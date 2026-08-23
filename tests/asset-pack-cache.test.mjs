import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { test } from 'node:test';

import {
  AssetPackCache,
  CONTENT_CACHE_NAME,
  LEGACY_CACHE_PREFIX,
  PACK_VERSION_QUERY,
  PREVIOUS_CACHE_PREFIX,
} from '../web/src/asset-pack-cache.js';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function manifest(path, body, delivery = 'cache-api-integrity', version = 'a'.repeat(64)) {
  return {
    schema: 'ue5-html5-asset-pack/v3',
    strategy: 'origin-scoped-content-addressed-cache',
    version: `sha256:${version}`,
    cacheBusting: 'pack-version-query',
    versionQuery: PACK_VERSION_QUERY,
    contentAddress: 'resource-sha256',
    cacheReuse: 'unchanged-resources-across-exports',
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
  assert.equal(cache.cacheName, CONTENT_CACHE_NAME);
  assert.deepEqual([...storage.stores.get(cache.cacheName).entries.keys()], [
    `https://activity.example/.ue5html5-cache/sha256/${sha256(body)}`,
  ]);
});

test('unchanged resource bytes are reused after the Unreal export and resource path change', async () => {
  const body = Buffer.from('shared-texture-or-audio');
  const storage = new MemoryCacheStorage();
  let requests = 0;
  const first = new AssetPackCache(manifest('assets/audio/fire.wav', body, 'cache-api-integrity', 'a'.repeat(64)), {
    baseUrl: 'https://123.discordsays.com/game/',
    cacheStorage: storage,
    cryptoImpl: webcrypto,
    fetchImpl: async () => { requests += 1; return new Response(body); },
  });
  const second = new AssetPackCache(manifest('assets/audio/shared/fire.wav', body, 'cache-api-integrity', 'b'.repeat(64)), {
    baseUrl: 'https://123.discordsays.com/game/',
    cacheStorage: storage,
    cryptoImpl: webcrypto,
    fetchImpl: async () => { requests += 1; return new Response(body); },
  });

  assert.equal(await (await first.fetch('assets/audio/fire.wav')).text(), 'shared-texture-or-audio');
  assert.equal(first.lastStatus.mode, 'network-cached');
  assert.equal(await (await second.fetch('assets/audio/shared/fire.wav')).text(), 'shared-texture-or-audio');
  assert.equal(second.lastStatus.mode, 'cache-hit');
  assert.equal(requests, 1);
  assert.equal(first.cacheName, second.cacheName);
});

test('changed resource bytes use a different content address and cannot reuse stale data', async () => {
  const oldBody = Buffer.from('old-scene');
  const newBody = Buffer.from('new-scene');
  const storage = new MemoryCacheStorage();
  let requests = 0;
  const first = new AssetPackCache(manifest('assets/scene.glb', oldBody, 'cache-api-integrity', 'a'.repeat(64)), {
    baseUrl: 'https://123.discordsays.com/game/', cacheStorage: storage, cryptoImpl: webcrypto,
    fetchImpl: async () => { requests += 1; return new Response(oldBody); },
  });
  const second = new AssetPackCache(manifest('assets/scene.glb', newBody, 'cache-api-integrity', 'b'.repeat(64)), {
    baseUrl: 'https://123.discordsays.com/game/', cacheStorage: storage, cryptoImpl: webcrypto,
    fetchImpl: async () => { requests += 1; return new Response(newBody); },
  });

  await first.fetch('assets/scene.glb');
  assert.equal(await (await second.fetch('assets/scene.glb')).text(), 'new-scene');
  assert.equal(second.lastStatus.mode, 'network-cached');
  assert.equal(requests, 2);
  assert.equal(storage.stores.get(CONTENT_CACHE_NAME).entries.size, 2);
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

test('asset pack checks existing persistent storage without prompting', async () => {
  const body = Buffer.from('persistent-scene');
  let requests = 0;
  const cache = new AssetPackCache(manifest('assets/scene.glb', body), {
    baseUrl: 'https://123.discordsays.com/',
    cacheStorage: new MemoryCacheStorage(),
    cryptoImpl: webcrypto,
    fetchImpl: async () => new Response(body),
    storageManager: {
      persisted: async () => true,
      persist: async () => { requests += 1; return true; },
    },
  });

  assert.deepEqual(await cache.checkPersistence(), { mode: 'persistent', reason: '' });
  assert.equal(requests, 0);
});

test('asset pack requests persistence only when explicitly invoked and keeps denial non-fatal', async () => {
  const body = Buffer.from('best-effort-scene');
  const events = [];
  let requests = 0;
  const cache = new AssetPackCache(manifest('assets/scene.glb', body), {
    baseUrl: 'https://123.discordsays.com/',
    cacheStorage: new MemoryCacheStorage(),
    cryptoImpl: webcrypto,
    fetchImpl: async () => new Response(body),
    storageManager: {
      persisted: async () => false,
      persist: async () => { requests += 1; return false; },
    },
  });
  cache.addEventListener('persistencechange', ({ detail }) => events.push(detail));

  assert.deepEqual(await cache.checkPersistence(), {
    mode: 'best-effort', reason: 'The browser may automatically evict cached assets.',
  });
  assert.equal(requests, 0);
  assert.deepEqual(await cache.requestPersistence(), {
    mode: 'denied', reason: 'The browser kept normal best-effort storage.',
  });
  assert.equal(requests, 1);
  assert.equal(await (await cache.fetch('assets/scene.glb')).text(), 'best-effort-scene');
  assert.deepEqual(events.map(({ mode }) => mode), ['checking', 'best-effort', 'requesting', 'denied']);
});

test('asset pack reports a granted persistence request without changing the cache contract', async () => {
  const body = Buffer.from('protected-scene');
  let persistent = false;
  const cache = new AssetPackCache(manifest('assets/scene.glb', body), {
    baseUrl: 'https://123.discordsays.com/',
    cacheStorage: new MemoryCacheStorage(),
    cryptoImpl: webcrypto,
    fetchImpl: async () => new Response(body),
    storageManager: {
      persisted: async () => persistent,
      persist: async () => { persistent = true; return true; },
    },
  });

  assert.deepEqual(await cache.requestPersistence(), { mode: 'persistent', reason: '' });
  assert.equal(cache.persistence.mode, 'persistent');
  assert.equal(await (await cache.fetch('assets/scene.glb')).text(), 'protected-scene');
  assert.equal(cache.lastStatus.mode, 'network-cached');
});

test('asset pack reports persistent storage as unsupported without collecting quota data', async () => {
  const body = Buffer.from('unsupported-persistence-scene');
  let estimates = 0;
  const cache = new AssetPackCache(manifest('assets/scene.glb', body), {
    baseUrl: 'https://activity.example/',
    cacheStorage: new MemoryCacheStorage(),
    cryptoImpl: webcrypto,
    fetchImpl: async () => new Response(body),
    storageManager: {
      estimate: async () => { estimates += 1; return { usage: 1, quota: 2 }; },
    },
  });

  assert.equal(cache.canRequestPersistence, false);
  assert.deepEqual(await cache.checkPersistence(), {
    mode: 'unsupported', reason: 'Persistent browser storage is unavailable.',
  });
  assert.deepEqual(await cache.requestPersistence(), {
    mode: 'unsupported', reason: 'Persistent browser storage is unavailable.',
  });
  assert.equal(estimates, 0);
});

test('asset pack cleanup removes superseded version caches but preserves the content cache and unrelated caches', async () => {
  const body = Buffer.from('scene');
  const storage = new MemoryCacheStorage();
  storage.stores.set(`${PREVIOUS_CACHE_PREFIX}${'b'.repeat(64)}`, new MemoryCache());
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
    `${PREVIOUS_CACHE_PREFIX}${'b'.repeat(64)}`,
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
