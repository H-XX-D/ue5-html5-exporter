import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BrowserCertification,
  CERTIFICATION_SCHEMA,
  isLoopbackCertification,
  resourceModeCoverage,
  runTargetPracticeCertification,
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
  const assetPack = { resources: [{ path: 'assets/scene.glb' }, { path: 'logic/blueprints.json' }] };
  const partial = resourceModeCoverage(assetPack, [{ mode: 'cache-hit', path: 'assets/scene.glb' }], 'cache-hit');
  assert.deepEqual(partial.map(({ passed }) => passed), [true, false]);
  const complete = resourceModeCoverage(assetPack, [
    { mode: 'cache-hit', path: 'assets/scene.glb' },
    { mode: 'cache-hit', path: 'logic/blueprints.json' },
  ], 'cache-hit');
  assert.ok(complete.every(({ passed }) => passed));
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
    { path: 'assets/scene.glb' },
    { path: 'logic/blueprints.json' },
    { path: 'logic/custom-adapters.json' },
  ];
  const manifest = {
    schema: 'ue5-html5-export/v5',
    exporterVersion: 'test',
    assetPack: { schema: 'ue5-html5-asset-pack/v1', version: `sha256:${'b'.repeat(64)}`, resources },
  };
  const assetCache = new EventTarget();
  assetCache.enabled = true;
  assetCache.cacheName = `ue5html5-asset-pack-v1-${'b'.repeat(64)}`;
  let reloads = 0;
  const common = {
    locationObject,
    storage,
    cacheStorage,
    documentObject: null,
    reload: () => { reloads += 1; },
    now: () => new Date('2026-08-23T12:00:00.000Z'),
  };

  const initial = new BrowserCertification(common);
  assert.equal(await initial.prepare(assetCache, manifest), true);
  assert.deepEqual(deleted, [assetCache.cacheName]);
  assert.equal(reloads, 1);

  const cold = new BrowserCertification(common);
  assert.equal(await cold.prepare(assetCache, manifest), false);
  for (const resource of resources) cold.onCacheStatus({ detail: { mode: 'network-cached', path: resource.path, reason: '' } });
  await cold.complete({ manifest, runtime: {}, gameplay: {}, targetPractice: {} });
  assert.equal(reloads, 2);

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
  for (const resource of resources) warm.onCacheStatus({ detail: { mode: 'cache-hit', path: resource.path, reason: '' } });
  const report = await warm.complete({
    manifest,
    runtime: {},
    gameplay: fixture.gameplay,
    targetPractice: fixture.targetPractice,
  });

  assert.equal(report.schema, CERTIFICATION_SCHEMA);
  assert.equal(report.status, 'passed');
  assert.equal(report.assetPack.cold.coverage.length, resources.length);
  assert.equal(report.assetPack.warm.coverage.length, resources.length);
  assert.equal(report.targetPractice.scoreDelta, 100);
  assert.deepEqual(submitted, report);
  assert.equal(storage.getItem('ue5html5-browser-certification-v1'), null);
});
