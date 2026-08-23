import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { AUDIO_ASSET_SCHEMA, AudioAdapter, validateAudioAssets } from '../web/src/audio-adapter.js';
import { BrowserRuntimeAdapters } from '../web/src/runtime-adapters.js';

const manifest = {
  schema: AUDIO_ASSET_SCHEMA,
  sounds: [{
    source: '/Game/FirstPerson/Audio/Fire.Fire',
    path: 'assets/audio/abc123-Fire.wav',
    durationSeconds: 0.4,
    channels: 2,
  }],
};

function audioHarness() {
  const calls = { resume: 0, decode: 0, start: [], stop: 0, close: 0 };
  const source = {
    playbackRate: { value: 1 },
    connect() {},
    addEventListener() {},
    start(...args) { calls.start.push(args); },
    stop() { calls.stop += 1; },
  };
  const context = {
    state: 'suspended',
    destination: {},
    async resume() { calls.resume += 1; this.state = 'running'; },
    async decodeAudioData(bytes) { calls.decode += 1; return { bytes: bytes.byteLength }; },
    createBufferSource() { return source; },
    createGain() { return { gain: { value: 1 }, connect() {} }; },
    async close() { calls.close += 1; },
  };
  return { calls, context, source };
}

test('portable audio validates a narrow SoundWave WAV manifest', () => {
  assert.deepEqual(validateAudioAssets(null), { schema: AUDIO_ASSET_SCHEMA, sounds: [] });
  assert.equal(validateAudioAssets(manifest).sounds[0].channels, 2);
  assert.throws(() => validateAudioAssets({ schema: AUDIO_ASSET_SCHEMA, sounds: [
    { source: '/Game/Fire.Fire', path: '../private.wav' },
  ] }), /invalid source or WAV path/);
  assert.throws(() => validateAudioAssets({ schema: AUDIO_ASSET_SCHEMA, sounds: [
    { source: '/Game/Fire.Fire', path: 'assets/audio/one.wav' },
    { source: '/Game/Fire.Fire', path: 'assets/audio/two.wav' },
  ] }), /more than once/);
});

test('portable audio resumes Web Audio and plays verified exported bytes without blocking Blueprint flow', async () => {
  const { calls, context, source } = audioHarness();
  const adapter = new AudioAdapter(manifest, {
    fetchAsset: async (path) => {
      assert.equal(path, 'assets/audio/abc123-Fire.wav');
      return new Response(new Uint8Array([1, 2, 3]));
    },
    audioContextFactory: () => context,
    eventTarget: null,
  });

  assert.equal(adapter.play("SoundWave'/Game/FirstPerson/Audio/Fire.Fire'", {
    volumemultiplier: 0.25,
    pitchmultiplier: 1.5,
    starttime: 0.1,
  }), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.resume, 1);
  assert.equal(calls.decode, 1);
  assert.deepEqual(calls.start, [[0, 0.1]]);
  assert.equal(source.playbackRate.value, 1.5);
  adapter.dispose();
  assert.equal(calls.stop, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.close, 1);
});

test('portable audio reports missing assets and unavailable Web Audio as non-fatal', () => {
  const warnings = [];
  const adapter = new AudioAdapter(manifest, {
    audioContextFactory: () => null,
    eventTarget: null,
    onWarning: (message) => warnings.push(message),
  });
  assert.equal(adapter.play('/Game/Missing.Missing'), false);
  assert.equal(adapter.play('/Game/FirstPerson/Audio/Fire.Fire'), false);
  assert.match(warnings[0], /No exported SoundWave/);
  assert.match(warnings[1], /does not provide Web Audio/);
});

test('Blueprint runtime routes UE Play Sound nodes through the portable audio adapter', async () => {
  const { context, calls } = audioHarness();
  const adapters = new BrowserRuntimeAdapters(new THREE.Group(), { audioAssets: manifest }, {
    fetchAsset: async () => new Response(new Uint8Array([4, 5, 6])),
    audioContextFactory: () => context,
  }, null);
  const result = adapters.call('PlaySound2D', {
    sound: '/Game/FirstPerson/Audio/Fire.Fire',
    volumemultiplier: 0.75,
  }, {});
  assert.deepEqual(result, { handled: true, value: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.start.length, 1);
  adapters.dispose();
});
