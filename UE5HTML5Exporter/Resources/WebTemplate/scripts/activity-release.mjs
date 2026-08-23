#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { parseEnv } from 'node:util';
import { pathToFileURL } from 'node:url';

import {
  inferDiscordRequirements,
  isSupportedManifestSchema,
  validateActivityExport,
  verifyActivityServices,
} from './activity-preflight.mjs';

export const REQUIRED_SENSITIVE_ENVIRONMENT = [
  'DISCORD_CLIENT_SECRET',
  'DISCORD_BOT_TOKEN',
  'SUPABASE_SECRET_KEY',
  'ACTIVITY_STATE_SECRET',
];

export const SENSITIVE_ENVIRONMENT = [
  ...REQUIRED_SENSITIVE_ENVIRONMENT,
  'SUPABASE_JWT_PRIVATE_KEY',
];

export const PUBLIC_ENVIRONMENT = [
  'DISCORD_CLIENT_ID',
  'SUPABASE_URL',
  'SUPABASE_PUBLISHABLE_KEY',
  'DISCORD_ENABLE_RICH_PRESENCE',
  'DISCORD_REQUIRE_PROXY_AUTH',
  'DISCORD_PUBLIC_KEY',
  'SUPABASE_JWT_KEY_ID',
];

const DEFAULT_ENVIRONMENT = {
  DISCORD_ENABLE_RICH_PRESENCE: 'false',
  DISCORD_REQUIRE_PROXY_AUTH: 'false',
};

function placeholder(value) {
  return !value || /replace[_ -]?me|your[_ -]|\.\.\./i.test(String(value));
}

function generatedStateSecret(random = randomBytes) {
  return random(32).toString('base64url');
}

export function parseActivityReleaseArgs(argv) {
  const options = {
    apply: false,
    deploy: true,
    migrate: true,
    directory: process.cwd(),
    environment: 'preview',
    generateStateSecret: false,
    promote: false,
    vercelOnlySecrets: false,
    supabaseCliKeys: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') options.apply = true;
    else if (argument === '--no-deploy') options.deploy = false;
    else if (argument === '--no-migrate') options.migrate = false;
    else if (argument === '--generate-state-secret') options.generateStateSecret = true;
    else if (argument === '--promote') options.promote = true;
    else if (argument === '--vercel-only-secrets') options.vercelOnlySecrets = true;
    else if (argument === '--supabase-cli-keys') options.supabaseCliKeys = true;
    else if (argument === '--directory') options.directory = argv[++index];
    else if (argument === '--env-file') options.envFile = argv[++index];
    else if (argument === '--supabase-project-ref') options.supabaseProjectRef = argv[++index];
    else if (argument === '--vercel-project') options.vercelProject = argv[++index];
    else if (argument === '--environment') options.environment = argv[++index];
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`Unknown option: ${argument}`);
  }
  if (!['preview', 'production'].includes(options.environment)) {
    throw new Error('--environment must be preview or production.');
  }
  if (options.promote && options.environment !== 'production') {
    throw new Error('--promote requires --environment production.');
  }
  if (options.promote && !options.deploy) {
    throw new Error('--promote cannot be used with --no-deploy.');
  }
  options.directory = resolve(options.directory);
  if (options.envFile) options.envFile = resolve(options.envFile);
  return options;
}

export function activityReleaseHelp() {
  return `Configure and deploy a UE5 Discord Activity without exposing server secrets.

Usage:
  npm run release:activity -- [options]

Optional configuration:
  --env-file <path>             Gitignored overrides for CI or advanced workflows

Project targets (optional when set in Unreal Project Settings):
  --supabase-project-ref <ref>  Exact Supabase project to receive the migration
  --vercel-project <name>       Vercel project to receive server environment

Options:
  --environment <target>        preview (default) or production
  --promote                     Promote the exact verified production deployment
  --generate-state-secret       Generate ACTIVITY_STATE_SECRET in memory when absent
  --vercel-only-secrets         Prompt hidden for missing secrets only when applying
  --supabase-cli-keys           Discover API keys in memory from authenticated Supabase CLI
  --no-migrate                  Do not link or migrate Supabase
  --no-deploy                   Configure services without deploying Vercel
  --directory <export>          UE5 export directory (default: current directory)
  --apply                       Perform mutations; without this flag only print a plan
  -h, --help                    Show this help

The dry-run plan is the default. Public project targets are read from
activity-handoff.json and explicit arguments must match them. --apply links the
exact selected projects, runs a
Supabase migration dry-run before db push, writes Vercel values through stdin,
runs the online identity/security preflight, and creates a Preview deployment.
Production uses --prod --skip-domain. It remains staged unless --promote is
explicitly supplied; promotion happens only after the exact deployment passes
the hosted public/iframe/manifest/API checks.
With --vercel-only-secrets, missing server secrets are held only in process
memory and Vercel; the public env file is never updated. --supabase-cli-keys
discovers the publishable and secret API keys without writing either to disk.`;
}

export function loadReleaseEnvironment(options, baseEnvironment = process.env, random = randomBytes) {
  let fileEnvironment = {};
  if (options.envFile) {
    if (!existsSync(options.envFile)) throw new Error(`Environment file was not found: ${options.envFile}`);
    fileEnvironment = parseEnv(readFileSync(options.envFile, 'utf8'));
  }
  const environment = { ...DEFAULT_ENVIRONMENT, ...baseEnvironment, ...fileEnvironment };
  if (!environment.ACTIVITY_STATE_SECRET && options.generateStateSecret) {
    environment.ACTIVITY_STATE_SECRET = generatedStateSecret(random);
  }
  return environment;
}

export async function promptHiddenValue(label, {
  input = process.stdin,
  output = process.stderr,
} = {}) {
  if (!input.isTTY || !output.isTTY) {
    throw new Error(`${label} requires an interactive terminal. Run the launcher in a terminal or provide the value through a private CI environment.`);
  }
  output.write(`${label}: `);
  const mutedOutput = new Writable({
    write(_chunk, _encoding, callback) { callback(); },
  });
  mutedOutput.isTTY = true;
  const readline = createInterface({ input, output: mutedOutput, terminal: true });
  try {
    const value = await readline.question('');
    output.write('\n');
    return value;
  } finally {
    readline.close();
  }
}

export async function completeVercelOnlySecrets(options, environment, {
  prompt = promptHiddenValue,
  random = randomBytes,
} = {}) {
  const completed = { ...environment };
  if (!options.vercelOnlySecrets || !options.apply) return completed;

  for (const name of REQUIRED_SENSITIVE_ENVIRONMENT) {
    if (!placeholder(completed[name])) continue;
    if (name === 'ACTIVITY_STATE_SECRET') {
      completed[name] = generatedStateSecret(random);
    } else {
      const value = await prompt(`Enter ${name} (hidden; stored only in Vercel)`);
      if (placeholder(value)) throw new Error(`${name} cannot be empty or a placeholder.`);
      completed[name] = value;
    }
  }

  if (!placeholder(completed.SUPABASE_JWT_PRIVATE_KEY)
      && placeholder(completed.SUPABASE_JWT_KEY_ID)) {
    try {
      const keyId = JSON.parse(completed.SUPABASE_JWT_PRIVATE_KEY).kid;
      if (!placeholder(keyId)) completed.SUPABASE_JWT_KEY_ID = String(keyId);
    } catch {
      // The shared validator reports malformed JWK input without exposing it.
    }
  }
  return completed;
}

export function hydrateUnrealPublicEnvironment(options, environment) {
  const hydrated = { ...environment };
  const targets = readActivityHandoffTargets(options.directory);
  const requirements = readActivityHandoffRequirements(options.directory);
  const projectRef = options.supabaseProjectRef || targets.supabaseProjectRef;
  if (placeholder(hydrated.DISCORD_CLIENT_ID) && targets.discordApplicationId) {
    hydrated.DISCORD_CLIENT_ID = targets.discordApplicationId;
  }
  if (placeholder(hydrated.DISCORD_PUBLIC_KEY) && targets.discordPublicKey) {
    hydrated.DISCORD_PUBLIC_KEY = targets.discordPublicKey;
  }
  if (placeholder(hydrated.SUPABASE_URL) && projectRef) {
    hydrated.SUPABASE_URL = `https://${projectRef}.supabase.co`;
  }
  if (requirements.requiredEnvironment?.DISCORD_ENABLE_RICH_PRESENCE === 'true') {
    hydrated.DISCORD_ENABLE_RICH_PRESENCE = 'true';
  }
  return hydrated;
}

export function discoverSupabaseApiKeys(options, environment, { runner = defaultRunner } = {}) {
  const discovered = { ...environment };
  if (!options.supabaseCliKeys || !options.apply) return discovered;
  if (!placeholder(discovered.SUPABASE_PUBLISHABLE_KEY)
      && !placeholder(discovered.SUPABASE_SECRET_KEY)) return discovered;

  const targets = readActivityHandoffTargets(options.directory);
  const projectRef = options.supabaseProjectRef || targets.supabaseProjectRef;
  if (!/^[a-z0-9]{20}$/.test(String(projectRef || ''))) {
    throw new Error('Supabase API-key discovery requires the exact 20-character project ref in Unreal Project Settings or --supabase-project-ref.');
  }
  const result = runCommand('supabase', [
    'projects', 'api-keys', '--project-ref', projectRef, '--reveal', '--output', 'json',
  ], {
    cwd: options.directory,
    environment: discovered,
    runner,
  });
  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new Error('Supabase CLI returned invalid API-key JSON; no key values were printed.');
  }
  const keys = Array.isArray(payload) ? payload : payload?.keys;
  if (!Array.isArray(keys)) throw new Error('Supabase CLI API-key response had an unexpected shape.');
  const preferred = (type) => keys.find((key) => key.type === type && key.name === 'default')
    || keys.find((key) => key.type === type);
  const publishable = preferred('publishable')?.api_key;
  const secret = preferred('secret')?.api_key;
  if (placeholder(discovered.SUPABASE_PUBLISHABLE_KEY)) {
    if (!String(publishable || '').startsWith('sb_publishable_')) {
      throw new Error('This Supabase project has no modern publishable API key. Create its default publishable/secret keys, then apply again.');
    }
    discovered.SUPABASE_PUBLISHABLE_KEY = publishable;
  }
  if (placeholder(discovered.SUPABASE_SECRET_KEY)) {
    if (!String(secret || '').startsWith('sb_secret_')) {
      throw new Error('Supabase CLI could not reveal a modern secret API key. Confirm CLI access to this project, then apply again.');
    }
    discovered.SUPABASE_SECRET_KEY = secret;
  }
  return discovered;
}

function dryRunEnvironment(options, environment) {
  if (options.apply) return environment;
  const preview = { ...environment };
  if (options.supabaseCliKeys && placeholder(preview.SUPABASE_PUBLISHABLE_KEY)) {
    preview.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_discovered-at-apply';
  }
  if (options.vercelOnlySecrets) {
    if (placeholder(preview.DISCORD_CLIENT_SECRET)) preview.DISCORD_CLIENT_SECRET = 'prompted-discord-client-secret';
    if (placeholder(preview.DISCORD_BOT_TOKEN)) preview.DISCORD_BOT_TOKEN = 'prompted-discord-bot-token-value';
    if (placeholder(preview.SUPABASE_SECRET_KEY)) preview.SUPABASE_SECRET_KEY = 'sb_secret_prompted-at-apply';
    if (placeholder(preview.ACTIVITY_STATE_SECRET)) preview.ACTIVITY_STATE_SECRET = 'generated-at-apply-0123456789abcdef';
  }
  return preview;
}

export function readVercelLink(directory) {
  const path = join(directory, '.vercel', 'project.json');
  if (!existsSync(path)) return null;
  try {
    const link = JSON.parse(readFileSync(path, 'utf8'));
    return link.projectName ? { projectName: link.projectName, projectId: link.projectId } : null;
  } catch {
    throw new Error(`Vercel project link is invalid JSON: ${path}`);
  }
}

function readActivityHandoffContract(directory) {
  const path = join(directory, 'activity-handoff.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`Activity handoff is invalid JSON: ${path}`);
  }
}

export function readActivityHandoffRequirements(directory) {
  const requirements = readActivityHandoffContract(directory)?.discordRequirements;
  return requirements?.schema === 'ue5-discord-activity-requirements/v1'
    ? requirements
    : inferDiscordRequirements({ programs: [] });
}

export function readActivityHandoffTargets(directory) {
  const handoff = readActivityHandoffContract(directory);
  if (!handoff) return {};
  try {
    const targets = handoff?.projectTargets;
    if (!targets || typeof targets !== 'object' || Array.isArray(targets)) return {};
    return {
      discordApplicationId: String(targets.discordApplicationId || ''),
      discordPublicKey: String(targets.discordPublicKey || ''),
      vercelProjectName: String(targets.vercelProjectName || ''),
      supabaseProjectRef: String(targets.supabaseProjectRef || ''),
      productionUrl: String(targets.productionUrl || ''),
    };
  } catch {
    throw new Error(`Activity handoff is invalid JSON: ${path}`);
  }
}

function supabaseHostname(projectRef) {
  return `${projectRef}.supabase.co`;
}

function productionHostname(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    return url.host;
  } catch {
    return null;
  }
}

export function validateReleaseSelection(
  options,
  environment,
  vercelLink = readVercelLink(options.directory),
  handoffTargets = readActivityHandoffTargets(options.directory),
) {
  const errors = [];
  const warnings = [];
  const handoff = readActivityHandoffContract(options.directory);
  const discordRequirements = readActivityHandoffRequirements(options.directory);
  if (handoff?.projectTargets
      && handoff.projectTargets.configured !== true) {
    const missing = Array.isArray(handoff.projectTargets.missingRequiredTargets)
      ? handoff.projectTargets.missingRequiredTargets.join(', ')
      : 'required public targets';
    errors.push(`Unreal project targets are incomplete (${missing}). Complete Project Settings and export again.`);
  }
  const handoffSupabase = handoffTargets.supabaseProjectRef || '';
  const handoffVercel = handoffTargets.vercelProjectName || '';
  if (options.supabaseProjectRef && handoffSupabase && options.supabaseProjectRef !== handoffSupabase) {
    errors.push(`--supabase-project-ref targets ${options.supabaseProjectRef}, not Unreal project target ${handoffSupabase}.`);
  }
  if (options.vercelProject && handoffVercel && options.vercelProject !== handoffVercel) {
    errors.push(`--vercel-project targets ${options.vercelProject}, not Unreal project target ${handoffVercel}.`);
  }
  const selectedSupabaseProjectRef = options.supabaseProjectRef || handoffSupabase;
  if (!/^[a-z0-9]{20}$/.test(String(selectedSupabaseProjectRef || ''))) {
    errors.push('--supabase-project-ref must be the exact 20-character project ref.');
  }
  const requestedVercelProject = options.vercelProject || handoffVercel;
  const selectedVercelProject = requestedVercelProject || vercelLink?.projectName;
  if (!selectedVercelProject) errors.push('--vercel-project is required when the export is not already linked.');
  if (vercelLink && requestedVercelProject && vercelLink.projectName !== requestedVercelProject) {
    errors.push(`Export is linked to Vercel project ${vercelLink.projectName}, not ${requestedVercelProject}.`);
  }
  if (handoffTargets.productionUrl && !productionHostname(handoffTargets.productionUrl)) {
    errors.push('Unreal Production URL must be a public HTTPS URL without user information, query parameters, or fragments.');
  }
  if (handoffTargets.discordApplicationId
      && environment.DISCORD_CLIENT_ID
      && handoffTargets.discordApplicationId !== environment.DISCORD_CLIENT_ID) {
    errors.push(`DISCORD_CLIENT_ID does not match Unreal project target ${handoffTargets.discordApplicationId}.`);
  }
  if (handoffTargets.discordPublicKey && !environment.DISCORD_PUBLIC_KEY) {
    errors.push('DISCORD_PUBLIC_KEY is missing but Unreal defines a public-key target.');
  } else if (handoffTargets.discordPublicKey
      && handoffTargets.discordPublicKey.toLowerCase() !== environment.DISCORD_PUBLIC_KEY.toLowerCase()) {
    errors.push('DISCORD_PUBLIC_KEY does not match the Unreal project target.');
  }
  try {
    const configuredHost = new URL(environment.SUPABASE_URL).hostname;
    if (selectedSupabaseProjectRef && configuredHost !== supabaseHostname(selectedSupabaseProjectRef)) {
      errors.push(`SUPABASE_URL targets ${configuredHost}, not selected project ${selectedSupabaseProjectRef}.`);
    }
  } catch {
    // The shared environment validator reports the malformed URL precisely.
  }
  if (options.environment === 'production'
      && !/^(?:1|true|yes|on)$/i.test(String(environment.DISCORD_REQUIRE_PROXY_AUTH || ''))) {
    warnings.push('Production is selected while Discord proxy authentication is disabled.');
  }
  if (discordRequirements.requiredEnvironment?.DISCORD_ENABLE_RICH_PRESENCE === 'true'
      && !/^(?:1|true|yes|on)$/i.test(String(environment.DISCORD_ENABLE_RICH_PRESENCE || ''))) {
    errors.push('Exported Rich Presence Blueprint nodes require DISCORD_ENABLE_RICH_PRESENCE=true.');
  }
  return {
    errors,
    warnings,
    selectedVercelProject,
    selectedSupabaseProjectRef,
    handoffTargets,
    discordRequirements,
  };
}

export function buildActivityReleasePlan(options, environment, vercelLink = readVercelLink(options.directory)) {
  const selection = validateReleaseSelection(options, environment, vercelLink);
  const discordApplicationId = selection.handoffTargets.discordApplicationId || environment.DISCORD_CLIENT_ID || null;
  const discordInstallUrl = discordApplicationId
    ? `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(discordApplicationId)}`
    : null;
  const variableNames = [...PUBLIC_ENVIRONMENT, ...SENSITIVE_ENVIRONMENT]
    .filter((name) => Boolean(environment[name])
      || (options.vercelOnlySecrets && REQUIRED_SENSITIVE_ENVIRONMENT.includes(name))
      || (options.supabaseCliKeys && name === 'SUPABASE_PUBLISHABLE_KEY'));
  return {
    schema: 'ue5-discord-activity-release-plan/v1',
    mode: options.apply ? 'apply' : 'dry-run',
    directory: options.directory,
    environment: options.environment,
    vercelProject: selection.selectedVercelProject || null,
    supabaseProjectRef: selection.selectedSupabaseProjectRef || null,
    discordApplicationId,
    discordInstallUrl,
    discordRequirements: selection.discordRequirements,
    productionUrl: selection.handoffTargets.productionUrl || null,
    packagePreflight: true,
    supabase: options.migrate
      ? ['link exact project', 'migration dry-run', 'apply pending migrations']
      : ['skipped by operator'],
    vercelEnvironment: variableNames.map((name) => ({
      name,
      sensitive: SENSITIVE_ENVIRONMENT.includes(name),
      source: name === 'DISCORD_ENABLE_RICH_PRESENCE'
          && selection.discordRequirements.requiredEnvironment?.DISCORD_ENABLE_RICH_PRESENCE === 'true'
        ? 'unreal-blueprint-inference'
        : options.supabaseCliKeys
          && ['SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY'].includes(name)
          && placeholder(environment[name])
        ? 'supabase-cli-at-apply'
        : (options.vercelOnlySecrets && REQUIRED_SENSITIVE_ENVIRONMENT.includes(name) && placeholder(environment[name])
          ? (name === 'ACTIVITY_STATE_SECRET' ? 'generated-at-apply' : 'hidden-prompt-at-apply')
          : 'environment'),
    })),
    onlinePreflight: true,
    deployment: options.deploy
      ? (options.environment === 'production'
        ? (options.promote
          ? 'staged production (--skip-domain), verify exact deployment, then promote'
          : 'staged production (--skip-domain)')
        : 'preview')
      : 'skipped by operator',
    promotion: options.promote
      ? 'promote exact verified deployment to current production'
      : 'not requested',
    discordUrlMappings: {
      '/': options.promote && selection.handoffTargets.productionUrl
        ? (productionHostname(selection.handoffTargets.productionUrl) || '<invalid-production-host>')
        : '<deployment-host returned after apply>',
      ...(!placeholder(environment.SUPABASE_JWT_PRIVATE_KEY) ? {
        '/supabase': selection.selectedSupabaseProjectRef ? supabaseHostname(selection.selectedSupabaseProjectRef) : null,
      } : {}),
    },
    discordPortalChecklist: [
      'Installation: enable both Guild Install and User Install.',
      `Installation: use ${discordInstallUrl || 'the Discord-provided install link'} to choose Add to My Apps for user access or Add to Server for guild access. Private development access still requires the application owner, a developer-team member, or an approved tester.`,
      'OAuth2: add a redirect URI; https://127.0.0.1 is sufficient when only the Embedded App SDK handles authorization.',
      'OAuth2: leave Public Client disabled; this export exchanges authorization codes in the Vercel server function and keeps the client secret off the browser.',
      'Activities: enable Activities and keep a global Primary Entry Point using DISCORD_LAUNCH_ACTIVITY.',
      'URL Mappings: map / to the deployment host printed after apply.',
      `Optional private Realtime only: map /supabase to ${selection.selectedSupabaseProjectRef ? supabaseHostname(selection.selectedSupabaseProjectRef) : '<selected-project-ref>.supabase.co'} when SUPABASE_JWT_PRIVATE_KEY is configured. Basic persistence does not need this mapping.`,
      'Activity Settings: enable every intended desktop, web, iOS, and Android platform and configure mobile orientation.',
      'General Information: add distribution metadata, art, participant limit, privacy policy, and terms as applicable.',
    ],
    errors: selection.errors,
    warnings: selection.warnings,
  };
}

function redactOutput(value, environment) {
  let output = String(value || '');
  for (const name of SENSITIVE_ENVIRONMENT) {
    const secret = String(environment[name] || '');
    if (secret.length >= 8) output = output.split(secret).join(`<redacted:${name}>`);
  }
  return output;
}

function defaultRunner(command, args, options) {
  return spawnSync(command, args, { ...options, encoding: 'utf8' });
}

export function runCommand(command, args, {
  cwd,
  environment,
  input,
  runner = defaultRunner,
} = {}) {
  const result = runner(command, args, {
    cwd,
    env: environment,
    input,
    encoding: 'utf8',
    shell: false,
  });
  if (result.error) throw result.error;
  const stdout = redactOutput(result.stdout, environment);
  const stderr = redactOutput(result.stderr, environment);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}.${stderr ? `\n${stderr.trim()}` : ''}`);
  }
  return { stdout, stderr };
}

function deploymentUrl(output) {
  const urls = String(output).match(/https:\/\/[^\s]+/g) || [];
  return urls.at(-1) || null;
}

function redirectDescription(response) {
  const location = response.headers?.get?.('location');
  if (!location) return 'another URL';
  try {
    return new URL(location).host;
  } catch {
    return 'another URL';
  }
}

function restrictiveFrameAncestors(value) {
  const directive = String(value || '').match(/(?:^|;)\s*frame-ancestors\s+([^;]+)/i)?.[1];
  if (!directive) return null;
  const normalized = directive.toLowerCase();
  if (normalized.includes('*')
      || normalized.includes('discord.com')
      || normalized.includes('discordapp.com')) return null;
  return directive.trim();
}

export async function verifyPublicDeployment(deploymentUrlValue, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
} = {}) {
  const errors = [];
  const warnings = [];
  const checks = [];
  let manifestIdentity = null;
  let assetPackIdentity = null;
  let origin;
  try {
    origin = new URL(deploymentUrlValue);
  } catch {
    return {
      errors: ['Vercel did not return a valid deployment URL.'],
      warnings,
      checks,
      manifestIdentity,
      assetPackIdentity,
    };
  }

  const request = async (path, accept) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(new URL(path, origin), {
        redirect: 'manual',
        signal: controller.signal,
        headers: { Accept: accept },
      });
    } finally {
      clearTimeout(timeout);
    }
  };

  let root;
  try {
    root = await request('/', 'text/html');
  } catch (error) {
    return {
      errors: [`Deployment is not publicly reachable: ${error.message || error}.`],
      warnings,
      checks,
      manifestIdentity,
      assetPackIdentity,
    };
  }
  if (root.status >= 300 && root.status < 400) {
    const destination = redirectDescription(root);
    errors.push(`Deployment redirects unauthenticated players to ${destination}. Disable Vercel Deployment Protection or use an unprotected custom domain before mapping it in Discord.`);
  } else if (!root.ok) {
    errors.push(`Deployment root returned HTTP ${root.status} to an unauthenticated player.`);
  } else {
    checks.push('Deployment root is publicly reachable without a bypass token.');
  }

  const frameOptions = String(root.headers?.get?.('x-frame-options') || '');
  if (/\b(?:deny|sameorigin)\b/i.test(frameOptions)) {
    errors.push(`Deployment blocks iframe embedding with X-Frame-Options: ${frameOptions}.`);
  }
  const frameAncestors = restrictiveFrameAncestors(root.headers?.get?.('content-security-policy'));
  if (frameAncestors) {
    errors.push(`Deployment Content-Security-Policy blocks Discord framing: frame-ancestors ${frameAncestors}.`);
  }
  if (!frameOptions && !frameAncestors && root.ok) checks.push('Deployment response is iframe-compatible.');

  try {
    const manifestResponse = await request('/export-manifest.json', 'application/json');
    if (!manifestResponse.ok) {
      errors.push(`Hosted export manifest returned HTTP ${manifestResponse.status}.`);
    } else {
      const manifest = JSON.parse(await manifestResponse.text());
      if (!isSupportedManifestSchema(manifest.schema)) {
        errors.push('Hosted export manifest has an unexpected schema.');
      } else {
        manifestIdentity = `sha256:${createHash('sha256')
          .update(JSON.stringify(manifest))
          .digest('hex')}`;
        if (/^sha256:[a-f0-9]{64}$/i.test(String(manifest.assetPack?.version || ''))) {
          assetPackIdentity = manifest.assetPack.version.toLowerCase();
        }
        checks.push(`Hosted Unreal export manifest is valid (${Number(manifest.actorCount || 0)} actors).`);
      }
    }
  } catch (error) {
    errors.push(`Hosted export manifest check failed: ${error.message || error}.`);
  }

  try {
    const apiResponse = await request('/api/activity', 'application/json');
    if (!apiResponse.ok) {
      errors.push(`Hosted Activity API returned HTTP ${apiResponse.status}.`);
    } else {
      const config = await apiResponse.json();
      if (config.enabled !== true) {
        errors.push('Hosted Activity API reports enabled:false. Verify the selected Vercel environment variables and redeploy.');
      } else {
        checks.push('Hosted Activity API reports enabled:true without exposing server secrets.');
      }
    }
  } catch (error) {
    errors.push(`Hosted Activity API check failed: ${error.message || error}.`);
  }

  return { errors, warnings, checks, manifestIdentity, assetPackIdentity };
}

export async function executeActivityRelease(options, environment, {
  runner = defaultRunner,
  verifyServices = verifyActivityServices,
  verifyDeployment = verifyPublicDeployment,
  prompt = promptHiddenValue,
  random = randomBytes,
} = {}) {
  let releaseEnvironment = hydrateUnrealPublicEnvironment(options, environment);
  releaseEnvironment = discoverSupabaseApiKeys(options, releaseEnvironment, { runner });
  releaseEnvironment = await completeVercelOnlySecrets(options, releaseEnvironment, { prompt, random });
  const validationEnvironment = dryRunEnvironment(options, releaseEnvironment);
  const local = validateActivityExport({ directory: options.directory, env: validationEnvironment });
  const link = readVercelLink(options.directory);
  const selection = validateReleaseSelection(options, releaseEnvironment, link);
  const errors = [...local.errors, ...selection.errors];
  const warnings = [...local.warnings, ...selection.warnings];
  if (options.vercelOnlySecrets && !options.apply) {
    warnings.push('Missing server secrets will be requested with hidden input only when --apply is used; they will not be written to the env file.');
  }
  if (options.supabaseCliKeys && !options.apply) {
    warnings.push('Supabase publishable and secret API keys will be discovered in memory from the authenticated CLI only when --apply is used.');
  }
  const plan = buildActivityReleasePlan(options, releaseEnvironment, link);
  if (errors.length) return { ok: false, applied: false, errors, warnings, plan };
  if (!options.apply) return { ok: true, applied: false, errors: [], warnings, plan };

  const run = (command, args, input) => runCommand(command, args, {
    cwd: options.directory,
    environment: releaseEnvironment,
    input,
    runner,
  });
  run('vercel', ['--version']);
  run('supabase', ['--version']);

  if (!link) run('vercel', ['link', '--yes', '--project', selection.selectedVercelProject]);
  if (options.migrate) {
    run('supabase', ['link', '--project-ref', selection.selectedSupabaseProjectRef]);
    run('supabase', ['db', 'push', '--linked', '--dry-run', '--yes']);
    run('supabase', ['db', 'push', '--linked', '--yes']);
  }

  const online = await verifyServices(releaseEnvironment);
  if (online.errors.length) {
    return {
      ok: false,
      applied: true,
      errors: online.errors,
      warnings: [...warnings, ...online.warnings],
      checks: online.checks,
      uploadedVariables: [],
      plan,
    };
  }

  const uploadedVariables = [];
  for (const name of [...PUBLIC_ENVIRONMENT, ...SENSITIVE_ENVIRONMENT]) {
    const value = releaseEnvironment[name];
    if (!value) continue;
    const args = ['env', 'add', name, options.environment, '--force', '--yes'];
    if (SENSITIVE_ENVIRONMENT.includes(name)) args.push('--sensitive');
    run('vercel', args, `${value}\n`);
    uploadedVariables.push(name);
  }

  let url = null;
  if (options.deploy) {
    const args = options.environment === 'production'
      ? ['deploy', '--prod', '--skip-domain', '--yes']
      : ['deploy', '--yes'];
    url = deploymentUrl(run('vercel', args).stdout);
  }
  const hosted = url
    ? await verifyDeployment(url)
    : { errors: [], warnings: [], checks: [] };
  const resultWarnings = [...warnings, ...online.warnings, ...hosted.warnings];
  const resultChecks = [...online.checks, ...hosted.checks];
  if (hosted.errors.length) {
    return {
      ok: false,
      applied: true,
      errors: hosted.errors,
      warnings: resultWarnings,
      checks: resultChecks,
      uploadedVariables,
      deploymentUrl: url,
      plan,
    };
  }
  if (options.promote && url && (!hosted.manifestIdentity || !hosted.assetPackIdentity)) {
    return {
      ok: false,
      applied: true,
      errors: ['The staged deployment did not expose both a content-addressed export-manifest identity and asset-pack identity, so the workflow cannot prove which build would be promoted. Re-export with the current plugin and try again.'],
      warnings: resultWarnings,
      checks: resultChecks,
      uploadedVariables,
      deploymentUrl: url,
      plan,
    };
  }
  let promoted = false;
  let publicUrl = url;
  if (options.promote && url) {
    run('vercel', ['promote', url, '--yes']);
    promoted = true;
    const configuredProductionUrl = selection.handoffTargets.productionUrl;
    if (configuredProductionUrl) {
      publicUrl = configuredProductionUrl;
      const production = await verifyDeployment(configuredProductionUrl);
      resultWarnings.push(...production.warnings);
      resultChecks.push(...production.checks);
      const productionErrors = [...production.errors];
      if (!production.manifestIdentity) {
        productionErrors.push('The stable production URL did not expose a content-addressed export-manifest identity after promotion.');
      } else if (production.manifestIdentity !== hosted.manifestIdentity) {
        productionErrors.push(`The stable production URL serves ${production.manifestIdentity}, not the verified staged build ${hosted.manifestIdentity}.`);
      }
      if (!production.assetPackIdentity) {
        productionErrors.push('The stable production URL did not expose a content-addressed asset-pack identity after promotion.');
      } else if (production.assetPackIdentity !== hosted.assetPackIdentity) {
        productionErrors.push(`The stable production URL serves asset pack ${production.assetPackIdentity}, not ${hosted.assetPackIdentity}.`);
      }
      if (productionErrors.length) {
        return {
          ok: false,
          applied: true,
          promoted,
          errors: productionErrors.map((error) => `Production was promoted, but follow-up verification failed: ${error}`),
          warnings: resultWarnings,
          checks: resultChecks,
          uploadedVariables,
          deploymentUrl: url,
          productionUrl: configuredProductionUrl,
          plan,
        };
      }
    } else {
      resultWarnings.push('Production was promoted, but Unreal has no stable production URL configured. Set Production URL in Unreal Project Settings before the next release so the public alias can be verified and printed for Discord.');
    }
  }
  return {
    ok: true,
    applied: true,
    errors: [],
    warnings: resultWarnings,
    checks: resultChecks,
    uploadedVariables,
    deploymentUrl: url,
    promoted,
    productionUrl: promoted ? (selection.handoffTargets.productionUrl || null) : null,
    discordUrlMappings: {
      '/': publicUrl ? new URL(publicUrl).host : '<deployment skipped>',
      ...(!placeholder(releaseEnvironment.SUPABASE_JWT_PRIVATE_KEY) ? {
        '/supabase': supabaseHostname(selection.selectedSupabaseProjectRef),
      } : {}),
    },
    plan,
  };
}

function printResult(result) {
  if (!result.ok) {
    console.error(`Discord Activity release workflow stopped (${result.errors.length} error${result.errors.length === 1 ? '' : 's'}):`);
    for (const error of result.errors) console.error(`- ${error}`);
    return 1;
  }
  if (!result.applied) {
    console.log(JSON.stringify(result.plan, null, 2));
    console.log('\nDry-run only. Re-run with --apply after reviewing this exact project plan.');
  } else {
    console.log('Discord Activity release workflow applied.');
    for (const check of result.checks || []) console.log(`- ${check}`);
    if (result.deploymentUrl) console.log(`Deployment: ${result.deploymentUrl}`);
    if (result.promoted) console.log(`Promoted production: ${result.productionUrl || result.deploymentUrl}`);
    console.log('Discord URL mappings:');
    for (const [prefix, host] of Object.entries(result.discordUrlMappings)) console.log(`- ${prefix} -> ${host}`);
  }
  for (const warning of result.warnings) console.warn(`Warning: ${warning}`);
  return 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = parseActivityReleaseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(activityReleaseHelp());
      process.exit(0);
    }
    const environment = loadReleaseEnvironment(options);
    const result = await executeActivityRelease(options, environment);
    process.exitCode = printResult(result);
  } catch (error) {
    console.error(`Discord Activity release workflow failed: ${error.message}`);
    process.exitCode = 1;
  }
}
