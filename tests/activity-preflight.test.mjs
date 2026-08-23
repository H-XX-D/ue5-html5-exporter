import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';

import {
  REQUIRED_EXPORT_FILES,
  REQUIRED_EXPORT_PATTERNS,
  inferDiscordRequirements,
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

function fixturePayloadMetrics(root) {
  const sizes = new Map();
  const add = (path) => {
    if (!statSync(path).isFile()) return;
    sizes.set(relative(root, path).split('\\').join('/'), statSync(path).size);
  };
  const visit = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) add(child);
    }
  };
  add(join(root, 'index.html'));
  for (const directory of ['runtime', 'assets', 'logic']) visit(join(root, directory));
  const entries = [...sizes].sort(([left], [right]) => left.localeCompare(right));
  const sumPrefix = (prefix) => entries
    .filter(([path]) => path.startsWith(`${prefix}/`))
    .reduce((total, [, size]) => total + size, 0);
  const largest = entries.reduce(
    (current, entry) => entry[1] > current[1] || (entry[1] === current[1] && entry[0] < current[0]) ? entry : current,
    ['', 0],
  );
  const indexBytes = sizes.get('index.html') || 0;
  const runtimeBytes = sumPrefix('runtime');
  const assetBytes = sumPrefix('assets');
  const logicBytes = sumPrefix('logic');
  return {
    browserPayloadBytes: indexBytes + runtimeBytes + assetBytes + logicBytes,
    indexBytes,
    runtimeBytes,
    assetBytes,
    sceneBytes: sizes.get('assets/scene.glb') || 0,
    logicBytes,
    largestArtifactPath: largest[0],
    largestArtifactBytes: largest[1],
  };
}

function writeAssetDelivery(root, advisoryBudgetBytes = 64 * 1024 * 1024) {
  const metrics = fixturePayloadMetrics(root);
  const delivery = {
    status: metrics.browserPayloadBytes > advisoryBudgetBytes ? 'exceeds-advisory-budget' : 'within-advisory-budget',
    advisoryOnly: true,
    ...metrics,
    advisoryBudgetBytes,
    measuredPaths: ['index.html', 'runtime/**', 'assets/**', 'logic/**'],
    details: 'Exporter advisory only; test real clients.',
  };
  for (const filename of ['export-manifest.json', 'activity-handoff.json']) {
    const path = join(root, filename);
    const value = JSON.parse(readFileSync(path, 'utf8'));
    value.assetDelivery = delivery;
    writeFileSync(path, JSON.stringify(value));
  }
  return delivery;
}

function writeAssetPack(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) files.push(child);
    }
  };
  visit(join(root, 'assets'));
  files.push(
    join(root, 'logic/blueprints.json'),
    join(root, 'logic/custom-adapters.json'),
    join(root, 'logic/custom-adapters.js'),
  );
  files.sort();
  let bytes = 0;
  let canonical = '';
  const resources = files.map((file) => {
    const path = relative(root, file).split('\\').join('/');
    const body = readFileSync(file);
    const sha256 = createHash('sha256').update(body).digest('hex');
    const delivery = path === 'logic/custom-adapters.js' ? 'versioned-module' : 'cache-api-integrity';
    bytes += body.byteLength;
    canonical += `${path}\n${delivery}\n${body.byteLength}\n${sha256}\n`;
    return {
      path,
      kind: path === 'assets/scene.glb' ? 'scene'
        : path === 'logic/blueprints.json' ? 'blueprint-ir'
          : path === 'logic/custom-adapters.json' ? 'adapter-manifest'
            : path === 'logic/custom-adapters.js' ? 'adapter-module' : 'asset',
      delivery,
      bytes: body.byteLength,
      sha256,
    };
  });
  const pack = {
    schema: 'ue5-html5-asset-pack/v2',
    strategy: 'origin-scoped-versioned-cache',
    version: `sha256:${createHash('sha256').update(canonical).digest('hex')}`,
    cacheBusting: 'pack-version-query',
    versionQuery: 'ue5html5_pack',
    runtimeStrategy: 'content-hashed-http-cache',
    scope: 'activity-origin',
    integrity: 'sha256',
    fallback: 'network',
    bytes,
    resources,
  };
  for (const filename of ['export-manifest.json', 'activity-handoff.json']) {
    const path = join(root, filename);
    const value = JSON.parse(readFileSync(path, 'utf8'));
    value.assetPack = pack;
    writeFileSync(path, JSON.stringify(value));
  }
  return pack;
}

function exportFixture() {
  const root = mkdtempSync(join(tmpdir(), 'ue5-activity-preflight-'));
  for (const path of REQUIRED_EXPORT_FILES) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, path.endsWith('.json') ? '{}' : 'fixture');
  }
  writeFileSync(join(root, 'export-manifest.json'), JSON.stringify({
    schema: 'ue5-html5-export/v3',
    blueprintCompatibility: {
      status: 'compatible', blueprintCount: 1, nodeCount: 2, supportedNodeCount: 2, unsupportedNodeCount: 0,
    },
  }));
  writeFileSync(join(root, 'activity-handoff.json'), JSON.stringify({
    schema: 'ue5-discord-activity-handoff/v4',
    handoffStatus: 'unreal-export-complete',
    projectTargets: {
      source: 'Unreal Project Settings > Plugins > UE5 HTML5 Discord Activity',
      containsSecrets: false,
      configured: false,
      discordApplicationId: '',
      discordPublicKey: '',
      vercelProjectName: '',
      supabaseProjectRef: '',
      productionUrl: '',
      missingRequiredTargets: [
        'Discord Application ID', 'Discord Public Key', 'Vercel Project Name', 'Supabase Project Ref',
      ],
    },
    blueprintCompatibility: {
      status: 'compatible', blueprintCount: 1, nodeCount: 2, supportedNodeCount: 2, unsupportedNodeCount: 0,
    },
  }));
  writeFileSync(join(root, 'logic/blueprints.json'), JSON.stringify({
    schema: 'ue-blueprint-ir/v1',
    programs: [{ graphs: [{ nodes: [{}, {}] }], compatibility: { unsupportedCount: 0 } }],
  }));
  for (const [index, required] of REQUIRED_EXPORT_PATTERNS.entries()) {
    const filename = required.label
      .replace('<hash>', `fixture${index}`)
      .replace('runtime/', '');
    const target = join(root, required.directory, filename);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, 'fixture');
  }
  writeAssetDelivery(root);
  return root;
}

test('Activity preflight accepts a complete private configuration', () => {
  assert.deepEqual(validateActivityEnvironment(validEnvironment()).errors, []);
});

test('Discord requirements are inferred only from used Blueprint calls', () => {
  const requirements = inferDiscordRequirements({
    programs: [{
      graphs: [{
        nodes: [
          { kind: 'callFunction', function: 'DiscordActivityChooseAndShareImage' },
          { kind: 'callFunction', function: 'DiscordActivitySetRichPresence' },
          { kind: 'callFunction', function: 'DiscordActivitySetRichPresence' },
          { kind: 'functionEntry', function: 'DiscordActivityClearRichPresence' },
          { kind: 'callFunction', function: 'PrintString' },
        ],
      }],
    }],
  });
  assert.deepEqual(requirements, {
    schema: 'ue5-discord-activity-requirements/v1',
    usedBlueprintFunctions: ['DiscordActivityChooseAndShareImage', 'DiscordActivitySetRichPresence'],
    features: ['image-sharing', 'rich-presence'],
    requiredOAuthScopes: ['identify', 'rpc.activities.write'],
    requiredEnvironment: { DISCORD_ENABLE_RICH_PRESENCE: 'true' },
  });
});

test('Activity package preflight verifies the current reusable asset-pack contract and detects tampering', () => {
  const root = exportFixture();
  try {
    const manifestPath = join(root, 'export-manifest.json');
    const handoffPath = join(root, 'activity-handoff.json');
    const logicPath = join(root, 'logic/blueprints.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const handoff = JSON.parse(readFileSync(handoffPath, 'utf8'));
    const logic = JSON.parse(readFileSync(logicPath, 'utf8'));
    const modernCounts = {
      status: 'compatible',
      blueprintCount: 1,
      nodeCount: 2,
      builtInSupportedNodeCount: 2,
      customAdapterNodeCount: 0,
      supportedNodeCount: 2,
      unsupportedNodeCount: 0,
    };
    manifest.schema = 'ue5-html5-export/v7';
    manifest.blueprintCompatibility = modernCounts;
    handoff.schema = 'ue5-discord-activity-handoff/v8';
    handoff.blueprintCompatibility = modernCounts;
    logic.projectAdapters = {
      schema: 'ue5-html5-custom-adapters/v1',
      manifest: 'logic/custom-adapters.json',
      module: 'logic/custom-adapters.js',
      declaredFunctionCount: 0,
    };
    logic.programs[0].compatibility.projectAdapterCount = 0;
    const discordRequirements = inferDiscordRequirements(logic);
    manifest.discordRequirements = discordRequirements;
    handoff.discordRequirements = discordRequirements;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    writeFileSync(handoffPath, JSON.stringify(handoff));
    writeFileSync(logicPath, JSON.stringify(logic));
    writeFileSync(join(root, 'logic/custom-adapters.json'), JSON.stringify({
      schema: 'ue5-html5-custom-adapters/v1', functions: [],
    }));
    writeAssetDelivery(root);
    const pack = writeAssetPack(root);
    const currentManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    currentManifest.exporterVersion = 'test-version';
    writeFileSync(manifestPath, JSON.stringify(currentManifest));

    const cacheResources = pack.resources.filter(({ delivery }) => delivery === 'cache-api-integrity');
    const moduleResources = pack.resources.filter(({ delivery }) => delivery === 'versioned-module');
    const coverage = (mode) => cacheResources.map(({ path }) => ({
      path, mode, cacheBustVersion: pack.version, passed: true,
    }));
    const versionedModuleCoverage = () => moduleResources.map(({ path }) => ({
      path, mode: 'versioned-module', cacheBustVersion: pack.version, passed: true,
    }));
    const browserCertificationPath = join(root, 'browser-certification.json');
    const browserCertification = {
      schema: 'ue5-html5-browser-certification/v3',
      status: 'passed',
      exporterVersion: currentManifest.exporterVersion,
      manifestSchema: currentManifest.schema,
      assetPack: {
        schema: pack.schema,
        version: pack.version,
        cacheBusting: pack.cacheBusting,
        resourceCount: pack.resources.length,
        cacheResourceCount: cacheResources.length,
        versionedModuleCount: moduleResources.length,
        cold: { coverage: coverage('network-cached'), versionedModuleCoverage: versionedModuleCoverage() },
        warm: { coverage: coverage('cache-hit'), versionedModuleCoverage: versionedModuleCoverage() },
      },
      runtime: { blueprintReady: true, firstPersonEnabled: true },
      performance: {
        advisoryOnly: true,
        context: 'local-browser-only',
        runtimeReadyFromNavigationStartMs: 850.5,
        framePacing: {
          sampleCount: 120,
          durationMs: 2000,
          averageFramesPerSecond: 60,
          p50FrameMs: 16.667,
          p95FrameMs: 17.5,
          maxFrameMs: 25,
          framesOver33Ms: 0,
          framesOver50Ms: 0,
        },
        deviceMetadataCollected: false,
      },
      targetPractice: {
        shots: 3,
        scoreDelta: 100,
        afterShots: { depletedTargets: 1 },
        afterRespawn: { activeTargets: 1 },
      },
      privacy: { credentialsAccessed: false, personalPlayerDataCollected: false, deviceMetadataCollected: false },
    };
    writeFileSync(browserCertificationPath, JSON.stringify(browserCertification));

    assert.deepEqual(validateActivityExport({ directory: root, packageOnly: true }).errors, []);
    const validHandoff = JSON.parse(readFileSync(handoffPath, 'utf8'));
    writeFileSync(handoffPath, JSON.stringify({
      ...validHandoff,
      discordRequirements: {
        ...validHandoff.discordRequirements,
        requiredOAuthScopes: ['identify', 'rpc.activities.write'],
      },
    }));
    assert.ok(validateActivityExport({ directory: root, packageOnly: true }).errors
      .some((error) => error.includes('does not match Discord functions')));
    writeFileSync(handoffPath, JSON.stringify(validHandoff));
    writeFileSync(browserCertificationPath, JSON.stringify({
      ...browserCertification,
      assetPack: { ...browserCertification.assetPack, version: `sha256:${'0'.repeat(64)}` },
    }));
    assert.ok(validateActivityExport({ directory: root, packageOnly: true }).errors
      .some((error) => error.includes('browser-certification.json asset-pack version')));
    writeFileSync(browserCertificationPath, JSON.stringify(browserCertification));
    browserCertification.assetPack.cold.versionedModuleCoverage[0].cacheBustVersion = `sha256:${'0'.repeat(64)}`;
    writeFileSync(browserCertificationPath, JSON.stringify(browserCertification));
    assert.ok(validateActivityExport({ directory: root, packageOnly: true }).errors
      .some((error) => error.includes('does not prove versioned loading')));
    browserCertification.assetPack.cold.versionedModuleCoverage[0].cacheBustVersion = pack.version;
    writeFileSync(browserCertificationPath, JSON.stringify(browserCertification));
    writeFileSync(browserCertificationPath, JSON.stringify({
      ...browserCertification,
      performance: {
        ...browserCertification.performance,
        framePacing: { ...browserCertification.performance.framePacing, averageFramesPerSecond: 0 },
      },
    }));
    assert.ok(validateActivityExport({ directory: root, packageOnly: true }).errors
      .some((error) => error.includes('frame-pacing evidence')));
    writeFileSync(browserCertificationPath, JSON.stringify(browserCertification));
    writeFileSync(join(root, 'assets/scene.glb'), 'tampered-scene');
    assert.ok(validateActivityExport({ directory: root, packageOnly: true }).errors
      .some((error) => error.includes('assetPack SHA-256')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Activity preflight keeps private Realtime optional for Discord auth and persistence', () => {
  const env = validEnvironment();
  delete env.SUPABASE_JWT_PRIVATE_KEY;
  delete env.SUPABASE_JWT_KEY_ID;
  const result = validateActivityEnvironment(env);
  assert.deepEqual(result.errors, []);
  assert.ok(result.warnings.some((warning) => warning.includes('private Realtime is disabled')));
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

test('Activity package preflight requires the Unreal-to-release-operator handoff contract', () => {
  assert.ok(REQUIRED_EXPORT_FILES.includes('activity-handoff.json'));
  const root = exportFixture();
  try {
    rmSync(join(root, 'activity-handoff.json'));
    const result = validateActivityExport({ directory: root, env: validEnvironment(), packageOnly: true });
    assert.ok(result.errors.includes('Export artifact is missing: activity-handoff.json'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Activity package preflight warns on honest partial Blueprint compatibility', () => {
  const root = exportFixture();
  try {
    const compatibility = {
      status: 'needs-adapters', blueprintCount: 1, nodeCount: 3, supportedNodeCount: 2, unsupportedNodeCount: 1,
    };
    writeFileSync(join(root, 'export-manifest.json'), JSON.stringify({
      schema: 'ue5-html5-export/v2', blueprintCompatibility: compatibility,
    }));
    writeFileSync(join(root, 'activity-handoff.json'), JSON.stringify({
      schema: 'ue5-discord-activity-handoff/v4',
      handoffStatus: 'unreal-export-needs-blueprint-adapters',
      projectTargets: {
        source: 'Unreal Project Settings', containsSecrets: false, configured: false,
        missingRequiredTargets: [
          'Discord Application ID', 'Discord Public Key', 'Vercel Project Name', 'Supabase Project Ref',
        ],
      },
      blueprintCompatibility: compatibility,
    }));
    writeFileSync(join(root, 'logic/blueprints.json'), JSON.stringify({
      schema: 'ue-blueprint-ir/v1', programs: [{ graphs: [{ nodes: [{}, {}, {}] }], compatibility: { unsupportedCount: 1 } }],
    }));
    const result = validateActivityExport({ directory: root, env: validEnvironment(), packageOnly: true });
    assert.deepEqual(result.errors, []);
    assert.ok(result.warnings.some((warning) => warning.includes('1 Blueprint node requires')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Activity package preflight preserves project-adapter coverage as runtime validation work', () => {
  const root = exportFixture();
  try {
    const compatibility = {
      status: 'project-adapters-require-runtime-validation',
      blueprintCount: 1,
      nodeCount: 2,
      builtInSupportedNodeCount: 1,
      customAdapterNodeCount: 1,
      supportedNodeCount: 2,
      unsupportedNodeCount: 0,
    };
    writeFileSync(join(root, 'export-manifest.json'), JSON.stringify({
      schema: 'ue5-html5-export/v4', blueprintCompatibility: compatibility,
    }));
    writeFileSync(join(root, 'activity-handoff.json'), JSON.stringify({
      schema: 'ue5-discord-activity-handoff/v5',
      handoffStatus: 'unreal-export-needs-runtime-validation',
      projectTargets: {
        source: 'Unreal Project Settings', containsSecrets: false, configured: false,
        discordApplicationId: '', discordPublicKey: '', vercelProjectName: '', supabaseProjectRef: '', productionUrl: '',
        missingRequiredTargets: [
          'Discord Application ID', 'Discord Public Key', 'Vercel Project Name', 'Supabase Project Ref',
        ],
      },
      blueprintCompatibility: compatibility,
    }));
    writeFileSync(join(root, 'logic/custom-adapters.json'), JSON.stringify({
      schema: 'ue5-html5-custom-adapters/v1', functions: ['NativeApplyDamage'],
    }));
    writeFileSync(join(root, 'logic/custom-adapters.js'), "window.UE5HTML5.registerFunction('NativeApplyDamage', () => true); export {};");
    writeFileSync(join(root, 'logic/blueprints.json'), JSON.stringify({
      schema: 'ue-blueprint-ir/v1',
      projectAdapters: {
        schema: 'ue5-html5-custom-adapters/v1',
        manifest: 'logic/custom-adapters.json',
        module: 'logic/custom-adapters.js',
        declaredFunctionCount: 1,
        runtimeValidationRequired: true,
      },
      programs: [{
        graphs: [{ nodes: [{ supportSource: 'built-in' }, { supportSource: 'project-adapter' }] }],
        compatibility: {
          unsupported: [], unsupportedCount: 0,
          projectAdapters: [{ function: 'NativeApplyDamage', runtimeValidationRequired: true }],
          projectAdapterCount: 1,
          runtimeValidationRequired: true,
        },
      }],
    }));
    writeAssetDelivery(root);
    const result = validateActivityExport({ directory: root, env: validEnvironment(), packageOnly: true });
    assert.deepEqual(result.errors, []);
    assert.ok(result.warnings.some((warning) => warning.includes('behavior requires local Discord preview')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Activity package preflight rejects a falsely complete Blueprint handoff', () => {
  const root = exportFixture();
  try {
    const compatibility = {
      status: 'needs-adapters', blueprintCount: 1, nodeCount: 3, supportedNodeCount: 2, unsupportedNodeCount: 1,
    };
    writeFileSync(join(root, 'export-manifest.json'), JSON.stringify({
      schema: 'ue5-html5-export/v2', blueprintCompatibility: compatibility,
    }));
    writeFileSync(join(root, 'activity-handoff.json'), JSON.stringify({
      schema: 'ue5-discord-activity-handoff/v4',
      handoffStatus: 'unreal-export-complete',
      projectTargets: {
        source: 'Unreal Project Settings', containsSecrets: false, configured: false,
        missingRequiredTargets: [
          'Discord Application ID', 'Discord Public Key', 'Vercel Project Name', 'Supabase Project Ref',
        ],
      },
      blueprintCompatibility: compatibility,
    }));
    writeFileSync(join(root, 'logic/blueprints.json'), JSON.stringify({
      schema: 'ue-blueprint-ir/v1', programs: [{ graphs: [{ nodes: [{}, {}, {}] }], compatibility: { unsupportedCount: 1 } }],
    }));
    const result = validateActivityExport({ directory: root, env: validEnvironment(), packageOnly: true });
    assert.ok(result.errors.some((error) => error.includes('unreal-export-needs-blueprint-adapters')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Activity package preflight rejects secret fields in Unreal project targets', () => {
  const root = exportFixture();
  try {
    const handoffPath = join(root, 'activity-handoff.json');
    const handoff = JSON.parse(readFileSync(handoffPath, 'utf8'));
    handoff.projectTargets.discordClientSecret = 'must-never-be-exported';
    handoff.projectTargets.containsSecrets = true;
    handoff.projectTargets.configured = true;
    writeFileSync(handoffPath, JSON.stringify(handoff));
    const result = validateActivityExport({ directory: root, env: validEnvironment(), packageOnly: true });
    assert.ok(result.errors.some((error) => error.includes('forbidden field: discordClientSecret')));
    assert.ok(result.errors.some((error) => error.includes('containsSecrets must be false')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Activity package preflight keeps a partial public target set explicitly incomplete', () => {
  const root = exportFixture();
  try {
    const handoffPath = join(root, 'activity-handoff.json');
    const handoff = JSON.parse(readFileSync(handoffPath, 'utf8'));
    handoff.projectTargets.discordApplicationId = '123456789012345678';
    handoff.projectTargets.missingRequiredTargets = [
      'Discord Public Key', 'Vercel Project Name', 'Supabase Project Ref',
    ];
    writeFileSync(handoffPath, JSON.stringify(handoff));
    assert.deepEqual(validateActivityExport({ directory: root, env: validEnvironment(), packageOnly: true }).errors, []);

    handoff.projectTargets.configured = true;
    writeFileSync(handoffPath, JSON.stringify(handoff));
    const result = validateActivityExport({ directory: root, env: validEnvironment(), packageOnly: true });
    assert.ok(result.errors.some((error) => error.includes('configured must be false')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Activity package preflight rejects stale browser payload metrics', () => {
  const root = exportFixture();
  try {
    writeFileSync(join(root, 'runtime/viewer-fixture0.js'), 'fixture grew after Unreal wrote its manifest');
    const result = validateActivityExport({ directory: root, env: validEnvironment(), packageOnly: true });
    assert.ok(result.errors.some((error) => error.includes('runtimeBytes does not match')));
    assert.ok(result.errors.some((error) => error.includes('browserPayloadBytes does not match')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Activity package preflight warns without blocking above the project advisory budget', () => {
  const root = exportFixture();
  try {
    writeAssetDelivery(root, 1);
    const result = validateActivityExport({ directory: root, env: validEnvironment(), packageOnly: true });
    assert.deepEqual(result.errors, []);
    assert.ok(result.warnings.some((warning) => warning.includes('above the 0.0 MiB project advisory budget')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Activity package preflight accepts legacy v2 exports with an explicit metrics warning', () => {
  const root = exportFixture();
  try {
    for (const filename of ['export-manifest.json', 'activity-handoff.json']) {
      const path = join(root, filename);
      const value = JSON.parse(readFileSync(path, 'utf8'));
      delete value.assetDelivery;
      if (filename === 'export-manifest.json') value.schema = 'ue5-html5-export/v2';
      writeFileSync(path, JSON.stringify(value));
    }
    const result = validateActivityExport({ directory: root, env: validEnvironment(), packageOnly: true });
    assert.deepEqual(result.errors, []);
    assert.ok(result.warnings.some((warning) => warning.includes('Legacy v2 export')));
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
        integration_types_config: { '0': {}, '1': {} },
        redirect_uris: ['https://127.0.0.1'],
        privacy_policy_url: 'https://game.test/privacy',
        terms_of_service_url: 'https://game.test/terms',
      });
    }
    if (value.endsWith(`/applications/${env.DISCORD_CLIENT_ID}/commands`)) {
      return Response.json([{ id: 'entry', name: 'launch', type: 4, handler: 2 }]);
    }
    if (value.endsWith('/auth/v1/.well-known/jwks.json')) {
      return Response.json({ keys: [{ kid: 'activity-key', kty: 'EC', crv: 'P-256', x: 'x-value', y: 'y-value' }] });
    }
    if (value.endsWith('/auth/v1/health')) return Response.json({ version: 'test' });
    if (value.includes('/discord_activity_world_state') || value.includes('/discord_activity_live_certification_checkins')) {
      return headers.get('apikey') === env.SUPABASE_PUBLISHABLE_KEY
        ? Response.json({ message: 'permission denied' }, { status: 403 })
        : Response.json([]);
    }
    throw new Error(`Unexpected online preflight request: ${value}`);
  };

  const result = await verifyActivityServices(env, { fetchImpl });
  assert.deepEqual(result.errors, []);
  assert.equal(result.checks.length, 11);
  assert.ok(calls.some((call) => call.value.endsWith('/auth/v1/health')));
  assert.equal(calls.some((call) => call.value.endsWith('/rest/v1/')), false);
  assert.equal(calls.find((call) => call.value.endsWith('/applications/@me')).headers.get('authorization'), `Bot ${env.DISCORD_BOT_TOKEN}`);
  for (const call of calls.filter((entry) => entry.value.includes('supabase.co/rest/'))) {
    assert.equal(call.headers.has('authorization'), false);
  }
});

test('online preflight skips signing-key discovery when private Realtime is disabled', async () => {
  const env = validEnvironment();
  delete env.SUPABASE_JWT_PRIVATE_KEY;
  delete env.SUPABASE_JWT_KEY_ID;
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const value = String(url);
    const headers = new Headers(init.headers);
    calls.push(value);
    if (value.endsWith('/applications/@me')) {
      return Response.json({
        id: env.DISCORD_CLIENT_ID,
        flags_new: String(1 << 17),
        integration_types_config: { '0': {}, '1': {} },
        redirect_uris: ['https://127.0.0.1'],
        privacy_policy_url: 'https://game.test/privacy',
        terms_of_service_url: 'https://game.test/terms',
      });
    }
    if (value.endsWith(`/applications/${env.DISCORD_CLIENT_ID}/commands`)) {
      return Response.json([{ id: 'entry', name: 'launch', type: 4, handler: 2 }]);
    }
    if (value.endsWith('/auth/v1/health')) return Response.json({ version: 'test' });
    if (value.includes('/discord_activity_world_state') || value.includes('/discord_activity_live_certification_checkins')) {
      return headers.get('apikey') === env.SUPABASE_PUBLISHABLE_KEY
        ? Response.json({ message: 'permission denied' }, { status: 403 })
        : Response.json([]);
    }
    throw new Error(`Unexpected online preflight request: ${value}`);
  };

  const result = await verifyActivityServices(env, { fetchImpl });
  assert.deepEqual(result.errors, []);
  assert.ok(result.checks.some((check) => check.includes('private Realtime is intentionally disabled')));
  assert.equal(calls.some((url) => url.endsWith('/auth/v1/.well-known/jwks.json')), false);
});

test('online preflight rejects mismatched service identities and browser-readable game state', async () => {
  const env = validEnvironment();
  const fetchImpl = async (url) => {
    const value = String(url);
    if (value.endsWith('/applications/@me')) return Response.json({ id: '999999999999999999', flags_new: '0' });
    if (value.endsWith(`/applications/${env.DISCORD_CLIENT_ID}/commands`)) return Response.json([]);
    if (value.endsWith('/auth/v1/.well-known/jwks.json')) {
      return Response.json({ keys: [{ kid: 'activity-key', kty: 'EC', crv: 'P-256', x: 'wrong', y: 'wrong' }] });
    }
    if (value.endsWith('/auth/v1/health')) return Response.json({ version: 'test' });
    if (value.includes('/discord_activity_world_state') || value.includes('/discord_activity_live_certification_checkins')) return Response.json([]);
    throw new Error(`Unexpected online preflight request: ${value}`);
  };
  const result = await verifyActivityServices(env, { fetchImpl });
  assert.ok(result.errors.some((error) => error.includes('different Discord application')));
  assert.ok(result.errors.some((error) => error.includes('not marked as an embedded Activity')));
  assert.ok(result.errors.some((error) => error.includes('does not match this project')));
  assert.ok(result.errors.some((error) => error.includes('can read the private world-state table')));
  assert.ok(result.errors.some((error) => error.includes('can read private live-certification check-ins')));
  assert.ok(result.errors.some((error) => error.includes('no global Primary Entry Point')));
  assert.ok(result.warnings.some((warning) => warning.includes('Guild Install and User Install')));
  assert.ok(result.warnings.some((warning) => warning.includes('OAuth2 redirect URI')));
});
