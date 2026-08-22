import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import {
  REQUIRED_EXPORT_FILES,
  REQUIRED_EXPORT_PATTERNS,
  validateActivityEnvironment,
  validateActivityExport,
  verifyActivityServices,
} from '../web/public/scripts/activity-preflight.mjs';

function validEnvironment() {
  return {
    DISCORD_CLIENT_ID: '123456789012345678',
    DISCORD_CLIENT_SECRET: 'discord-client-secret-value',
    DISCORD_BOT_TOKEN: 'discord-bot-token-value-long',
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_public-value',
    SUPABASE_SECRET_KEY: 'sb_secret_server-value',
    SUPABASE_JWT_PRIVATE_KEY: JSON.stringify({
      kty: 'EC', crv: 'P-256', kid: 'activity-key', x: 'x-value', y: 'y-value', d: 'd-value',
    }),
    SUPABASE_JWT_KEY_ID: 'activity-key',
    ACTIVITY_STATE_SECRET: '0123456789abcdef0123456789abcdef',
  };
}

function exportFixture() {
  const root = mkdtempSync(join(tmpdir(), 'ue5-activity-preflight-'));
  for (const path of REQUIRED_EXPORT_FILES) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, path.endsWith('.json') ? '{}' : 'fixture');
  }
  for (const [index, required] of REQUIRED_EXPORT_PATTERNS.entries()) {
    const filename = required.label
      .replace('<hash>', `fixture${index}`)
      .replace('runtime/', '');
    const target = join(root, required.directory, filename);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, 'fixture');
  }
  return root;
}

test('Activity preflight accepts a complete private configuration', () => {
  assert.deepEqual(validateActivityEnvironment(validEnvironment()).errors, []);
});

test('Activity preflight rejects placeholders, weak secrets, and mismatched signing keys', () => {
  const env = validEnvironment();
  env.DISCORD_BOT_TOKEN = 'Bot short';
  env.SUPABASE_PUBLISHABLE_KEY = 'sb_secret_wrong-role';
  env.ACTIVITY_STATE_SECRET = 'short';
  env.SUPABASE_JWT_KEY_ID = 'different-key';
  const { errors } = validateActivityEnvironment(env);
  assert.ok(errors.some((error) => error.includes('raw token')));
  assert.ok(errors.some((error) => error.includes('publishable key')));
  assert.ok(errors.some((error) => error.includes('at least 32 bytes')));
  assert.ok(errors.some((error) => error.includes('does not match')));
});

test('Activity package preflight checks artifacts and detects a browser-bundled secret', () => {
  const root = exportFixture();
  try {
    const env = validEnvironment();
    assert.deepEqual(validateActivityExport({ directory: root, env, packageOnly: true }).errors, []);
    writeFileSync(join(root, 'runtime/viewer-fixture0.js'), `const leaked = ${JSON.stringify(env.DISCORD_CLIENT_SECRET)};`);
    const result = validateActivityExport({ directory: root, env, packageOnly: true });
    assert.ok(result.errors.some((error) => error.includes('DISCORD_CLIENT_SECRET appears in browser-visible file')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('online preflight matches Discord app, Supabase signing key, migration, and private-table boundary', async () => {
  const env = validEnvironment();
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const value = String(url);
    const headers = new Headers(init.headers);
    calls.push({ value, headers });
    if (value.endsWith('/applications/@me')) {
      return Response.json({
        id: env.DISCORD_CLIENT_ID,
        flags_new: String(1 << 17),
        privacy_policy_url: 'https://game.test/privacy',
        terms_of_service_url: 'https://game.test/terms',
      });
    }
    if (value.endsWith('/auth/v1/.well-known/jwks.json')) {
      return Response.json({ keys: [{ kid: 'activity-key', kty: 'EC', crv: 'P-256', x: 'x-value', y: 'y-value' }] });
    }
    if (value.endsWith('/rest/v1/')) return Response.json({});
    if (value.includes('/discord_activity_world_state')) {
      return headers.get('apikey') === env.SUPABASE_PUBLISHABLE_KEY
        ? Response.json({ message: 'permission denied' }, { status: 403 })
        : Response.json([]);
    }
    throw new Error(`Unexpected online preflight request: ${value}`);
  };

  const result = await verifyActivityServices(env, { fetchImpl });
  assert.deepEqual(result.errors, []);
  assert.equal(result.checks.length, 6);
  assert.equal(calls.find((call) => call.value.endsWith('/applications/@me')).headers.get('authorization'), `Bot ${env.DISCORD_BOT_TOKEN}`);
  for (const call of calls.filter((entry) => entry.value.includes('supabase.co/rest/'))) {
    assert.equal(call.headers.has('authorization'), false);
  }
});

test('online preflight rejects mismatched service identities and browser-readable game state', async () => {
  const env = validEnvironment();
  const fetchImpl = async (url) => {
    const value = String(url);
    if (value.endsWith('/applications/@me')) return Response.json({ id: '999999999999999999', flags_new: '0' });
    if (value.endsWith('/auth/v1/.well-known/jwks.json')) {
      return Response.json({ keys: [{ kid: 'activity-key', kty: 'EC', crv: 'P-256', x: 'wrong', y: 'wrong' }] });
    }
    if (value.endsWith('/rest/v1/')) return Response.json({});
    if (value.includes('/discord_activity_world_state')) return Response.json([]);
    throw new Error(`Unexpected online preflight request: ${value}`);
  };
  const result = await verifyActivityServices(env, { fetchImpl });
  assert.ok(result.errors.some((error) => error.includes('different Discord application')));
  assert.ok(result.errors.some((error) => error.includes('not marked as an embedded Activity')));
  assert.ok(result.errors.some((error) => error.includes('does not match this project')));
  assert.ok(result.errors.some((error) => error.includes('can read the private world-state table')));
});
