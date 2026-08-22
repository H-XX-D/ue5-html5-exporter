#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { pathToFileURL } from 'node:url';

import {
  validateActivityExport,
  verifyActivityServices,
} from './activity-preflight.mjs';

export const SENSITIVE_ENVIRONMENT = [
  'DISCORD_CLIENT_SECRET',
  'DISCORD_BOT_TOKEN',
  'SUPABASE_SECRET_KEY',
  'SUPABASE_JWT_PRIVATE_KEY',
  'ACTIVITY_STATE_SECRET',
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

export function parseActivityReleaseArgs(argv) {
  const options = {
    apply: false,
    deploy: true,
    migrate: true,
    directory: process.cwd(),
    environment: 'preview',
    generateStateSecret: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') options.apply = true;
    else if (argument === '--no-deploy') options.deploy = false;
    else if (argument === '--no-migrate') options.migrate = false;
    else if (argument === '--generate-state-secret') options.generateStateSecret = true;
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
  options.directory = resolve(options.directory);
  if (options.envFile) options.envFile = resolve(options.envFile);
  return options;
}

export function activityReleaseHelp() {
  return `Configure and deploy a UE5 Discord Activity without exposing server secrets.

Usage:
  npm run release:activity -- [options]

Required:
  --supabase-project-ref <ref>  Exact Supabase project to receive the migration
  --vercel-project <name>       Vercel project to receive server environment
  --env-file <path>             Gitignored environment file (values are never printed)

Options:
  --environment <target>        preview (default) or production
  --generate-state-secret       Generate ACTIVITY_STATE_SECRET in memory when absent
  --no-migrate                  Do not link or migrate Supabase
  --no-deploy                   Configure services without deploying Vercel
  --directory <export>          UE5 export directory (default: current directory)
  --apply                       Perform mutations; without this flag only print a plan
  -h, --help                    Show this help

The dry-run plan is the default. --apply links the exact selected projects, runs a
Supabase migration dry-run before db push, writes Vercel values through stdin,
runs the online identity/security preflight, and creates a Preview deployment.
Production uses --prod --skip-domain and is never promoted automatically.`;
}

export function loadReleaseEnvironment(options, baseEnvironment = process.env, random = randomBytes) {
  let fileEnvironment = {};
  if (options.envFile) {
    if (!existsSync(options.envFile)) throw new Error(`Environment file was not found: ${options.envFile}`);
    fileEnvironment = parseEnv(readFileSync(options.envFile, 'utf8'));
  }
  const environment = { ...DEFAULT_ENVIRONMENT, ...baseEnvironment, ...fileEnvironment };
  if (!environment.ACTIVITY_STATE_SECRET && options.generateStateSecret) {
    environment.ACTIVITY_STATE_SECRET = random(32).toString('base64url');
  }
  return environment;
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

function supabaseHostname(projectRef) {
  return `${projectRef}.supabase.co`;
}

export function validateReleaseSelection(options, environment, vercelLink = readVercelLink(options.directory)) {
  const errors = [];
  const warnings = [];
  if (!/^[a-z0-9]{20}$/.test(String(options.supabaseProjectRef || ''))) {
    errors.push('--supabase-project-ref must be the exact 20-character project ref.');
  }
  const selectedVercelProject = options.vercelProject || vercelLink?.projectName;
  if (!selectedVercelProject) errors.push('--vercel-project is required when the export is not already linked.');
  if (vercelLink && options.vercelProject && vercelLink.projectName !== options.vercelProject) {
    errors.push(`Export is linked to Vercel project ${vercelLink.projectName}, not ${options.vercelProject}.`);
  }
  try {
    const configuredHost = new URL(environment.SUPABASE_URL).hostname;
    if (options.supabaseProjectRef && configuredHost !== supabaseHostname(options.supabaseProjectRef)) {
      errors.push(`SUPABASE_URL targets ${configuredHost}, not selected project ${options.supabaseProjectRef}.`);
    }
  } catch {
    // The shared environment validator reports the malformed URL precisely.
  }
  if (options.environment === 'production'
      && !/^(?:1|true|yes|on)$/i.test(String(environment.DISCORD_REQUIRE_PROXY_AUTH || ''))) {
    warnings.push('Production is selected while Discord proxy authentication is disabled.');
  }
  return { errors, warnings, selectedVercelProject };
}

export function buildActivityReleasePlan(options, environment, vercelLink = readVercelLink(options.directory)) {
  const selection = validateReleaseSelection(options, environment, vercelLink);
  const variableNames = [...PUBLIC_ENVIRONMENT, ...SENSITIVE_ENVIRONMENT]
    .filter((name) => Boolean(environment[name]));
  return {
    schema: 'ue5-discord-activity-release-plan/v1',
    mode: options.apply ? 'apply' : 'dry-run',
    directory: options.directory,
    environment: options.environment,
    vercelProject: selection.selectedVercelProject || null,
    supabaseProjectRef: options.supabaseProjectRef || null,
    packagePreflight: true,
    supabase: options.migrate
      ? ['link exact project', 'migration dry-run', 'apply pending migrations']
      : ['skipped by operator'],
    vercelEnvironment: variableNames.map((name) => ({
      name,
      sensitive: SENSITIVE_ENVIRONMENT.includes(name),
    })),
    onlinePreflight: true,
    deployment: options.deploy
      ? (options.environment === 'production' ? 'staged production (--skip-domain)' : 'preview')
      : 'skipped by operator',
    discordUrlMappings: {
      '/': '<deployment-host returned after apply>',
      '/supabase': options.supabaseProjectRef ? supabaseHostname(options.supabaseProjectRef) : null,
    },
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
  let origin;
  try {
    origin = new URL(deploymentUrlValue);
  } catch {
    return { errors: ['Vercel did not return a valid deployment URL.'], warnings, checks };
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
      const manifest = await manifestResponse.json();
      if (manifest.schema !== 'ue5-html5-export/v2') {
        errors.push('Hosted export manifest has an unexpected schema.');
      } else {
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

  return { errors, warnings, checks };
}

export async function executeActivityRelease(options, environment, {
  runner = defaultRunner,
  verifyServices = verifyActivityServices,
  verifyDeployment = verifyPublicDeployment,
} = {}) {
  const local = validateActivityExport({ directory: options.directory, env: environment });
  const link = readVercelLink(options.directory);
  const selection = validateReleaseSelection(options, environment, link);
  const errors = [...local.errors, ...selection.errors];
  const warnings = [...local.warnings, ...selection.warnings];
  const plan = buildActivityReleasePlan(options, environment, link);
  if (errors.length) return { ok: false, applied: false, errors, warnings, plan };
  if (!options.apply) return { ok: true, applied: false, errors: [], warnings, plan };

  const run = (command, args, input) => runCommand(command, args, {
    cwd: options.directory,
    environment,
    input,
    runner,
  });
  run('vercel', ['--version']);
  run('supabase', ['--version']);

  if (!link) run('vercel', ['link', '--yes', '--project', selection.selectedVercelProject]);
  if (options.migrate) {
    run('supabase', ['link', '--project-ref', options.supabaseProjectRef]);
    run('supabase', ['db', 'push', '--linked', '--dry-run', '--yes']);
    run('supabase', ['db', 'push', '--linked', '--yes']);
  }

  const online = await verifyServices(environment);
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
    const value = environment[name];
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
  return {
    ok: true,
    applied: true,
    errors: [],
    warnings: resultWarnings,
    checks: resultChecks,
    uploadedVariables,
    deploymentUrl: url,
    discordUrlMappings: {
      '/': url ? new URL(url).host : '<deployment skipped>',
      '/supabase': supabaseHostname(options.supabaseProjectRef),
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
