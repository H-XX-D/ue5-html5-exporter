import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three';

import { TargetPracticeRuntime } from '../web/src/target-practice.js';

test('Unreal target metadata drives browser health, score, depletion, and respawn', () => {
  const world = new THREE.Group();
  const actor = new THREE.Group();
  actor.name = 'Practice Target 01';
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  mesh.name = 'TargetMesh';
  actor.add(mesh);
  world.add(actor);

  const scheduled = [];
  const states = [];
  const runtime = new TargetPracticeRuntime(world, [{
    id: '/Game/Test.PracticeTarget01',
    label: 'Practice Target 01',
    objectName: 'BP_PracticeTarget_C_0',
    maxHealth: 2,
    damagePerShot: 1,
    scoreValue: 250,
    respawn: true,
    respawnDelaySeconds: 0.05,
    hitFlashSeconds: 0,
  }], {
    state: (state) => states.push(state),
    schedule: (callback, delay) => {
      const entry = { callback, delay, cancelled: false };
      scheduled.push(entry);
      return entry;
    },
    cancelSchedule: (entry) => { entry.cancelled = true; },
  });

  assert.equal(runtime.enabled, true);
  assert.equal(states[0].configuredTargets, 1);
  assert.equal(states[0].boundTargets, 1);
  const first = runtime.applyHit({ object: mesh });
  assert.deepEqual(first, {
    id: '/Game/Test.PracticeTarget01',
    label: 'Practice Target 01',
    health: 1,
    maxHealth: 2,
    depleted: false,
    scoreDelta: 0,
    score: 0,
  });
  assert.equal(actor.visible, true);

  const second = runtime.applyHit({ object: mesh });
  assert.equal(second.depleted, true);
  assert.equal(second.scoreDelta, 250);
  assert.equal(second.score, 250);
  assert.equal(actor.visible, false);
  assert.equal(runtime.applyHit({ object: mesh }), null);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 50);

  scheduled[0].callback();
  assert.equal(actor.visible, true);
  assert.equal(runtime.snapshot().activeTargets, 1);
  assert.equal(runtime.snapshot().target, null);
  assert.equal(states.at(-1).reason, 'respawned');
  assert.equal(states.at(-1).target.health, 2);
  assert.equal(runtime.score, 250);

  const reset = runtime.reset();
  assert.equal(reset.score, 0);
  assert.equal(reset.activeTargets, 1);
  runtime.dispose();
  mesh.geometry.dispose();
  mesh.material.dispose();
});

test('target practice ignores ordinary scene hits and reports unbound Unreal actors', () => {
  const world = new THREE.Group();
  const wall = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  wall.name = 'Wall';
  world.add(wall);
  let readyState;
  const runtime = new TargetPracticeRuntime(world, [{
    label: 'Missing Target',
    maxHealth: 1,
    damagePerShot: 1,
    scoreValue: 10,
    respawn: false,
  }], { state: (state) => { readyState = state; } });

  assert.equal(readyState.configuredTargets, 1);
  assert.equal(readyState.boundTargets, 0);
  assert.equal(readyState.activeTargets, 0);
  assert.equal(readyState.depletedTargets, 0);
  assert.equal(runtime.applyHit({ object: wall }), null);
  assert.equal(runtime.score, 0);
  runtime.dispose();
  wall.geometry.dispose();
  wall.material.dispose();
});
