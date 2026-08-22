import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { BlueprintRuntime } from './blueprint-runtime.js';
import { BrowserRuntimeAdapters } from './runtime-adapters.js';
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
const pendingCustomFunctions = new Map();

window.UE5HTML5 = {
  registerFunction(name, implementation) {
    pendingCustomFunctions.set(name, implementation);
    runtimeAdapters?.registerFunction(name, implementation);
  },
  call(eventName, actorName, args) { return blueprintRuntime?.call(eventName, actorName, args); },
  get runtime() { return blueprintRuntime; },
  get adapters() { return runtimeAdapters; },
};

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
    const response = await fetch('./logic/blueprints.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    blueprintDocument = await response.json();
    runtimeAdapters = new BrowserRuntimeAdapters(content, blueprintDocument, {
      print: showBlueprintMessage,
      diagnostic: () => blueprintDocument && blueprintRuntime && showLogicReport(blueprintDocument, blueprintRuntime),
    }, window);
    for (const [name, implementation] of pendingCustomFunctions) runtimeAdapters.registerFunction(name, implementation);
    blueprintRuntime = new BlueprintRuntime(blueprintDocument, runtimeAdapters, { eventTarget: window });
    runtimeAdapters.attachRuntime(blueprintRuntime);
    blueprintRuntime.start();
    showLogicReport(blueprintDocument, blueprintRuntime);
  } catch (error) {
    console.error('Blueprint runtime initialization failed', error);
    blueprintDocument = null;
    logicButton.textContent = 'Logic: none';
    logicSummary.textContent = 'No Blueprint IR was found in this export.';
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

function load(url, label = 'scene.glb') {
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
    stats.textContent = `${info.meshes.toLocaleString()} meshes · ${info.triangles.toLocaleString()} triangles · WebGL ${renderer.capabilities.isWebGL2 ? '2' : '1'}`;
    document.querySelector('#title').textContent = gltf.scene.name || label.replace(/\.(glb|gltf)$/i, '');
    loading.hidden = true;
    await configureBlueprintLogic();
  }, (event) => {
    const percent = event.total ? Math.round((event.loaded / event.total) * 100) : 35;
    progress.style.width = `${Math.min(percent, 100)}%`;
  }, (error) => {
    loading.hidden = true;
    errorPanel.hidden = false;
    const hint = window.location.protocol === 'file:'
      ? 'Serve this folder over HTTP; browsers block module-based viewers opened directly with file://.'
      : 'Make sure assets/scene.glb exists and was uploaded with the rest of the export.';
    errorMessage.textContent = `${error.message || error}. ${hint}`;
    stats.textContent = 'Scene unavailable';
  });
}

document.querySelector('#reset').addEventListener('click', () => content && frameObject(content));
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
  controls.update();
  renderer.render(scene, camera);
});

load('./assets/scene.glb');
