import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { BlueprintRuntime } from './blueprint-runtime.js';
import { FirstPersonController } from './first-person-controller.js';
import { loadProjectAdapters, normalizeAdapterName } from './project-adapters.js';
import { BrowserRuntimeAdapters } from './runtime-adapters.js';
import { TargetPracticeRuntime } from './target-practice.js';
import { createAssetPackCache } from './asset-pack-cache.js';
import { createBrowserCertification } from './browser-certification.js';
import './style.css';

const canvas = document.querySelector('#scene');
const loading = document.querySelector('#loading');
const loadingLabel = document.querySelector('#loading-label');
const progress = document.querySelector('#progress');
const errorPanel = document.querySelector('#error');
const errorMessage = document.querySelector('#error-message');
const stats = document.querySelector('#stats');
const animationWrap = document.querySelector('#animation-wrap');
const animationSelect = document.querySelector('#animation');
const logicButton = document.querySelector('#logic-button');
const logicPanel = document.querySelector('#logic-panel');
const logicSummary = document.querySelector('#logic-summary');
const logicDetails = document.querySelector('#logic-details');
const blueprintLog = document.querySelector('#blueprint-log');
const activityStatus = document.querySelector('#activity-status');
const fpsHud = document.querySelector('#fps-hud');
const fpsPrompt = document.querySelector('#fps-prompt');
const targetStatus = document.querySelector('#fps-target-status');
const targetScore = document.querySelector('#fps-target-score');
const targetCount = document.querySelector('#fps-target-count');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x070b10);
scene.environment = createEnvironment();
scene.add(new THREE.HemisphereLight(0xdcecff, 0x16202c, 1.35));

const key = new THREE.DirectionalLight(0xffffff, 2.2);
key.position.set(4, 8, 5);
key.castShadow = true;
scene.add(key);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.01, 100000);
camera.position.set(5, 4, 7);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.075;
controls.screenSpacePanning = true;

const loader = new GLTFLoader();
const clock = new THREE.Clock();
let content = null;
let mixer = null;
let clips = [];
let objectUrl = null;
let blueprintRuntime = null;
let blueprintDocument = null;
let runtimeAdapters = null;
let firstPersonController = null;
let targetPractice = null;
let activityBridge = null;
let exportManifest = null;
let assetPackCache = null;
const browserCertification = createBrowserCertification();
let sceneStats = 'Preparing renderer…';
let deliveryStats = '';
const pendingCustomFunctions = new Map();
let projectAdapters = null;
let projectAdaptersPromise = null;

const looksLikeDiscordActivity = window.location.hostname.toLowerCase().endsWith('.discordsays.com')
  || new URLSearchParams(window.location.search).has('frame_id');
const activityQuery = new URLSearchParams(window.location.search);
const activityHostname = window.location.hostname.toLowerCase();
const discordPreviewMode = activityQuery.get('ue5_discord_preview') === '1'
  && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(activityHostname);
const activityPromise = looksLikeDiscordActivity || discordPreviewMode
  ? startDiscordActivity({ previewMode: discordPreviewMode }).catch((error) => {
      console.warn('Discord Activity adapter unavailable:', error);
      return activityBridge;
    })
  : Promise.resolve(null);

window.UE5HTML5 = {
  registerFunction(name, implementation) {
    const normalized = normalizeAdapterName(name);
    if (!normalized || typeof implementation !== 'function') {
      throw new TypeError('UE5HTML5.registerFunction requires a function name and JavaScript implementation.');
    }
    pendingCustomFunctions.set(normalized, implementation);
    runtimeAdapters?.registerFunction(name, implementation);
  },
  call(eventName, actorName, args) { return blueprintRuntime?.call(eventName, actorName, args); },
  get runtime() { return blueprintRuntime; },
  get adapters() { return runtimeAdapters; },
  get gameplay() { return firstPersonController; },
  get targetPractice() { return targetPractice; },
  get activity() { return activityBridge; },
  get activityReady() { return activityPromise; },
  get projectAdapters() { return projectAdapters; },
  get projectAdaptersReady() { return ensureProjectAdapters(); },
  get exportManifest() { return exportManifest; },
  get assetCache() { return assetPackCache; },
  get certification() { return browserCertification; },
};

function ensureProjectAdapters() {
  projectAdaptersPromise ||= (() => {
    const moduleUrl = assetPackCache?.has('logic/custom-adapters.js')
      ? assetPackCache.versionedUrl('logic/custom-adapters.js')
      : new URL('./logic/custom-adapters.js', window.location.href);
    return loadProjectAdapters({
      manifestUrl: new URL('./logic/custom-adapters.json', window.location.href),
      moduleUrl,
      fetchImpl: assetPackCache
        ? () => assetPackCache.fetch('logic/custom-adapters.json')
        : globalThis.fetch.bind(globalThis),
      isRegistered: (name) => pendingCustomFunctions.has(normalizeAdapterName(name)),
    }).then((value) => {
      projectAdapters = value;
      return value;
    });
  })();
  return projectAdaptersPromise;
}

function formatBytes(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = Number(bytes) || 0;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function updateStats() {
  stats.textContent = [sceneStats, deliveryStats].filter(Boolean).join(' · ');
}

async function loadExportManifest() {
  try {
    const response = await fetch('./export-manifest.json', { cache: 'no-store' });
    if (!response.ok) return null;
    exportManifest = await response.json();
    const delivery = exportManifest?.assetDelivery;
    if (!delivery || !Number.isSafeInteger(delivery.browserPayloadBytes)) return exportManifest;
    const review = delivery.status === 'exceeds-advisory-budget';
    deliveryStats = `${formatBytes(delivery.browserPayloadBytes)} primary payload${review ? ' · delivery review' : ''}`;
    stats.dataset.delivery = review ? 'review' : 'within-budget';
    updateStats();
    return exportManifest;
  } catch (error) {
    console.warn('Export manifest unavailable:', error);
    return null;
  }
}

async function startDiscordActivity({ previewMode = false } = {}) {
  activityStatus.hidden = false;
  activityStatus.dataset.mode = 'connecting';
  const { createDiscordActivityBridge } = await import('./discord-activity.js');
  activityBridge = createDiscordActivityBridge({ previewMode });
  activityBridge.addEventListener('statechange', ({ detail }) => {
    if (detail.mode === 'standalone' || detail.mode === 'idle' || detail.mode === 'checking') {
      activityStatus.hidden = true;
      return;
    }
    activityStatus.hidden = false;
    activityStatus.dataset.mode = detail.mode;
    activityStatus.textContent = detail.mode === 'ready'
      ? `${detail.preview ? 'Discord Preview' : 'Discord'} · ${detail.user.global_name || detail.user.username || 'connected'}`
      : detail.mode === 'error' ? 'Discord · connection failed' : 'Discord · connecting';
  });
  await activityBridge.start();
  return activityBridge;
}

function createEnvironment() {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.background = new THREE.Color(0x1a2430);
  envScene.add(new THREE.HemisphereLight(0xddeeff, 0x111820, 3));
  const result = pmrem.fromScene(envScene, 0.04);
  pmrem.dispose();
  return result.texture;
}

function clearContent() {
  blueprintRuntime?.stop();
  blueprintRuntime = null;
  runtimeAdapters?.dispose();
  runtimeAdapters = null;
  firstPersonController?.dispose();
  firstPersonController = null;
  targetPractice?.dispose();
  targetPractice = null;
  targetStatus.hidden = true;
  fpsHud.hidden = true;
  controls.enabled = true;
  if (!content) return;
  scene.remove(content);
  content.traverse((object) => {
    object.geometry?.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.filter(Boolean).forEach((material) => {
      Object.values(material).forEach((value) => value?.isTexture && value.dispose());
      material.dispose();
    });
  });
  content = null;
  mixer = null;
}

function showBlueprintMessage(message, instance) {
  const element = document.createElement('div');
  element.className = 'blueprint-message';
  element.textContent = instance?.actor?.label ? `${instance.actor.label}: ${message}` : message;
  blueprintLog.append(element);
  setTimeout(() => element.remove(), 4000);
}

function showLogicReport(blueprintIr, runtime) {
  const programs = blueprintIr.programs || [];
  const instances = programs.reduce((total, program) => total + (program.actors?.length || 0), 0);
  const nodes = programs.flatMap((program) => program.graphs || []).flatMap((graph) => graph.nodes || []);
  const unsupported = programs.flatMap((program) => program.compatibility?.unsupported || []);
  logicButton.textContent = unsupported.length ? `Logic: ${unsupported.length} warnings` : `Logic: ${nodes.length} nodes`;
  logicSummary.textContent = `${programs.length} Blueprint programs · ${instances} actor instances · ${nodes.length} graph nodes. ${unsupported.length ? `${unsupported.length} nodes need a web implementation.` : 'All exported nodes are in the supported runtime subset.'}`;
  logicDetails.replaceChildren();
  for (const program of programs) {
    const issues = program.compatibility?.unsupported || [];
    const card = document.createElement('div');
    card.className = `logic-card${issues.length ? ' warning' : ''}`;
    const name = document.createElement('strong');
    name.textContent = program.name;
    const detail = document.createElement('span');
    detail.textContent = `${program.actors?.length || 0} instances · ${issues.length} unsupported nodes`;
    card.append(name, detail);
    logicDetails.append(card);
  }
  for (const diagnostic of runtime.diagnostics) {
    const card = document.createElement('div');
    card.className = 'logic-card warning';
    card.textContent = `${diagnostic.blueprint}: ${diagnostic.message}`;
    logicDetails.append(card);
  }
}

async function configureBlueprintLogic() {
  blueprintRuntime?.stop();
  blueprintRuntime = null;
  try {
    await ensureProjectAdapters();
    const response = assetPackCache
      ? await assetPackCache.fetch('logic/blueprints.json')
      : await fetch('./logic/blueprints.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    blueprintDocument = await response.json();
    runtimeAdapters = new BrowserRuntimeAdapters(content, blueprintDocument, {
      print: showBlueprintMessage,
      diagnostic: () => blueprintDocument && blueprintRuntime && showLogicReport(blueprintDocument, blueprintRuntime),
    }, window);
    targetPractice = new TargetPracticeRuntime(content, blueprintDocument.gameplay?.targets, {
      state: (state) => {
        targetStatus.hidden = state.configuredTargets === 0;
        targetScore.textContent = String(state.score);
        targetCount.textContent = `${state.activeTargets}/${state.configuredTargets}`;
        targetStatus.dataset.bound = state.boundTargets === state.configuredTargets ? 'complete' : 'partial';
      },
    });
    firstPersonController = new FirstPersonController(camera, canvas, content, blueprintDocument.gameplay, {
      state: ({ locked, touch }) => {
        fpsHud.hidden = false;
        fpsPrompt.hidden = touch || locked;
      },
      jump: ({ jumped }) => {
        if (!jumped) return;
        const args = { value: true, actionValue: true, triggerEvent: 'Started' };
        blueprintRuntime?.call('IA_Jump', null, args);
        blueprintRuntime?.call('InputAction_IA_Jump', null, args);
      },
      primaryThumbstick: (args) => Boolean(blueprintRuntime?.call('Primary Thumbstick', null, args)),
      secondaryThumbstick: (args) => Boolean(blueprintRuntime?.call('Secondary Thumbstick', null, args)),
      touchJumpStart: (args) => Boolean(blueprintRuntime?.call('Touch Jump Start', null, args)),
      touchJumpEnd: (args) => Boolean(blueprintRuntime?.call('Touch Jump End', null, args)),
      shoot: (hit) => {
        const targetHit = targetPractice?.applyHit(hit) || null;
        const args = { value: true, actionValue: true, triggerEvent: 'Started', hit, targetHit };
        blueprintRuntime?.call('IA_Shoot', null, args);
        blueprintRuntime?.call('InputAction_IA_Shoot', null, args);
      },
    }, window);
    if (firstPersonController.enabled) {
      controls.enabled = false;
      fpsHud.hidden = false;
      runtimeAdapters.attachGameplayController(firstPersonController);
    }
    for (const [name, implementation] of pendingCustomFunctions) runtimeAdapters.registerFunction(name, implementation);
    blueprintRuntime = new BlueprintRuntime(blueprintDocument, runtimeAdapters, { eventTarget: window });
    runtimeAdapters.attachRuntime(blueprintRuntime);
    blueprintRuntime.start();
    showLogicReport(blueprintDocument, blueprintRuntime);
  } catch (error) {
    console.error('Blueprint runtime initialization failed', error);
    blueprintDocument = null;
    logicButton.textContent = 'Logic: unavailable';
    logicSummary.textContent = `Blueprint runtime did not start: ${error.message}`;
    logicDetails.replaceChildren();
  }
}

function frameObject(object) {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const radius = Math.max(sphere.radius, 0.1);
  const distance = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2));
  camera.near = Math.max(radius / 1000, 0.001);
  camera.far = Math.max(radius * 1000, 1000);
  camera.updateProjectionMatrix();
  camera.position.copy(sphere.center).add(new THREE.Vector3(0.8, 0.55, 1).normalize().multiplyScalar(distance * 1.05));
  controls.target.copy(sphere.center);
  controls.maxDistance = radius * 25;
  controls.update();
}

function countScene(root) {
  let meshes = 0;
  let triangles = 0;
  root.traverse((node) => {
    if (!node.isMesh) return;
    meshes += 1;
    const geometry = node.geometry;
    triangles += geometry.index ? geometry.index.count / 3 : (geometry.attributes.position?.count || 0) / 3;
    node.castShadow = true;
    node.receiveShadow = true;
  });
  return { meshes, triangles: Math.round(triangles) };
}

function configureAnimations(animations) {
  clips = animations;
  animationSelect.replaceChildren();
  if (!clips.length) {
    animationWrap.hidden = true;
    return;
  }
  mixer = new THREE.AnimationMixer(content);
  clips.forEach((clip, index) => animationSelect.add(new Option(clip.name || `Clip ${index + 1}`, String(index))));
  animationWrap.hidden = false;
  playAnimation(0);
}

function playAnimation(index) {
  if (!mixer || !clips[index]) return;
  mixer.stopAllAction();
  mixer.clipAction(clips[index]).reset().fadeIn(0.2).play();
}

function load(url, label = 'scene.glb', { revokeAfterLoad = false } = {}) {
  loading.hidden = false;
  errorPanel.hidden = true;
  loadingLabel.textContent = `Loading ${label}…`;
  progress.style.width = '3%';
  loader.load(url, async (gltf) => {
    clearContent();
    content = gltf.scene;
    scene.add(content);
    frameObject(content);
    configureAnimations(gltf.animations);
    const info = countScene(content);
    sceneStats = `${info.meshes.toLocaleString()} meshes · ${info.triangles.toLocaleString()} triangles · WebGL ${renderer.capabilities.isWebGL2 ? '2' : '1'}`;
    updateStats();
    document.querySelector('#title').textContent = gltf.scene.name || label.replace(/\.(glb|gltf)$/i, '');
    loading.hidden = true;
    if (revokeAfterLoad) URL.revokeObjectURL(url);
    await configureBlueprintLogic();
    await browserCertification.complete({
      manifest: exportManifest,
      runtime: blueprintRuntime,
      gameplay: firstPersonController,
      targetPractice,
    });
  }, (event) => {
    const percent = event.total ? Math.round((event.loaded / event.total) * 100) : 35;
    progress.style.width = `${Math.min(percent, 100)}%`;
  }, (error) => {
    if (revokeAfterLoad) URL.revokeObjectURL(url);
    loading.hidden = true;
    errorPanel.hidden = false;
    const hint = window.location.protocol === 'file:'
      ? 'Serve this folder over HTTP; browsers block module-based viewers opened directly with file://.'
      : 'Make sure assets/scene.glb exists and was uploaded with the rest of the export.';
    errorMessage.textContent = `${error.message || error}. ${hint}`;
    sceneStats = 'Scene unavailable';
    updateStats();
    void browserCertification.fail(error, exportManifest);
  });
}

document.querySelector('#reset').addEventListener('click', () => {
  if (firstPersonController?.enabled) {
    firstPersonController.teleportToStart();
    targetPractice?.reset();
  }
  else if (content) frameObject(content);
});
document.querySelector('#fullscreen').addEventListener('click', () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen());
logicButton.addEventListener('click', () => { logicPanel.hidden = !logicPanel.hidden; });
document.querySelector('#logic-close').addEventListener('click', () => { logicPanel.hidden = true; });
animationSelect.addEventListener('change', () => playAnimation(Number(animationSelect.value)));
document.querySelector('#file').addEventListener('change', (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);
  load(objectUrl, file.name);
});
window.addEventListener('resize', () => {
  const width = window.innerWidth;
  const height = window.innerHeight;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
});

renderer.setAnimationLoop(() => {
  const delta = Math.min(clock.getDelta(), 0.1);
  mixer?.update(delta);
  blueprintRuntime?.tick(delta);
  runtimeAdapters?.tick(delta);
  firstPersonController?.update(delta);
  if (controls.enabled) controls.update();
  renderer.render(scene, camera);
});

async function boot() {
  const manifest = await loadExportManifest();
  try {
    assetPackCache = createAssetPackCache(manifest?.assetPack, {
      baseUrl: window.location.href,
    });
    assetPackCache.addEventListener('statuschange', ({ detail }) => {
      document.documentElement.dataset.assetCache = detail.mode;
    });
  } catch (error) {
    console.warn('Exported asset-pack cache is unavailable:', error);
    assetPackCache = null;
    if (browserCertification.enabled) {
      await browserCertification.fail(error, manifest);
      return;
    }
  }

  try {
    if (await browserCertification.prepare(assetPackCache, manifest)) return;
  } catch (error) {
    await browserCertification.fail(error, manifest);
    return;
  }

  if (!assetPackCache) {
    load('./assets/scene.glb');
    return;
  }
  try {
    const response = await assetPackCache.fetch('assets/scene.glb');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const sceneUrl = URL.createObjectURL(await response.blob());
    load(sceneUrl, 'scene.glb', { revokeAfterLoad: true });
  } catch (error) {
    loading.hidden = true;
    errorPanel.hidden = false;
    errorMessage.textContent = `The exported scene did not pass its asset-pack integrity check: ${error.message || error}`;
    sceneStats = 'Scene unavailable';
    updateStats();
    await browserCertification.fail(error, manifest);
  }
}

void boot();
