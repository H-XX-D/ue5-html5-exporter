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
import {
  packageSourcePlugin,
  parseSourcePackageArgs,
} from '../scripts/package-source-plugin.mjs';
import {
  cleanGeneratedTemplateDuplicates,
  duplicateBasePath,
  findNumberedDuplicates,
} from '../scripts/template-hygiene.mjs';

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

test('source packager creates a clean Windows teammate bundle without native intermediates', () => {
  const root = mkdtempSync(join(tmpdir(), 'ue5-html5-source-package-'));
  const source = join(root, 'Plugin');
  const output = join(root, 'Bundle');
  mkdirSync(join(source, 'Source'), { recursive: true });
  mkdirSync(join(source, 'Resources', 'WebTemplate'), { recursive: true });
  mkdirSync(join(source, 'Binaries'), { recursive: true });
  mkdirSync(join(source, 'Intermediate'), { recursive: true });
  writeFileSync(join(source, 'UE5HTML5Exporter.uplugin'), '{}');
  writeFileSync(join(source, 'Source', 'portable.cpp'), 'source');
  writeFileSync(join(source, 'Resources', 'WebTemplate', 'index.html'), '<html></html>');
  writeFileSync(join(source, 'Binaries', 'native.bin'), 'native');
  writeFileSync(join(source, 'Intermediate', 'object.o'), 'object');

  const options = parseSourcePackageArgs(['--plugin', source, '--output', output]);
  const result = packageSourcePlugin(options);
  assert.equal(result.output, output);
  assert.equal(readFileSync(join(output, 'UE5HTML5Exporter', 'Source', 'portable.cpp'), 'utf8'), 'source');
  assert.equal(existsSync(join(output, 'UE5HTML5Exporter', 'Binaries')), false);
  assert.equal(existsSync(join(output, 'UE5HTML5Exporter', 'Intermediate')), false);
  assert.equal(existsSync(join(output, 'scripts', 'Install-UE5HTML5Exporter.ps1')), true);
  assert.equal(existsSync(join(output, 'scripts', 'Setup-UE5HTML5Exporter.ps1')), true);
  assert.equal(existsSync(join(output, 'scripts', 'UE5HTML5Tools.psm1')), true);
  assert.equal(existsSync(join(output, 'scripts', 'Package-UE5HTML5Exporter.ps1')), true);
  assert.equal(existsSync(join(output, 'scripts', 'Verify-UE5HTML5Exporter.ps1')), true);
  assert.equal(existsSync(join(output, 'TEAM_INSTALL.md')), true);
});

test('source packager refuses Finder-style numbered duplicate files', () => {
  const root = mkdtempSync(join(tmpdir(), 'ue5-html5-source-duplicate-'));
  const source = join(root, 'Plugin');
  mkdirSync(join(source, 'Resources', 'WebTemplate'), { recursive: true });
  writeFileSync(join(source, 'UE5HTML5Exporter.uplugin'), '{}');
  writeFileSync(join(source, 'Resources', 'WebTemplate', 'index.html'), '<html></html>');
  writeFileSync(join(source, 'Resources', 'WebTemplate', 'index 2.html'), '<html></html>');
  assert.throws(
    () => packageSourcePlugin({ plugin: source, output: join(root, 'Bundle'), replace: false }),
    /numbered duplicate files/,
  );
});

test('template hygiene removes only byte-identical numbered generated files', () => {
  const root = mkdtempSync(join(tmpdir(), 'ue5-html5-template-hygiene-'));
  mkdirSync(join(root, 'runtime'), { recursive: true });
  const canonical = join(root, 'runtime', 'viewer-hash.js');
  const duplicate = join(root, 'runtime', 'viewer-hash 2.js');
  writeFileSync(canonical, 'same generated output');
  writeFileSync(duplicate, 'same generated output');
  assert.equal(duplicateBasePath(duplicate), canonical);
  assert.deepEqual(findNumberedDuplicates(root), [duplicate]);
  assert.deepEqual(cleanGeneratedTemplateDuplicates(root), [duplicate]);
  assert.equal(existsSync(duplicate), false);

  writeFileSync(duplicate, 'different output');
  assert.throws(() => cleanGeneratedTemplateDuplicates(root), /differs from its canonical counterpart/);
  assert.equal(existsSync(duplicate), true);
});
