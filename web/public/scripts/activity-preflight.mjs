import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

export const REQUIRED_ENVIRONMENT = [
  'DISCORD_CLIENT_ID',
  'DISCORD_CLIENT_SECRET',
  'DISCORD_BOT_TOKEN',
  'SUPABASE_URL',
  'SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_SECRET_KEY',
  'ACTIVITY_STATE_SECRET',
];

export const REQUIRED_EXPORT_FILES = [
  'index.html',
  'assets/scene.glb',
  'logic/blueprints.json',
  'logic/custom-adapters.json',
  'logic/custom-adapters.js',
  'export-manifest.json',
  'activity-handoff.json',
  '.env.example',
  'api/activity.mjs',
  'serve.py',
  'preview-discord-activity.cmd',
  'preview-discord-activity.command',
  'preview-discord-activity.sh',
  'release-discord-activity.cmd',
  'release-discord-activity.command',
  'release-discord-activity.sh',
  'scripts/Start-DiscordActivityRelease.ps1',
  'scripts/activity-release-assistant.mjs',
  'scripts/activity-release.mjs',
  'supabase/migrations/20260822094350_discord_activity_core.sql',
  'supabase/migrations/20260823011755_optimize_discord_activity_realtime_rls.sql',
  'supabase/migrations/20260823011922_restrict_discord_activity_service_role_privileges.sql',
  'vercel.json',
  'package.json',
];

export const REQUIRED_EXPORT_PATTERNS = [
  { directory: 'runtime', pattern: /^viewer-[A-Za-z0-9_-]+\.js$/, label: 'runtime/viewer-<hash>.js' },
  { directory: 'runtime', pattern: /^discord-activity-[A-Za-z0-9_-]+\.js$/, label: 'runtime/discord-activity-<hash>.js' },
  { directory: 'runtime', pattern: /^index-[A-Za-z0-9_-]+\.css$/, label: 'runtime/index-<hash>.css' },
];

const SERVER_SECRET_NAMES = [
  'DISCORD_CLIENT_SECRET',
  'DISCORD_BOT_TOKEN',
  'SUPABASE_SECRET_KEY',
  'SUPABASE_JWT_PRIVATE_KEY',
  'ACTIVITY_STATE_SECRET',
];

const PUBLIC_TEXT_ROOTS = ['index.html', 'runtime', 'logic', 'export-manifest.json', 'activity-handoff.json'];
const DISCORD_API = 'https://discord.com/api/v10';
const DISCORD_EMBEDDED_FLAG = 1n << 17n;
const DISCORD_PRIMARY_ENTRY_POINT = 4;
const DISCORD_LAUNCH_ACTIVITY_HANDLER = 2;
const ONLINE_TIMEOUT_MS = 10_000;
const CURRENT_HANDOFF_SCHEMA = 'ue5-discord-activity-handoff/v6';
const HANDOFF_SCHEMAS = new Set([
  'ue5-discord-activity-handoff/v4',
  'ue5-discord-activity-handoff/v5',
  CURRENT_HANDOFF_SCHEMA,
]);
const CURRENT_MANIFEST_SCHEMA = 'ue5-html5-export/v5';
const MANIFEST_SCHEMAS = new Set([
  'ue5-html5-export/v2',
  'ue5-html5-export/v3',
  'ue5-html5-export/v4',
  CURRENT_MANIFEST_SCHEMA,
]);
const ASSET_DELIVERY_SCHEMA = 'ue5-html5-export/v3';
const ASSET_PACK_SCHEMA = 'ue5-html5-asset-pack/v1';
const PROJECT_ADAPTER_SCHEMA = 'ue5-html5-custom-adapters/v1';
const ASSET_DELIVERY_PATHS = ['index.html', 'runtime/**', 'assets/**', 'logic/**'];
const REQUIRED_PROJECT_TARGETS = [
  ['discordApplicationId', 'Discord Application ID'],
  ['discordPublicKey', 'Discord Public Key'],
  ['vercelProjectName', 'Vercel Project Name'],
  ['supabaseProjectRef', 'Supabase Project Ref'],
];
const PROJECT_TARGET_KEYS = new Set([
  'source',
  'containsSecrets',
  'configured',
  'discordApplicationId',
  'discordPublicKey',
  'vercelProjectName',
  'supabaseProjectRef',
  'productionUrl',
  'missingRequiredTargets',
]);
const SECRET_TARGET_KEY = /(?:secret|token|password|private.?key|bot.?token|service.?role)/i;

function placeholder(value) {
  return !value || /(?:replace[_ -]?me|your[_ -]|\.\.\.)/i.test(value);
}

function publicTextFiles(root) {
  const files = [];
  const visit = (path) => {
    if (!existsSync(path)) return;
    const info = statSync(path);
    if (info.isDirectory()) {
      for (const entry of readdirSync(path)) visit(join(path, entry));
      return;
    }
    if (/\.(?:html|css|js|json|txt|md)$/i.test(path)) files.push(path);
  };
  for (const path of PUBLIC_TEXT_ROOTS) visit(join(root, path));
  return files;
}

function readJsonArtifact(root, path, errors) {
  const file = join(root, path);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    errors.push(`Export artifact contains invalid JSON: ${path}`);
    return null;
  }
}

function browserArtifactFiles(root) {
  const files = [];
  const addFile = (path) => {
    if (existsSync(path) && statSync(path).isFile()) files.push(path);
  };
  const addDirectory = (path) => {
    if (!existsSync(path) || !statSync(path).isDirectory()) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) addDirectory(child);
      else if (entry.isFile()) files.push(child);
    }
  };
  addFile(join(root, 'index.html'));
  for (const directory of ['runtime', 'assets', 'logic']) addDirectory(join(root, directory));
  return files.sort((left, right) => {
    const leftPath = relative(root, left).split('\\').join('/');
    const rightPath = relative(root, right).split('\\').join('/');
    return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
  });
}

function browserPayloadMetrics(root) {
  const sizes = new Map();
  let largestArtifactPath = '';
  let largestArtifactBytes = 0;
  for (const file of browserArtifactFiles(root)) {
    const path = relative(root, file).split('\\').join('/');
    const size = statSync(file).size;
    sizes.set(path, size);
    if (size > largestArtifactBytes
        || (size === largestArtifactBytes && (!largestArtifactPath || path < largestArtifactPath))) {
      largestArtifactPath = path;
      largestArtifactBytes = size;
    }
  }
  const sumPrefix = (prefix) => [...sizes]
    .filter(([path]) => path.startsWith(`${prefix}/`))
    .reduce((total, [, size]) => total + size, 0);
  const indexBytes = sizes.get('index.html') || 0;
  const runtimeBytes = sumPrefix('runtime');
  const assetBytes = sumPrefix('assets');
  const logicBytes = sumPrefix('logic');
  return {
    browserPayloadBytes: indexBytes + runtimeBytes + assetBytes + logicBytes,
    indexBytes,
    runtimeBytes,
    assetBytes,
    sceneBytes: sizes.get('assets/scene.glb') || 0,
    logicBytes,
    largestArtifactPath,
    largestArtifactBytes,
  };
}

function validateAssetDelivery(root, manifest, handoff, errors, warnings) {
  const required = [ASSET_DELIVERY_SCHEMA, 'ue5-html5-export/v4', CURRENT_MANIFEST_SCHEMA].includes(manifest.schema);
  const manifestDelivery = manifest.assetDelivery;
  const handoffDelivery = handoff.assetDelivery;
  if (!manifestDelivery && !handoffDelivery && !required) {
    warnings.push('Legacy v2 export has no exact browser payload metrics; export again with the current plugin before performance review.');
    return;
  }
  if (!manifestDelivery || typeof manifestDelivery !== 'object' || Array.isArray(manifestDelivery)) {
    errors.push('export-manifest.json.assetDelivery must be an object for schema v3.');
    return;
  }
  if (!handoffDelivery || typeof handoffDelivery !== 'object' || Array.isArray(handoffDelivery)) {
    errors.push('activity-handoff.json.assetDelivery must match the manifest.');
    return;
  }
  const actual = browserPayloadMetrics(root);
  const budget = manifestDelivery.advisoryBudgetBytes;
  if (!Number.isSafeInteger(budget) || budget <= 0) {
    errors.push('assetDelivery.advisoryBudgetBytes must be a positive safe integer.');
    return;
  }
  if (manifestDelivery.advisoryOnly !== true || handoffDelivery.advisoryOnly !== true) {
    errors.push('assetDelivery.advisoryOnly must be true; the budget is not a Discord platform limit.');
  }
  if (JSON.stringify(manifestDelivery.measuredPaths) !== JSON.stringify(ASSET_DELIVERY_PATHS)
      || JSON.stringify(handoffDelivery.measuredPaths) !== JSON.stringify(ASSET_DELIVERY_PATHS)) {
    errors.push(`assetDelivery.measuredPaths must equal ${JSON.stringify(ASSET_DELIVERY_PATHS)}.`);
  }
  for (const [name, value] of Object.entries(actual)) {
    if (manifestDelivery[name] !== value) {
      errors.push(`export-manifest.json.assetDelivery.${name} does not match the exported files.`);
    }
    if (handoffDelivery[name] !== value) {
      errors.push(`activity-handoff.json.assetDelivery.${name} does not match the exported files.`);
    }
  }
  if (handoffDelivery.advisoryBudgetBytes !== budget) {
    errors.push('Asset advisory budget mismatch between manifest and handoff.');
  }
  const expectedStatus = actual.browserPayloadBytes > budget
    ? 'exceeds-advisory-budget'
    : 'within-advisory-budget';
  if (manifestDelivery.status !== expectedStatus || handoffDelivery.status !== expectedStatus) {
    errors.push(`assetDelivery.status must be ${expectedStatus}.`);
  }
  if (expectedStatus === 'exceeds-advisory-budget') {
    const payloadMiB = (actual.browserPayloadBytes / 1024 / 1024).toFixed(1);
    const budgetMiB = (budget / 1024 / 1024).toFixed(1);
    warnings.push(`Primary browser payload is ${payloadMiB} MiB, above the ${budgetMiB} MiB project advisory budget; optimize assets and test real Discord clients.`);
  }
}

function assetPackFiles(root) {
  const files = [];
  const visit = (directory) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) files.push(child);
    }
  };
  visit(join(root, 'assets'));
  for (const path of ['logic/blueprints.json', 'logic/custom-adapters.json']) {
    const file = join(root, path);
    if (existsSync(file) && statSync(file).isFile()) files.push(file);
  }
  return files.sort((left, right) => relative(root, left).localeCompare(relative(root, right)));
}

function validateAssetPack(root, manifest, handoff, errors, warnings) {
  const required = manifest.schema === CURRENT_MANIFEST_SCHEMA || handoff.schema === CURRENT_HANDOFF_SCHEMA;
  const manifestPack = manifest.assetPack;
  const handoffPack = handoff.assetPack;
  if (!manifestPack && !handoffPack && !required) {
    warnings.push('Legacy export has no reusable origin-scoped asset pack; export again with the current plugin to enable verified client caching.');
    return;
  }
  if (!manifestPack || typeof manifestPack !== 'object' || Array.isArray(manifestPack)) {
    errors.push('export-manifest.json.assetPack must describe the reusable browser asset pack.');
    return;
  }
  if (!handoffPack || JSON.stringify(handoffPack) !== JSON.stringify(manifestPack)) {
    errors.push('activity-handoff.json.assetPack must exactly match export-manifest.json.assetPack.');
    return;
  }
  if (manifestPack.schema !== ASSET_PACK_SCHEMA
      || manifestPack.strategy !== 'origin-scoped-cache-api'
      || manifestPack.runtimeStrategy !== 'content-hashed-http-cache'
      || manifestPack.scope !== 'activity-origin'
      || manifestPack.integrity !== 'sha256'
      || manifestPack.fallback !== 'network') {
    errors.push(`assetPack must use the ${ASSET_PACK_SCHEMA} origin-scoped cache contract.`);
  }
  if (!Array.isArray(manifestPack.resources)) {
    errors.push('assetPack.resources must be an array.');
    return;
  }

  const actualFiles = assetPackFiles(root);
  const actualPaths = actualFiles.map((file) => relative(root, file).split('\\').join('/'));
  const declaredPaths = manifestPack.resources.map((resource) => String(resource?.path || ''));
  if (JSON.stringify(declaredPaths) !== JSON.stringify([...declaredPaths].sort())) {
    errors.push('assetPack.resources must be sorted by path.');
  }
  if (new Set(declaredPaths).size !== declaredPaths.length) {
    errors.push('assetPack.resources contains duplicate paths.');
  }
  if (JSON.stringify(declaredPaths) !== JSON.stringify(actualPaths)) {
    errors.push('assetPack.resources must include every exported assets/** file plus the Blueprint IR and adapter manifest, with no extra paths.');
  }

  let total = 0;
  let canonical = '';
  for (let index = 0; index < manifestPack.resources.length; index += 1) {
    const resource = manifestPack.resources[index];
    const path = declaredPaths[index];
    let decodedSegments = [];
    try {
      decodedSegments = path.split('/').map((segment) => decodeURIComponent(segment));
    } catch {
      decodedSegments = ['..'];
    }
    if (!path
        || path.startsWith('/')
        || path.includes('\\')
        || /[:?#]/.test(path)
        || decodedSegments.some((segment) => !segment || segment === '.' || segment === '..' || /[/\\]/.test(segment))) {
      errors.push(`assetPack.resources[${index}].path is unsafe.`);
      continue;
    }
    const file = join(root, path);
    if (!existsSync(file) || !statSync(file).isFile()) continue;
    const bytes = statSync(file).size;
    const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
    if (!Number.isSafeInteger(resource.bytes) || resource.bytes !== bytes) {
      errors.push(`assetPack resource byte count does not match ${path}.`);
    }
    if (!/^[a-f0-9]{64}$/.test(resource.sha256 || '') || resource.sha256 !== digest) {
      errors.push(`assetPack SHA-256 does not match ${path}.`);
    }
    const expectedKind = path === 'assets/scene.glb' ? 'scene'
      : path === 'logic/blueprints.json' ? 'blueprint-ir'
        : path === 'logic/custom-adapters.json' ? 'adapter-manifest' : 'asset';
    if (resource.kind !== expectedKind) errors.push(`assetPack resource kind does not match ${path}.`);
    total += bytes;
    canonical += `${path}\n${bytes}\n${digest}\n`;
  }
  const version = `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
  if (manifestPack.version !== version) errors.push('assetPack.version does not match its canonical resource index.');
  if (!Number.isSafeInteger(manifestPack.bytes) || manifestPack.bytes !== total) {
    errors.push('assetPack.bytes does not match the declared resources.');
  }
}

function compatibilityCounts(value, label, errors, requireAdapterCounts = false) {
  if (!value || typeof value !== 'object') {
    errors.push(`${label} is missing Blueprint compatibility counts.`);
    return null;
  }
  const result = {};
  for (const name of ['blueprintCount', 'nodeCount', 'supportedNodeCount', 'unsupportedNodeCount']) {
    const count = value[name];
    if (!Number.isInteger(count) || count < 0) {
      errors.push(`${label}.${name} must be a non-negative integer.`);
      return null;
    }
    result[name] = count;
  }
  if (result.supportedNodeCount + result.unsupportedNodeCount !== result.nodeCount) {
    errors.push(`${label} supported and unsupported counts do not add up to nodeCount.`);
  }
  if (requireAdapterCounts) {
    for (const name of ['builtInSupportedNodeCount', 'customAdapterNodeCount']) {
      const count = value[name];
      if (!Number.isInteger(count) || count < 0) {
        errors.push(`${label}.${name} must be a non-negative integer.`);
        return null;
      }
      result[name] = count;
    }
    if (result.builtInSupportedNodeCount + result.customAdapterNodeCount !== result.supportedNodeCount) {
      errors.push(`${label} built-in and project-adapter counts do not add up to supportedNodeCount.`);
    }
  }
  return result;
}

function normalizedAdapterName(value) {
  return String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function validateProjectAdapters(root, logic, errors, warnings) {
  const manifest = readJsonArtifact(root, 'logic/custom-adapters.json', errors);
  if (!manifest) return null;
  if (manifest.schema !== PROJECT_ADAPTER_SCHEMA || !Array.isArray(manifest.functions)) {
    errors.push(`logic/custom-adapters.json must use ${PROJECT_ADAPTER_SCHEMA} with a functions array.`);
    return null;
  }
  const declared = new Set();
  for (const [index, value] of manifest.functions.entries()) {
    const name = typeof value === 'string' ? value.trim() : '';
    const normalized = normalizedAdapterName(name);
    if (!name || name.length > 128 || !normalized) {
      errors.push(`logic/custom-adapters.json.functions[${index}] must be a non-empty string of at most 128 characters.`);
      continue;
    }
    if (declared.has(normalized)) errors.push(`logic/custom-adapters.json declares duplicate function ${name}.`);
    declared.add(normalized);
  }
  if (logic.projectAdapters?.schema !== PROJECT_ADAPTER_SCHEMA
      || logic.projectAdapters?.manifest !== 'logic/custom-adapters.json'
      || logic.projectAdapters?.module !== 'logic/custom-adapters.js'
      || logic.projectAdapters?.declaredFunctionCount !== declared.size) {
    errors.push('logic/blueprints.json projectAdapters contract does not match logic/custom-adapters.json.');
  }

  const covered = (logic.programs || []).flatMap((program) => program?.compatibility?.projectAdapters || []);
  for (const coverage of covered) {
    if (!declared.has(normalizedAdapterName(coverage?.function))) {
      errors.push(`Blueprint node claims undeclared project adapter coverage: ${coverage?.function || '<missing function>'}.`);
    }
    if (coverage?.runtimeValidationRequired !== true) {
      errors.push('Project-adapter-covered Blueprint nodes must retain runtimeValidationRequired=true.');
    }
  }
  if (declared.size > 0 && covered.length === 0) {
    warnings.push('Project adapters are declared but no exported Blueprint nodes use them.');
  }
  return { declaredCount: declared.size, coveredCount: covered.length };
}

function validateProjectTargets(value, errors) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push('activity-handoff.json.projectTargets must be an object.');
    return;
  }
  for (const key of Object.keys(value)) {
    if (!PROJECT_TARGET_KEYS.has(key) || (key !== 'containsSecrets' && SECRET_TARGET_KEY.test(key))) {
      errors.push(`activity-handoff.json.projectTargets contains forbidden field: ${key}.`);
    }
  }
  if (value.containsSecrets !== false) {
    errors.push('activity-handoff.json.projectTargets.containsSecrets must be false.');
  }
  const appId = String(value.discordApplicationId || '');
  const publicKey = String(value.discordPublicKey || '');
  const vercelProject = String(value.vercelProjectName || '');
  const supabaseRef = String(value.supabaseProjectRef || '');
  const productionUrl = String(value.productionUrl || '');
  const missingRequiredTargets = REQUIRED_PROJECT_TARGETS
    .filter(([key]) => !String(value[key] || ''))
    .map(([, label]) => label);
  const complete = missingRequiredTargets.length === 0;
  if (typeof value.configured !== 'boolean' || value.configured !== complete) {
    errors.push(`projectTargets.configured must be ${complete} for the complete required target set.`);
  }
  if (!Array.isArray(value.missingRequiredTargets)
      || JSON.stringify(value.missingRequiredTargets) !== JSON.stringify(missingRequiredTargets)) {
    errors.push(`projectTargets.missingRequiredTargets must equal ${JSON.stringify(missingRequiredTargets)}.`);
  }
  if (appId && !/^\d{17,20}$/.test(appId)) {
    errors.push('projectTargets.discordApplicationId must contain 17 to 20 digits.');
  }
  if (publicKey && !/^[a-f0-9]{64}$/i.test(publicKey)) {
    errors.push('projectTargets.discordPublicKey must contain exactly 64 hexadecimal characters.');
  }
  if (vercelProject && !/^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/.test(vercelProject)) {
    errors.push('projectTargets.vercelProjectName has an invalid project name.');
  }
  if (supabaseRef && !/^[a-z0-9]{20}$/.test(supabaseRef)) {
    errors.push('projectTargets.supabaseProjectRef must contain exactly 20 lowercase letters or numbers.');
  }
  if (productionUrl) {
    try {
      if (new URL(productionUrl).protocol !== 'https:') throw new Error('not HTTPS');
    } catch {
      errors.push('projectTargets.productionUrl must be a valid HTTPS URL.');
    }
  }
}

function validateUnrealHandoff(root, errors, warnings) {
  const manifest = readJsonArtifact(root, 'export-manifest.json', errors);
  const handoff = readJsonArtifact(root, 'activity-handoff.json', errors);
  const logic = readJsonArtifact(root, 'logic/blueprints.json', errors);
  if (!manifest || !handoff || !logic) return;

  if (!MANIFEST_SCHEMAS.has(manifest.schema)) {
    errors.push('export-manifest.json has an unsupported schema.');
  }
  if (!HANDOFF_SCHEMAS.has(handoff.schema)) {
    errors.push(`activity-handoff.json must use ${CURRENT_HANDOFF_SCHEMA}. Export again with the current plugin.`);
  }
  validateProjectTargets(handoff.projectTargets, errors);
  validateAssetDelivery(root, manifest, handoff, errors, warnings);
  validateAssetPack(root, manifest, handoff, errors, warnings);
  if (logic.schema !== 'ue-blueprint-ir/v1' || !Array.isArray(logic.programs)) {
    errors.push('logic/blueprints.json has an unsupported schema.');
  }

  const requiresAdapterContract = ['ue5-html5-export/v4', CURRENT_MANIFEST_SCHEMA].includes(manifest.schema)
    || ['ue5-discord-activity-handoff/v5', CURRENT_HANDOFF_SCHEMA].includes(handoff.schema);
  const manifestCounts = compatibilityCounts(
    manifest.blueprintCompatibility,
    'export-manifest.json.blueprintCompatibility',
    errors,
    requiresAdapterContract,
  );
  const handoffCounts = compatibilityCounts(
    handoff.blueprintCompatibility,
    'activity-handoff.json.blueprintCompatibility',
    errors,
    requiresAdapterContract,
  );
  if (!manifestCounts || !handoffCounts || !Array.isArray(logic.programs)) return;

  const adapterContract = requiresAdapterContract
    ? validateProjectAdapters(root, logic, errors, warnings)
    : null;

  for (const name of Object.keys(manifestCounts)) {
    if (manifestCounts[name] !== handoffCounts[name]) {
      errors.push(`Blueprint compatibility mismatch between manifest and handoff: ${name}.`);
    }
  }
  const logicBlueprints = logic.programs.length;
  const logicNodes = logic.programs.reduce(
    (total, program) => total + (Array.isArray(program?.graphs)
      ? program.graphs.reduce((graphTotal, graph) => graphTotal + (Array.isArray(graph?.nodes) ? graph.nodes.length : 0), 0)
      : 0),
    0,
  );
  const logicUnsupported = logic.programs.reduce(
    (total, program) => total + Number(program?.compatibility?.unsupportedCount || 0),
    0,
  );
  if (logicBlueprints !== manifestCounts.blueprintCount) {
    errors.push('Blueprint count does not match logic/blueprints.json.');
  }
  if (logicNodes !== manifestCounts.nodeCount) {
    errors.push('Blueprint node count does not match logic/blueprints.json.');
  }
  if (logicUnsupported !== manifestCounts.unsupportedNodeCount) {
    errors.push('Blueprint unsupported-node count does not match logic/blueprints.json.');
  }
  if (requiresAdapterContract) {
    const logicCustom = logic.programs.reduce(
      (total, program) => total + Number(program?.compatibility?.projectAdapterCount || 0),
      0,
    );
    if (logicCustom !== manifestCounts.customAdapterNodeCount
        || adapterContract?.coveredCount !== manifestCounts.customAdapterNodeCount) {
      errors.push('Blueprint project-adapter count does not match logic/blueprints.json.');
    }
    if (manifestCounts.customAdapterNodeCount > 0 && adapterContract?.declaredCount === 0) {
      errors.push('Project-adapter-covered nodes require declared functions in logic/custom-adapters.json.');
    }
  }

  const needsAdapters = manifestCounts.unsupportedNodeCount > 0;
  const needsRuntimeValidation = requiresAdapterContract && manifestCounts.customAdapterNodeCount > 0;
  const expectedCompatibilityStatus = needsAdapters
    ? 'needs-adapters'
    : (needsRuntimeValidation ? 'project-adapters-require-runtime-validation' : 'compatible');
  if (manifest.blueprintCompatibility.status !== expectedCompatibilityStatus
      || handoff.blueprintCompatibility.status !== expectedCompatibilityStatus) {
    errors.push(`Blueprint compatibility status must be ${expectedCompatibilityStatus}.`);
  }
  const expectedStatus = needsAdapters
    ? 'unreal-export-needs-blueprint-adapters'
    : (needsRuntimeValidation ? 'unreal-export-needs-runtime-validation' : 'unreal-export-complete');
  if (handoff.handoffStatus !== expectedStatus) {
    errors.push(`activity-handoff.json status must be ${expectedStatus}.`);
  }
  if (needsAdapters) {
    const subject = manifestCounts.unsupportedNodeCount === 1 ? '1 Blueprint node requires' : `${manifestCounts.unsupportedNodeCount} Blueprint nodes require`;
    warnings.push(`${subject} adapters; review logic/blueprints.json before release.`);
  }
  if (needsRuntimeValidation) {
    const subject = manifestCounts.customAdapterNodeCount === 1
      ? '1 Blueprint node uses a project adapter'
      : `${manifestCounts.customAdapterNodeCount} Blueprint nodes use project adapters`;
    warnings.push(`${subject}; registration is checked at startup, but behavior requires local Discord preview and gameplay testing.`);
  }
}

function validateJwk(env, errors) {
  let jwk;
  try {
    jwk = JSON.parse(env.SUPABASE_JWT_PRIVATE_KEY);
  } catch {
    errors.push('SUPABASE_JWT_PRIVATE_KEY must be one-line JSON.');
    return;
  }
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y || !jwk.d) {
    errors.push('SUPABASE_JWT_PRIVATE_KEY must be a private ES256/P-256 JWK with x, y, and d.');
  }
  const keyId = env.SUPABASE_JWT_KEY_ID || jwk.kid;
  if (!keyId || placeholder(String(keyId))) {
    errors.push('SUPABASE_JWT_KEY_ID or a non-placeholder JWK kid is required.');
  } else if (env.SUPABASE_JWT_KEY_ID && jwk.kid && env.SUPABASE_JWT_KEY_ID !== jwk.kid) {
    errors.push('SUPABASE_JWT_KEY_ID does not match the private JWK kid.');
  }
}

export function validateActivityEnvironment(env = process.env) {
  const errors = [];
  const warnings = [];
  for (const name of REQUIRED_ENVIRONMENT) {
    if (placeholder(String(env[name] || ''))) errors.push(`${name} is missing or still a placeholder.`);
  }
  if (!/^\d{17,20}$/.test(env.DISCORD_CLIENT_ID)) {
    errors.push('DISCORD_CLIENT_ID must be a Discord snowflake (17-20 digits).');
  }
  if (String(env.DISCORD_CLIENT_SECRET).length < 16) {
    errors.push('DISCORD_CLIENT_SECRET is unexpectedly short.');
  }
  if (String(env.DISCORD_BOT_TOKEN).startsWith('Bot ')) {
    errors.push('DISCORD_BOT_TOKEN must contain the raw token without the "Bot " prefix.');
  } else if (String(env.DISCORD_BOT_TOKEN).length < 20) {
    errors.push('DISCORD_BOT_TOKEN is unexpectedly short.');
  }

  try {
    const url = new URL(env.SUPABASE_URL);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/') {
      errors.push('SUPABASE_URL must be an HTTPS project origin without credentials or a path.');
    }
  } catch {
    errors.push('SUPABASE_URL is not a valid URL.');
  }
  if (!String(env.SUPABASE_PUBLISHABLE_KEY).startsWith('sb_publishable_')) {
    errors.push('SUPABASE_PUBLISHABLE_KEY must be a publishable key, not a secret or legacy service-role key.');
  }
  if (!String(env.SUPABASE_SECRET_KEY).startsWith('sb_secret_')) {
    errors.push('SUPABASE_SECRET_KEY must be a server-only secret key.');
  }
  if (Buffer.byteLength(String(env.ACTIVITY_STATE_SECRET), 'utf8') < 32) {
    errors.push('ACTIVITY_STATE_SECRET must contain at least 32 bytes of unpredictable data.');
  }
  const requireProxyAuth = /^(?:1|true|yes|on)$/i.test(String(env.DISCORD_REQUIRE_PROXY_AUTH || ''));
  if (requireProxyAuth && !/^[0-9a-f]{64}$/i.test(String(env.DISCORD_PUBLIC_KEY || ''))) {
    errors.push('DISCORD_PUBLIC_KEY must be the 64-character Ed25519 public key when DISCORD_REQUIRE_PROXY_AUTH is true.');
  } else if (!requireProxyAuth) {
    warnings.push('Discord proxy request authentication is not required; enable it before production if available for this app.');
  }
  const realtimeKey = String(env.SUPABASE_JWT_PRIVATE_KEY || '');
  if (!realtimeKey) {
    warnings.push('Supabase private Realtime is disabled; Discord auth and server-mediated game persistence remain available.');
  } else if (placeholder(realtimeKey)) {
    errors.push('SUPABASE_JWT_PRIVATE_KEY is still a placeholder; remove it to disable Realtime or configure a private ES256 JWK.');
  } else {
    validateJwk(env, errors);
  }
  return { errors, warnings };
}

export function validateActivityExport({
  directory = process.cwd(),
  env = process.env,
  packageOnly = false,
} = {}) {
  const root = resolve(directory);
  const errors = [];
  const warnings = [];
  for (const path of REQUIRED_EXPORT_FILES) {
    if (!existsSync(join(root, path))) errors.push(`Export artifact is missing: ${path}`);
  }
  for (const required of REQUIRED_EXPORT_PATTERNS) {
    const directory = join(root, required.directory);
    const entries = existsSync(directory) ? readdirSync(directory) : [];
    if (!entries.some((entry) => required.pattern.test(entry))) {
      errors.push(`Export artifact is missing: ${required.label}`);
    }
  }
  validateUnrealHandoff(root, errors, warnings);

  if (!packageOnly) {
    const environment = validateActivityEnvironment(env);
    errors.push(...environment.errors);
    warnings.push(...environment.warnings);
  }

  const textFiles = publicTextFiles(root);
  for (const name of SERVER_SECRET_NAMES) {
    const secret = String(env[name] || '');
    if (placeholder(secret) || secret.length < 8) continue;
    for (const file of textFiles) {
      if (readFileSync(file, 'utf8').includes(secret)) {
        errors.push(`${name} appears in browser-visible file ${relative(root, file)}.`);
      }
    }
  }
  return { root, errors, warnings, checkedFiles: REQUIRED_EXPORT_FILES.length + REQUIRED_EXPORT_PATTERNS.length };
}

async function onlineRequest(fetchImpl, label, url, init = {}) {
  try {
    return await fetchImpl(url, {
      ...init,
      signal: init.signal || AbortSignal.timeout(ONLINE_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error?.name === 'TimeoutError' ? 'timed out' : 'could not connect';
    throw new Error(`${label} ${reason}.`);
  }
}

async function onlineJson(fetchImpl, label, url, init = {}) {
  const response = await onlineRequest(fetchImpl, label, url, init);
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}.`);
  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload !== 'object') throw new Error(`${label} returned invalid JSON.`);
  return payload;
}

function apiKeyHeaders(key) {
  return { apikey: key, 'User-Agent': 'ue5-discord-activity-preflight' };
}

export async function verifyActivityServices(env = process.env, { fetchImpl = fetch } = {}) {
  const errors = [];
  const warnings = [];
  const checks = [];
  const environment = validateActivityEnvironment(env);
  if (environment.errors.length) return { errors: environment.errors, warnings, checks };

  try {
    const application = await onlineJson(fetchImpl, 'Discord application check', `${DISCORD_API}/applications/@me`, {
      headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
    });
    if (String(application.id) !== env.DISCORD_CLIENT_ID) {
      errors.push('DISCORD_BOT_TOKEN belongs to a different Discord application.');
    } else {
      checks.push('Discord bot token matches DISCORD_CLIENT_ID');
    }
    let flags = 0n;
    try { flags = BigInt(application.flags_new ?? application.flags ?? 0); } catch {}
    if ((flags & DISCORD_EMBEDDED_FLAG) === 0n) {
      errors.push('Discord application is not marked as an embedded Activity.');
    } else {
      checks.push('Discord application has the EMBEDDED Activity flag');
    }
    const integrationTypes = application.integration_types_config;
    if (integrationTypes && Object.hasOwn(integrationTypes, '0') && Object.hasOwn(integrationTypes, '1')) {
      checks.push('Discord application supports Guild Install and User Install');
    } else {
      warnings.push('Enable both Guild Install and User Install in Discord so the Activity can launch in servers, DMs, and group DMs.');
    }
    if (Array.isArray(application.redirect_uris) && application.redirect_uris.length > 0) {
      checks.push('Discord application has an OAuth2 redirect URI for Embedded App SDK authorization');
    } else {
      warnings.push('Add an OAuth2 redirect URI in Discord; https://127.0.0.1 is sufficient when authorization is handled only by the Embedded App SDK.');
    }
    if (/^(?:1|true|yes|on)$/i.test(String(env.DISCORD_REQUIRE_PROXY_AUTH || ''))) {
      if (String(application.verify_key || '').toLowerCase() !== String(env.DISCORD_PUBLIC_KEY).toLowerCase()) {
        errors.push('DISCORD_PUBLIC_KEY does not match the Discord application public key.');
      } else {
        checks.push('Discord proxy verification key matches the application');
      }
    }
    if (!application.privacy_policy_url) warnings.push('Discord application has no privacy policy URL.');
    if (!application.terms_of_service_url) warnings.push('Discord application has no terms-of-service URL.');
  } catch (error) {
    errors.push(error.message);
  }

  try {
    const commands = await onlineJson(
      fetchImpl,
      'Discord Entry Point command check',
      `${DISCORD_API}/applications/${env.DISCORD_CLIENT_ID}/commands`,
      { headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` } },
    );
    const entryPoint = Array.isArray(commands)
      ? commands.find((command) => Number(command?.type) === DISCORD_PRIMARY_ENTRY_POINT)
      : null;
    if (!entryPoint) {
      errors.push('Discord application has no global Primary Entry Point command; enable Activities or create a type-4 launch command.');
    } else if (Number(entryPoint.handler) !== DISCORD_LAUNCH_ACTIVITY_HANDLER) {
      errors.push('Discord Primary Entry Point must use the DISCORD_LAUNCH_ACTIVITY handler because this export does not host a custom interaction handler.');
    } else {
      checks.push('Discord Primary Entry Point launches the Activity through Discord');
    }
  } catch (error) {
    errors.push(error.message);
  }

  if (env.SUPABASE_JWT_PRIVATE_KEY) {
    let privateJwk;
    try { privateJwk = JSON.parse(env.SUPABASE_JWT_PRIVATE_KEY); } catch {}
    const keyId = env.SUPABASE_JWT_KEY_ID || privateJwk?.kid;
    try {
      const jwks = await onlineJson(
        fetchImpl,
        'Supabase signing-key check',
        `${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`,
      );
      const publicJwk = Array.isArray(jwks.keys) ? jwks.keys.find((key) => key.kid === keyId) : null;
      if (!publicJwk) {
        errors.push('Configured Supabase signing-key ID is not published by this project.');
      } else if (publicJwk.kty !== 'EC' || publicJwk.crv !== 'P-256' || publicJwk.x !== privateJwk.x || publicJwk.y !== privateJwk.y) {
        errors.push('SUPABASE_JWT_PRIVATE_KEY does not match this project’s published ES256 key.');
      } else {
        checks.push('Supabase project publishes the matching ES256 public key');
      }
    } catch (error) {
      errors.push(error.message);
    }
  } else {
    checks.push('Supabase private Realtime is intentionally disabled; server-mediated persistence remains enabled');
  }

  try {
    // Supabase removed publishable/anon access to the PostgREST OpenAPI root in
    // 2026. Auth health still validates the project API key without exposing
    // schema metadata or creating a user/session.
    const response = await onlineRequest(fetchImpl, 'Supabase publishable-key check', `${env.SUPABASE_URL}/auth/v1/health`, {
      headers: apiKeyHeaders(env.SUPABASE_PUBLISHABLE_KEY),
    });
    if (!response.ok) errors.push(`Supabase publishable-key check returned HTTP ${response.status}.`);
    else checks.push('Supabase publishable key reaches the configured project');
    await response.body?.cancel();
  } catch (error) {
    errors.push(error.message);
  }

  const tableUrl = `${env.SUPABASE_URL}/rest/v1/discord_activity_world_state?select=world_id&limit=0`;
  try {
    const response = await onlineRequest(fetchImpl, 'Supabase browser-denial check', tableUrl, {
      headers: apiKeyHeaders(env.SUPABASE_PUBLISHABLE_KEY),
    });
    if (response.ok) errors.push('Publishable Supabase key can read the private world-state table; revoke browser table grants.');
    else if (response.status === 401 || response.status === 403) checks.push('Browser key is denied direct game-state table access');
    else errors.push(`Supabase browser-denial check returned unexpected HTTP ${response.status}.`);
    await response.body?.cancel();
  } catch (error) {
    errors.push(error.message);
  }

  try {
    const response = await onlineRequest(fetchImpl, 'Supabase migration check', tableUrl, {
      headers: apiKeyHeaders(env.SUPABASE_SECRET_KEY),
    });
    if (!response.ok) errors.push(`Supabase migration/secret-key check returned HTTP ${response.status}.`);
    else checks.push('Supabase secret key can read the migrated world-state table');
    await response.body?.cancel();
  } catch (error) {
    errors.push(error.message);
  }

  return { errors, warnings, checks };
}

function printResult(result, packageOnly) {
  const mode = packageOnly ? 'package' : 'deployment';
  if (result.errors.length) {
    console.error(`Discord Activity ${mode} preflight failed (${result.errors.length} error${result.errors.length === 1 ? '' : 's'}):`);
    for (const error of result.errors) console.error(`- ${error}`);
    return 1;
  }
  console.log(`Discord Activity ${mode} preflight passed.`);
  console.log(`Checked ${result.checkedFiles} required export artifacts; no server secret appeared in browser text.`);
  for (const warning of result.warnings) console.warn(`Warning: ${warning}`);
  return 0;
}

function printOnlineResult(result) {
  if (result.errors.length) {
    console.error(`Discord Activity online preflight failed (${result.errors.length} error${result.errors.length === 1 ? '' : 's'}):`);
    for (const error of result.errors) console.error(`- ${error}`);
    return 1;
  }
  console.log('Discord Activity online preflight passed.');
  for (const check of result.checks) console.log(`- ${check}`);
  for (const warning of result.warnings) console.warn(`Warning: ${warning}`);
  return 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const packageOnly = process.argv.includes('--package-only');
  const online = process.argv.includes('--online');
  const localResult = validateActivityExport({ packageOnly });
  process.exitCode = printResult(localResult, packageOnly);
  if (!process.exitCode && online) {
    process.exitCode = printOnlineResult(await verifyActivityServices());
  }
}
