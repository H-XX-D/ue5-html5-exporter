import * as THREE from 'three';

const CERTIFICATION_SCHEMA = 'ue5-html5-browser-certification/v3';
const CERTIFICATION_QUERY = 'ue5_certify';
const CERTIFICATION_TOKEN_QUERY = 'ue5_certify_token';
const CERTIFICATION_ENDPOINT = '/__ue5html5_certification__';
const CERTIFICATION_STORAGE_KEY = 'ue5html5-browser-certification-v3';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function errorText(error) {
  return error?.message || String(error);
}

function roundMetric(value) {
  return Number(Number(value).toFixed(3));
}

function percentile(sortedValues, fraction) {
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(sortedValues.length * fraction) - 1));
  return sortedValues[index];
}

export async function measureFramePacing({
  requestFrame = globalThis.requestAnimationFrame?.bind(globalThis),
  sampleFrames = 120,
} = {}) {
  requireCondition(typeof requestFrame === 'function', 'Frame-pacing certification requires requestAnimationFrame.');
  requireCondition(Number.isInteger(sampleFrames) && sampleFrames >= 30 && sampleFrames <= 600,
    'Frame-pacing certification requires 30 to 600 sampled frames.');

  const timestamps = [];
  await new Promise((resolve, reject) => {
    const capture = (timestamp) => {
      if (!Number.isFinite(timestamp)) {
        reject(new Error('requestAnimationFrame returned an invalid timestamp.'));
        return;
      }
      timestamps.push(timestamp);
      if (timestamps.length > sampleFrames) {
        resolve();
        return;
      }
      requestFrame(capture);
    };
    requestFrame(capture);
  });

  const intervals = timestamps.slice(1).map((timestamp, index) => timestamp - timestamps[index]);
  requireCondition(intervals.length === sampleFrames && intervals.every((value) => Number.isFinite(value) && value > 0),
    'Frame-pacing certification received invalid frame intervals.');
  const durationMs = intervals.reduce((total, value) => total + value, 0);
  const sorted = [...intervals].sort((left, right) => left - right);
  return {
    sampleCount: intervals.length,
    durationMs: roundMetric(durationMs),
    averageFramesPerSecond: roundMetric((intervals.length * 1000) / durationMs),
    p50FrameMs: roundMetric(percentile(sorted, 0.50)),
    p95FrameMs: roundMetric(percentile(sorted, 0.95)),
    maxFrameMs: roundMetric(sorted[sorted.length - 1]),
    framesOver33Ms: intervals.filter((value) => value > (1000 / 30)).length,
    framesOver50Ms: intervals.filter((value) => value > 50).length,
  };
}

export function isLoopbackCertification(locationObject = globalThis.location) {
  if (!locationObject) return false;
  const query = new URLSearchParams(locationObject.search || '');
  return LOOPBACK_HOSTS.has(String(locationObject.hostname || '').toLowerCase())
    && query.get(CERTIFICATION_QUERY) === '1';
}

export function resourceModeCoverage(assetPack, events, expectedMode) {
  const expectedVersion = String(assetPack?.version || '');
  const resources = Array.from(assetPack?.resources || [])
    .filter(({ delivery }) => delivery === 'cache-api-integrity')
    .map(({ path }) => String(path || ''));
  return resources.map((path) => ({
    path,
    mode: expectedMode,
    cacheBustVersion: expectedVersion,
    passed: Boolean(path && events.some((event) => (
      event.path === path
      && event.mode === expectedMode
      && event.cacheBustVersion === expectedVersion
    ))),
  }));
}

export function versionedModuleCoverage(assetPack, events) {
  const expectedVersion = String(assetPack?.version || '');
  const resources = Array.from(assetPack?.resources || [])
    .filter(({ delivery }) => delivery === 'versioned-module')
    .map(({ path }) => String(path || ''));
  return resources.map((path) => ({
    path,
    mode: 'versioned-module',
    cacheBustVersion: expectedVersion,
    passed: Boolean(path && events.some((event) => (
      event.path === path
      && event.mode === 'versioned-module'
      && event.cacheBustVersion === expectedVersion
    ))),
  }));
}

async function waitUntil(predicate, {
  timeoutMs,
  intervalMs = 50,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = () => Date.now(),
}) {
  const deadline = now() + timeoutMs;
  while (now() <= deadline) {
    if (predicate()) return true;
    await wait(intervalMs);
  }
  return false;
}

export function aimAtBoundTarget(gameplay, target) {
  if (!gameplay?.camera || !target?.objects?.size) return false;
  const bounds = new THREE.Box3();
  for (const object of target.objects) bounds.expandByObject(object, true);
  if (bounds.isEmpty()) return false;
  const center = bounds.getCenter(new THREE.Vector3());
  gameplay.camera.lookAt(center);
  gameplay.yaw = gameplay.camera.rotation.y;
  gameplay.pitch = gameplay.camera.rotation.x;
  gameplay.updateCamera?.();
  gameplay.camera.updateMatrixWorld?.(true);
  return true;
}

export async function runTargetPracticeCertification(gameplay, targetPractice, options = {}) {
  requireCondition(gameplay?.enabled, 'The exported game did not enable its first-person controller.');
  requireCondition(targetPractice?.enabled, 'The export does not contain a target-practice definition.');

  const reset = targetPractice.reset();
  requireCondition(reset.configuredTargets > 0, 'No target-practice targets were configured.');
  requireCondition(reset.boundTargets === reset.configuredTargets, 'One or more target-practice definitions did not bind to exported scene objects.');
  const initialScore = reset.score;
  const initialActiveTargets = reset.activeTargets;
  const boundTarget = targetPractice.targets.find((candidate) => candidate.objects?.size > 0 && !candidate.depleted);
  requireCondition(boundTarget, 'No configured target has an exported scene object.');
  if (gameplay.camera) {
    requireCondition(aimAtBoundTarget(gameplay, boundTarget), `Could not aim the browser camera at ${boundTarget.label}.`);
  }

  const firstHit = gameplay.shoot();
  requireCondition(firstHit, 'The center-ray shot did not hit exported scene geometry.');
  await (options.wait || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))))(40);

  const target = targetPractice.targets.find((candidate) => candidate.depleted || candidate.health < candidate.maxHealth);
  requireCondition(target, 'The center-ray shot did not resolve to a configured target.');
  requireCondition(target.scoreValue > 0, `Target ${target.label} has no positive score value.`);
  requireCondition(target.respawn, `Target ${target.label} is not configured to respawn.`);

  let shots = 1;
  const maximumShots = Math.min(100, Math.ceil(target.maxHealth / target.damagePerShot) + 2);
  while (!target.depleted && shots < maximumShots) {
    const hit = gameplay.shoot();
    requireCondition(hit, `Shot ${shots + 1} did not hit exported scene geometry.`);
    shots += 1;
    await (options.wait || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))))(40);
  }

  const afterShots = targetPractice.snapshot('certification-shots');
  requireCondition(target.depleted, `Target ${target.label} did not deplete after ${shots} center-ray shots.`);
  requireCondition(afterShots.activeTargets === initialActiveTargets - 1, 'Depleting the target did not reduce the active-target count.');
  requireCondition(afterShots.score === initialScore + target.scoreValue, 'Depleting the target did not apply its configured score exactly once.');

  const respawnTimeoutMs = Math.min(30000, Math.max(3000, Math.ceil(target.respawnDelaySeconds * 1000) + 2000));
  const respawned = await waitUntil(() => !target.depleted && target.health === target.maxHealth, {
    timeoutMs: respawnTimeoutMs,
    wait: options.wait,
    now: options.now,
  });
  requireCondition(respawned, `Target ${target.label} did not respawn within ${respawnTimeoutMs} ms.`);
  const afterRespawn = targetPractice.snapshot('certification-respawn');
  requireCondition(afterRespawn.activeTargets === initialActiveTargets, 'Respawning the target did not restore the active-target count.');

  return {
    target: { id: target.id, label: target.label },
    shots,
    scoreDelta: afterShots.score - initialScore,
    before: clone(reset),
    afterShots: clone(afterShots),
    afterRespawn: clone(afterRespawn),
  };
}

export class BrowserCertification {
  constructor({
    locationObject = globalThis.location,
    storage = globalThis.sessionStorage,
    cacheStorage = globalThis.caches,
    fetchImpl = globalThis.fetch?.bind(globalThis),
    reload = () => globalThis.location?.reload(),
    documentObject = globalThis.document,
    now = () => new Date(),
    wait,
    monotonicNow = globalThis.performance?.now?.bind(globalThis.performance),
    requestFrame = globalThis.requestAnimationFrame?.bind(globalThis),
    measureFrames = measureFramePacing,
  } = {}) {
    this.location = locationObject;
    this.storage = storage;
    this.cacheStorage = cacheStorage;
    this.fetchImpl = fetchImpl;
    this.reload = reload;
    this.document = documentObject;
    this.now = now;
    this.wait = wait;
    this.monotonicNow = monotonicNow;
    this.requestFrame = requestFrame;
    this.measureFrames = measureFrames;
    this.enabled = isLoopbackCertification(locationObject);
    this.events = [];
    this.assetCache = null;
    this.assetPack = null;
    this.lastReport = null;
    this.statusElement = null;
    this.onCacheStatus = ({ detail }) => this.events.push(clone(detail));
  }

  token() {
    const token = new URLSearchParams(this.location?.search || '').get(CERTIFICATION_TOKEN_QUERY) || '';
    return /^[a-f0-9]{32,128}$/i.test(token) ? token : '';
  }

  readState() {
    try {
      return JSON.parse(this.storage?.getItem(CERTIFICATION_STORAGE_KEY) || 'null');
    } catch {
      return null;
    }
  }

  writeState(state) {
    this.storage?.setItem(CERTIFICATION_STORAGE_KEY, JSON.stringify(state));
  }

  clearState() {
    this.storage?.removeItem(CERTIFICATION_STORAGE_KEY);
  }

  show(message, status = 'running') {
    if (!this.document?.body) return;
    if (!this.statusElement) {
      this.statusElement = this.document.createElement('pre');
      this.statusElement.id = 'ue5-browser-certification';
      Object.assign(this.statusElement.style, {
        position: 'fixed',
        inset: '1rem',
        zIndex: '2147483647',
        margin: '0',
        padding: '1rem',
        overflow: 'auto',
        color: '#eef6ff',
        background: 'rgba(5, 10, 18, 0.94)',
        border: '2px solid #4ba3ff',
        borderRadius: '10px',
        font: '14px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace',
        whiteSpace: 'pre-wrap',
      });
      this.document.body.append(this.statusElement);
    }
    this.statusElement.dataset.status = status;
    this.statusElement.style.borderColor = status === 'passed' ? '#55d98b' : status === 'failed' ? '#ff6b75' : '#4ba3ff';
    this.statusElement.textContent = message;
  }

  async prepare(assetCache, manifest) {
    if (!this.enabled) return false;
    this.assetCache = assetCache;
    this.assetPack = manifest?.assetPack;
    const token = this.token();
    requireCondition(token, 'Browser certification requires the loopback server token.');
    requireCondition(assetCache?.enabled, 'Browser certification requires Cache API and Web Crypto support.');
    requireCondition(this.assetPack?.version, 'Browser certification requires an exported asset-pack manifest.');
    assetCache.addEventListener('statuschange', this.onCacheStatus);

    const previous = this.readState();
    if (!previous
        || previous.schema !== CERTIFICATION_SCHEMA
        || previous.token !== token
        || previous.assetPackVersion !== this.assetPack.version
        || !['cold', 'warm'].includes(previous.stage)) {
      this.show('UE5 browser certification\nPreparing an empty exporter cache…');
      const cleared = await this.cacheStorage?.delete?.(assetCache.cacheName);
      requireCondition(cleared !== undefined, 'Browser certification could not access Cache Storage.');
      this.writeState({
        schema: CERTIFICATION_SCHEMA,
        token,
        assetPackVersion: this.assetPack.version,
        stage: 'cold',
        startedAtUtc: this.now().toISOString(),
      });
      this.reload();
      return true;
    }

    this.show(`UE5 browser certification\nRunning ${previous.stage} asset and gameplay stage…`);
    return false;
  }

  assertDeliveryMode(mode) {
    const coverage = resourceModeCoverage(this.assetPack, this.events, mode);
    const missing = coverage.filter(({ passed }) => !passed).map(({ path }) => path);
    requireCondition(!missing.length, `${mode} was not observed for: ${missing.join(', ')}`);
    const unsafe = this.events.find(({ mode: eventMode }) => ['cache-rejected', 'network-fallback', 'network-only'].includes(eventMode));
    requireCondition(!unsafe, `Asset delivery entered ${unsafe?.mode} for ${unsafe?.path || '<unknown>'}.`);
    return coverage;
  }

  assertVersionedModules() {
    const coverage = versionedModuleCoverage(this.assetPack, this.events);
    const missing = coverage.filter(({ passed }) => !passed).map(({ path }) => path);
    requireCondition(!missing.length, `Versioned module loading was not observed for: ${missing.join(', ')}`);
    return coverage;
  }

  async complete({ manifest, runtime, gameplay, targetPractice }) {
    if (!this.enabled) return null;
    try {
      const state = this.readState();
      requireCondition(state?.token === this.token(), 'Browser certification lost its reload state.');
      if (state.stage === 'cold') {
        state.cold = {
          events: clone(this.events),
          coverage: this.assertDeliveryMode('network-cached'),
          versionedModuleCoverage: this.assertVersionedModules(),
        };
        state.stage = 'warm';
        this.writeState(state);
        this.show('UE5 browser certification\nCold download and integrity checks passed. Reloading for warm-cache proof…');
        this.reload();
        return null;
      }

      requireCondition(state.stage === 'warm', `Unsupported browser certification stage: ${state.stage || '<missing>'}`);
      const warm = {
        events: clone(this.events),
        coverage: this.assertDeliveryMode('cache-hit'),
        versionedModuleCoverage: this.assertVersionedModules(),
      };
      requireCondition(runtime, 'The exported Blueprint runtime did not start.');
      const runtimeReadyFromNavigationStartMs = Number(this.monotonicNow?.());
      requireCondition(Number.isFinite(runtimeReadyFromNavigationStartMs) && runtimeReadyFromNavigationStartMs >= 0,
        'Browser certification could not measure runtime-ready time.');
      const framePacing = await this.measureFrames({ requestFrame: this.requestFrame });
      const gameplayResult = await runTargetPracticeCertification(gameplay, targetPractice, {
        wait: this.wait,
        now: this.wait ? () => this.now().getTime() : undefined,
      });
      const report = {
        schema: CERTIFICATION_SCHEMA,
        status: 'passed',
        verifiedAtUtc: this.now().toISOString(),
        exporterVersion: String(manifest?.exporterVersion || ''),
        manifestSchema: String(manifest?.schema || ''),
        assetPack: {
          schema: String(this.assetPack?.schema || ''),
          version: String(this.assetPack?.version || ''),
          cacheBusting: String(this.assetPack?.cacheBusting || ''),
          resourceCount: this.assetPack?.resources?.length || 0,
          cacheResourceCount: Array.from(this.assetPack?.resources || [])
            .filter(({ delivery }) => delivery === 'cache-api-integrity').length,
          versionedModuleCount: Array.from(this.assetPack?.resources || [])
            .filter(({ delivery }) => delivery === 'versioned-module').length,
          cold: state.cold,
          warm,
        },
        runtime: {
          blueprintReady: true,
          firstPersonEnabled: Boolean(gameplay?.enabled),
        },
        performance: {
          advisoryOnly: true,
          context: 'local-browser-only',
          runtimeReadyFromNavigationStartMs: roundMetric(runtimeReadyFromNavigationStartMs),
          framePacing,
          deviceMetadataCollected: false,
        },
        targetPractice: gameplayResult,
        privacy: {
          credentialsAccessed: false,
          personalPlayerDataCollected: false,
          deviceMetadataCollected: false,
          scope: 'loopback browser runtime, asset delivery, timing-only performance, and local target-practice behavior only',
        },
        errors: [],
      };
      await this.submit(report);
      this.clearState();
      this.lastReport = report;
      this.show(`UE5 browser certification PASSED\n\n${JSON.stringify(report, null, 2)}`, 'passed');
      return report;
    } catch (error) {
      return this.fail(error, manifest);
    }
  }

  async fail(error, manifest = null) {
    if (!this.enabled) return null;
    const report = {
      schema: CERTIFICATION_SCHEMA,
      status: 'failed',
      verifiedAtUtc: this.now().toISOString(),
      exporterVersion: String(manifest?.exporterVersion || ''),
      manifestSchema: String(manifest?.schema || ''),
      assetPack: {
        version: String(this.assetPack?.version || ''),
        events: clone(this.events),
      },
      privacy: {
        credentialsAccessed: false,
        personalPlayerDataCollected: false,
        deviceMetadataCollected: false,
        scope: 'loopback browser runtime, asset delivery, timing-only performance, and local target-practice behavior only',
      },
      errors: [errorText(error)],
    };
    this.clearState();
    this.lastReport = report;
    this.show(`UE5 browser certification FAILED\n\n${errorText(error)}`, 'failed');
    try {
      await this.submit(report);
    } catch (submitError) {
      this.show(`UE5 browser certification FAILED\n\n${errorText(error)}\n\nCould not write the report: ${errorText(submitError)}`, 'failed');
    }
    return report;
  }

  async submit(report) {
    requireCondition(this.fetchImpl, 'Fetch is unavailable for the certification report.');
    const endpoint = new URL(CERTIFICATION_ENDPOINT, this.location.href);
    requireCondition(endpoint.origin === this.location.origin, 'Certification reports must stay on the loopback origin.');
    const response = await this.fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ue5html5-certification-token': this.token(),
      },
      body: JSON.stringify(report),
    });
    requireCondition(response.ok, `Certification server rejected the report with HTTP ${response.status}.`);
  }
}

export function createBrowserCertification(options) {
  return new BrowserCertification(options);
}

export {
  CERTIFICATION_ENDPOINT,
  CERTIFICATION_QUERY,
  CERTIFICATION_SCHEMA,
  CERTIFICATION_STORAGE_KEY,
  CERTIFICATION_TOKEN_QUERY,
};
