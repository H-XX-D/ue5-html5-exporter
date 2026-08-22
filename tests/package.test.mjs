import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

const plugin = new URL('../UE5HTML5Exporter/', import.meta.url);
const read = (path) => readFileSync(new URL(path, plugin), 'utf8');

test('plugin descriptor declares runtime Blueprint and editor exporter modules', () => {
  const descriptor = JSON.parse(read('UE5HTML5Exporter.uplugin'));
  assert.equal(descriptor.Modules.find((entry) => entry.Name === 'UE5HTML5ExporterRuntime')?.Type, 'Runtime');
  assert.equal(descriptor.Modules.find((entry) => entry.Name === 'UE5HTML5Exporter')?.Type, 'Editor');
  assert.equal(descriptor.Plugins.find((entry) => entry.Name === 'GLTFExporter')?.Enabled, true);
});

test('runtime module exposes Discord Activity operations as familiar Blueprint nodes', () => {
  const header = read('Source/UE5HTML5ExporterRuntime/Public/UE5HTML5DiscordBlueprintLibrary.h');
  const implementation = read('Source/UE5HTML5ExporterRuntime/Private/UE5HTML5DiscordBlueprintLibrary.cpp');
  for (const functionName of [
    'IsDiscordActivityReady', 'DiscordActivityBroadcast', 'DiscordActivityOpenInviteDialog',
    'DiscordActivityGetParticipants', 'DiscordActivityLoadWorldState', 'DiscordActivitySaveWorldState',
    'DiscordActivityLoadPlayerState', 'DiscordActivitySavePlayerState',
    'DiscordActivityGetSkus', 'DiscordActivityGetVerifiedEntitlements',
    'DiscordActivityHasEntitlement', 'DiscordActivityStartPurchase',
  ]) {
    assert.match(header, new RegExp(functionName));
  }
  assert.match(header, /BlueprintCallable|BlueprintPure/);
  assert.match(implementation, /available after HTML5 export/);
});

test('production web template is built and uses relative paths', () => {
  const indexUrl = new URL('Resources/WebTemplate/index.html', plugin);
  assert.ok(existsSync(indexUrl), 'run npm run build to create the bundled viewer');
  const html = readFileSync(indexUrl, 'utf8');
  assert.match(html, /\.\/runtime\/viewer-[A-Za-z0-9_-]+\.js/);
  assert.match(html, /name="ue5-activity-api" content="\/api\/activity"/);
  assert.doesNotMatch(html, /(?:src|href)="\//);
});

test('production template includes the Discord Activity API, Vercel adapter, and Supabase deployment surface', () => {
  for (const path of [
    'Resources/WebTemplate/api/activity.mjs',
    'Resources/WebTemplate/vercel.json',
    'Resources/WebTemplate/package.json',
    'Resources/WebTemplate/.env.example',
    'Resources/WebTemplate/DISCORD_ACTIVITY_WORKFLOW.md',
    'Resources/WebTemplate/scripts/activity-preflight.mjs',
  ]) assert.ok(existsSync(new URL(path, plugin)), `${path} is missing; run npm run build`);

  const migrationDirectory = new URL('Resources/WebTemplate/supabase/migrations/', plugin);
  assert.ok(existsSync(migrationDirectory));
  const api = read('Resources/WebTemplate/api/activity.mjs');
  assert.match(api, /activity-instances/);
  assert.match(api, /SUPABASE_SECRET_KEY/);
  assert.doesNotMatch(api, /sb_secret_[A-Za-z0-9_-]{8,}/);
  const deploymentPackage = JSON.parse(read('Resources/WebTemplate/package.json'));
  assert.equal(deploymentPackage.scripts.preflight, 'node scripts/activity-preflight.mjs');
  assert.equal(deploymentPackage.scripts['preflight:package'], 'node scripts/activity-preflight.mjs --package-only');
  assert.equal(deploymentPackage.scripts['preflight:online'], 'node scripts/activity-preflight.mjs --online');
  const runtimeFiles = readdirSync(new URL('Resources/WebTemplate/runtime/', plugin));
  const viewerFile = runtimeFiles.find((name) => /^viewer-[A-Za-z0-9_-]+\.js$/.test(name));
  const activityFile = runtimeFiles.find((name) => /^discord-activity-[A-Za-z0-9_-]+\.js$/.test(name));
  assert.ok(viewerFile, 'content-hashed viewer bundle is missing');
  assert.ok(activityFile, 'content-hashed Discord Activity bundle is missing');
  const viewer = read(`Resources/WebTemplate/runtime/${viewerFile}`);
  const activity = read(`Resources/WebTemplate/runtime/${activityFile}`);
  assert.match(viewer, /discordactivitygetverifiedentitlements/);
  assert.match(viewer, /discordactivitystartpurchase/);
  assert.match(activity, /startPurchase/);
});

test('exporter writes the scene, manifest, and local server helper', () => {
  const source = read('Source/UE5HTML5Exporter/Private/UE5HTML5ExportLibrary.cpp');
  assert.match(source, /scene\.glb/);
  assert.match(source, /export-manifest\.json/);
  assert.match(source, /serve\.py/);
  assert.match(source, /UGLTFExporter::ExportToGLTF/);
  assert.match(source, /FUE5BlueprintGraphExporter::Export/);
  assert.match(source, /discord-activity/);
  assert.match(source, /DISCORD_ACTIVITY_WORKFLOW\.md/);
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
  assert.match(source, /ResolveGameModeClass/);
  assert.match(source, /DefaultPawnClass/);
  assert.match(source, /playerStart/);
  assert.match(source, /firstPerson/);
  assert.match(source, /SimpleConstructionScript/);
  assert.match(source, /BlueprintFunctions/);
  assert.match(source, /switchString/);
  assert.match(source, /Function = GraphName/);
  assert.match(source, /discordactivity/);
});

test('Enhanced Input metadata is read from enhanced mappings', () => {
  const source = read('Source/UE5HTML5Exporter/Private/UE5BlueprintGraphExporter.cpp');
  const legacyStart = source.indexOf('for (const FInputActionKeyMapping& Mapping');
  const enhancedStart = source.indexOf('for (const FEnhancedActionKeyMapping& Mapping');
  assert.ok(legacyStart >= 0 && enhancedStart > legacyStart);

  const legacyMappingBlock = source.slice(legacyStart, enhancedStart);
  assert.doesNotMatch(legacyMappingBlock, /Mapping\.Action->/);
  assert.doesNotMatch(legacyMappingBlock, /Mapping\.(?:Modifiers|Triggers)\b/);

  const enhancedMappingBlock = source.slice(enhancedStart, source.indexOf('Root->SetArrayField(TEXT("inputMappings")', enhancedStart));
  for (const member of ['Action', 'Modifiers', 'Triggers']) {
    assert.match(enhancedMappingBlock, new RegExp(`Mapping\\.${member}`));
  }
  assert.match(enhancedMappingBlock, /Mapping\.Action->ValueType/);
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
  assert.match(source, /addmovementinput/);
  assert.match(source, /attachGameplayController/);
  assert.match(source, /callDiscordActivity/);
});

test('first-person controller converts Unreal coordinates and consumes exported movement defaults', async () => {
  const THREE = await import('three');
  const { FirstPersonController, unrealVectorToThree } = await import('../web/src/first-person-controller.js');
  const converted = unrealVectorToThree({ x: 100, y: 200, z: 300 });
  assert.deepEqual(converted.toArray(), [1, 3, -2]);

  const documentTarget = new EventTarget();
  documentTarget.pointerLockElement = null;
  const canvasTarget = new EventTarget();
  canvasTarget.ownerDocument = documentTarget;
  canvasTarget.requestPointerLock = () => { documentTarget.pointerLockElement = canvasTarget; };
  const controller = new FirstPersonController(
    new THREE.PerspectiveCamera(),
    canvasTarget,
    new THREE.Group(),
    {
      profile: 'firstPerson',
      playerStart: { location: { x: 100, y: 0, z: 200 } },
      movement: { maxWalkSpeed: 420, jumpVelocity: 510, gravityScale: 1.25, capsuleRadius: 40, capsuleHalfHeight: 90 },
    },
    {},
    new EventTarget(),
  );
  assert.equal(controller.enabled, true);
  assert.equal(controller.moveSpeed, 4.2);
  assert.equal(controller.jumpVelocity, 5.1);
  assert.equal(controller.gravity, 12.25);
  assert.equal(controller.radius, 0.4);
  controller.groundGrace = 0.1;
  assert.equal(controller.jump(), true);
  assert.equal(controller.velocity.y, 5.1);
  controller.dispose();
});

test('Unreal module declares editor dependencies for exported adapter assets', () => {
  const rules = read('Source/UE5HTML5Exporter/UE5HTML5Exporter.Build.cs');
  for (const module of ['EnhancedInput', 'EngineSettings', 'AIModule', 'UMG', 'UMGEditor']) assert.match(rules, new RegExp(`"${module}"`));
});

test('Windows teammates have native PowerShell install and packaging helpers', () => {
  const install = readFileSync(new URL('../scripts/Install-UE5HTML5Exporter.ps1', import.meta.url), 'utf8');
  const pack = readFileSync(new URL('../scripts/Package-UE5HTML5Exporter.ps1', import.meta.url), 'utf8');
  assert.match(install, /\.ue5html5-backups/);
  assert.match(install, /UE5HTML5Exporter\.uplugin/);
  assert.match(pack, /RunUAT\.bat/);
  assert.match(pack, /BuildPlugin/);
  assert.match(pack, /Win64/);
});
