#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
    forwarded: [],
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--skip-install') {
      options.install = false;
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

The first run creates .env.activity.local from .env.example and stops so you can
fill the private server configuration. The next run installs pinned Vercel and
Supabase CLIs locally, then prints the fail-closed dry-run release plan.

Add --apply only after reviewing that plan. All activity-release options are
passed through unchanged. Use --skip-install only when dependencies are already
present in this export folder.`;
}

function defaultRunner(command, args, options) {
  return spawnSync(command, args, { ...options, stdio: 'inherit', shell: false });
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

export function runReleaseAssistant(argv, {
  directory = EXPORT_DIRECTORY,
  nodeVersion = process.versions.node,
  platform = process.platform,
  exists = existsSync,
  copyFile = copyFileSync,
  runner = defaultRunner,
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
  if (!exists(envFile)) {
    if (options.explicitEnvFile) {
      stderr(`Environment file was not found: ${envFile}`);
      return 1;
    }
    const example = join(directory, '.env.example');
    if (!exists(example)) {
      stderr(`Release template was not found: ${example}`);
      return 1;
    }
    copyFile(example, envFile);
    stdout(`Created private release template: ${envFile}`);
    stdout('Fill its placeholder values, then run this launcher again. The file is gitignored.');
    return 2;
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

  const release = runner(npm, [
    'run', 'release:activity', '--', '--env-file', envFile, ...options.forwarded,
  ], { cwd: directory });
  if (release.error) {
    stderr(`Could not start the release workflow: ${release.error.message}`);
    return 1;
  }
  return release.status ?? 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = runReleaseAssistant(process.argv.slice(2));
}
