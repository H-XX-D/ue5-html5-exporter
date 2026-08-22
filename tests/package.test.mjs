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
    'DiscordActivitySetRichPresence', 'DiscordActivityClearRichPresence',
    'DiscordActivityShareLink', 'DiscordActivityOpenExternalLink',
    'DiscordActivityGetLaunchContext',
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
    'Resources/WebTemplate/scripts/activity-release.mjs',
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
  assert.equal(deploymentPackage.scripts['release:activity'], 'node scripts/activity-release.mjs');
  const runtimeFiles = readdirSync(new URL('Resources/WebTemplate/runtime/', plugin));
  const viewerFile = runtimeFiles.find((name) => /^viewer-[A-Za-z0-9_-]+\.js$/.test(name));
  const activityFile = runtimeFiles.find((name) => /^discord-activity-[A-Za-z0-9_-]+\.js$/.test(name));
  assert.ok(viewerFile, 'content-hashed viewer bundle is missing');
  assert.ok(activityFile, 'content-hashed Discord Activity bundle is missing');
  const viewer = read(`Resources/WebTemplate/runtime/${viewerFile}`);
  const activity = read(`Resources/WebTemplate/runtime/${activityFile}`);
  assert.match(viewer, /discordactivitygetverifiedentitlements/);
  assert.match(viewer, /discordactivitystartpurchase/);
  assert.match(viewer, /discordactivitysetrichpresence/);
  assert.match(viewer, /discordactivitysharelink/);
  assert.match(activity, /startPurchase/);
  assert.match(activity, /setRichPresence/);
  assert.match(activity, /shareLink/);
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
  assert.match(source, /activity-handoff\.json/);
  assert.match(source, /ue5-discord-activity-handoff\/v1/);
  for (const environmentName of [
    'DISCORD_BOT_TOKEN', 'SUPABASE_PUBLISHABLE_KEY',
    'SUPABASE_JWT_PRIVATE_KEY', 'ACTIVITY_STATE_SECRET',
  ]) assert.match(source, new RegExp(environmentName));
  assert.doesNotMatch(source, /ACTIVITY_SESSION_SECRET|SUPABASE_JWT_SECRET/);
});

test('Unreal Tools menu exposes a Discord Activity readiness check', () => {
  const module = read('Source/UE5HTML5Exporter/Private/UE5HTML5ExporterModule.cpp');
  const library = read('Source/UE5HTML5Exporter/Private/UE5HTML5ExportLibrary.cpp');
  assert.match(module, /Check Discord Activity Readiness/);
  assert.match(module, /CheckDiscordActivityReadinessInteractive/);
  assert.match(library, /CheckDiscordActivityReadiness/);
  assert.match(library, /GLTFExporter/);
  assert.match(library, /release operator supplies Discord and Supabase configuration/);
});

test('Unreal commandlet exposes the same readiness policy for workstation automation', () => {
  const commandlet = read('Source/UE5HTML5Exporter/Private/UE5HTML5ExportCommandlet.cpp');
  assert.match(commandlet, /FParse::Param\(\*Params, TEXT\("CheckOnly"\)\)/);
  assert.match(commandlet, /FUE5HTML5ExportLibrary::CheckDiscordActivityReadiness\(World\)/);
  assert.match(commandlet, /Discord Activity readiness check passed/);
  assert.match(commandlet, /Readiness blocker/);
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
  assert.match(source, /shouldUseTouchControls/);
});

test('first-person controller converts Unreal coordinates and consumes exported movement defaults', async () => {
  const THREE = await import('three');
  const {
    FirstPersonController,
    shouldUseTouchControls,
    unrealVectorToThree,
  } = await import('../web/src/first-person-controller.js');
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

  assert.equal(shouldUseTouchControls({
    matchMedia: () => ({ matches: true }),
  }, { maxTouchPoints: 0 }), true);
  assert.equal(shouldUseTouchControls({
    matchMedia: () => ({ matches: false }),
  }, { maxTouchPoints: 2 }), true);
  assert.equal(shouldUseTouchControls({
    matchMedia: () => ({ matches: false }),
  }, { maxTouchPoints: 0 }), false);
  assert.equal(shouldUseTouchControls({
    matchMedia: (query) => ({ matches: query === '(pointer: fine)' }),
  }, { maxTouchPoints: 5 }), false);
});

test('mobile first-person controls provide move, look, jump, and fire without pointer lock', async () => {
  const THREE = await import('three');
  const { FirstPersonController } = await import('../web/src/first-person-controller.js');
  class TouchTarget extends EventTarget {
    constructor() {
      super();
      this.hidden = true;
      this.style = {};
      this.targets = new Map();
    }
    querySelector(selector) { return this.targets.get(selector) || null; }
    setPointerCapture() {}
  }
  const eventTarget = new TouchTarget();
  eventTarget.navigator = { maxTouchPoints: 5 };
  eventTarget.matchMedia = () => ({ matches: true });
  const documentTarget = new TouchTarget();
  documentTarget.pointerLockElement = null;
  const controls = new TouchTarget();
  const move = new TouchTarget();
  const knob = new TouchTarget();
  const look = new TouchTarget();
  const jump = new TouchTarget();
  const shoot = new TouchTarget();
  controls.targets.set('[data-touch-move]', move);
  controls.targets.set('[data-touch-move-knob]', knob);
  controls.targets.set('[data-touch-look]', look);
  controls.targets.set('[data-touch-jump]', jump);
  controls.targets.set('[data-touch-shoot]', shoot);
  documentTarget.targets.set('#touch-controls', controls);
  const canvas = new TouchTarget();
  canvas.ownerDocument = documentTarget;
  let requestedPointerLock = false;
  canvas.requestPointerLock = () => { requestedPointerLock = true; };
  let shots = 0;
  let jumps = 0;
  const controller = new FirstPersonController(
    new THREE.PerspectiveCamera(),
    canvas,
    new THREE.Group(),
    { profile: 'firstPerson', movement: {} },
    {
      shoot: () => { shots += 1; },
      jump: ({ jumped }) => { if (jumped) jumps += 1; },
    },
    eventTarget,
  );
  const pointer = (type, { pointerId = 1, clientX = 0, clientY = 0 } = {}) => {
    const event = new Event(type, { cancelable: true });
    Object.defineProperties(event, {
      pointerId: { value: pointerId },
      clientX: { value: clientX },
      clientY: { value: clientY },
    });
    return event;
  };

  assert.equal(controller.touchEnabled, true);
  assert.equal(controls.hidden, false);
  canvas.dispatchEvent(new Event('click'));
  assert.equal(requestedPointerLock, false);
  move.dispatchEvent(pointer('pointerdown', { clientX: 50, clientY: 100 }));
  move.dispatchEvent(pointer('pointermove', { clientX: 77, clientY: 73 }));
  assert.ok(controller.touchMovement.x > 0);
  assert.ok(controller.touchMovement.y > 0);
  const yawBefore = controller.yaw;
  look.dispatchEvent(pointer('pointerdown', { pointerId: 2, clientX: 200, clientY: 100 }));
  look.dispatchEvent(pointer('pointermove', { pointerId: 2, clientX: 230, clientY: 115 }));
  assert.ok(controller.yaw > yawBefore);
  controller.groundGrace = 0.1;
  jump.dispatchEvent(pointer('pointerdown', { pointerId: 3 }));
  shoot.dispatchEvent(pointer('pointerdown', { pointerId: 4 }));
  assert.equal(jumps, 1);
  assert.equal(shots, 1);
  move.dispatchEvent(pointer('pointerup'));
  assert.deepEqual(controller.touchMovement.toArray(), [0, 0]);
  controller.dispose();
  assert.equal(controls.hidden, true);
});

test('exported ShouldUseTouchControls Blueprint calls share the controller capability decision', async () => {
  const THREE = await import('three');
  const { BrowserRuntimeAdapters } = await import('../web/src/runtime-adapters.js');
  const touchWindow = new EventTarget();
  touchWindow.navigator = { maxTouchPoints: 3 };
  touchWindow.matchMedia = () => ({ matches: true });
  const adapters = new BrowserRuntimeAdapters(new THREE.Group(), {
    inputMappings: [],
    widgetBlueprints: [],
    behaviorTrees: [],
  }, {}, touchWindow);

  assert.deepEqual(adapters.call('ShouldUseTouchControls', {}, {}), {
    handled: true,
    value: true,
  });
  adapters.dispose();
});

test('Unreal module declares editor dependencies for exported adapter assets', () => {
  const rules = read('Source/UE5HTML5Exporter/UE5HTML5Exporter.Build.cs');
  for (const module of ['EnhancedInput', 'EngineSettings', 'AIModule', 'UMG', 'UMGEditor']) assert.match(rules, new RegExp(`"${module}"`));
});

test('Windows teammates have native PowerShell install and packaging helpers', () => {
  const tools = readFileSync(new URL('../scripts/UE5HTML5Tools.psm1', import.meta.url), 'utf8');
  const setup = readFileSync(new URL('../scripts/Setup-UE5HTML5Exporter.ps1', import.meta.url), 'utf8');
  const install = readFileSync(new URL('../scripts/Install-UE5HTML5Exporter.ps1', import.meta.url), 'utf8');
  const pack = readFileSync(new URL('../scripts/Package-UE5HTML5Exporter.ps1', import.meta.url), 'utf8');
  const verify = readFileSync(new URL('../scripts/Verify-UE5HTML5Exporter.ps1', import.meta.url), 'utf8');
  assert.match(tools, /LauncherInstalled\.dat/);
  assert.match(tools, /Microsoft\.VisualStudio\.Workload\.NativeGame/);
  assert.match(tools, /10\.0\.22621\.0/);
  assert.match(tools, /17\.14/);
  assert.match(tools, /18\.0/);
  assert.match(setup, /Get-UE5HTML5WorkstationReport/);
  assert.match(setup, /CheckOnly/);
  assert.match(setup, /Install-UE5HTML5Exporter\.ps1/);
  assert.match(install, /\.ue5html5-backups/);
  assert.match(install, /UE5HTML5Exporter\.uplugin/);
  assert.match(pack, /RunUAT\.bat/);
  assert.match(pack, /BuildPlugin/);
  assert.match(pack, /Win64/);
  assert.match(verify, /-CheckOnly/);
  assert.match(verify, /activity-preflight\.mjs/);
  assert.match(verify, /workstation-certification\.json/);
  assert.match(verify, /Get-UE5HTML5WorkstationReport/);
  assert.match(verify, /visualStudioVersion/);
  assert.match(verify, /Package-UE5HTML5Exporter\.ps1/);
  assert.match(verify, /Install-UE5HTML5Exporter\.ps1/);
  assert.match(verify, /projectFile/);
  assert.doesNotMatch(verify, /project = \$projectPath|pluginPackage = \$packagePath|export = \$exportPath/);
});
