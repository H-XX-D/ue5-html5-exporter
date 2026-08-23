#!/usr/bin/env node

import {
  cpSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { findNumberedDuplicates } from './template-hygiene.mjs';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PLUGIN = join(REPOSITORY_ROOT, 'UE5HTML5Exporter');

export function parseSourcePackageArgs(argv) {
  const options = { plugin: DEFAULT_PLUGIN, replace: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--plugin') options.plugin = argv[++index];
    else if (argument === '--output') options.output = argv[++index];
    else if (argument === '--replace') options.replace = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`Unknown option: ${argument}`);
  }
  options.output ||= join(REPOSITORY_ROOT, 'dist', 'UE5HTML5Exporter-Source');
  return options;
}

export function sourcePackageHelp() {
  return `Create a portable source-only UE5HTML5Exporter teammate bundle.

Usage:
  node scripts/package-source-plugin.mjs [options]

Options:
  --plugin <directory>  Plugin source directory (default: repository plugin)
  --output <directory>  Bundle output directory
  --replace             Back up an existing output before packaging
  -h, --help            Show this help

The bundle contains the plugin, Windows workstation doctor/installer, and handoff documentation.
On Windows, double-click Install-UE5HTML5Exporter.cmd and choose a .uproject file.
Unreal compiles the plugin for the teammate's installed engine version.
Double-click Certify-UE5HTML5Exporter.cmd to build, install, export, certify the browser FPS, and record combined Win64 evidence.`;
}

function requireFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${label} was not found: ${path}`);
}

function requireDirectory(path, label) {
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`${label} was not found: ${path}`);
}

export function getSourceRevision({ env = process.env, exec = execFileSync } = {}) {
  const git = (args) => {
    try {
      return String(exec('git', ['-C', REPOSITORY_ROOT, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })).trim();
    } catch {
      return null;
    }
  };
  const commit = String(env.GITHUB_SHA || git(['rev-parse', 'HEAD']) || '').trim() || null;
  const ref = String(env.GITHUB_REF || git(['symbolic-ref', '--quiet', '--short', 'HEAD']) || '').trim() || null;
  const status = git(['status', '--porcelain']);
  return {
    schema: 'ue5-html5-source-revision/v1',
    commit: commit && /^[0-9a-f]{40}$/i.test(commit) ? commit.toLowerCase() : null,
    ref,
    dirty: status === null ? null : status.length > 0,
  };
}

export function packageSourcePlugin(rawOptions, { now = new Date(), sourceRevision = getSourceRevision() } = {}) {
  const plugin = resolve(rawOptions.plugin || DEFAULT_PLUGIN);
  const output = resolve(rawOptions.output);
  requireDirectory(plugin, 'Plugin directory');
  requireFile(join(plugin, 'UE5HTML5Exporter.uplugin'), 'Plugin descriptor');
  requireFile(join(plugin, 'Resources', 'WebTemplate', 'index.html'), 'Built web runtime');

  const duplicates = findNumberedDuplicates(plugin, {
    includeDirectories: true,
    skipNames: ['Binaries', 'Intermediate', '.DS_Store'],
  });
  if (duplicates.length) {
    throw new Error(`Refusing to package numbered duplicate files or directories: ${duplicates.join(', ')}`);
  }

  let backup = null;
  if (existsSync(output)) {
    if (!rawOptions.replace) {
      throw new Error(`Source package output already exists at ${output}. Re-run with --replace to back it up.`);
    }
    backup = `${output}.backup-${now.toISOString().replace(/[:.]/g, '-')}`;
    if (existsSync(backup)) throw new Error(`Backup target already exists: ${backup}`);
    renameSync(output, backup);
  }

  try {
    mkdirSync(output, { recursive: true });
    cpSync(plugin, join(output, 'UE5HTML5Exporter'), {
      recursive: true,
      errorOnExist: true,
      filter(source) {
        const name = basename(source);
        return name !== '.DS_Store' && name !== 'Binaries' && name !== 'Intermediate';
      },
    });
    mkdirSync(join(output, 'scripts'), { recursive: true });
    for (const script of [
      'UE5HTML5Tools.psm1',
      'Start-UE5HTML5Setup.ps1',
      'Start-UE5HTML5Certification.ps1',
      'Setup-UE5HTML5Exporter.ps1',
      'Install-UE5HTML5Exporter.ps1',
      'Package-UE5HTML5Exporter.ps1',
      'Verify-UE5HTML5Exporter.ps1',
    ]) {
      cpSync(join(REPOSITORY_ROOT, 'scripts', script), join(output, 'scripts', script));
    }
    cpSync(
      join(REPOSITORY_ROOT, 'scripts', 'Install-UE5HTML5Exporter.cmd'),
      join(output, 'Install-UE5HTML5Exporter.cmd'),
    );
    cpSync(
      join(REPOSITORY_ROOT, 'scripts', 'Certify-UE5HTML5Exporter.cmd'),
      join(output, 'Certify-UE5HTML5Exporter.cmd'),
    );
    cpSync(join(REPOSITORY_ROOT, 'docs', 'TEAM_INSTALL.md'), join(output, 'TEAM_INSTALL.md'));
    cpSync(join(REPOSITORY_ROOT, 'LICENSE'), join(output, 'LICENSE'));
    writeFileSync(join(output, 'source-revision.json'), `${JSON.stringify(sourceRevision, null, 2)}\n`);
  } catch (error) {
    if (existsSync(output)) rmSync(output, { recursive: true, force: true });
    if (backup) renameSync(backup, output);
    throw error;
  }

  return { plugin, output, backup };
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
}

if (isMainModule()) {
  try {
    const options = parseSourcePackageArgs(process.argv.slice(2));
    if (options.help) {
      console.log(sourcePackageHelp());
      process.exit(0);
    }
    const result = packageSourcePlugin(options);
    console.log(`Created source teammate bundle at ${result.output}`);
    if (result.backup) console.log(`Previous bundle backed up to ${result.backup}`);
  } catch (error) {
    console.error(`Source packaging failed: ${error.message}`);
    process.exit(1);
  }
}
