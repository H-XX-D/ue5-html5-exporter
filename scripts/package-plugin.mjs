#!/usr/bin/env node

import { existsSync, renameSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PLUGIN = join(REPOSITORY_ROOT, 'UE5HTML5Exporter', 'UE5HTML5Exporter.uplugin');
const SUPPORTED_PLATFORMS = new Set(['Win64', 'Mac', 'Linux']);

export function hostPlatform(nodePlatform = process.platform) {
  if (nodePlatform === 'win32') return 'Win64';
  if (nodePlatform === 'darwin') return 'Mac';
  if (nodePlatform === 'linux') return 'Linux';
  throw new Error(`Unsupported host platform: ${nodePlatform}`);
}

export function parsePackageArgs(argv, nodePlatform = process.platform) {
  const options = { plugin: DEFAULT_PLUGIN, platforms: [], replace: false, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--engine') options.engine = argv[++index];
    else if (argument === '--plugin') options.plugin = argv[++index];
    else if (argument === '--output') options.output = argv[++index];
    else if (argument === '--platform') options.platforms.push(...String(argv[++index] || '').split(/[,+]/));
    else if (argument === '--replace') options.replace = true;
    else if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`Unknown option: ${argument}`);
  }
  options.engine ||= process.env.UE_ENGINE_ROOT;
  options.platforms = options.platforms.filter(Boolean);
  if (!options.platforms.length) options.platforms = [hostPlatform(nodePlatform)];
  for (const platform of options.platforms) {
    if (!SUPPORTED_PLATFORMS.has(platform)) {
      throw new Error(`Unsupported target platform '${platform}'. Use Win64, Mac, or Linux.`);
    }
  }
  options.platforms = [...new Set(options.platforms)];
  options.output ||= join(REPOSITORY_ROOT, 'dist', `UE5HTML5Exporter-${options.platforms.join('+')}`);
  return options;
}

export function packageHelp() {
  return `Build a distributable UE5HTML5Exporter package with Unreal Automation Tool.

Usage:
  node scripts/package-plugin.mjs --engine <UE_5.x> [options]

Options:
  --platform <name>      Win64, Mac, or Linux; repeat or comma-separate for multiple
  --plugin <uplugin>     Descriptor to package (default: repository plugin)
  --output <directory>   Package output directory
  --replace              Back up an existing output before building
  --dry-run              Print the resolved command without executing it
  -h, --help             Show this help

UE_ENGINE_ROOT may be used instead of --engine.`;
}

export function resolveRunUat(engineRoot, nodePlatform = process.platform) {
  if (!engineRoot) throw new Error('Set --engine or UE_ENGINE_ROOT to the Unreal Engine root.');
  const root = resolve(engineRoot);
  const filename = nodePlatform === 'win32' ? 'RunUAT.bat' : 'RunUAT.sh';
  return join(root, 'Engine', 'Build', 'BatchFiles', filename);
}

export function buildPackageInvocation(options, nodePlatform = process.platform) {
  const engine = resolve(options.engine);
  const plugin = resolve(options.plugin || DEFAULT_PLUGIN);
  const output = resolve(options.output);
  const runUat = resolveRunUat(engine, nodePlatform);
  const args = [
    'BuildPlugin',
    `-Plugin=${plugin}`,
    `-Package=${output}`,
    `-TargetPlatforms=${options.platforms.join('+')}`,
    '-Rocket',
  ];
  return { engine, plugin, output, runUat, args };
}

function requireFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${label} was not found: ${path}`);
}

export function packagePlugin(rawOptions, dependencies = {}) {
  const nodePlatform = dependencies.nodePlatform || process.platform;
  const spawn = dependencies.spawn || spawnSync;
  const now = dependencies.now || new Date();
  const invocation = buildPackageInvocation(rawOptions, nodePlatform);
  requireFile(invocation.plugin, 'Plugin descriptor');
  requireFile(invocation.runUat, 'Unreal Automation Tool');

  if (rawOptions.dryRun) return { ...invocation, dryRun: true, backup: null };

  let backup = null;
  if (existsSync(invocation.output)) {
    if (!rawOptions.replace) {
      throw new Error(`Package output already exists at ${invocation.output}. Re-run with --replace to back it up.`);
    }
    backup = `${invocation.output}.backup-${now.toISOString().replace(/[:.]/g, '-')}`;
    if (existsSync(backup)) throw new Error(`Backup target already exists: ${backup}`);
    renameSync(invocation.output, backup);
  }

  const command = nodePlatform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : invocation.runUat;
  const args = nodePlatform === 'win32'
    ? ['/d', '/s', '/c', invocation.runUat, ...invocation.args]
    : invocation.args;
  const result = spawn(command, args, { cwd: REPOSITORY_ROOT, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Unreal BuildPlugin exited with status ${result.status}.`);
  return { ...invocation, dryRun: false, backup };
}

function quoteForDisplay(value) {
  return /\s/.test(value) ? JSON.stringify(value) : value;
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
}

if (isMainModule()) {
  try {
    const options = parsePackageArgs(process.argv.slice(2));
    if (options.help) {
      console.log(packageHelp());
      process.exit(0);
    }
    const result = packagePlugin(options);
    if (result.dryRun) {
      console.log([result.runUat, ...result.args].map(quoteForDisplay).join(' '));
    } else {
      console.log(`Packaged UE5HTML5Exporter for ${options.platforms.join(', ')} at ${result.output}`);
      if (result.backup) console.log(`Previous package backed up to ${result.backup}`);
    }
  } catch (error) {
    console.error(`Plugin packaging failed: ${error.message}`);
    process.exit(1);
  }
}
