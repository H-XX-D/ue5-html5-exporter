import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import { decodeJwt, exportJWK, generateKeyPair } from 'jose';
import { Events } from '@discord/embedded-app-sdk';

import {
  DiscordActivityBridge,
  LIVE_CERTIFICATION_SCHEMA,
  isDiscordActivityContext,
  isDiscordActivityPreviewContext,
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

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
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

test('local Discord preview requires an explicit loopback-only flag', () => {
  assert.equal(isDiscordActivityPreviewContext({ hostname: 'localhost', search: '?ue5_discord_preview=1' }), true);
  assert.equal(isDiscordActivityPreviewContext({ hostname: '127.0.0.1', search: '?ue5_discord_preview=1' }), true);
  assert.equal(isDiscordActivityPreviewContext({ hostname: 'game.vercel.app', search: '?ue5_discord_preview=1' }), false);
  assert.equal(isDiscordActivityPreviewContext({ hostname: 'localhost', search: '' }), false);
});

test('official SDK mock preview reaches ready without API calls and loops Broadcast locally', async () => {
  let fetchCalls = 0;
  const bridge = new DiscordActivityBridge({
    previewMode: true,
    locationObject: { hostname: 'localhost', search: '?ue5_discord_preview=1' },
    fetchImpl: async () => { fetchCalls += 1; throw new Error('preview must stay offline'); },
    storage: memoryStorage(),
  });
  const broadcasts = [];
  bridge.addEventListener('broadcast', ({ detail }) => broadcasts.push(detail));
  await bridge.start();

  assert.equal(fetchCalls, 0);
  assert.equal(bridge.mode, 'ready');
  assert.deepEqual(bridge.publicState, { mode: 'ready', preview: true });
  assert.equal(bridge.discord.sdkVersion, 'mock');
  assert.equal((await bridge.getParticipants()).participants[0].global_name, 'Mock Player');
  assert.equal((await bridge.getLocale()).locale, 'en-US');

  await bridge.broadcast('ScoreChanged', { score: 12 });
  assert.deepEqual(broadcasts, [{
    event: 'ScoreChanged', payload: { score: 12 }, meta: { replayed: false, preview: true },
  }]);
  await bridge.dispose();
});

test('local Discord preview mirrors persistence revisions and mock purchases', async () => {
  const storage = memoryStorage();
  const options = {
    previewMode: true,
    locationObject: { hostname: 'localhost', search: '?ue5_discord_preview=1' },
    storage,
  };
  const first = new DiscordActivityBridge(options);
  await first.start();
  assert.deepEqual(await first.loadPlayerState(), {
    state: null, revision: 0, updatedAt: null, preview: true,
  });
  assert.equal((await first.savePlayerState({ level: 3 }, 0)).revision, 1);
  await assert.rejects(first.savePlayerState({ level: 4 }, 0), (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.revision, 1);
    return true;
  });
  const purchase = await first.startPurchase('preview-sku');
  assert.equal(purchase.entitlements[0].skuId, 'preview-sku');
  assert.equal(purchase.entitlements[0].preview, true);

  const second = new DiscordActivityBridge(options);
  await second.start();
  assert.deepEqual((await second.loadPlayerState()).state, { level: 3 });
  assert.equal((await second.loadPlayerState()).revision, 1);
  await first.dispose();
  await second.dispose();
});

test('public lifecycle state exposes stable reasons and codes without raw errors', async () => {
  const bridge = new DiscordActivityBridge({
    fetchImpl: async () => Response.json({ enabled: false }),
    locationObject: { hostname: 'localhost', search: '?frame_id=test' },
  });
  await bridge.start();
  assert.deepEqual(bridge.publicState, {
    mode: 'standalone', reason: 'ConfigurationDisabled',
  });

  bridge.setMode('error', {
    error: Object.assign(new Error('Bearer discord-access-token player@example.test'), {
      code: '401 invalid token',
    }),
  });
  assert.deepEqual(bridge.publicState, {
    mode: 'error', errorCode: 'ACTIVITY_CONNECTION_FAILED',
  });
  assert.doesNotMatch(JSON.stringify(bridge.publicState), /discord-access-token|player@example\.test/);

  bridge.setMode('error', { error: Object.assign(new Error('unsupported'), { code: 4002 }) });
  assert.deepEqual(bridge.publicState, { mode: 'error', errorCode: '4002' });
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
  assert.equal(payload.realtimeEnabled, true);
  assert.equal(payload.supabaseProxyTarget, 'project.supabase.co');
  assert.equal(payload.richPresenceEnabled, false);
  assert.deepEqual(payload.oauthScopes, ['identify']);
  assert.doesNotMatch(JSON.stringify(payload), /discord-secret|bot-secret|sb_secret_private/);
});

test('Activity auth and persistence stay enabled without a Supabase private Realtime key', async () => {
  const env = await testEnvironment();
  delete env.SUPABASE_JWT_PRIVATE_KEY;
  delete env.SUPABASE_JWT_KEY_ID;
  const fetchImpl = mockDiscordFetch();

  const configResponse = await handleActivityRequest(new Request('https://game.test/api/activity'), { env });
  const config = await configResponse.json();
  assert.equal(config.enabled, true);
  assert.equal(config.realtimeEnabled, false);

  const authResponse = await handleActivityRequest(new Request('https://game.test/api/activity', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'authenticate', instanceId: 'i-test', code: 'discord-code' }),
  }), { env, fetchImpl });
  const authenticated = await authResponse.json();
  assert.equal(authResponse.status, 200);
  assert.equal(authenticated.realtimeToken, null);
  assert.equal(authenticated.realtimeExpiresAt, null);
  assert.match(authResponse.headers.get('set-cookie'), /^__Host-ue5_activity_session=/);
});

test('bridge reaches ready without constructing Supabase when private Realtime is disabled', async () => {
  let supabaseClients = 0;
  const calls = [];
  const config = {
    enabled: true,
    realtimeEnabled: false,
    discordClientId: '123',
    supabaseUrl: 'https://project.supabase.co',
    supabasePublishableKey: 'sb_publishable_public',
    oauthScopes: ['identify'],
  };
  const fetchImpl = async (_url, init = {}) => {
    calls.push(init);
    if (!init.method) return Response.json(config);
    const request = JSON.parse(init.body);
    if (request.action === 'authenticate') {
      return Response.json({
        accessToken: 'discord-access-token',
        realtimeToken: null,
        realtimeExpiresAt: null,
        topic: 'activity:opaque',
        entitlements: [],
      });
    }
    return Response.json({ state: { checkpoint: 1 }, revision: 2 });
  };
  class MockDiscordSDK {
    constructor() { this.instanceId = 'i-test'; }
    async ready() {}
    commands = {
      authorize: async () => ({ code: 'discord-code' }),
      authenticate: async () => ({ user: { id: '42' } }),
    };
    subscribe() {}
    close() {}
  }
  const bridge = new DiscordActivityBridge({
    fetchImpl,
    DiscordSDKClass: MockDiscordSDK,
    createSupabaseClient: () => { supabaseClients += 1; throw new Error('must not construct'); },
    locationObject: { hostname: '123.discordsays.com', origin: 'https://123.discordsays.com', search: '' },
  });

  await bridge.start();
  assert.equal(bridge.mode, 'ready');
  assert.equal(bridge.discordAccessToken, null);
  assert.equal(bridge.channel, null);
  assert.equal(supabaseClients, 0);
  assert.deepEqual(await bridge.loadPlayerState(), { state: { checkpoint: 1 }, revision: 2 });
  assert.equal(JSON.parse(calls.at(-1).body).accessToken, undefined);
  await bridge.dispose();
});

test('Rich Presence scope is enabled only by explicit server configuration', async () => {
  const env = await testEnvironment();
  env.DISCORD_ENABLE_RICH_PRESENCE = 'true';
  const response = await handleActivityRequest(new Request('https://game.test/api/activity'), { env });
  const payload = await response.json();
  assert.equal(payload.richPresenceEnabled, true);
  assert.deepEqual(payload.oauthScopes, ['identify', 'rpc.activities.write']);
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

test('live certification rechecks one Discord instance and sends only opaque account keys to Supabase', async () => {
  const env = await testEnvironment();
  const users = ['user-42', 'user-84'];
  const fetchFor = (userId) => async (url) => {
    const value = String(url);
    if (value.endsWith('/oauth2/token')) return Response.json({ access_token: `discord-access-token-${userId}` });
    if (value.endsWith('/users/@me')) return Response.json({ id: userId });
    if (value.includes('/activity-instances/')) return Response.json({ users });
    if (value.includes('/entitlements')) return Response.json([]);
    throw new Error(`Unexpected Discord request: ${value}`);
  };
  const firstCookie = await authenticatedCookie(env, fetchFor(users[0]), 'i-live-test');
  const secondCookie = await authenticatedCookie(env, fetchFor(users[1]), 'i-live-test');
  const rpcCalls = [];
  const createClientImpl = () => ({
    rpc(name, parameters) {
      rpcCalls.push({ name, parameters });
      return {
        async single() {
          const authenticatedClients = new Set(rpcCalls.map((call) => call.parameters.p_player_key)).size;
          return {
            data: {
              status: authenticatedClients >= 2 ? 'passed' : 'waiting',
              authenticated_clients: authenticatedClients,
              participant_count: 2,
              all_proxy_authenticated: false,
              checked_at: '2026-08-23T18:00:00Z',
              expires_at: '2026-08-23T18:10:00Z',
            },
            error: null,
          };
        },
      };
    },
  });
  const certify = (cookie, challenge) => handleActivityRequest(new Request('https://game.test/api/activity', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ action: 'certify-live', instanceId: 'i-live-test', challenge }),
  }), { env, fetchImpl: fetchFor(users[0]), createClientImpl });

  const first = await certify(firstCookie, 'challenge_first_123456');
  const second = await certify(secondCookie, 'challenge_second_12345');
  const firstReport = await first.json();
  const secondReport = await second.json();

  assert.equal(firstReport.status, 'waiting');
  assert.equal(secondReport.status, 'passed');
  assert.equal(secondReport.schema, LIVE_CERTIFICATION_SCHEMA);
  assert.equal(secondReport.authenticatedClientCount, 2);
  assert.equal(secondReport.participantCount, 2);
  assert.equal(secondReport.backendMembershipRechecked, true);
  assert.equal(secondReport.realtimeRequired, false);
  assert.equal(rpcCalls.length, 2);
  assert.equal(rpcCalls.every((call) => call.name === 'check_in_discord_activity_certification'), true);
  for (const { parameters } of rpcCalls) {
    assert.deepEqual(Object.keys(parameters).sort(), [
      'p_challenge_key', 'p_instance_key', 'p_participant_count', 'p_player_key', 'p_proxy_authenticated',
    ]);
    assert.match(parameters.p_instance_key, /^[0-9a-f]{64}$/);
    assert.match(parameters.p_player_key, /^[0-9a-f]{64}$/);
    assert.match(parameters.p_challenge_key, /^[0-9a-f]{64}$/);
    assert.equal(parameters.p_participant_count, 2);
  }
  assert.notEqual(rpcCalls[0].parameters.p_player_key, rpcCalls[1].parameters.p_player_key);
  assert.doesNotMatch(JSON.stringify({ rpcCalls, firstReport, secondReport }), /user-42|user-84|i-live-test/);
});

test('bridge polls a privacy-safe live certificate and rejects preview certification', async () => {
  const calls = [];
  const reports = [
    { status: 'waiting', authenticatedClientCount: 1 },
    { status: 'passed', authenticatedClientCount: 2 },
  ];
  const bridge = new DiscordActivityBridge({
    randomUUID: () => '01234567-89ab-cdef-0123-456789abcdef',
    fetchImpl: async (_url, init) => {
      calls.push(JSON.parse(init.body));
      return Response.json({
        schema: LIVE_CERTIFICATION_SCHEMA,
        requiredAuthenticatedClients: 2,
        participantCount: 2,
        ...reports.shift(),
      });
    },
  });
  bridge.mode = 'ready';
  bridge.discord = { instanceId: 'i-live-test' };
  const progress = [];
  const report = await bridge.certifyLiveSession({
    timeoutMs: 100,
    pollIntervalMs: 0,
    onProgress: (value) => progress.push(value.status),
  });

  assert.equal(report.status, 'passed');
  assert.deepEqual(progress, ['waiting', 'passed']);
  assert.equal(calls.length, 2);
  assert.equal(calls.every((call) => call.action === 'certify-live' && call.instanceId === 'i-live-test'), true);
  assert.equal(calls[0].challenge, '01234567-89ab-cdef-0123-456789abcdef');
  assert.equal(calls.every((call) => !('accessToken' in call)), true);

  const preview = new DiscordActivityBridge({
    previewMode: true,
    locationObject: { hostname: 'localhost', search: '?ue5_discord_preview=1' },
  });
  await preview.start();
  await assert.rejects(
    preview.checkInLiveCertification('preview_challenge_1234'),
    /real, connected Discord Activity/,
  );
  await preview.dispose();
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
  const socialCommands = [];
  const displayCommands = [];
  const subscriptions = new Map();
  const unsubscribed = [];
  const inboundEvents = [];
  const config = {
    enabled: true,
    discordClientId: '123',
    supabaseUrl: 'https://project.supabase.co',
    supabasePublishableKey: 'sb_publishable_public',
    supabaseProxyPrefix: '/supabase',
    supabaseProxyTarget: 'project.supabase.co',
    oauthScopes: ['identify', 'rpc.activities.write'],
    richPresenceEnabled: true,
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
    presenceState() { return { 'connection-a': [{ connected: true }] }; },
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
    constructor(clientId) {
      assert.equal(clientId, '123');
      this.instanceId = 'i-test';
      this.customId = 'campaign-summer';
      this.referrerId = '99';
    }
    async ready() {}
    commands = {
      authorize: async (args) => { assert.deepEqual(args.scope, ['identify', 'rpc.activities.write']); return { code: 'discord-code' }; },
      authenticate: async ({ access_token }) => { assert.equal(access_token, 'discord-access-token'); return { user: { id: '42', username: 'player', global_name: 'Player' } }; },
      getInstanceConnectedParticipants: async () => ({ participants: [{ id: '42' }] }),
      openInviteDialog: async () => ({ opened: true }),
      encourageHardwareAcceleration: async () => ({ enabled: true }),
      getSkus: async () => ({ skus: [{ id: 'sku-premium' }] }),
      getEntitlements: async () => ({ entitlements: [{ sku_id: 'client-only' }] }),
      startPurchase: async ({ sku_id }) => ({ sku_id, opened: true }),
      setActivity: async (args) => { socialCommands.push({ setActivity: args }); return args.activity; },
      shareLink: async (args) => { socialCommands.push({ shareLink: args }); return { success: true, didCopyLink: false, didSendMessage: true }; },
      openExternalLink: async (args) => { socialCommands.push({ openExternalLink: args }); return { opened: true }; },
      setOrientationLockState: async (args) => { displayCommands.push({ orientation: args }); return args; },
      setConfig: async (args) => { displayCommands.push({ config: args }); return args; },
      getPlatformBehaviors: async () => ({ iosKeyboardResizesView: true }),
      userSettingsGetLocale: async () => ({ locale: 'en-US' }),
    };
    subscribe(event, handler) { subscriptions.set(event, handler); }
    unsubscribe(event, handler) { unsubscribed.push([event, handler]); }
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
  for (const type of ['broadcast', 'presence', 'participants', 'entitlements']) {
    bridge.addEventListener(type, ({ detail }) => inboundEvents.push([type, detail]));
  }

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
  assert.deepEqual(bridge.getPresenceState(), { 'connection-a': [{ connected: true }] });
  channel.handlers.find(({ type }) => type === 'broadcast').callback({
    type: 'broadcast', event: 'movement', payload: { x: 2 },
  });
  channel.handlers.find(({ type }) => type === 'presence').callback();
  subscriptions.get(Events.ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE)({
    participants: [{ id: '42', username: 'player' }],
  });
  assert.deepEqual(await bridge.getParticipants(), { participants: [{ id: '42' }] });
  assert.deepEqual(await bridge.openInviteDialog(), { opened: true });
  assert.deepEqual(await bridge.encourageHardwareAcceleration(), { enabled: true });
  assert.equal((await bridge.setOrientationLock(3, 2)).supported, true);
  assert.equal((await bridge.setInteractivePip(true)).supported, true);
  assert.deepEqual(await bridge.getPlatformBehaviors(), {
    supported: true, behaviors: { iosKeyboardResizesView: true },
  });
  assert.deepEqual(await bridge.getLocale(), { supported: true, locale: 'en-US' });
  assert.deepEqual(await bridge.getSkus(), { skus: [{ id: 'sku-premium' }] });
  assert.deepEqual(await bridge.getClientEntitlements(), { entitlements: [{ sku_id: 'client-only' }] });
  assert.deepEqual(await bridge.startPurchase('sku-premium'), {
    purchase: { sku_id: 'sku-premium', opened: true },
    entitlements: [{ skuId: 'sku-premium', consumed: false }],
  });
  assert.equal((await bridge.setRichPresence({
    details: 'Round 2', state: 'In match', currentPartySize: 2, maximumPartySize: 4,
    largeImage: 'arena', largeText: 'Arena',
  })).supported, true);
  assert.equal((await bridge.clearRichPresence()).supported, true);
  assert.equal((await bridge.shareLink('Join my match', 'campaign-summer')).success, true);
  assert.equal((await bridge.openExternalLink('https://example.com/help')).opened, true);
  assert.deepEqual(bridge.getLaunchContext(), {
    customId: 'campaign-summer', hasReferrer: true,
  });
  assert.deepEqual(displayCommands, [
    { orientation: { lock_state: 3, picture_in_picture_lock_state: 2 } },
    { config: { use_interactive_pip: true } },
  ]);
  const displayEvents = [];
  for (const type of ['thermalstate', 'orientation', 'layoutmode']) {
    bridge.addEventListener(type, ({ detail }) => displayEvents.push([type, detail]));
  }
  subscriptions.get(Events.THERMAL_STATE_UPDATE)({ thermal_state: 2 });
  subscriptions.get(Events.ORIENTATION_UPDATE)({ screen_orientation: 1, orientation: 'landscape' });
  subscriptions.get(Events.ACTIVITY_LAYOUT_MODE_UPDATE)({ layout_mode: 1 });
  assert.deepEqual(displayEvents, [
    ['thermalstate', { thermalState: 2, thermalStateName: 'Serious' }],
    ['orientation', { orientation: 1, orientationName: 'Landscape' }],
    ['layoutmode', { layoutMode: 1, layoutModeName: 'PictureInPicture' }],
  ]);
  assert.deepEqual(inboundEvents, [
    ['broadcast', { type: 'broadcast', event: 'movement', payload: { x: 2 } }],
    ['presence', { 'connection-a': [{ connected: true }] }],
    ['participants', { participants: [{ id: '42', username: 'player' }] }],
    ['entitlements', [{ skuId: 'sku-premium', consumed: false }]],
  ]);
  assert.deepEqual(socialCommands[0].setActivity.activity.party, { id: 'i-test', size: [2, 4] });
  assert.equal(socialCommands[1].setActivity.activity, null);
  assert.deepEqual(socialCommands[2].shareLink, { message: 'Join my match', custom_id: 'campaign-summer' });
  assert.deepEqual(socialCommands[3].openExternalLink, { url: 'https://example.com/help' });
  await assert.rejects(() => bridge.openExternalLink('javascript:alert(1)'), /must use HTTPS/);
  await bridge.dispose();
  assert.equal(unsubscribed.length, 5);
});

test('new social commands fail soft on older Discord clients', async () => {
  const bridge = new DiscordActivityBridge();
  bridge.discord = {
    commands: {
      shareLink: async () => { throw Object.assign(new Error('old client'), { code: 4002 }); },
    },
  };
  bridge.config = { richPresenceEnabled: true };
  const warnings = [];
  bridge.addEventListener('warning', ({ detail }) => warnings.push(detail.command));

  assert.deepEqual(await bridge.shareLink('Join me'), {
    success: false, didCopyLink: false, didSendMessage: false, supported: false,
  });
  assert.deepEqual(await bridge.clearRichPresence(), { supported: false });
  assert.deepEqual(await bridge.setOrientationLock(1), { supported: false });
  assert.deepEqual(await bridge.setInteractivePip(true), { supported: false });
  assert.deepEqual(await bridge.getPlatformBehaviors(), { supported: false });
  assert.deepEqual(await bridge.getLocale(), { supported: false });
  assert.deepEqual(warnings, [
    'shareLink', 'setActivity', 'setOrientationLockState', 'setConfig',
    'getPlatformBehaviors', 'userSettingsGetLocale',
  ]);
});
