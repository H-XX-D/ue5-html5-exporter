import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BrowserCertification,
  CERTIFICATION_SCHEMA,
  isLoopbackCertification,
  measureFramePacing,
  resourceModeCoverage,
  runTargetPracticeCertification,
  versionedModuleCoverage,
} from '../web/src/browser-certification.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

function targetFixture() {
  const target = {
    id: 'target-1',
    label: 'Practice Target',
    maxHealth: 3,
    health: 3,
    damagePerShot: 1,
    scoreValue: 100,
    respawn: true,
    respawnDelaySeconds: 0.1,
    depleted: false,
    objects: new Set([{}]),
  };
  let score = 0;
  const snapshot = (reason) => ({
    reason,
    score,
    configuredTargets: 1,
    boundTargets: 1,
    activeTargets: target.depleted ? 0 : 1,
    depletedTargets: target.depleted ? 1 : 0,
    target: null,
  });
  const targetPractice = {
    enabled: true,
    targets: [target],
    reset() {
      target.health = target.maxHealth;
      target.depleted = false;
      score = 0;
      return snapshot('reset');
    },
    snapshot,
  };
  const gameplay = {
    enabled: true,
    shoot() {
      if (!target.depleted) {
        target.health = Math.max(0, target.health - target.damagePerShot);
        if (target.health === 0) {
          target.depleted = true;
          score += target.scoreValue;
        }
      }
      return { object: { name: target.label } };
    },
  };
  let depletedWaits = 0;
  const wait = async () => {
    if (target.depleted) {
      depletedWaits += 1;
      if (depletedWaits >= 2) {
        target.health = target.maxHealth;
        target.depleted = false;
      }
    }
  };
  return { gameplay, targetPractice, target, wait };
}

test('browser certification is limited to an explicit loopback query', () => {
  assert.equal(isLoopbackCertification({ hostname: '127.0.0.1', search: '?ue5_certify=1' }), true);
  assert.equal(isLoopbackCertification({ hostname: 'localhost', search: '?ue5_certify=1' }), true);
  assert.equal(isLoopbackCertification({ hostname: '123.discordsays.com', search: '?ue5_certify=1' }), false);
  assert.equal(isLoopbackCertification({ hostname: '127.0.0.1', search: '' }), false);
});

test('asset delivery coverage requires every manifest resource in the requested mode', () => {
  const version = `sha256:${'b'.repeat(64)}`;
  const assetPack = { version, resources: [
    { path: 'assets/scene.glb', delivery: 'cache-api-integrity' },
    { path: 'logic/blueprints.json', delivery: 'cache-api-integrity' },
    { path: 'logic/custom-adapters.js', delivery: 'versioned-module' },
  ] };
  const partial = resourceModeCoverage(assetPack, [{
    mode: 'cache-hit', path: 'assets/scene.glb', cacheBustVersion: version,
  }], 'cache-hit');
  assert.deepEqual(partial.map(({ passed }) => passed), [true, false]);
  const complete = resourceModeCoverage(assetPack, [
    { mode: 'cache-hit', path: 'assets/scene.glb', cacheBustVersion: version },
    { mode: 'cache-hit', path: 'logic/blueprints.json', cacheBustVersion: version },
  ], 'cache-hit');
  assert.ok(complete.every(({ passed }) => passed));
  assert.deepEqual(versionedModuleCoverage(assetPack, [{
    mode: 'versioned-module', path: 'logic/custom-adapters.js', cacheBustVersion: version,
  }]).map(({ passed }) => passed), [true]);
});

test('frame pacing records timing-only percentiles without device metadata', async () => {
  let timestamp = 0;
  let call = 0;
  const result = await measureFramePacing({
    sampleFrames: 30,
    requestFrame(callback) {
      const delta = call === 10 ? 40 : call === 20 ? 60 : (1000 / 60);
      call += 1;
      timestamp += delta;
      callback(timestamp);
    },
  });

  assert.equal(result.sampleCount, 30);
  assert.equal(result.framesOver33Ms, 2);
  assert.equal(result.framesOver50Ms, 1);
  assert.equal(result.p95FrameMs, 40);
  assert.equal(result.maxFrameMs, 60);
  assert.ok(result.averageFramesPerSecond > 50 && result.averageFramesPerSecond < 60);
});

test('target-practice certification proves center-ray hits, score, depletion, and respawn', async () => {
  const fixture = targetFixture();
  const result = await runTargetPracticeCertification(fixture.gameplay, fixture.targetPractice, {
    wait: fixture.wait,
    now: () => 0,
  });
  assert.equal(result.shots, 3);
  assert.equal(result.scoreDelta, 100);
  assert.equal(result.afterShots.activeTargets, 0);
  assert.equal(result.afterRespawn.activeTargets, 1);
  assert.equal(fixture.target.health, 3);
});

test('browser certification coordinates cold and warm reloads and submits a machine-readable report', async () => {
  const token = 'a'.repeat(48);
  const locationObject = {
    hostname: '127.0.0.1',
    origin: 'http://127.0.0.1:8123',
    href: `http://127.0.0.1:8123/?ue5_certify=1&ue5_certify_token=${token}`,
    search: `?ue5_certify=1&ue5_certify_token=${token}`,
  };
  const storage = memoryStorage();
  const deleted = [];
  const cacheStorage = { delete: async (name) => { deleted.push(name); return true; } };
  const resources = [
    { path: 'assets/scene.glb', delivery: 'cache-api-integrity' },
    { path: 'assets/audio/fire.wav', delivery: 'cache-api-integrity' },
    { path: 'logic/blueprints.json', delivery: 'cache-api-integrity' },
    { path: 'logic/custom-adapters.json', delivery: 'cache-api-integrity' },
    { path: 'logic/custom-adapters.js', delivery: 'versioned-module' },
  ];
  const version = `sha256:${'b'.repeat(64)}`;
  const manifest = {
    schema: 'ue5-html5-export/v6',
    exporterVersion: 'test',
    assetPack: {
      schema: 'ue5-html5-asset-pack/v2',
      version,
      cacheBusting: 'pack-version-query',
      resources,
    },
  };
  const assetCache = new EventTarget();
  assetCache.enabled = true;
  assetCache.cacheName = `ue5html5-asset-pack-v2-${'b'.repeat(64)}`;
  let certificationStage = 'cold';
  const deferredFetches = [];
  assetCache.fetch = async (path) => {
    deferredFetches.push({ stage: certificationStage, path });
    assetCache.dispatchEvent(new CustomEvent('statuschange', { detail: {
      mode: certificationStage === 'cold' ? 'network-cached' : 'cache-hit',
      path,
      reason: '',
      cacheBustVersion: version,
    } }));
    return new Response('certified');
  };
  let reloads = 0;
  const common = {
    locationObject,
    storage,
    cacheStorage,
    documentObject: null,
    reload: () => { reloads += 1; },
    now: () => new Date('2026-08-23T12:00:00.000Z'),
    monotonicNow: () => 812.25,
    measureFrames: async () => ({
      sampleCount: 120,
      durationMs: 2000,
      averageFramesPerSecond: 60,
      p50FrameMs: 16.667,
      p95FrameMs: 17.1,
      maxFrameMs: 22.5,
      framesOver33Ms: 0,
      framesOver50Ms: 0,
    }),
  };

  const initial = new BrowserCertification(common);
  assert.equal(await initial.prepare(assetCache, manifest), true);
  assert.deepEqual(deleted, [assetCache.cacheName]);
  assert.equal(reloads, 1);

  const cold = new BrowserCertification(common);
  assert.equal(await cold.prepare(assetCache, manifest), false);
  for (const resource of resources.filter(({ path }) => !path.startsWith('assets/audio/'))) cold.onCacheStatus({ detail: {
    mode: resource.delivery === 'versioned-module' ? 'versioned-module' : 'network-cached',
    path: resource.path,
    reason: '',
    cacheBustVersion: version,
  } });
  await cold.complete({ manifest, runtime: {}, gameplay: {}, targetPractice: {} });
  assert.equal(reloads, 2);
  assert.deepEqual(deferredFetches, [{ stage: 'cold', path: 'assets/audio/fire.wav' }]);

  certificationStage = 'warm';
  let submitted = null;
  const fixture = targetFixture();
  const warm = new BrowserCertification({
    ...common,
    wait: fixture.wait,
    fetchImpl: async (url, request) => {
      assert.equal(url.toString(), 'http://127.0.0.1:8123/__ue5html5_certification__');
      assert.equal(request.headers['x-ue5html5-certification-token'], token);
      submitted = JSON.parse(request.body);
      return { ok: true, status: 204 };
    },
  });
  assert.equal(await warm.prepare(assetCache, manifest), false);
  for (const resource of resources.filter(({ path }) => !path.startsWith('assets/audio/'))) warm.onCacheStatus({ detail: {
    mode: resource.delivery === 'versioned-module' ? 'versioned-module' : 'cache-hit',
    path: resource.path,
    reason: '',
    cacheBustVersion: version,
  } });
  const report = await warm.complete({
    manifest,
    runtime: {},
    gameplay: fixture.gameplay,
    targetPractice: fixture.targetPractice,
  });

  assert.equal(report.schema, CERTIFICATION_SCHEMA);
  assert.equal(report.status, 'passed');
  assert.equal(report.assetPack.cold.coverage.length, 4);
  assert.equal(report.assetPack.warm.coverage.length, 4);
  assert.equal(report.assetPack.cold.versionedModuleCoverage.length, 1);
  assert.equal(report.assetPack.warm.versionedModuleCoverage.length, 1);
  assert.deepEqual(report.assetPack.cold.exercisedDeferredResources, ['assets/audio/fire.wav']);
  assert.deepEqual(report.assetPack.warm.exercisedDeferredResources, ['assets/audio/fire.wav']);
  assert.deepEqual(deferredFetches, [
    { stage: 'cold', path: 'assets/audio/fire.wav' },
    { stage: 'warm', path: 'assets/audio/fire.wav' },
  ]);
  assert.equal(report.performance.advisoryOnly, true);
  assert.equal(report.performance.context, 'local-browser-only');
  assert.equal(report.performance.runtimeReadyFromNavigationStartMs, 812.25);
  assert.equal(report.performance.framePacing.averageFramesPerSecond, 60);
  assert.equal(report.performance.deviceMetadataCollected, false);
  assert.equal(report.targetPractice.scoreDelta, 100);
  assert.deepEqual(submitted, report);
  assert.equal(storage.getItem('ue5html5-browser-certification-v3'), null);
});
