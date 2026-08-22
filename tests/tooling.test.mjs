import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { installPlugin, parseInstallArgs } from '../scripts/install-plugin.mjs';
import {
  buildPackageInvocation,
  hostPlatform,
  parsePackageArgs,
  resolveRunUat,
} from '../scripts/package-plugin.mjs';

test('installer parses Windows paths without shell quoting assumptions', () => {
  const options = parseInstallArgs([
    '--project', 'C:\\Games\\Example Game\\Example.uproject',
    '--plugin', 'D:\\UE Plugins\\UE5HTML5Exporter',
    '--source-only',
    '--replace',
  ]);
  assert.equal(options.project, 'C:\\Games\\Example Game\\Example.uproject');
  assert.equal(options.plugin, 'D:\\UE Plugins\\UE5HTML5Exporter');
  assert.equal(options.sourceOnly, true);
  assert.equal(options.replace, true);
});

test('installer copies a plugin and safely backs up an existing install', () => {
  const root = mkdtempSync(join(tmpdir(), 'ue5-html5-installer-'));
  const projectDirectory = join(root, 'Game');
  const source = join(root, 'Plugin Source');
  mkdirSync(join(source, 'Source'), { recursive: true });
  mkdirSync(join(source, 'Binaries'), { recursive: true });
  mkdirSync(projectDirectory, { recursive: true });
  const project = join(projectDirectory, 'Game.uproject');
  writeFileSync(project, '{}');
  writeFileSync(join(source, 'UE5HTML5Exporter.uplugin'), '{}');
  writeFileSync(join(source, 'Source', 'portable.txt'), 'source');
  writeFileSync(join(source, 'Binaries', 'native.txt'), 'binary');

  const first = installPlugin({ project, plugin: source, sourceOnly: true, replace: false });
  assert.equal(readFileSync(join(first.destination, 'Source', 'portable.txt'), 'utf8'), 'source');
  assert.equal(existsSync(join(first.destination, 'Binaries')), false);

  writeFileSync(join(first.destination, 'local-change.txt'), 'preserve');
  const second = installPlugin(
    { project, plugin: source, sourceOnly: true, replace: true },
    { now: new Date('2026-08-22T12:00:00.000Z') },
  );
  assert.ok(second.backup);
  assert.match(second.backup, /\.ue5html5-backups/);
  assert.equal(second.backup.startsWith(join(projectDirectory, 'Plugins')), false);
  assert.equal(readFileSync(join(second.backup, 'local-change.txt'), 'utf8'), 'preserve');
  assert.equal(readFileSync(join(second.destination, 'Source', 'portable.txt'), 'utf8'), 'source');
});

test('packager resolves native RunUAT launchers and target platform arguments', () => {
  assert.equal(hostPlatform('win32'), 'Win64');
  assert.equal(hostPlatform('darwin'), 'Mac');
  assert.equal(hostPlatform('linux'), 'Linux');
  assert.match(resolveRunUat('C:\\Epic\\UE_5.8', 'win32'), /RunUAT\.bat$/);
  assert.match(resolveRunUat('/opt/Unreal/UE_5.8', 'linux'), /RunUAT\.sh$/);

  const packageOutput = join(tmpdir(), 'plugin package');
  const options = parsePackageArgs([
    '--engine', '/opt/Unreal/UE_5.8',
    '--platform', 'Win64,Linux',
    '--output', packageOutput,
    '--dry-run',
  ], 'linux');
  const invocation = buildPackageInvocation(options, 'linux');
  assert.deepEqual(options.platforms, ['Win64', 'Linux']);
  assert.ok(invocation.args.includes('-TargetPlatforms=Win64+Linux'));
  assert.ok(invocation.args.includes(`-Package=${resolve(packageOutput)}`));
});
