#!/usr/bin/env node

import {
  cpSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PLUGIN = join(REPOSITORY_ROOT, 'UE5HTML5Exporter');

export function parseInstallArgs(argv) {
  const options = { plugin: DEFAULT_PLUGIN, replace: false, sourceOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--project') options.project = argv[++index];
    else if (argument === '--plugin') options.plugin = argv[++index];
    else if (argument === '--replace') options.replace = true;
    else if (argument === '--source-only') options.sourceOnly = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

export function installHelp() {
  return `Install UE5HTML5Exporter into an Unreal project.

Usage:
  node scripts/install-plugin.mjs --project <Game.uproject> [options]

Options:
  --plugin <directory>  Plugin source or prebuilt package (default: repository plugin)
  --source-only         Skip Binaries and Intermediate for an on-machine source build
  --replace             Back up an existing installation before replacing it
  -h, --help            Show this help

The default is safe: an existing plugin is never overwritten without --replace.`;
}

function requireFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${label} was not found: ${path}`);
}

function requireDirectory(path, label) {
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`${label} was not found: ${path}`);
}

function backupSuffix(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

export function installPlugin(rawOptions, { now = new Date() } = {}) {
  if (!rawOptions.project) throw new Error('--project must point to a .uproject file.');
  const project = resolve(rawOptions.project);
  const plugin = resolve(rawOptions.plugin || DEFAULT_PLUGIN);
  requireFile(project, 'Unreal project');
  if (!project.toLowerCase().endsWith('.uproject')) throw new Error(`Expected a .uproject file: ${project}`);
  requireDirectory(plugin, 'Plugin directory');
  requireFile(join(plugin, 'UE5HTML5Exporter.uplugin'), 'Plugin descriptor');

  const destination = join(dirname(project), 'Plugins', 'UE5HTML5Exporter');
  let backup = null;
  if (existsSync(destination)) {
    if (!rawOptions.replace) {
      throw new Error(`Plugin already exists at ${destination}. Re-run with --replace to create a backup and replace it.`);
    }
    const backupDirectory = join(dirname(project), '.ue5html5-backups');
    mkdirSync(backupDirectory, { recursive: true });
    backup = join(backupDirectory, `UE5HTML5Exporter-${backupSuffix(now)}`);
    if (existsSync(backup)) throw new Error(`Backup target already exists: ${backup}`);
    renameSync(destination, backup);
  }

  try {
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(plugin, destination, {
      recursive: true,
      errorOnExist: true,
      filter(source) {
        const name = basename(source);
        if (name === '.DS_Store' || name === 'Intermediate') return false;
        if (rawOptions.sourceOnly && name === 'Binaries') return false;
        return true;
      },
    });
  } catch (error) {
    if (backup && !existsSync(destination)) renameSync(backup, destination);
    throw error;
  }

  return { project, plugin, destination, backup, sourceOnly: Boolean(rawOptions.sourceOnly) };
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
}

if (isMainModule()) {
  try {
    const options = parseInstallArgs(process.argv.slice(2));
    if (options.help) {
      console.log(installHelp());
      process.exit(0);
    }
    const result = installPlugin(options);
    console.log(`Installed UE5HTML5Exporter to ${result.destination}`);
    if (result.backup) console.log(`Previous installation backed up to ${result.backup}`);
    console.log(result.sourceOnly
      ? 'Open the project and allow Unreal Build Tool to compile the plugin for this machine.'
      : 'Open the project. Unreal will use packaged binaries when compatible, or request a rebuild.');
  } catch (error) {
    console.error(`Plugin installation failed: ${error.message}`);
    process.exit(1);
  }
}
