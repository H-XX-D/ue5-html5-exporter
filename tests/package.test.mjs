import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const plugin = new URL('../UE5HTML5Exporter/', import.meta.url);
const read = (path) => readFileSync(new URL(path, plugin), 'utf8');

test('plugin descriptor declares editor module and GLTFExporter dependency', () => {
  const descriptor = JSON.parse(read('UE5HTML5Exporter.uplugin'));
  assert.equal(descriptor.Modules[0].Type, 'Editor');
  assert.equal(descriptor.Plugins.find((entry) => entry.Name === 'GLTFExporter')?.Enabled, true);
});

test('production web template is built and uses relative paths', () => {
  const indexUrl = new URL('Resources/WebTemplate/index.html', plugin);
  assert.ok(existsSync(indexUrl), 'run npm run build to create the bundled viewer');
  const html = readFileSync(indexUrl, 'utf8');
  assert.match(html, /\.\/runtime\/viewer\.js/);
  assert.doesNotMatch(html, /(?:src|href)="\//);
});

test('exporter writes the scene, manifest, and local server helper', () => {
  const source = read('Source/UE5HTML5Exporter/Private/UE5HTML5ExportLibrary.cpp');
  assert.match(source, /scene\.glb/);
  assert.match(source, /export-manifest\.json/);
  assert.match(source, /serve\.py/);
  assert.match(source, /UGLTFExporter::ExportToGLTF/);
  assert.match(source, /FUE5BlueprintGraphExporter::Export/);
});

test('Blueprint exporter preserves graph pins and writes browser IR', () => {
  const source = read('Source/UE5HTML5Exporter/Private/UE5BlueprintGraphExporter.cpp');
  assert.match(source, /ue-blueprint-ir\/v1/);
  assert.match(source, /Pin->LinkedTo/);
  assert.match(source, /blueprints\.json/);
  assert.match(source, /unsupportedCount/);
  assert.match(source, /UInputMappingContext::StaticClass/);
  assert.match(source, /UBehaviorTree::StaticClass/);
  assert.match(source, /UWidgetBlueprint::StaticClass/);
  assert.match(source, /widgetBlueprints/);
});

test('viewer exposes errors and animation selection', () => {
  const source = readFileSync(new URL('../web/src/main.js', import.meta.url), 'utf8');
  assert.match(source, /configureAnimations/);
  assert.match(source, /errorPanel\.hidden = false/);
  assert.match(source, /renderer\.setAnimationLoop/);
  assert.match(source, /BlueprintRuntime/);
  assert.match(source, /BrowserRuntimeAdapters/);
});

test('browser adapters cover gameplay integration families', () => {
  const source = readFileSync(new URL('../web/src/runtime-adapters.js', import.meta.url), 'utf8');
  for (const symbol of ['ReplicationAdapter', 'EnhancedInputAdapter', 'CollisionAdapter', 'PhysicsAdapter', 'AbilitySystemAdapter', 'WidgetAdapter', 'ParticleAdapter', 'BehaviorTreeAdapter']) {
    assert.match(source, new RegExp(`class ${symbol}`));
  }
  assert.match(source, /registerFunction/);
});

test('Unreal module declares editor dependencies for exported adapter assets', () => {
  const rules = read('Source/UE5HTML5Exporter/UE5HTML5Exporter.Build.cs');
  for (const module of ['EnhancedInput', 'AIModule', 'UMG', 'UMGEditor']) assert.match(rules, new RegExp(`"${module}"`));
});
