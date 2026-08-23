export const PROJECT_ADAPTER_SCHEMA = 'ue5-html5-custom-adapters/v1';

export function normalizeAdapterName(value) {
  return String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

export function validateProjectAdapterManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('logic/custom-adapters.json must contain an object.');
  }
  if (value.schema !== PROJECT_ADAPTER_SCHEMA) {
    throw new Error(`logic/custom-adapters.json must use ${PROJECT_ADAPTER_SCHEMA}.`);
  }
  if (!Array.isArray(value.functions)) {
    throw new Error('logic/custom-adapters.json.functions must be an array.');
  }

  const normalizedNames = new Set();
  const functions = value.functions.map((rawName, index) => {
    if (typeof rawName !== 'string' || !rawName.trim() || rawName.length > 128) {
      throw new Error(`logic/custom-adapters.json.functions[${index}] must be a non-empty string of at most 128 characters.`);
    }
    const name = rawName.trim();
    const normalized = normalizeAdapterName(name);
    if (!normalized) {
      throw new Error(`logic/custom-adapters.json.functions[${index}] has no letters or numbers.`);
    }
    if (normalizedNames.has(normalized)) {
      throw new Error(`logic/custom-adapters.json declares the duplicate function ${name}.`);
    }
    normalizedNames.add(normalized);
    return name;
  });
  return { schema: PROJECT_ADAPTER_SCHEMA, functions };
}

export async function loadProjectAdapters({
  manifestUrl,
  moduleUrl,
  fetchImpl = globalThis.fetch,
  importModule = (url) => import(/* @vite-ignore */ url),
  isRegistered,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required to load project adapters.');
  if (typeof importModule !== 'function') throw new Error('A module importer is required to load project adapters.');
  if (typeof isRegistered !== 'function') throw new Error('A registration lookup is required to load project adapters.');

  const response = await fetchImpl(manifestUrl, { cache: 'no-store' });
  if (!response?.ok) throw new Error(`Could not load logic/custom-adapters.json (HTTP ${response?.status ?? 'unknown'}).`);
  const manifest = validateProjectAdapterManifest(await response.json());
  await importModule(String(moduleUrl));

  const missing = manifest.functions.filter((name) => !isRegistered(name));
  if (missing.length) {
    throw new Error(`Project adapter module did not register: ${missing.join(', ')}.`);
  }
  return Object.freeze({
    schema: manifest.schema,
    functions: Object.freeze([...manifest.functions]),
    runtimeValidationRequired: manifest.functions.length > 0,
  });
}
