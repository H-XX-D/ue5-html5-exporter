import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { test } from 'node:test';

import {
  AssetPackCache,
  CACHE_PREFIX,
  LEGACY_CACHE_PREFIX,
  PACK_VERSION_QUERY,
} from '../web/src/asset-pack-cache.js';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function manifest(path, body, delivery = 'cache-api-integrity') {
  return {
    schema: 'ue5-html5-asset-pack/v2',
    strategy: 'origin-scoped-versioned-cache',
    version: `sha256:${'a'.repeat(64)}`,
    cacheBusting: 'pack-version-query',
    versionQuery: PACK_VERSION_QUERY,
    runtimeStrategy: 'content-hashed-http-cache',
    integrity: 'sha256',
    fallback: 'network',
    resources: [{ path, delivery, bytes: body.byteLength, sha256: sha256(body) }],
  };
}

class MemoryCache {
  entries = new Map();

  async match(request) {
    return this.entries.get(request.url)?.clone();
  }

  async put(request, response) {
    this.entries.set(request.url, response.clone());
  }

  async delete(request) {
    return this.entries.delete(request.url);
  }
}

class MemoryCacheStorage {
  stores = new Map();

  async open(name) {
    if (!this.stores.has(name)) this.stores.set(name, new MemoryCache());
    return this.stores.get(name);
  }

  async keys() {
    return [...this.stores.keys()];
  }

  async delete(name) {
    return this.stores.delete(name);
  }
}

test('asset pack verifies the network response once and serves a verified cache hit later', async () => {
  const body = Buffer.from('reusable-scene');
  const storage = new MemoryCacheStorage();
  let requests = 0;
  let requestedUrl = '';
  const cache = new AssetPackCache(manifest('assets/scene.glb', body), {
    baseUrl: 'https://activity.example/game/',
    cacheStorage: storage,
    cryptoImpl: webcrypto,
    fetchImpl: async (url) => {
      requests += 1;
      requestedUrl = String(url);
      return new Response(body);
    },
  });

  assert.equal(await (await cache.fetch('assets/scene.glb')).text(), 'reusable-scene');
  assert.equal(cache.lastStatus.mode, 'network-cached');
  assert.equal(await (await cache.fetch('./assets/scene.glb')).text(), 'reusable-scene');
  assert.equal(cache.lastStatus.mode, 'cache-hit');
  assert.equal(requests, 1);
  assert.equal(requestedUrl, `https://activity.example/game/assets/scene.glb?${PACK_VERSION_QUERY}=${'a'.repeat(64)}`);
  assert.deepEqual([...storage.stores.get(cache.cacheName).entries.keys()], [requestedUrl]);
});

test('asset pack gives project adapter modules a pack-version URL without putting them in Cache API', async () => {
  const body = Buffer.from('export {};');
  const cache = new AssetPackCache(manifest('logic/custom-adapters.js', body, 'versioned-module'), {
    baseUrl: 'https://123.discordsays.com/game/',
    cacheStorage: new MemoryCacheStorage(),
    cryptoImpl: webcrypto,
    fetchImpl: async () => new Response(body),
  });
  const events = [];
  cache.addEventListener('statuschange', ({ detail }) => events.push(detail));

  assert.equal(cache.has('logic/custom-adapters.js'), true);
  assert.equal(
    cache.versionedUrl('logic/custom-adapters.js').toString(),
    `https://123.discordsays.com/game/logic/custom-adapters.js?${PACK_VERSION_QUERY}=${'a'.repeat(64)}`,
  );
  assert.deepEqual(events, [{
    mode: 'versioned-module',
    path: 'logic/custom-adapters.js',
    reason: '',
    cacheBustVersion: `sha256:${'a'.repeat(64)}`,
  }]);
  await assert.rejects(() => cache.fetch('logic/custom-adapters.js'), /versioned module URL/);
});

test('asset pack rejects corrupted network content and never caches it', async () => {
  const expected = Buffer.from('expected');
  const storage = new MemoryCacheStorage();
  const cache = new AssetPackCache(manifest('logic/blueprints.json', expected), {
    baseUrl: 'https://activity.example/',
    cacheStorage: storage,
    cryptoImpl: webcrypto,
    fetchImpl: async () => new Response('corrupted'),
  });

  await assert.rejects(() => cache.fetch('logic/blueprints.json'), /Byte length mismatch|SHA-256 mismatch/);
  const store = await storage.open(cache.cacheName);
  assert.equal(store.entries.size, 0);
});

test('asset pack falls back to ordinary network loading when browser cache primitives are unavailable', async () => {
  const body = Buffer.from('fallback-scene');
  const cache = new AssetPackCache(manifest('assets/scene.glb', body), {
    baseUrl: 'https://activity.example/',
    cacheStorage: undefined,
    cryptoImpl: undefined,
    fetchImpl: async () => new Response(body),
  });

  assert.equal(cache.enabled, false);
  assert.equal(await (await cache.fetch('assets/scene.glb')).text(), 'fallback-scene');
  assert.equal(cache.lastStatus.mode, 'network-only');
});

test('asset pack cleanup removes only stale exporter-owned cache versions', async () => {
  const body = Buffer.from('scene');
  const storage = new MemoryCacheStorage();
  storage.stores.set(`${CACHE_PREFIX}${'b'.repeat(64)}`, new MemoryCache());
  storage.stores.set(`${LEGACY_CACHE_PREFIX}${'c'.repeat(64)}`, new MemoryCache());
  storage.stores.set('another-application-cache', new MemoryCache());
  const cache = new AssetPackCache(manifest('assets/scene.glb', body), {
    baseUrl: 'https://activity.example/',
    cacheStorage: storage,
    cryptoImpl: webcrypto,
    fetchImpl: async () => new Response(body),
  });
  await storage.open(cache.cacheName);

  const removed = await cache.cleanupOldVersions();
  assert.deepEqual(removed.sort(), [
    `${CACHE_PREFIX}${'b'.repeat(64)}`,
    `${LEGACY_CACHE_PREFIX}${'c'.repeat(64)}`,
  ].sort());
  assert.deepEqual((await storage.keys()).sort(), ['another-application-cache', cache.cacheName].sort());
});

test('asset pack rejects traversal paths before making a request', () => {
  const body = Buffer.from('scene');
  assert.throws(() => new AssetPackCache({
    ...manifest('assets/scene.glb', body),
    resources: [{ path: '../secret', bytes: body.byteLength, sha256: sha256(body) }],
  }, {
    baseUrl: 'https://activity.example/',
    cacheStorage: new MemoryCacheStorage(),
    cryptoImpl: webcrypto,
    fetchImpl: async () => new Response(body),
  }), /Unsafe asset-pack path/);
  assert.throws(() => new AssetPackCache({
    ...manifest('assets/scene.glb', body),
    resources: [{ path: 'https://evil.example/scene.glb', bytes: body.byteLength, sha256: sha256(body) }],
  }, {
    baseUrl: 'https://activity.example/',
    cacheStorage: new MemoryCacheStorage(),
    cryptoImpl: webcrypto,
    fetchImpl: async () => new Response(body),
  }), /Unsafe asset-pack path/);
});
