import {
  createHmac,
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
} from 'node:crypto';
import { importJWK, SignJWT } from 'jose';
import { createClient } from '@supabase/supabase-js';

const DISCORD_API = 'https://discord.com/api/v10';
const MAX_WORLD_STATE_BYTES = 512 * 1024;
const LIVE_CERTIFICATION_SCHEMA = 'ue5-discord-live-certification/v1';
const LIVE_CERTIFICATION_REQUIRED_CLIENTS = 2;
const LIVE_CERTIFICATION_WINDOW_SECONDS = 10 * 60;
const SESSION_COOKIE = '__Host-ue5_activity_session';
const SESSION_TTL_SECONDS = 20 * 60;
const MAX_DISCORD_RATE_LIMIT_RETRIES = 2;
const MAX_DISCORD_RATE_LIMIT_DELAY_MS = 10_000;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const REQUIRED_ENVIRONMENT = [
  'DISCORD_CLIENT_ID',
  'DISCORD_CLIENT_SECRET',
  'DISCORD_BOT_TOKEN',
  'SUPABASE_URL',
  'SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_SECRET_KEY',
  'ACTIVITY_STATE_SECRET',
];

function json(data, status = 200, extraHeaders = {}) {
  return Response.json(data, {
    status,
    headers: {
      'Cache-Control': 'no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}

function requiredEnvironment(env, names) {
  const missing = names.filter((name) => !env[name]);
  if (missing.length) throw new Error(`Missing server environment: ${missing.join(', ')}`);
}

function hasRequiredEnvironment(env, names = REQUIRED_ENVIRONMENT) {
  if (!names.every((name) => Boolean(env[name]))) return false;
  return !proxyAuthenticationRequired(env) || validDiscordPublicKey(env.DISCORD_PUBLIC_KEY);
}

function validInstanceId(value) {
  return typeof value === 'string' && value.startsWith('i-') && value.length <= 256;
}

function proxyAuthenticationRequired(env) {
  return /^(?:1|true|yes|on)$/i.test(String(env.DISCORD_REQUIRE_PROXY_AUTH || ''));
}

function richPresenceEnabled(env) {
  return /^(?:1|true|yes|on)$/i.test(String(env.DISCORD_ENABLE_RICH_PRESENCE || ''));
}

function realtimeEnabled(env) {
  try {
    const key = JSON.parse(env.SUPABASE_JWT_PRIVATE_KEY);
    return key.kty === 'EC'
      && key.crv === 'P-256'
      && Boolean(key.x && key.y && key.d && (env.SUPABASE_JWT_KEY_ID || key.kid));
  } catch {
    return false;
  }
}

function validDiscordPublicKey(value) {
  return /^[0-9a-f]{64}$/i.test(String(value || ''));
}

function decodeDiscordSignature(value) {
  const encoded = String(value || '');
  return /^[0-9a-f]{128}$/i.test(encoded)
    ? Buffer.from(encoded, 'hex')
    : Buffer.from(encoded, 'base64');
}

function discordRetryDelayMs(response, payload) {
  const seconds = Number(payload?.retry_after ?? response.headers.get('retry-after'));
  if (!Number.isFinite(seconds) || seconds < 0) return 1_000;
  return Math.min(Math.ceil(seconds * 1_000), MAX_DISCORD_RATE_LIMIT_DELAY_MS);
}

async function wait(milliseconds) {
  if (milliseconds <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function discordJson(fetchImpl, url, init) {
  for (let attempt = 0; attempt <= MAX_DISCORD_RATE_LIMIT_RETRIES; attempt += 1) {
    const response = await fetchImpl(url, init);
    const payload = await response.json().catch(() => ({}));
    if (response.status === 429 && attempt < MAX_DISCORD_RATE_LIMIT_RETRIES) {
      await wait(discordRetryDelayMs(response, payload));
      continue;
    }
    if (!response.ok) throw new Error(payload.message || `Discord API returned HTTP ${response.status}`);
    return payload;
  }
  throw new Error('Discord API rate-limit retry budget exhausted.');
}

export function verifyDiscordProxyRequest(request, env, now = Math.floor(Date.now() / 1000)) {
  if (!proxyAuthenticationRequired(env)) return { ok: true, enforced: false };
  if (!validDiscordPublicKey(env.DISCORD_PUBLIC_KEY)) {
    return { ok: false, reason: 'Discord proxy authentication public key is not configured.' };
  }

  const signatureHeader = request.headers.get('x-signature-ed25519');
  const timestamp = request.headers.get('x-signature-timestamp');
  const payloadHeader = request.headers.get('x-discord-proxy-payload');
  if (!signatureHeader || !timestamp || !payloadHeader) {
    return { ok: false, reason: 'Discord proxy authentication headers are missing.' };
  }

  try {
    const payloadBytes = Buffer.from(payloadHeader, 'base64');
    // Discord's examples have historically shown both base64 and hexadecimal
    // decoding in different languages, so accept either exact 64-byte form.
    const signatureBytes = decodeDiscordSignature(signatureHeader);
    if (!payloadBytes.length || signatureBytes.length !== 64) {
      return { ok: false, reason: 'Discord proxy authentication headers are malformed.' };
    }
    const payload = JSON.parse(payloadBytes.toString('utf8'));
    if (String(payload.created_at) !== timestamp) {
      return { ok: false, reason: 'Discord proxy timestamp does not match its signed payload.' };
    }
    if (!Number.isSafeInteger(payload.expires_at) || payload.expires_at < now) {
      return { ok: false, reason: 'Discord proxy authentication payload is expired.' };
    }

    const rawPublicKey = Buffer.from(env.DISCORD_PUBLIC_KEY, 'hex');
    const publicKey = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, rawPublicKey]),
      format: 'der',
      type: 'spki',
    });
    if (!verifySignature(null, payloadBytes, publicKey, signatureBytes)) {
      return { ok: false, reason: 'Discord proxy signature is invalid.' };
    }
    return { ok: true, enforced: true };
  } catch {
    return { ok: false, reason: 'Discord proxy authentication headers are malformed.' };
  }
}

async function fetchActivityInstance(fetchImpl, env, instanceId) {
  return discordJson(
    fetchImpl,
    `${DISCORD_API}/applications/${encodeURIComponent(env.DISCORD_CLIENT_ID)}/activity-instances/${encodeURIComponent(instanceId)}`,
    { headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` } },
  );
}

async function verifyDiscordSession(fetchImpl, env, instanceId, accessToken) {
  if (!validInstanceId(instanceId)) return { error: json({ error: 'Invalid Activity instance ID.' }, 400) };
  if (typeof accessToken !== 'string' || accessToken.length < 16 || accessToken.length > 4096) {
    return { error: json({ error: 'Missing Discord access token.' }, 401) };
  }
  const [discordUser, instance] = await Promise.all([
    discordJson(fetchImpl, `${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    }),
    fetchActivityInstance(fetchImpl, env, instanceId),
  ]);
  if (!instance.users?.includes(discordUser.id)) {
    return { error: json({ error: 'Discord user is not present in this Activity instance.' }, 403) };
  }
  return { discordUser, instance };
}

function opaqueStateId(env, kind, sourceId) {
  return createHmac('sha256', env.ACTIVITY_STATE_SECRET).update(`${kind}:${sourceId}`).digest('hex');
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function sessionValue(env, playerKey, instanceKey, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    p: playerKey,
    i: instanceKey,
    exp: Math.floor(now / 1000) + SESSION_TTL_SECONDS,
  })).toString('base64url');
  const signature = createHmac('sha256', env.ACTIVITY_STATE_SECRET)
    .update(`activity-session:${payload}`)
    .digest('base64url');
  return `${payload}.${signature}`;
}

function sessionCookie(value, maxAge = SESSION_TTL_SECONDS) {
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=None; Partitioned`;
}

function requestCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return null;
}

function readActivitySession(request, env, now = Date.now()) {
  const value = requestCookie(request, SESSION_COOKIE);
  if (!value) return null;
  const [payload, signature, extra] = value.split('.');
  if (!payload || !signature || extra) return null;
  const expected = createHmac('sha256', env.ACTIVITY_STATE_SECRET)
    .update(`activity-session:${payload}`)
    .digest('base64url');
  if (!safeEqual(signature, expected)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (session.v !== 1 || !/^[0-9a-f]{64}$/.test(session.p) || !/^[0-9a-f]{64}$/.test(session.i)) return null;
    if (!Number.isSafeInteger(session.exp) || session.exp <= Math.floor(now / 1000)) return null;
    return session;
  } catch {
    return null;
  }
}

async function verifyActivitySession(request, body, fetchImpl, env) {
  if (!validInstanceId(body.instanceId)) return { error: json({ error: 'Invalid Activity instance ID.' }, 400) };
  const session = readActivitySession(request, env);
  if (!session) return { error: json({ error: 'Missing or expired Activity session.' }, 401) };
  const instanceKey = opaqueStateId(env, 'session-instance', body.instanceId);
  if (!safeEqual(session.i, instanceKey)) {
    return { error: json({ error: 'Activity session does not match this instance.' }, 403) };
  }
  const instance = await fetchActivityInstance(fetchImpl, env, body.instanceId);
  const discordUserId = instance.users?.find((userId) => safeEqual(
    opaqueStateId(env, 'player', String(userId)),
    session.p,
  ));
  if (!discordUserId) {
    return { error: json({ error: 'Discord user is not present in this Activity instance.' }, 403) };
  }
  return { discordUserId: String(discordUserId), playerKey: session.p, instanceKey, instance };
}

async function mintRealtimeToken(env, topic) {
  const privateJwk = JSON.parse(env.SUPABASE_JWT_PRIVATE_KEY);
  const keyId = env.SUPABASE_JWT_KEY_ID || privateJwk.kid;
  if (!keyId) throw new Error('SUPABASE_JWT_KEY_ID or a JWK kid is required.');
  const privateKey = await importJWK(privateJwk, 'ES256');
  const expiresAt = Math.floor(Date.now() / 1000) + 10 * 60;
  const token = await new SignJWT({
    role: 'authenticated',
    activity_topic: topic,
  })
    .setProtectedHeader({ alg: 'ES256', kid: keyId, typ: 'JWT' })
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(privateKey);
  return { token, expiresAt };
}

function realtimeTopic(env, instanceId) {
  return `activity:${opaqueStateId(env, 'realtime', instanceId)}`;
}

function validExpectedRevision(value) {
  return value === undefined || (Number.isSafeInteger(value) && value >= 0);
}

function validCertificationChallenge(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value);
}

function stateSize(state) {
  return new TextEncoder().encode(JSON.stringify(state)).byteLength;
}

async function atomicSave(admin, functionName, parameters) {
  const { data, error } = await admin.rpc(functionName, parameters).single();
  if (error) throw error;
  if (data.conflict) {
    return json({
      error: 'Game state changed; reload before saving.',
      revision: Number(data.revision || 0),
    }, 409);
  }
  return json({
    saved: true,
    revision: Number(data.revision),
    updatedAt: data.updated_at,
  });
}

function activeEntitlementView(entitlements) {
  const now = Date.now();
  return entitlements
    .filter((item) => !item.deleted && (!item.ends_at || Date.parse(item.ends_at) > now))
    .map((item) => ({
      skuId: item.sku_id,
      type: item.type,
      endsAt: item.ends_at || null,
      consumed: Boolean(item.consumed),
    }));
}

export function supabaseSecretFetch(secretKey, fetchImpl = fetch) {
  return async (input, init = {}) => {
    const headers = new Headers(init.headers);
    if (headers.get('Authorization') === `Bearer ${secretKey}`) headers.delete('Authorization');
    return fetchImpl(input, { ...init, headers });
  };
}

async function fetchEntitlements(fetchImpl, env, discordUserId) {
  const url = new URL(`${DISCORD_API}/applications/${encodeURIComponent(env.DISCORD_CLIENT_ID)}/entitlements`);
  url.searchParams.set('user_id', discordUserId);
  url.searchParams.set('exclude_ended', 'true');
  url.searchParams.set('exclude_deleted', 'true');
  const entitlements = await discordJson(fetchImpl, url, {
    headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
  });
  return activeEntitlementView(entitlements);
}

async function exchangeDiscordCode(fetchImpl, env, code) {
  if (typeof code !== 'string' || code.length < 8 || code.length > 2048) {
    return { error: json({ error: 'Invalid Discord authorization code.' }, 400) };
  }
  const token = await discordJson(fetchImpl, `${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
    }),
  });
  if (!token.access_token) return { error: json({ error: 'Discord returned no access token.' }, 502) };
  return { accessToken: token.access_token };
}

async function authenticate(body, fetchImpl, env) {
  if (!validInstanceId(body.instanceId)) return json({ error: 'Invalid Activity instance ID.' }, 400);
  const exchange = await exchangeDiscordCode(fetchImpl, env, body.code);
  if (exchange.error) return exchange.error;
  const verified = await verifyDiscordSession(fetchImpl, env, body.instanceId, exchange.accessToken);
  if (verified.error) return verified.error;
  const topic = realtimeTopic(env, body.instanceId);
  const playerKey = opaqueStateId(env, 'player', verified.discordUser.id);
  const instanceKey = opaqueStateId(env, 'session-instance', body.instanceId);
  const realtimePromise = realtimeEnabled(env)
    ? mintRealtimeToken(env, topic)
    : Promise.resolve({ token: null, expiresAt: null });
  const [realtime, entitlements] = await Promise.all([
    realtimePromise,
    fetchEntitlements(fetchImpl, env, verified.discordUser.id),
  ]);
  return json({
    accessToken: exchange.accessToken,
    realtimeToken: realtime.token,
    realtimeExpiresAt: realtime.expiresAt,
    topic,
    entitlements,
  }, 200, { 'Set-Cookie': sessionCookie(sessionValue(env, playerKey, instanceKey)) });
}

async function refresh(request, body, fetchImpl, env) {
  const verified = await verifyActivitySession(request, body, fetchImpl, env);
  if (verified.error) return verified.error;
  const realtime = realtimeEnabled(env)
    ? await mintRealtimeToken(env, realtimeTopic(env, body.instanceId))
    : { token: null, expiresAt: null };
  return json(
    { realtimeToken: realtime.token, realtimeExpiresAt: realtime.expiresAt },
    200,
    { 'Set-Cookie': sessionCookie(sessionValue(env, verified.playerKey, verified.instanceKey)) },
  );
}

async function verifyEntitlements(request, body, fetchImpl, env) {
  const verified = await verifyActivitySession(request, body, fetchImpl, env);
  if (verified.error) return verified.error;
  return json({ entitlements: await fetchEntitlements(fetchImpl, env, verified.discordUserId) });
}

async function loadWorld(request, body, admin, fetchImpl, env) {
  const verified = await verifyActivitySession(request, body, fetchImpl, env);
  if (verified.error) return verified.error;
  const id = opaqueStateId(env, 'world', body.instanceId);
  const { data, error } = await admin
    .from('discord_activity_world_state')
    .select('state, revision, updated_at')
    .eq('world_id', id)
    .maybeSingle();
  if (error) throw error;
  return json({ state: data?.state ?? null, revision: data?.revision ?? 0, updatedAt: data?.updated_at ?? null });
}

async function saveWorld(request, body, admin, fetchImpl, env) {
  const verified = await verifyActivitySession(request, body, fetchImpl, env);
  if (verified.error) return verified.error;
  if (body.state === undefined) return json({ error: 'Missing game world state.' }, 400);
  if (!validExpectedRevision(body.expectedRevision)) {
    return json({ error: 'Expected revision must be a non-negative safe integer.' }, 400);
  }
  if (stateSize(body.state) > MAX_WORLD_STATE_BYTES) {
    return json({ error: `Game world state exceeds ${MAX_WORLD_STATE_BYTES} bytes.` }, 413);
  }
  const id = opaqueStateId(env, 'world', body.instanceId);
  return atomicSave(admin, 'save_discord_activity_world_state', {
    p_world_id: id,
    p_state: body.state,
    p_expected_revision: body.expectedRevision ?? null,
  });
}

async function loadPlayer(request, body, admin, fetchImpl, env) {
  const verified = await verifyActivitySession(request, body, fetchImpl, env);
  if (verified.error) return verified.error;
  const id = verified.playerKey;
  const { data, error } = await admin
    .from('discord_activity_player_state')
    .select('state, revision, updated_at')
    .eq('player_key', id)
    .maybeSingle();
  if (error) throw error;
  return json({ state: data?.state ?? null, revision: data?.revision ?? 0, updatedAt: data?.updated_at ?? null });
}

async function savePlayer(request, body, admin, fetchImpl, env) {
  const verified = await verifyActivitySession(request, body, fetchImpl, env);
  if (verified.error) return verified.error;
  if (body.state === undefined) return json({ error: 'Missing player game state.' }, 400);
  if (!validExpectedRevision(body.expectedRevision)) {
    return json({ error: 'Expected revision must be a non-negative safe integer.' }, 400);
  }
  if (stateSize(body.state) > MAX_WORLD_STATE_BYTES) {
    return json({ error: `Player game state exceeds ${MAX_WORLD_STATE_BYTES} bytes.` }, 413);
  }
  const id = verified.playerKey;
  return atomicSave(admin, 'save_discord_activity_player_state', {
    p_player_key: id,
    p_state: body.state,
    p_expected_revision: body.expectedRevision ?? null,
  });
}

async function certifyLiveSession(request, body, admin, fetchImpl, env, proxyAuthenticated) {
  if (!validCertificationChallenge(body.challenge)) {
    return json({ error: 'Live certification challenge is invalid.' }, 400);
  }
  const verified = await verifyActivitySession(request, body, fetchImpl, env);
  if (verified.error) return verified.error;
  const participantCount = new Set(
    Array.from(verified.instance.users || [], (value) => String(value)),
  ).size;
  const challengeKey = opaqueStateId(env, 'live-certification-challenge', body.challenge);
  const { data, error } = await admin.rpc('check_in_discord_activity_certification', {
    p_instance_key: verified.instanceKey,
    p_player_key: verified.playerKey,
    p_challenge_key: challengeKey,
    p_participant_count: participantCount,
    p_proxy_authenticated: Boolean(proxyAuthenticated),
  }).single();
  if (error) throw error;
  return json({
    schema: LIVE_CERTIFICATION_SCHEMA,
    status: data.status === 'passed' ? 'passed' : 'waiting',
    checkedAtUtc: data.checked_at,
    expiresAtUtc: data.expires_at,
    requiredAuthenticatedClients: LIVE_CERTIFICATION_REQUIRED_CLIENTS,
    authenticatedClientCount: Number(data.authenticated_clients || 0),
    participantCount: Number(data.participant_count || 0),
    sameActivityInstance: true,
    backendMembershipRechecked: true,
    proxyAuthenticationEnforced: Boolean(data.all_proxy_authenticated),
    realtimeRequired: false,
    certificationWindowSeconds: LIVE_CERTIFICATION_WINDOW_SECONDS,
    privacy: {
      rawDiscordIdentityStored: false,
      personalPlayerDataStored: false,
      billingDataStored: false,
      deviceMetadataCollected: false,
      databaseKeys: 'opaque-hmac-only',
      retention: 'check-ins older than 24 hours are deleted during certification',
    },
  });
}

export async function handleActivityRequest(request, {
  env = process.env,
  fetchImpl = fetch,
  createClientImpl = createClient,
} = {}) {
  if (request.method === 'GET') {
    if (!hasRequiredEnvironment(env)) return json({ enabled: false });
    return json({
      enabled: true,
      realtimeEnabled: realtimeEnabled(env),
      discordClientId: env.DISCORD_CLIENT_ID,
      supabaseUrl: env.SUPABASE_URL,
      supabasePublishableKey: env.SUPABASE_PUBLISHABLE_KEY,
      supabaseProxyPrefix: '/supabase',
      supabaseProxyTarget: new URL(env.SUPABASE_URL).host,
      oauthScopes: richPresenceEnabled(env) ? ['identify', 'rpc.activities.write'] : ['identify'],
      richPresenceEnabled: richPresenceEnabled(env),
      proxyAuthenticationRequired: proxyAuthenticationRequired(env),
    });
  }
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  try {
    requiredEnvironment(env, REQUIRED_ENVIRONMENT);
    const proxyVerification = verifyDiscordProxyRequest(request, env);
    if (!proxyVerification.ok) return json({ error: 'Invalid Discord proxy signature.' }, 401);
    const body = await request.json().catch(() => ({}));
    if (body.action === 'authenticate') return authenticate(body, fetchImpl, env);
    if (body.action === 'refresh') return refresh(request, body, fetchImpl, env);
    if (body.action === 'verify-entitlements') return verifyEntitlements(request, body, fetchImpl, env);

    const admin = createClientImpl(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: supabaseSecretFetch(env.SUPABASE_SECRET_KEY, fetchImpl) },
    });
    if (body.action === 'load-world') return loadWorld(request, body, admin, fetchImpl, env);
    if (body.action === 'save-world') return saveWorld(request, body, admin, fetchImpl, env);
    if (body.action === 'load-player') return loadPlayer(request, body, admin, fetchImpl, env);
    if (body.action === 'save-player') return savePlayer(request, body, admin, fetchImpl, env);
    if (body.action === 'certify-live') {
      return certifyLiveSession(request, body, admin, fetchImpl, env, proxyVerification.enforced);
    }
    return json({ error: 'Unknown Activity action.' }, 400);
  } catch (error) {
    console.error('Discord Activity API error', error);
    return json({ error: 'Activity service failed.' }, 500);
  }
}

export default {
  fetch(request) {
    return handleActivityRequest(request);
  },
};
