import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import {
  PUBLIC_ENVIRONMENT,
  SENSITIVE_ENVIRONMENT,
  buildActivityReleasePlan,
  executeActivityRelease,
  loadReleaseEnvironment,
  parseActivityReleaseArgs,
  runCommand,
  validateReleaseSelection,
} from '../web/public/scripts/activity-release.mjs';
import {
  REQUIRED_EXPORT_FILES,
  REQUIRED_EXPORT_PATTERNS,
} from '../web/public/scripts/activity-preflight.mjs';

function validEnvironment() {
  return {
    DISCORD_CLIENT_ID: '123456789012345678',
    DISCORD_CLIENT_SECRET: 'discord-client-secret-value',
    DISCORD_BOT_TOKEN: 'discord-bot-token-value-long',
    SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_public-value',
    SUPABASE_SECRET_KEY: 'sb_secret_server-value',
    SUPABASE_JWT_PRIVATE_KEY: JSON.stringify({
      kty: 'EC', crv: 'P-256', kid: 'activity-key', x: 'x-value', y: 'y-value', d: 'd-value',
    }),
    SUPABASE_JWT_KEY_ID: 'activity-key',
    ACTIVITY_STATE_SECRET: '0123456789abcdef0123456789abcdef',
    DISCORD_ENABLE_RICH_PRESENCE: 'true',
    DISCORD_REQUIRE_PROXY_AUTH: 'false',
  };
}

function exportFixture() {
  const root = mkdtempSync(join(tmpdir(), 'ue5-activity-release-'));
  for (const path of REQUIRED_EXPORT_FILES) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, path.endsWith('.json') ? '{}' : 'fixture');
  }
  for (const [index, required] of REQUIRED_EXPORT_PATTERNS.entries()) {
    const filename = required.label.replace('<hash>', `fixture${index}`).replace('runtime/', '');
    const target = join(root, required.directory, filename);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, 'fixture');
  }
  return root;
}

test('release workflow parses a Windows-safe explicit project plan', () => {
  const options = parseActivityReleaseArgs([
    '--directory', 'C:\\Exports\\My Game',
    '--env-file', 'C:\\Secrets\\activity.env',
    '--supabase-project-ref', 'abcdefghijklmnopqrst',
    '--vercel-project', 'my-discord-game',
    '--environment', 'production',
    '--apply',
  ]);
  assert.equal(options.supabaseProjectRef, 'abcdefghijklmnopqrst');
  assert.equal(options.vercelProject, 'my-discord-game');
  assert.equal(options.environment, 'production');
  assert.equal(options.apply, true);
});

test('release workflow refuses cross-project Supabase and Vercel configuration', () => {
  const options = {
    directory: '/export',
    supabaseProjectRef: 'abcdefghijklmnopqrst',
    vercelProject: 'expected-game',
    environment: 'preview',
  };
  const env = { ...validEnvironment(), SUPABASE_URL: 'https://zyxwvutsrqponmlkjihg.supabase.co' };
  const result = validateReleaseSelection(options, env, { projectName: 'different-game' });
  assert.ok(result.errors.some((error) => error.includes('not expected-game')));
  assert.ok(result.errors.some((error) => error.includes('not selected project')));
});

test('dry-run plan names secret inputs without containing their values', () => {
  const root = exportFixture();
  const options = {
    apply: false,
    deploy: true,
    migrate: true,
    directory: root,
    environment: 'preview',
    supabaseProjectRef: 'abcdefghijklmnopqrst',
    vercelProject: 'my-discord-game',
  };
  const env = validEnvironment();
  const serialized = JSON.stringify(buildActivityReleasePlan(options, env, null));
  for (const name of [...PUBLIC_ENVIRONMENT, ...SENSITIVE_ENVIRONMENT]) {
    if (env[name]) assert.match(serialized, new RegExp(name));
  }
  for (const name of SENSITIVE_ENVIRONMENT) assert.doesNotMatch(serialized, new RegExp(env[name]));
});

test('state secret can be generated in memory without writing an env file', () => {
  const options = { generateStateSecret: true };
  const env = loadReleaseEnvironment(options, {}, () => Buffer.alloc(32, 7));
  assert.equal(Buffer.from(env.ACTIVITY_STATE_SECRET, 'base64url').length, 32);
  assert.equal(env.DISCORD_REQUIRE_PROXY_AUTH, 'false');
});

test('apply sends secrets only through stdin and stages preview deployment', async () => {
  const root = exportFixture();
  const options = {
    apply: true,
    deploy: true,
    migrate: true,
    directory: root,
    environment: 'preview',
    supabaseProjectRef: 'abcdefghijklmnopqrst',
    vercelProject: 'my-discord-game',
  };
  const env = validEnvironment();
  const calls = [];
  const runner = (command, args, invocation) => {
    calls.push({ command, args, input: invocation.input });
    const stdout = command === 'vercel' && args[0] === 'deploy'
      ? 'https://my-discord-game-preview.vercel.app\n'
      : '';
    return { status: 0, stdout, stderr: '' };
  };
  const result = await executeActivityRelease(options, env, {
    runner,
    verifyServices: async () => ({ errors: [], warnings: [], checks: ['services verified'] }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.deploymentUrl, 'https://my-discord-game-preview.vercel.app');
  assert.deepEqual(result.discordUrlMappings, {
    '/': 'my-discord-game-preview.vercel.app',
    '/supabase': 'abcdefghijklmnopqrst.supabase.co',
  });
  assert.ok(calls.some((call) => call.command === 'supabase' && call.args.includes('--dry-run')));
  assert.ok(calls.some((call) => call.command === 'supabase' && call.args.includes('--linked') && !call.args.includes('--dry-run')));
  assert.ok(calls.some((call) => call.command === 'vercel' && call.args[0] === 'deploy'));
  const serializedArgs = JSON.stringify(calls.map(({ command, args }) => ({ command, args })));
  for (const name of SENSITIVE_ENVIRONMENT) assert.doesNotMatch(serializedArgs, new RegExp(env[name]));
  for (const name of SENSITIVE_ENVIRONMENT) {
    const upload = calls.find((call) => call.args.includes(name));
    assert.equal(upload.input, `${env[name]}\n`);
    assert.ok(upload.args.includes('--sensitive'));
  }
});

test('failed service identity preflight stops before Vercel environment writes', async () => {
  const root = exportFixture();
  const options = {
    apply: true,
    deploy: true,
    migrate: true,
    directory: root,
    environment: 'preview',
    supabaseProjectRef: 'abcdefghijklmnopqrst',
    vercelProject: 'my-discord-game',
  };
  const calls = [];
  const result = await executeActivityRelease(options, validEnvironment(), {
    runner: (command, args) => {
      calls.push({ command, args });
      return { status: 0, stdout: '', stderr: '' };
    },
    verifyServices: async () => ({ errors: ['Discord application mismatch'], warnings: [], checks: [] }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.applied, true);
  assert.equal(calls.some((call) => call.command === 'vercel' && call.args[0] === 'env'), false);
  assert.equal(calls.some((call) => call.command === 'vercel' && call.args[0] === 'deploy'), false);
});

test('subprocess failures redact server secrets from diagnostics', () => {
  const env = validEnvironment();
  assert.throws(
    () => runCommand('vercel', ['env', 'add', 'DISCORD_CLIENT_SECRET'], {
      cwd: '/export',
      environment: env,
      input: `${env.DISCORD_CLIENT_SECRET}\n`,
      runner: () => ({
        status: 1,
        stdout: '',
        stderr: `invalid value ${env.DISCORD_CLIENT_SECRET}`,
      }),
    }),
    (error) => {
      assert.doesNotMatch(error.message, new RegExp(env.DISCORD_CLIENT_SECRET));
      assert.match(error.message, /<redacted:DISCORD_CLIENT_SECRET>/);
      return true;
    },
  );
});
