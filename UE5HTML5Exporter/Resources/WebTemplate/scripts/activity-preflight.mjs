import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

export const REQUIRED_ENVIRONMENT = [
  'DISCORD_CLIENT_ID',
  'DISCORD_CLIENT_SECRET',
  'DISCORD_BOT_TOKEN',
  'SUPABASE_URL',
  'SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_SECRET_KEY',
  'SUPABASE_JWT_PRIVATE_KEY',
  'ACTIVITY_STATE_SECRET',
];

export const REQUIRED_EXPORT_FILES = [
  'index.html',
  'assets/scene.glb',
  'logic/blueprints.json',
  'export-manifest.json',
  'activity-handoff.json',
  'api/activity.mjs',
  'scripts/activity-release.mjs',
  'supabase/migrations/20260822094350_discord_activity_core.sql',
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

const PUBLIC_TEXT_ROOTS = ['index.html', 'runtime', 'logic', 'activity-handoff.json'];
const DISCORD_API = 'https://discord.com/api/v10';
const DISCORD_EMBEDDED_FLAG = 1n << 17n;
const ONLINE_TIMEOUT_MS = 10_000;
const HANDOFF_SCHEMA = 'ue5-discord-activity-handoff/v3';
const PROJECT_TARGET_KEYS = new Set([
  'source',
  'containsSecrets',
  'configured',
  'discordApplicationId',
  'discordPublicKey',
  'vercelProjectName',
  'supabaseProjectRef',
  'productionUrl',
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

function compatibilityCounts(value, label, errors) {
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
  return result;
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
  const hasAnyTarget = Boolean(appId || publicKey || vercelProject || supabaseRef || productionUrl);
  if (typeof value.configured !== 'boolean' || value.configured !== hasAnyTarget) {
    errors.push(`projectTargets.configured must be ${hasAnyTarget} for the supplied public targets.`);
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

  if (manifest.schema !== 'ue5-html5-export/v2') {
    errors.push('export-manifest.json has an unsupported schema.');
  }
  if (handoff.schema !== HANDOFF_SCHEMA) {
    errors.push(`activity-handoff.json must use ${HANDOFF_SCHEMA}. Export again with the current plugin.`);
  }
  validateProjectTargets(handoff.projectTargets, errors);
  if (logic.schema !== 'ue-blueprint-ir/v1' || !Array.isArray(logic.programs)) {
    errors.push('logic/blueprints.json has an unsupported schema.');
  }

  const manifestCounts = compatibilityCounts(manifest.blueprintCompatibility, 'export-manifest.json.blueprintCompatibility', errors);
  const handoffCounts = compatibilityCounts(handoff.blueprintCompatibility, 'activity-handoff.json.blueprintCompatibility', errors);
  if (!manifestCounts || !handoffCounts || !Array.isArray(logic.programs)) return;

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

  const needsAdapters = manifestCounts.unsupportedNodeCount > 0;
  const expectedCompatibilityStatus = needsAdapters ? 'needs-adapters' : 'compatible';
  if (manifest.blueprintCompatibility.status !== expectedCompatibilityStatus
      || handoff.blueprintCompatibility.status !== expectedCompatibilityStatus) {
    errors.push(`Blueprint compatibility status must be ${expectedCompatibilityStatus}.`);
  }
  const expectedStatus = needsAdapters
    ? 'unreal-export-needs-blueprint-adapters'
    : 'unreal-export-complete';
  if (handoff.handoffStatus !== expectedStatus) {
    errors.push(`activity-handoff.json status must be ${expectedStatus}.`);
  }
  if (needsAdapters) {
    const subject = manifestCounts.unsupportedNodeCount === 1 ? '1 Blueprint node requires' : `${manifestCounts.unsupportedNodeCount} Blueprint nodes require`;
    warnings.push(`${subject} adapters; review logic/blueprints.json before release.`);
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
  if (errors.some((message) => message.startsWith('SUPABASE_JWT_PRIVATE_KEY'))) {
    return { errors, warnings };
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
  validateJwk(env, errors);
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

  try {
    const response = await onlineRequest(fetchImpl, 'Supabase publishable-key check', `${env.SUPABASE_URL}/rest/v1/`, {
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
