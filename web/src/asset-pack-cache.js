const ASSET_PACK_SCHEMA = 'ue5-html5-asset-pack/v3';
const CONTENT_CACHE_NAME = 'ue5html5-asset-content-v1';
const PREVIOUS_CACHE_PREFIX = 'ue5html5-asset-pack-v2-';
const LEGACY_CACHE_PREFIX = 'ue5html5-asset-pack-v1-';
const PACK_VERSION_QUERY = 'ue5html5_pack';
const CACHE_DELIVERY = 'cache-api-integrity';
const MODULE_DELIVERY = 'versioned-module';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function normalizePath(value) {
  const path = String(value || '').replace(/^\.\//, '');
  let decodedSegments = [];
  try {
    decodedSegments = path.split('/').map((segment) => decodeURIComponent(segment));
  } catch {
    throw new Error(`Unsafe asset-pack path: ${value || '<empty>'}`);
  }
  if (!path
      || path.startsWith('/')
      || path.includes('\\')
      || /[:?#]/.test(path)
      || decodedSegments.some((segment) => !segment || segment === '.' || segment === '..' || /[/\\]/.test(segment))) {
    throw new Error(`Unsafe asset-pack path: ${value || '<empty>'}`);
  }
  return path;
}

function hex(bytes) {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function cloneResponse(bytes, response) {
  return new Response(bytes.slice(0), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export class AssetPackCache extends EventTarget {
  constructor(assetPack, {
    baseUrl = globalThis.location?.href,
    fetchImpl = globalThis.fetch?.bind(globalThis),
    cacheStorage = globalThis.caches,
    cryptoImpl = globalThis.crypto,
    storageManager = globalThis.navigator?.storage,
  } = {}) {
    super();
    this.assetPack = assetPack;
    this.baseUrl = new URL(baseUrl || 'http://localhost/');
    this.fetchImpl = fetchImpl;
    this.cacheStorage = cacheStorage;
    this.cryptoImpl = cryptoImpl;
    this.storageManager = storageManager;
    this.resources = new Map();
    this.version = '';
    this.cacheName = '';
    this.enabled = false;
    this.lastStatus = { mode: 'disabled', path: '', reason: 'No asset-pack manifest.' };
    this.persistence = { mode: 'disabled', reason: 'No asset-pack manifest.' };

    if (!assetPack) return;
    if (assetPack.schema !== ASSET_PACK_SCHEMA || assetPack.strategy !== 'origin-scoped-content-addressed-cache') {
      throw new Error(`Unsupported asset-pack contract: ${assetPack.schema || '<missing schema>'}`);
    }
    if (assetPack.integrity !== 'sha256'
        || assetPack.fallback !== 'network'
        || assetPack.cacheBusting !== 'pack-version-query'
        || assetPack.versionQuery !== PACK_VERSION_QUERY
        || assetPack.contentAddress !== 'resource-sha256'
        || assetPack.cacheReuse !== 'unchanged-resources-across-exports') {
      throw new Error('Asset-pack integrity and fallback policy is invalid.');
    }
    const version = String(assetPack.version || '').replace(/^sha256:/, '');
    if (!SHA256_PATTERN.test(version)) throw new Error('Asset-pack version must be a SHA-256 digest.');
    this.version = version;
    if (!Array.isArray(assetPack.resources)) throw new Error('Asset-pack resources must be an array.');
    for (const resource of assetPack.resources) {
      const path = normalizePath(resource?.path);
      if (this.resources.has(path)) throw new Error(`Duplicate asset-pack path: ${path}`);
      if (!Number.isSafeInteger(resource.bytes) || resource.bytes < 0 || !SHA256_PATTERN.test(resource.sha256 || '')) {
        throw new Error(`Invalid asset-pack resource metadata: ${path}`);
      }
      if (![CACHE_DELIVERY, MODULE_DELIVERY].includes(resource.delivery)) {
        throw new Error(`Invalid asset-pack delivery policy: ${path}`);
      }
      this.resources.set(path, { ...resource, path });
    }
    this.cacheName = CONTENT_CACHE_NAME;
    this.enabled = Boolean(fetchImpl && cacheStorage?.open && cryptoImpl?.subtle?.digest);
    this.lastStatus = this.enabled
      ? { mode: 'ready', path: '', reason: '' }
      : { mode: 'network-only', path: '', reason: 'Cache API or Web Crypto is unavailable.' };
    this.persistence = this.enabled && storageManager?.persisted
      ? { mode: 'unknown', reason: '' }
      : {
          mode: 'unsupported',
          reason: this.enabled
            ? 'Persistent browser storage is unavailable.'
            : 'The verified asset cache is unavailable.',
        };
  }

  status(mode, path = '', reason = '') {
    this.lastStatus = {
      mode,
      path,
      reason,
      cacheBustVersion: path && this.resources.has(path) ? `sha256:${this.version}` : '',
    };
    this.dispatchEvent(new CustomEvent('statuschange', { detail: this.lastStatus }));
  }

  persistenceStatus(mode, reason = '') {
    this.persistence = { mode, reason };
    this.dispatchEvent(new CustomEvent('persistencechange', { detail: this.persistence }));
    return this.persistence;
  }

  get canRequestPersistence() {
    return Boolean(this.enabled && this.storageManager?.persist);
  }

  async checkPersistence() {
    if (!this.enabled) {
      return this.persistenceStatus('unsupported', 'The verified asset cache is unavailable.');
    }
    if (!this.storageManager?.persisted) {
      return this.persistenceStatus('unsupported', 'Persistent browser storage is unavailable.');
    }
    this.persistenceStatus('checking');
    try {
      const persistent = await this.storageManager.persisted();
      return this.persistenceStatus(
        persistent ? 'persistent' : 'best-effort',
        persistent ? '' : 'The browser may automatically evict cached assets.',
      );
    } catch (error) {
      return this.persistenceStatus('error', error.message || String(error));
    }
  }

  async requestPersistence() {
    if (!this.canRequestPersistence) {
      return this.persistenceStatus('unsupported', 'Persistent browser storage is unavailable.');
    }
    if (this.storageManager?.persisted) {
      try {
        if (await this.storageManager.persisted()) return this.persistenceStatus('persistent');
      } catch (error) {
        return this.persistenceStatus('error', error.message || String(error));
      }
    }
    this.persistenceStatus('requesting');
    try {
      const granted = await this.storageManager.persist();
      return this.persistenceStatus(
        granted ? 'persistent' : 'denied',
        granted ? '' : 'The browser kept normal best-effort storage.',
      );
    } catch (error) {
      return this.persistenceStatus('error', error.message || String(error));
    }
  }

  has(pathValue) {
    return this.resources.has(normalizePath(pathValue));
  }

  versionedUrl(pathValue) {
    const path = normalizePath(pathValue);
    const resource = this.resources.get(path);
    if (!resource) throw new Error(`Resource is not part of the exported asset pack: ${path}`);
    const url = new URL(path, this.baseUrl);
    url.searchParams.set(PACK_VERSION_QUERY, this.version);
    if (resource.delivery === MODULE_DELIVERY) this.status('versioned-module', path);
    return url;
  }

  contentRequest(resource) {
    const url = new URL(`.ue5html5-cache/sha256/${resource.sha256}`, `${this.baseUrl.origin}/`);
    return new Request(url);
  }

  async verify(response, resource) {
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${resource.path}`);
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength !== resource.bytes) {
      throw new Error(`Byte length mismatch for ${resource.path}: expected ${resource.bytes}, received ${bytes.byteLength}.`);
    }
    const digest = hex(await this.cryptoImpl.subtle.digest('SHA-256', bytes));
    if (digest !== resource.sha256) throw new Error(`SHA-256 mismatch for ${resource.path}.`);
    return { bytes, response };
  }

  async network(path, resource, { verify = true } = {}) {
    if (!this.fetchImpl) throw new Error('Fetch is unavailable in this browser.');
    const response = await this.fetchImpl(this.versionedUrl(path), { cache: 'no-store' });
    if (!verify) return response;
    const checked = await this.verify(response, resource);
    return cloneResponse(checked.bytes, checked.response);
  }

  async fetch(pathValue) {
    const path = normalizePath(pathValue);
    const resource = this.resources.get(path);
    if (!resource) {
      this.status('network-unmanaged', path, 'Resource is not part of the exported asset pack.');
      if (!this.fetchImpl) throw new Error('Fetch is unavailable in this browser.');
      return this.fetchImpl(new URL(path, this.baseUrl), { cache: 'no-store' });
    }
    if (resource.delivery !== CACHE_DELIVERY) {
      throw new Error(`Resource must use its versioned module URL instead of Cache API fetch: ${path}`);
    }
    if (!this.enabled) {
      this.status('network-only', path, this.lastStatus.reason);
      return this.network(path, resource, { verify: false });
    }

    let cache;
    try {
      cache = await this.cacheStorage.open(this.cacheName);
    } catch (error) {
      this.status('network-fallback', path, error.message || String(error));
      return this.network(path, resource);
    }

    const request = this.contentRequest(resource);
    let cached = null;
    try {
      cached = await cache.match(request);
    } catch (error) {
      this.status('network-fallback', path, error.message || String(error));
      return this.network(path, resource);
    }
    if (cached) {
      try {
        const checked = await this.verify(cached, resource);
        this.status('cache-hit', path);
        return cloneResponse(checked.bytes, checked.response);
      } catch (error) {
        await cache.delete(request).catch(() => false);
        this.status('cache-rejected', path, error.message || String(error));
      }
    }

    const response = await this.network(path, resource);
    try {
      await cache.put(request, response.clone());
      this.status('network-cached', path);
      void this.cleanupOldVersions().catch(() => []);
    } catch (error) {
      this.status('network-fallback', path, error.message || String(error));
    }
    return response;
  }

  async cleanupOldVersions() {
    if (!this.enabled || !this.cacheStorage.keys) return [];
    const names = await this.cacheStorage.keys();
    const stale = names.filter((name) => (
      name.startsWith(PREVIOUS_CACHE_PREFIX) || name.startsWith(LEGACY_CACHE_PREFIX)
    ));
    await Promise.all(stale.map((name) => this.cacheStorage.delete(name)));
    return stale;
  }
}

export function createAssetPackCache(assetPack, options) {
  return new AssetPackCache(assetPack, options);
}

export {
  ASSET_PACK_SCHEMA,
  CACHE_DELIVERY,
  CONTENT_CACHE_NAME,
  LEGACY_CACHE_PREFIX,
  MODULE_DELIVERY,
  PACK_VERSION_QUERY,
  PREVIOUS_CACHE_PREFIX,
};
