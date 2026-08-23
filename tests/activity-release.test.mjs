import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import {
  RELEASE_TOOL_PACKAGES,
  parseReleaseAssistantArgs,
  runReleaseAssistant,
} from '../web/public/scripts/activity-release-assistant.mjs';
import {
  PUBLIC_ENVIRONMENT,
  SENSITIVE_ENVIRONMENT,
  buildActivityReleasePlan,
  completeVercelOnlySecrets,
  discoverSupabaseApiKeys,
  executeActivityRelease,
  hydrateUnrealPublicEnvironment,
  loadReleaseEnvironment,
  parseActivityReleaseArgs,
  readActivityHandoffTargets,
  runCommand,
  validateReleaseSelection,
  verifyPublicDeployment,
} from '../web/public/scripts/activity-release.mjs';
import {
  REQUIRED_EXPORT_FILES,
  REQUIRED_EXPORT_PATTERNS,
} from '../web/public/scripts/activity-preflight.mjs';

test('release assistant keeps the underlying workflow arguments Windows-safe', () => {
  const options = parseReleaseAssistantArgs([
    '--env-file', 'C:\\Private Config\\activity.env',
    '--environment', 'preview',
    '--apply',
  ]);
  assert.equal(options.envFile, 'C:\\Private Config\\activity.env');
  assert.equal(options.explicitEnvFile, true);
  assert.deepEqual(options.forwarded, ['--environment', 'preview', '--apply']);
});

test('release assistant needs no environment file for the guided workflow', () => {
  const root = mkdtempSync(join(tmpdir(), 'ue5-activity-assistant-'));
  const calls = [];
  const status = runReleaseAssistant([], {
    directory: root,
    nodeVersion: '22.12.0',
    runner(command, args) { calls.push({ command, args }); return { status: 0 }; },
    stdout() {},
  });
  assert.equal(status, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].args.includes('--env-file'), false);
  assert.ok(calls[1].args.includes('--vercel-only-secrets'));
  assert.ok(calls[1].args.includes('--supabase-cli-keys'));
});

test('release assistant rejects an explicitly requested missing environment file', () => {
  const root = mkdtempSync(join(tmpdir(), 'ue5-activity-assistant-'));
  const errors = [];
  const status = runReleaseAssistant(['--env-file', 'missing.env'], {
    directory: root,
    nodeVersion: '22.12.0',
    stderr(message) { errors.push(message); },
  });
  assert.equal(status, 1);
  assert.ok(errors.some((message) => message.includes('was not found')));
});

test('release assistant installs pinned local tools and preserves dry-run by default', () => {
  const root = mkdtempSync(join(tmpdir(), 'ue5-activity-assistant-'));
  writeFileSync(join(root, '.env.activity.local'), 'DISCORD_CLIENT_ID=123\n');
  const calls = [];
  const status = runReleaseAssistant([], {
    directory: root,
    nodeVersion: '22.12.0',
    platform: 'win32',
    runner(command, args, invocation) {
      calls.push({ command, args, cwd: invocation.cwd });
      return { status: 0 };
    },
    stdout() {},
  });
  assert.equal(status, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, 'npm.cmd');
  assert.deepEqual(calls[0].args.slice(-RELEASE_TOOL_PACKAGES.length), RELEASE_TOOL_PACKAGES);
  assert.deepEqual(calls[1].args.slice(0, 5), [
    'run', 'release:activity', '--', '--env-file', join(root, '.env.activity.local'),
  ]);
  assert.ok(calls[1].args.includes('--vercel-only-secrets'));
  assert.ok(calls[1].args.includes('--supabase-cli-keys'));
  assert.equal(calls[1].args.includes('--apply'), false);
  assert.ok(calls.every((call) => call.cwd === root));
});

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
  const compatibility = {
    status: 'compatible', blueprintCount: 1, nodeCount: 2, supportedNodeCount: 2, unsupportedNodeCount: 0,
  };
  writeFileSync(join(root, 'export-manifest.json'), JSON.stringify({
    schema: 'ue5-html5-export/v2', blueprintCompatibility: compatibility,
  }));
  writeFileSync(join(root, 'activity-handoff.json'), JSON.stringify({
    schema: 'ue5-discord-activity-handoff/v4',
    handoffStatus: 'unreal-export-complete',
    blueprintCompatibility: compatibility,
    projectTargets: {
      source: 'Unreal Project Settings > Plugins > UE5 HTML5 Discord Activity',
      containsSecrets: false,
      configured: true,
      discordApplicationId: '123456789012345678',
      discordPublicKey: 'a'.repeat(64),
      vercelProjectName: 'my-discord-game',
      supabaseProjectRef: 'abcdefghijklmnopqrst',
      productionUrl: '',
      missingRequiredTargets: [],
    },
  }));
  writeFileSync(join(root, 'logic/blueprints.json'), JSON.stringify({
    schema: 'ue-blueprint-ir/v1', programs: [{ graphs: [{ nodes: [{}, {}] }], compatibility: { unsupportedCount: 0 } }],
  }));
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
    '--vercel-only-secrets',
    '--supabase-cli-keys',
    '--apply',
  ]);
  assert.equal(options.supabaseProjectRef, 'abcdefghijklmnopqrst');
  assert.equal(options.vercelProject, 'my-discord-game');
  assert.equal(options.environment, 'production');
  assert.equal(options.vercelOnlySecrets, true);
  assert.equal(options.supabaseCliKeys, true);
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

test('release workflow defaults to Unreal project targets without copying secrets', () => {
  const root = exportFixture();
  const targets = {
    source: 'Unreal Project Settings > Plugins > UE5 HTML5 Discord Activity',
    containsSecrets: false,
    configured: true,
    discordApplicationId: '123456789012345678',
    discordPublicKey: 'a'.repeat(64),
    vercelProjectName: 'my-discord-game',
    supabaseProjectRef: 'abcdefghijklmnopqrst',
    productionUrl: 'https://game.example',
    missingRequiredTargets: [],
  };
  const handoff = JSON.parse(readFileSync(join(root, 'activity-handoff.json'), 'utf8'));
  writeFileSync(join(root, 'activity-handoff.json'), JSON.stringify({ ...handoff, projectTargets: targets }));

  assert.deepEqual(readActivityHandoffTargets(root), {
    discordApplicationId: targets.discordApplicationId,
    discordPublicKey: targets.discordPublicKey,
    vercelProjectName: targets.vercelProjectName,
    supabaseProjectRef: targets.supabaseProjectRef,
    productionUrl: targets.productionUrl,
  });
  const result = validateReleaseSelection(
    { directory: root, environment: 'preview' },
    { ...validEnvironment(), DISCORD_PUBLIC_KEY: 'a'.repeat(64) },
    null,
  );
  assert.deepEqual(result.errors, []);
  assert.equal(result.selectedVercelProject, targets.vercelProjectName);
  assert.equal(result.selectedSupabaseProjectRef, targets.supabaseProjectRef);
});

test('v5 handoff refuses release when Unreal public targets are incomplete', async () => {
  const root = exportFixture();
  const handoffPath = join(root, 'activity-handoff.json');
  const handoff = JSON.parse(readFileSync(handoffPath, 'utf8'));
  handoff.schema = 'ue5-discord-activity-handoff/v5';
  handoff.projectTargets.configured = false;
  handoff.projectTargets.discordPublicKey = '';
  handoff.projectTargets.missingRequiredTargets = ['Discord Public Key'];
  writeFileSync(handoffPath, JSON.stringify(handoff));
  const result = await executeActivityRelease({
    apply: false,
    deploy: false,
    migrate: false,
    directory: root,
    environment: 'preview',
    supabaseProjectRef: 'abcdefghijklmnopqrst',
    vercelProject: 'my-discord-game',
  }, { ...validEnvironment(), DISCORD_PUBLIC_KEY: 'a'.repeat(64) });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('Unreal project targets are incomplete (Discord Public Key)')));
});

test('release workflow hydrates public service identity directly from Unreal handoff', () => {
  const root = exportFixture();
  const handoff = JSON.parse(readFileSync(join(root, 'activity-handoff.json'), 'utf8'));
  handoff.projectTargets = {
    ...handoff.projectTargets,
    configured: true,
    discordApplicationId: '123456789012345678',
    discordPublicKey: 'a'.repeat(64),
    vercelProjectName: 'my-discord-game',
    supabaseProjectRef: 'abcdefghijklmnopqrst',
    missingRequiredTargets: [],
  };
  writeFileSync(join(root, 'activity-handoff.json'), JSON.stringify(handoff));
  const hydrated = hydrateUnrealPublicEnvironment({ directory: root }, {});
  assert.equal(hydrated.DISCORD_CLIENT_ID, handoff.projectTargets.discordApplicationId);
  assert.equal(hydrated.DISCORD_PUBLIC_KEY, handoff.projectTargets.discordPublicKey);
  assert.equal(hydrated.SUPABASE_URL, 'https://abcdefghijklmnopqrst.supabase.co');
});

test('release workflow rejects arguments and Discord environment that drift from Unreal targets', () => {
  const handoffTargets = {
    discordApplicationId: '123456789012345678',
    discordPublicKey: 'a'.repeat(64),
    vercelProjectName: 'expected-game',
    supabaseProjectRef: 'abcdefghijklmnopqrst',
    missingRequiredTargets: [],
  };
  const result = validateReleaseSelection({
    directory: '/export',
    environment: 'preview',
    supabaseProjectRef: 'zyxwvutsrqponmlkjihg',
    vercelProject: 'different-game',
  }, {
    ...validEnvironment(),
    DISCORD_CLIENT_ID: '987654321098765432',
    DISCORD_PUBLIC_KEY: 'b'.repeat(64),
  }, null, handoffTargets);
  assert.ok(result.errors.some((error) => error.includes('not Unreal project target abcdefghijklmnopqrst')));
  assert.ok(result.errors.some((error) => error.includes('not Unreal project target expected-game')));
  assert.ok(result.errors.some((error) => error.includes('DISCORD_CLIENT_ID does not match')));
  assert.ok(result.errors.some((error) => error.includes('DISCORD_PUBLIC_KEY does not match')));
});

test('release workflow requires a configured Discord public key in the release environment', () => {
  const result = validateReleaseSelection({
    directory: '/export', environment: 'preview',
  }, validEnvironment(), null, {
    discordPublicKey: 'a'.repeat(64),
    vercelProjectName: 'expected-game',
    supabaseProjectRef: 'abcdefghijklmnopqrst',
  });
  assert.ok(result.errors.some((error) => error.includes('DISCORD_PUBLIC_KEY is missing')));
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

test('Supabase CLI API-key discovery stays in memory and selects modern default keys', () => {
  const root = exportFixture();
  const calls = [];
  const environment = {
    ...validEnvironment(),
    SUPABASE_PUBLISHABLE_KEY: '',
    SUPABASE_SECRET_KEY: '',
  };
  const discovered = discoverSupabaseApiKeys({
    apply: true,
    supabaseCliKeys: true,
    directory: root,
    supabaseProjectRef: 'abcdefghijklmnopqrst',
  }, environment, {
    runner(command, args) {
      calls.push({ command, args });
      return {
        status: 0,
        stdout: JSON.stringify([
          { type: 'legacy', name: 'anon', api_key: 'legacy-value' },
          { type: 'publishable', name: 'default', api_key: 'sb_publishable_discovered-value' },
          { type: 'secret', name: 'default', api_key: 'sb_secret_discovered-value' },
        ]),
        stderr: '',
      };
    },
  });
  assert.equal(environment.SUPABASE_PUBLISHABLE_KEY, '');
  assert.equal(discovered.SUPABASE_PUBLISHABLE_KEY, 'sb_publishable_discovered-value');
  assert.equal(discovered.SUPABASE_SECRET_KEY, 'sb_secret_discovered-value');
  assert.deepEqual(calls[0], {
    command: 'supabase',
    args: ['projects', 'api-keys', '--project-ref', 'abcdefghijklmnopqrst', '--reveal', '--output', 'json'],
  });
  assert.doesNotMatch(JSON.stringify(calls), /sb_(?:publishable|secret)_discovered/);
});

test('Vercel-only mode prompts for missing server secrets and never mutates the file environment', async () => {
  const options = { apply: true, vercelOnlySecrets: true };
  const original = {
    ...validEnvironment(),
    DISCORD_CLIENT_SECRET: '',
    DISCORD_BOT_TOKEN: '',
    SUPABASE_SECRET_KEY: 'sb_secret_REPLACE_ME',
    SUPABASE_JWT_PRIVATE_KEY: '{"kid":"REPLACE_ME"}',
    SUPABASE_JWT_KEY_ID: 'REPLACE_ME',
    ACTIVITY_STATE_SECRET: '',
  };
  const answers = {
    DISCORD_CLIENT_SECRET: 'prompted-discord-client-secret',
    DISCORD_BOT_TOKEN: 'prompted-discord-bot-token-value',
    SUPABASE_SECRET_KEY: 'sb_secret_prompted-value',
    SUPABASE_JWT_PRIVATE_KEY: JSON.stringify({
      kty: 'EC', crv: 'P-256', kid: 'prompted-key', x: 'x', y: 'y', d: 'd',
    }),
  };
  const labels = [];
  const completed = await completeVercelOnlySecrets(options, original, {
    prompt: async (label) => {
      labels.push(label);
      const name = Object.keys(answers).find((candidate) => label.includes(candidate));
      return answers[name];
    },
    random: () => Buffer.alloc(32, 9),
  });

  assert.equal(original.DISCORD_CLIENT_SECRET, '');
  assert.equal(original.SUPABASE_JWT_KEY_ID, 'REPLACE_ME');
  assert.equal(completed.DISCORD_CLIENT_SECRET, answers.DISCORD_CLIENT_SECRET);
  assert.equal(completed.SUPABASE_JWT_KEY_ID, 'prompted-key');
  assert.equal(Buffer.from(completed.ACTIVITY_STATE_SECRET, 'base64url').length, 32);
  assert.equal(labels.length, 4);
});

test('Vercel-only dry-run plans hidden prompts without requiring local secrets', async () => {
  const root = exportFixture();
  const environment = validEnvironment();
  for (const name of SENSITIVE_ENVIRONMENT) environment[name] = '';
  environment.SUPABASE_JWT_KEY_ID = '';
  const options = {
    apply: false,
    deploy: true,
    migrate: true,
    vercelOnlySecrets: true,
    directory: root,
    environment: 'preview',
    supabaseProjectRef: 'abcdefghijklmnopqrst',
    vercelProject: 'my-discord-game',
  };
  const result = await executeActivityRelease(options, environment);
  assert.equal(result.ok, true);
  assert.equal(result.applied, false);
  assert.ok(result.warnings.some((warning) => warning.includes('hidden input')));
  const sources = Object.fromEntries(result.plan.vercelEnvironment.map((entry) => [entry.name, entry.source]));
  assert.equal(sources.DISCORD_CLIENT_SECRET, 'hidden-prompt-at-apply');
  assert.equal(sources.ACTIVITY_STATE_SECRET, 'generated-at-apply');
});

test('guided dry-run needs no environment file when Unreal targets are configured', async () => {
  const root = exportFixture();
  const handoff = JSON.parse(readFileSync(join(root, 'activity-handoff.json'), 'utf8'));
  handoff.projectTargets = {
    ...handoff.projectTargets,
    configured: true,
    discordApplicationId: '123456789012345678',
    discordPublicKey: 'a'.repeat(64),
    vercelProjectName: 'my-discord-game',
    supabaseProjectRef: 'abcdefghijklmnopqrst',
    missingRequiredTargets: [],
  };
  writeFileSync(join(root, 'activity-handoff.json'), JSON.stringify(handoff));
  const options = {
    apply: false,
    deploy: true,
    migrate: true,
    vercelOnlySecrets: true,
    supabaseCliKeys: true,
    directory: root,
    environment: 'preview',
  };
  const result = await executeActivityRelease(options, loadReleaseEnvironment({}, {}));
  assert.equal(result.ok, true);
  assert.equal(result.plan.discordApplicationId, handoff.projectTargets.discordApplicationId);
  assert.equal(result.plan.vercelProject, handoff.projectTargets.vercelProjectName);
  assert.ok(result.plan.discordPortalChecklist.some((item) => item.includes('Guild Install and User Install')));
  assert.ok(result.plan.discordPortalChecklist.some((item) => item.includes('/supabase')));
  const sources = Object.fromEntries(result.plan.vercelEnvironment.map((entry) => [entry.name, entry.source]));
  assert.equal(sources.SUPABASE_PUBLISHABLE_KEY, 'supabase-cli-at-apply');
  assert.equal(sources.SUPABASE_SECRET_KEY, 'supabase-cli-at-apply');
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
    verifyDeployment: async () => ({ errors: [], warnings: [], checks: ['public deployment verified'] }),
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
  assert.ok(result.checks.includes('public deployment verified'));
  const serializedArgs = JSON.stringify(calls.map(({ command, args }) => ({ command, args })));
  for (const name of SENSITIVE_ENVIRONMENT) assert.doesNotMatch(serializedArgs, new RegExp(env[name]));
  for (const name of SENSITIVE_ENVIRONMENT) {
    const upload = calls.find((call) => call.args.includes(name));
    assert.equal(upload.input, `${env[name]}\n`);
    assert.ok(upload.args.includes('--sensitive'));
  }
});

test('guided apply discovers Supabase keys then prompts only for remaining private inputs', async () => {
  const root = exportFixture();
  const handoff = JSON.parse(readFileSync(join(root, 'activity-handoff.json'), 'utf8'));
  handoff.projectTargets = {
    ...handoff.projectTargets,
    configured: true,
    discordApplicationId: '123456789012345678',
    discordPublicKey: 'a'.repeat(64),
    vercelProjectName: 'my-discord-game',
    supabaseProjectRef: 'abcdefghijklmnopqrst',
    missingRequiredTargets: [],
  };
  writeFileSync(join(root, 'activity-handoff.json'), JSON.stringify(handoff));
  const calls = [];
  const promptNames = [];
  const promptValues = {
    DISCORD_CLIENT_SECRET: 'prompted-discord-client-secret',
    DISCORD_BOT_TOKEN: 'prompted-discord-bot-token-value',
    SUPABASE_JWT_PRIVATE_KEY: JSON.stringify({
      kty: 'EC', crv: 'P-256', kid: 'guided-key', x: 'x', y: 'y', d: 'd',
    }),
  };
  const runner = (command, args, invocation) => {
    calls.push({ command, args, input: invocation.input });
    if (command === 'supabase' && args[0] === 'projects') {
      return {
        status: 0,
        stdout: JSON.stringify([
          { type: 'publishable', name: 'default', api_key: 'sb_publishable_guided-value' },
          { type: 'secret', name: 'default', api_key: 'sb_secret_guided-value' },
        ]),
        stderr: '',
      };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  const result = await executeActivityRelease({
    apply: true,
    deploy: false,
    migrate: false,
    vercelOnlySecrets: true,
    supabaseCliKeys: true,
    directory: root,
    environment: 'preview',
  }, loadReleaseEnvironment({}, {}), {
    runner,
    prompt: async (label) => {
      const name = Object.keys(promptValues).find((candidate) => label.includes(candidate));
      promptNames.push(name);
      return promptValues[name];
    },
    random: () => Buffer.alloc(32, 4),
    verifyServices: async () => ({ errors: [], warnings: [], checks: ['services verified'] }),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(promptNames, ['DISCORD_CLIENT_SECRET', 'DISCORD_BOT_TOKEN', 'SUPABASE_JWT_PRIVATE_KEY']);
  const secretUpload = calls.find((call) => call.args.includes('SUPABASE_SECRET_KEY'));
  assert.equal(secretUpload.input, 'sb_secret_guided-value\n');
  assert.ok(secretUpload.args.includes('--sensitive'));
  const serializedArgs = JSON.stringify(calls.map(({ command, args }) => ({ command, args })));
  assert.doesNotMatch(serializedArgs, /sb_(?:publishable|secret)_guided-value/);
});

test('public deployment probe rejects Vercel authentication and iframe denial', async () => {
  const result = await verifyPublicDeployment('https://protected-game.vercel.app', {
    fetchImpl: async () => new Response(null, {
      status: 302,
      headers: {
        location: 'https://vercel.com/sso-api?secret-value-is-not-reported',
        'x-frame-options': 'DENY',
        'content-security-policy': "default-src 'self'; frame-ancestors 'self'",
      },
    }),
  });

  assert.ok(result.errors.some((error) => error.includes('vercel.com')));
  assert.ok(result.errors.some((error) => error.includes('X-Frame-Options')));
  assert.ok(result.errors.some((error) => error.includes('Content-Security-Policy')));
  assert.doesNotMatch(JSON.stringify(result), /secret-value-is-not-reported/);
});

test('public deployment probe validates hosted export and enabled Activity API', async () => {
  const requests = [];
  const result = await verifyPublicDeployment('https://public-game.example', {
    fetchImpl: async (input, options) => {
      const url = new URL(input);
      requests.push({ pathname: url.pathname, redirect: options.redirect });
      if (url.pathname === '/') return new Response('<html></html>', { status: 200 });
      if (url.pathname === '/export-manifest.json') {
        return Response.json({ schema: 'ue5-html5-export/v3', actorCount: 69 });
      }
      if (url.pathname === '/api/activity') return Response.json({ enabled: true, clientId: 'public' });
      return new Response(null, { status: 404 });
    },
  });

  assert.deepEqual(result.errors, []);
  assert.ok(result.checks.some((check) => check.includes('69 actors')));
  assert.ok(result.checks.some((check) => check.includes('enabled:true')));
  assert.deepEqual(requests.map(({ pathname }) => pathname), ['/', '/export-manifest.json', '/api/activity']);
  assert.ok(requests.every(({ redirect }) => redirect === 'manual'));
});

test('public deployment probe fails closed when hosted Activity API is disabled', async () => {
  const result = await verifyPublicDeployment('https://incomplete-game.example', {
    fetchImpl: async (input) => {
      const { pathname } = new URL(input);
      if (pathname === '/') return new Response('<html></html>', { status: 200 });
      if (pathname === '/export-manifest.json') return Response.json({ schema: 'ue5-html5-export/v2' });
      return Response.json({ enabled: false });
    },
  });

  assert.ok(result.errors.some((error) => error.includes('enabled:false')));
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
