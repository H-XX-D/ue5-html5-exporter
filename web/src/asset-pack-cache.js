const ASSET_PACK_SCHEMA = 'ue5-html5-asset-pack/v1';
const CACHE_PREFIX = 'ue5html5-asset-pack-v1-';
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
  } = {}) {
    super();
    this.assetPack = assetPack;
    this.baseUrl = new URL(baseUrl || 'http://localhost/');
    this.fetchImpl = fetchImpl;
    this.cacheStorage = cacheStorage;
    this.cryptoImpl = cryptoImpl;
    this.resources = new Map();
    this.cacheName = '';
    this.enabled = false;
    this.lastStatus = { mode: 'disabled', path: '', reason: 'No asset-pack manifest.' };

    if (!assetPack) return;
    if (assetPack.schema !== ASSET_PACK_SCHEMA || assetPack.strategy !== 'origin-scoped-cache-api') {
      throw new Error(`Unsupported asset-pack contract: ${assetPack.schema || '<missing schema>'}`);
    }
    if (assetPack.integrity !== 'sha256' || assetPack.fallback !== 'network') {
      throw new Error('Asset-pack integrity and fallback policy is invalid.');
    }
    const version = String(assetPack.version || '').replace(/^sha256:/, '');
    if (!SHA256_PATTERN.test(version)) throw new Error('Asset-pack version must be a SHA-256 digest.');
    if (!Array.isArray(assetPack.resources)) throw new Error('Asset-pack resources must be an array.');
    for (const resource of assetPack.resources) {
      const path = normalizePath(resource?.path);
      if (this.resources.has(path)) throw new Error(`Duplicate asset-pack path: ${path}`);
      if (!Number.isSafeInteger(resource.bytes) || resource.bytes < 0 || !SHA256_PATTERN.test(resource.sha256 || '')) {
        throw new Error(`Invalid asset-pack resource metadata: ${path}`);
      }
      this.resources.set(path, { ...resource, path });
    }
    this.cacheName = `${CACHE_PREFIX}${version}`;
    this.enabled = Boolean(fetchImpl && cacheStorage?.open && cryptoImpl?.subtle?.digest);
    this.lastStatus = this.enabled
      ? { mode: 'ready', path: '', reason: '' }
      : { mode: 'network-only', path: '', reason: 'Cache API or Web Crypto is unavailable.' };
  }

  status(mode, path = '', reason = '') {
    this.lastStatus = { mode, path, reason };
    this.dispatchEvent(new CustomEvent('statuschange', { detail: this.lastStatus }));
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
    const response = await this.fetchImpl(new URL(path, this.baseUrl), { cache: 'no-store' });
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

    const request = new Request(new URL(path, this.baseUrl));
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
    const stale = names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== this.cacheName);
    await Promise.all(stale.map((name) => this.cacheStorage.delete(name)));
    return stale;
  }
}

export function createAssetPackCache(assetPack, options) {
  return new AssetPackCache(assetPack, options);
}

export { ASSET_PACK_SCHEMA, CACHE_PREFIX };
