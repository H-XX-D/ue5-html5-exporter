#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const RELEASE_TOOL_PACKAGES = [
  'vercel@59.4.0',
  'supabase@2.115.0',
  // Force Vercel's compatible tar range onto its current patched release.
  'tar@7.5.22',
];

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const EXPORT_DIRECTORY = resolve(SCRIPT_DIRECTORY, '..');
const DEFAULT_ENV_FILE = '.env.activity.local';
const REQUIRED_NODE_MAJOR = 22;

export function parseReleaseAssistantArgs(argv) {
  const options = {
    envFile: DEFAULT_ENV_FILE,
    explicitEnvFile: false,
    install: true,
    guided: false,
    forwarded: [],
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--skip-install') {
      options.install = false;
    } else if (argument === '--guided') {
      options.guided = true;
    } else if (argument === '--env-file') {
      const value = argv[++index];
      if (!value) throw new Error('--env-file requires a path.');
      options.envFile = value;
      options.explicitEnvFile = true;
    } else {
      options.forwarded.push(argument);
      if (argument === '--help' || argument === '-h') options.help = true;
    }
  }
  return options;
}

export function releaseAssistantHelp() {
  return `One-command UE5 Discord Activity release assistant.

Windows:  release-discord-activity.cmd
macOS:    ./release-discord-activity.command
Linux:    ./release-discord-activity.sh

The launcher reads public project identity directly from Unreal, installs pinned
Vercel and Supabase CLIs locally, then prints the fail-closed dry-run plan. With
--guided, it asks whether to apply that exact plan in the same terminal. No
environment file is required for the guided workflow.

The platform launchers enable --guided automatically. Answering No, a failed dry
run, or non-interactive use makes no hosted changes. Advanced automation may pass
--apply directly. All activity-release options are passed through unchanged. At
apply time, Supabase API keys are discovered through the authenticated CLI and
remaining secrets use hidden input; none are saved by the assistant. Use
--env-file only for CI or advanced overrides.`;
}

function defaultRunner(command, args, options) {
  return spawnSync(command, args, { ...options, stdio: 'inherit', shell: false });
}

async function defaultConfirmApply(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(question);
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

function requiredDependencies(directory, platform) {
  const commandSuffix = platform === 'win32' ? '.cmd' : '';
  return [
    join(directory, 'node_modules', '@supabase', 'supabase-js', 'package.json'),
    join(directory, 'node_modules', 'jose', 'package.json'),
    join(directory, 'node_modules', '.bin', `vercel${commandSuffix}`),
    join(directory, 'node_modules', '.bin', `supabase${commandSuffix}`),
  ];
}

export async function runReleaseAssistant(argv, {
  directory = EXPORT_DIRECTORY,
  nodeVersion = process.versions.node,
  platform = process.platform,
  exists = existsSync,
  runner = defaultRunner,
  confirmApply = defaultConfirmApply,
  stdout = console.log,
  stderr = console.error,
} = {}) {
  let options;
  try {
    options = parseReleaseAssistantArgs(argv);
  } catch (error) {
    stderr(`Discord Activity release assistant failed: ${error.message}`);
    return 1;
  }
  if (options.help) {
    stdout(releaseAssistantHelp());
    return 0;
  }

  const major = Number.parseInt(String(nodeVersion).split('.')[0], 10);
  if (!Number.isInteger(major) || major < REQUIRED_NODE_MAJOR) {
    stderr(`Node.js ${REQUIRED_NODE_MAJOR} or newer is required; found ${nodeVersion || 'unknown'}.`);
    stderr('Install the current Node.js LTS release, then run this launcher again.');
    return 1;
  }

  const envFile = resolve(directory, options.envFile);
  if (options.explicitEnvFile && !exists(envFile)) {
    stderr(`Environment file was not found: ${envFile}`);
    return 1;
  }

  const npm = platform === 'win32' ? 'npm.cmd' : 'npm';
  const dependenciesReady = requiredDependencies(directory, platform).every(exists);
  if (!dependenciesReady && options.install) {
    stdout('Installing pinned Discord Activity release tools locally...');
    const install = runner(npm, [
      'install', '--no-save', '--package-lock=false', '--no-audit', '--no-fund',
      ...RELEASE_TOOL_PACKAGES,
    ], { cwd: directory });
    if (install.error) {
      stderr(`Could not start npm: ${install.error.message}`);
      return 1;
    }
    if (install.status !== 0) {
      stderr(`Release-tool installation failed with status ${install.status}.`);
      return install.status || 1;
    }
  } else if (!dependenciesReady) {
    stderr('Release dependencies are missing and --skip-install was supplied.');
    return 1;
  }

  const releaseArgs = ['run', 'release:activity', '--'];
  if (exists(envFile)) releaseArgs.push('--env-file', envFile);
  releaseArgs.push('--vercel-only-secrets', '--supabase-cli-keys', ...options.forwarded);
  const release = runner(npm, releaseArgs, { cwd: directory });
  if (release.error) {
    stderr(`Could not start the release workflow: ${release.error.message}`);
    return 1;
  }
  const releaseStatus = release.status ?? 1;
  if (releaseStatus !== 0 || !options.guided || options.forwarded.includes('--apply')) {
    return releaseStatus;
  }

  const approved = await confirmApply('\nDry run passed. Configure services and create this deployment now? [y/N] ');
  if (!approved) {
    stdout('No hosted changes were made. Run this launcher again when you are ready.');
    return 0;
  }

  const applyArgs = [...releaseArgs, '--apply'];
  const apply = runner(npm, applyArgs, { cwd: directory });
  if (apply.error) {
    stderr(`Could not start the release workflow: ${apply.error.message}`);
    return 1;
  }
  return apply.status ?? 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runReleaseAssistant(process.argv.slice(2));
}
