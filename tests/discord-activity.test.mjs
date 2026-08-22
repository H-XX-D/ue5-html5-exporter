import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import { decodeJwt, exportJWK, generateKeyPair } from 'jose';

import {
  DiscordActivityBridge,
  isDiscordActivityContext,
  resolveActivityApiUrl,
} from '../web/src/discord-activity.js';
import {
  handleActivityRequest,
  supabaseSecretFetch,
  verifyDiscordProxyRequest,
} from '../web/public/api/activity.mjs';

async function testEnvironment() {
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  const privateJwk = await exportJWK(privateKey);
  privateJwk.kid = 'activity-test-key';
  return {
    DISCORD_CLIENT_ID: '123',
    DISCORD_CLIENT_SECRET: 'discord-secret',
    DISCORD_BOT_TOKEN: 'bot-secret',
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_public',
    SUPABASE_SECRET_KEY: 'sb_secret_private',
    SUPABASE_JWT_PRIVATE_KEY: JSON.stringify(privateJwk),
    SUPABASE_JWT_KEY_ID: privateJwk.kid,
    ACTIVITY_STATE_SECRET: 'a-test-secret-long-enough-for-hmac',
  };
}

function mockDiscordFetch(requests = []) {
  return async (url) => {
    const value = String(url);
    requests.push(value);
    if (value.endsWith('/oauth2/token')) return Response.json({ access_token: 'discord-access-token' });
    if (value.endsWith('/users/@me')) return Response.json({ id: 'user-42' });
    if (value.includes('/activity-instances/')) return Response.json({ users: ['user-42'] });
    if (value.includes('/entitlements')) return Response.json([]);
    throw new Error(`Unexpected Discord request: ${value}`);
  };
}

async function authenticatedCookie(env, fetchImpl, instanceId = 'i-test') {
  const response = await handleActivityRequest(new Request('https://game.test/api/activity', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'authenticate', instanceId, code: 'discord-code' }),
  }), { env, fetchImpl });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}

test('Discord context detection does not activate on an ordinary deployment URL', () => {
  assert.equal(isDiscordActivityContext({ hostname: 'game.vercel.app', search: '' }), false);
  assert.equal(isDiscordActivityContext({ hostname: '123.discordsays.com', search: '' }), true);
  assert.equal(isDiscordActivityContext({ hostname: 'localhost', search: '?frame_id=test' }), true);
});

test('Activity API endpoint is host-configurable and defaults to the bundled route', () => {
  assert.equal(resolveActivityApiUrl(null), '/api/activity');
  assert.equal(resolveActivityApiUrl({
    querySelector: () => ({ getAttribute: () => 'https://activity-api.example.test/v1' }),
  }), 'https://activity-api.example.test/v1');
});

test('public Activity config never returns server secrets', async () => {
  const env = await testEnvironment();
  const response = await handleActivityRequest(new Request('https://game.test/api/activity'), { env });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.enabled, true);
  assert.equal(payload.supabaseProxyTarget, 'project.supabase.co');
  assert.doesNotMatch(JSON.stringify(payload), /discord-secret|bot-secret|sb_secret_private/);
});

test('public Activity config fails closed when any server setting is absent', async () => {
  const env = await testEnvironment();
  delete env.DISCORD_BOT_TOKEN;
  const response = await handleActivityRequest(new Request('https://game.test/api/activity'), { env });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { enabled: false });
});

test('optional Discord proxy authentication verifies signed, unexpired headers and rejects direct requests', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicDer = publicKey.export({ format: 'der', type: 'spki' });
  const env = await testEnvironment();
  env.DISCORD_REQUIRE_PROXY_AUTH = 'true';
  env.DISCORD_PUBLIC_KEY = publicDer.subarray(-32).toString('hex');
  const now = 1_800_000_000;
  const payloadBytes = Buffer.from(JSON.stringify({ created_at: now, expires_at: now + 60 }));
  const headers = {
    'X-Signature-Ed25519': sign(null, payloadBytes, privateKey).toString('base64'),
    'X-Signature-Timestamp': String(now),
    'X-Discord-Proxy-Payload': payloadBytes.toString('base64'),
  };

  assert.deepEqual(
    verifyDiscordProxyRequest(new Request('https://game.test/api/activity', { headers }), env, now),
    { ok: true, enforced: true },
  );
  assert.deepEqual(
    verifyDiscordProxyRequest(new Request('https://game.test/api/activity', {
      headers: { ...headers, 'X-Signature-Ed25519': sign(null, payloadBytes, privateKey).toString('hex') },
    }), env, now),
    { ok: true, enforced: true },
  );
  assert.equal(
    verifyDiscordProxyRequest(new Request('https://game.test/api/activity'), env, now).ok,
    false,
  );

  const response = await handleActivityRequest(new Request('https://game.test/api/activity', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'authenticate', instanceId: 'i-test', code: 'discord-code' }),
  }), { env, fetchImpl: mockDiscordFetch() });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'Invalid Discord proxy signature.' });
});

test('Discord API calls retry a bounded 429 response using retry_after', async () => {
  const env = await testEnvironment();
  let attempts = 0;
  const baseFetch = mockDiscordFetch();
  const fetchImpl = async (url, init) => {
    if (String(url).includes('/activity-instances/') && attempts++ === 0) {
      return Response.json({ retry_after: 0 }, { status: 429 });
    }
    return baseFetch(url, init);
  };
  const response = await handleActivityRequest(new Request('https://game.test/api/activity', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'authenticate', instanceId: 'i-test', code: 'discord-code' }),
  }), { env, fetchImpl });
  assert.equal(response.status, 200);
  assert.equal(attempts, 2);
});

test('Supabase secret-key transport removes only the invalid opaque bearer fallback', async () => {
  const secret = 'sb_secret_server-value';
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, headers: new Headers(init.headers) });
    return Response.json([]);
  };
  const wrapped = supabaseSecretFetch(secret, fetchImpl);
  await wrapped('https://project.supabase.co/rest/v1/test', {
    headers: { apikey: secret, Authorization: `Bearer ${secret}` },
  });
  await wrapped('https://project.supabase.co/rest/v1/test', {
    headers: { apikey: secret, Authorization: 'Bearer real-user-jwt' },
  });
  assert.equal(requests[0].headers.get('apikey'), secret);
  assert.equal(requests[0].headers.has('authorization'), false);
  assert.equal(requests[1].headers.get('authorization'), 'Bearer real-user-jwt');
});

test('Activity API rejects persistence without a signed Activity session even if a token is injected', async () => {
  const env = {
    DISCORD_CLIENT_ID: '123',
    DISCORD_CLIENT_SECRET: 'discord-secret',
    DISCORD_BOT_TOKEN: 'bot-secret',
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_public',
    SUPABASE_SECRET_KEY: 'sb_secret_private',
    SUPABASE_JWT_PRIVATE_KEY: '{"kty":"EC"}',
    ACTIVITY_STATE_SECRET: 'state-secret',
  };
  const request = new Request('https://game.test/api/activity', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'save-world', instanceId: 'i-test', accessToken: 'attacker-supplied-token' }),
  });
  const response = await handleActivityRequest(request, { env });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'Missing or expired Activity session.' });
});

test('authentication exposes only opaque Realtime and HttpOnly partitioned session claims', async () => {
  const env = await testEnvironment();
  const fetchImpl = mockDiscordFetch();
  const request = new Request('https://game.test/api/activity', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'authenticate', instanceId: 'i-private-instance', code: 'discord-code' }),
  });

  const response = await handleActivityRequest(request, { env, fetchImpl });
  const payload = await response.json();
  const claims = decodeJwt(payload.realtimeToken);
  const setCookie = response.headers.get('set-cookie');
  const sessionPayload = JSON.parse(Buffer.from(
    setCookie.split('=')[1].split('.')[0],
    'base64url',
  ).toString('utf8'));

  assert.equal(response.status, 200);
  assert.match(payload.topic, /^activity:[0-9a-f]{64}$/);
  assert.equal(claims.activity_topic, payload.topic);
  assert.equal(claims.activity_instance, undefined);
  assert.doesNotMatch(JSON.stringify(payload), /i-private-instance/);
  assert.match(setCookie, /^__Host-ue5_activity_session=/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /Secure/i);
  assert.match(setCookie, /SameSite=None/i);
  assert.match(setCookie, /Partitioned/i);
  assert.match(sessionPayload.p, /^[0-9a-f]{64}$/);
  assert.match(sessionPayload.i, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(sessionPayload), /user-42|i-private-instance/);
});

test('persistence uses one atomic database RPC and reports revision conflicts', async () => {
  const env = await testEnvironment();
  const discordRequests = [];
  const fetchImpl = mockDiscordFetch(discordRequests);
  const cookie = await authenticatedCookie(env, fetchImpl);
  discordRequests.length = 0;
  const rpcCalls = [];
  const createClientImpl = () => ({
    rpc(name, parameters) {
      rpcCalls.push({ name, parameters });
      return {
        async single() {
          return { data: { revision: 7, updated_at: '2026-08-22T12:00:00Z', conflict: true }, error: null };
        },
      };
    },
  });
  const request = new Request('https://game.test/api/activity', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      action: 'save-world',
      instanceId: 'i-test',
      state: { checkpoint: 2 },
      expectedRevision: 6,
    }),
  });

  const response = await handleActivityRequest(request, { env, fetchImpl, createClientImpl });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: 'Game state changed; reload before saving.',
    revision: 7,
  });
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].name, 'save_discord_activity_world_state');
  assert.equal(rpcCalls[0].parameters.p_expected_revision, 6);
  assert.match(rpcCalls[0].parameters.p_world_id, /^[0-9a-f]{64}$/);
  assert.equal(discordRequests.some((url) => url.endsWith('/users/@me')), false);
  assert.equal(discordRequests.filter((url) => url.includes('/activity-instances/')).length, 1);
});

test('Activity sessions reject tampering and cannot cross Activity instances', async () => {
  const env = await testEnvironment();
  const fetchImpl = mockDiscordFetch();
  const cookie = await authenticatedCookie(env, fetchImpl, 'i-original');
  const [name, value] = cookie.split('=');
  const tamperedCookie = `${name}=${value.slice(0, -1)}${value.endsWith('a') ? 'b' : 'a'}`;
  const requestFor = (instanceId, requestCookie) => new Request('https://game.test/api/activity', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: requestCookie },
    body: JSON.stringify({ action: 'load-player', instanceId }),
  });

  const tampered = await handleActivityRequest(requestFor('i-original', tamperedCookie), { env, fetchImpl });
  const crossed = await handleActivityRequest(requestFor('i-different', cookie), { env, fetchImpl });
  const refreshed = await handleActivityRequest(new Request('https://game.test/api/activity', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ action: 'refresh', instanceId: 'i-original' }),
  }), { env, fetchImpl });

  assert.equal(tampered.status, 401);
  assert.deepEqual(await tampered.json(), { error: 'Missing or expired Activity session.' });
  assert.equal(crossed.status, 403);
  assert.deepEqual(await crossed.json(), { error: 'Activity session does not match this instance.' });
  assert.equal(refreshed.status, 200);
  assert.match(refreshed.headers.get('set-cookie'), /^__Host-ue5_activity_session=/);
  assert.ok((await refreshed.json()).realtimeToken);
});

test('bridge completes Discord auth, clears the OAuth token, and joins private Realtime', async () => {
  const calls = [];
  const config = {
    enabled: true,
    discordClientId: '123',
    supabaseUrl: 'https://project.supabase.co',
    supabasePublishableKey: 'sb_publishable_public',
    supabaseProxyPrefix: '/supabase',
    supabaseProxyTarget: 'project.supabase.co',
    oauthScopes: ['identify'],
  };
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (!init.method) return Response.json(config);
    const request = JSON.parse(init.body);
    if (request.action === 'verify-entitlements') {
      return Response.json({ entitlements: [{ skuId: 'sku-premium', consumed: false }] });
    }
    if (request.action !== 'authenticate') return Response.json({ state: null, revision: 0 });
    return Response.json({
      accessToken: 'discord-access-token',
      realtimeToken: 'supabase-realtime-jwt',
      realtimeExpiresAt: 9999999999,
      topic: 'activity:i-test',
      entitlements: [],
    });
  };

  const channel = {
    handlers: [],
    on(type, filter, callback) { this.handlers.push({ type, filter, callback }); return this; },
    subscribe(callback) { callback('SUBSCRIBED'); return this; },
    async track() {},
    presenceState() { return {}; },
    async send(payload) { return payload; },
  };
  const supabase = {
    realtime: { setAuth(token) { assert.equal(token, 'supabase-realtime-jwt'); } },
    channel(topic, options) {
      assert.equal(topic, 'activity:i-test');
      assert.equal(options.config.private, true);
      return channel;
    },
    async removeChannel() {},
  };
  class MockDiscordSDK {
    constructor(clientId) { assert.equal(clientId, '123'); this.instanceId = 'i-test'; }
    async ready() {}
    commands = {
      authorize: async (args) => { assert.deepEqual(args.scope, ['identify']); return { code: 'discord-code' }; },
      authenticate: async ({ access_token }) => { assert.equal(access_token, 'discord-access-token'); return { user: { id: '42', username: 'player', global_name: 'Player' } }; },
      getInstanceConnectedParticipants: async () => ({ participants: [{ id: '42' }] }),
      openInviteDialog: async () => ({ opened: true }),
      encourageHardwareAcceleration: async () => ({ enabled: true }),
      getSkus: async () => ({ skus: [{ id: 'sku-premium' }] }),
      getEntitlements: async () => ({ entitlements: [{ sku_id: 'client-only' }] }),
      startPurchase: async ({ sku_id }) => ({ sku_id, opened: true }),
    };
    subscribe() {}
    unsubscribe() {}
    close() {}
  }

  const mappings = [];
  const bridge = new DiscordActivityBridge({
    fetchImpl,
    DiscordSDKClass: MockDiscordSDK,
    patchMappings: (value) => mappings.push(value),
    createSupabaseClient: (url, key) => {
      assert.equal(url, 'https://123.discordsays.com/supabase');
      assert.equal(key, 'sb_publishable_public');
      return supabase;
    },
    locationObject: {
      hostname: '123.discordsays.com',
      origin: 'https://123.discordsays.com',
      search: '',
    },
  });

  await bridge.start();
  assert.equal(bridge.mode, 'ready');
  assert.equal(bridge.user.id, '42');
  assert.equal(bridge.discordAccessToken, null);
  assert.deepEqual(mappings, [[{ prefix: '/supabase', target: 'project.supabase.co' }]]);
  assert.equal(JSON.parse(calls[1].init.body).code, 'discord-code');
  assert.equal(calls[1].init.credentials, 'include');
  await bridge.loadWorld();
  assert.equal(JSON.parse(calls[2].init.body).accessToken, undefined);
  assert.equal(calls[2].init.credentials, 'include');
  assert.deepEqual(await bridge.broadcast('input', { x: 1 }), {
    type: 'broadcast', event: 'input', payload: { x: 1 },
  });
  assert.deepEqual(await bridge.getParticipants(), { participants: [{ id: '42' }] });
  assert.deepEqual(await bridge.openInviteDialog(), { opened: true });
  assert.deepEqual(await bridge.encourageHardwareAcceleration(), { enabled: true });
  assert.deepEqual(await bridge.getSkus(), { skus: [{ id: 'sku-premium' }] });
  assert.deepEqual(await bridge.getClientEntitlements(), { entitlements: [{ sku_id: 'client-only' }] });
  assert.deepEqual(await bridge.startPurchase('sku-premium'), {
    purchase: { sku_id: 'sku-premium', opened: true },
    entitlements: [{ skuId: 'sku-premium', consumed: false }],
  });
  await bridge.dispose();
});
