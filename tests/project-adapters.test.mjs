import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PROJECT_ADAPTER_SCHEMA,
  loadProjectAdapters,
  normalizeAdapterName,
  validateProjectAdapterManifest,
} from '../web/src/project-adapters.js';

test('project adapter manifest normalizes declarations without certifying behavior', () => {
  const manifest = validateProjectAdapterManifest({
    schema: PROJECT_ADAPTER_SCHEMA,
    functions: ['Native Apply Damage'],
  });
  assert.deepEqual(manifest.functions, ['Native Apply Damage']);
  assert.equal(normalizeAdapterName(manifest.functions[0]), 'nativeapplydamage');
});

test('project adapter manifest rejects ambiguous duplicate declarations', () => {
  assert.throws(() => validateProjectAdapterManifest({
    schema: PROJECT_ADAPTER_SCHEMA,
    functions: ['NativeApplyDamage', 'Native Apply-Damage'],
  }), /duplicate function/);
});

test('project adapters load before Blueprint startup and verify every registration', async () => {
  const registered = new Set();
  const result = await loadProjectAdapters({
    manifestUrl: 'custom-adapters.json',
    moduleUrl: 'custom-adapters.js',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ schema: PROJECT_ADAPTER_SCHEMA, functions: ['NativeApplyDamage'] }),
    }),
    importModule: async () => { registered.add('nativeapplydamage'); },
    isRegistered: (name) => registered.has(normalizeAdapterName(name)),
  });
  assert.deepEqual([...result.functions], ['NativeApplyDamage']);
  assert.equal(result.runtimeValidationRequired, true);
});

test('project adapter loading fails loudly when implementation is not registered', async () => {
  await assert.rejects(loadProjectAdapters({
    manifestUrl: 'custom-adapters.json',
    moduleUrl: 'custom-adapters.js',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ schema: PROJECT_ADAPTER_SCHEMA, functions: ['NativeApplyDamage'] }),
    }),
    importModule: async () => {},
    isRegistered: () => false,
  }), /did not register: NativeApplyDamage/);
});
