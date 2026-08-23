export const AUDIO_ASSET_SCHEMA = 'ue5-html5-audio-assets/v1';

const finiteNumber = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

function setAudioParam(param, value, time = 0) {
  if (!param) return false;
  if (typeof param.setValueAtTime === 'function') param.setValueAtTime(value, time);
  else param.value = value;
  return true;
}

function setPosition(target, position, time = 0) {
  const x = finiteNumber(position?.x);
  const y = finiteNumber(position?.y);
  const z = finiteNumber(position?.z);
  if (setAudioParam(target?.positionX, x, time)
    && setAudioParam(target?.positionY, y, time)
    && setAudioParam(target?.positionZ, z, time)) return;
  target?.setPosition?.(x, y, z);
}

function setOrientation(target, forward, up, time = 0) {
  const forwardX = finiteNumber(forward?.x);
  const forwardY = finiteNumber(forward?.y);
  const forwardZ = finiteNumber(forward?.z, -1);
  const upX = finiteNumber(up?.x);
  const upY = finiteNumber(up?.y, 1);
  const upZ = finiteNumber(up?.z);
  if (setAudioParam(target?.forwardX, forwardX, time)
    && setAudioParam(target?.forwardY, forwardY, time)
    && setAudioParam(target?.forwardZ, forwardZ, time)
    && setAudioParam(target?.upX, upX, time)
    && setAudioParam(target?.upY, upY, time)
    && setAudioParam(target?.upZ, upZ, time)) return;
  target?.setOrientation?.(forwardX, forwardY, forwardZ, upX, upY, upZ);
}

export function unrealAudioLocationToWebAudio(value = {}) {
  return {
    x: finiteNumber(value?.x) / 100,
    y: finiteNumber(value?.z) / 100,
    z: -finiteNumber(value?.y) / 100,
  };
}

function soundReference(value) {
  const raw = typeof value === 'object' && value !== null
    ? value.source || value.path || value.asset || value.name || ''
    : value;
  return String(raw || '')
    .trim()
    .replace(/^(?:SoundWave|SoundCue)'(.+)'$/i, '$1')
    .toLowerCase();
}

export function validateAudioAssets(value) {
  if (!value) return { schema: AUDIO_ASSET_SCHEMA, sounds: [] };
  if (typeof value !== 'object' || value.schema !== AUDIO_ASSET_SCHEMA || !Array.isArray(value.sounds)) {
    throw new Error(`Blueprint audio assets must use ${AUDIO_ASSET_SCHEMA}.`);
  }
  const sources = new Set();
  const sounds = value.sounds.map((entry, index) => {
    const source = String(entry?.source || '').trim();
    const path = String(entry?.path || '').trim();
    const key = soundReference(source);
    if (!source || !key || !/^assets\/audio\/[A-Za-z0-9_.-]+\.wav$/.test(path)) {
      throw new Error(`Blueprint audio asset ${index} has an invalid source or WAV path.`);
    }
    if (sources.has(key)) throw new Error(`Blueprint audio assets declare ${source} more than once.`);
    sources.add(key);
    return {
      source,
      path,
      durationSeconds: Math.max(0, Number(entry.durationSeconds || 0)),
      channels: Math.max(0, Math.round(Number(entry.channels || 0))),
    };
  });
  return { schema: AUDIO_ASSET_SCHEMA, sounds };
}

export class AudioAdapter {
  constructor(audioAssets, {
    fetchAsset = (path) => fetch(path, { cache: 'no-store' }),
    audioContextFactory = () => {
      const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
      return Context ? new Context() : null;
    },
    eventTarget = globalThis.window,
    onWarning = () => {},
  } = {}) {
    this.manifest = validateAudioAssets(audioAssets);
    this.entries = new Map(this.manifest.sounds.map((entry) => [soundReference(entry.source), entry]));
    this.fetchAsset = fetchAsset;
    this.audioContextFactory = audioContextFactory;
    this.eventTarget = eventTarget;
    this.onWarning = onWarning;
    this.context = null;
    this.buffers = new Map();
    this.sources = new Set();
    this.unlock = () => {
      if (this.context?.state === 'suspended') this.context.resume().catch(() => {});
    };
    for (const type of ['pointerdown', 'keydown', 'touchstart']) {
      this.eventTarget?.addEventListener?.(type, this.unlock, { passive: true });
    }
  }

  resolve(value) { return this.entries.get(soundReference(value)) || null; }

  ensureContext() {
    this.context ||= this.audioContextFactory?.() || null;
    return this.context;
  }

  load(entry, context) {
    if (!this.buffers.has(entry.path)) {
      this.buffers.set(entry.path, Promise.resolve(this.fetchAsset(entry.path)).then(async (response) => {
        if (!response?.ok) throw new Error(`HTTP ${response?.status ?? 'unknown'} for ${entry.path}`);
        return context.decodeAudioData((await response.arrayBuffer()).slice(0));
      }));
    }
    return this.buffers.get(entry.path);
  }

  play(value, args = {}) {
    const entry = this.resolve(value);
    if (!entry) {
      this.onWarning(`No exported SoundWave matches ${String(value || '<empty>')}.`);
      return false;
    }
    const context = this.ensureContext();
    if (!context) {
      this.onWarning('This browser does not provide Web Audio playback.');
      return false;
    }
    const resume = context.state === 'suspended' ? context.resume() : Promise.resolve();
    Promise.all([resume, this.load(entry, context)]).then(([, buffer]) => {
      const source = context.createBufferSource();
      const gain = context.createGain();
      source.buffer = buffer;
      source.playbackRate.value = Math.min(4, Math.max(0.125, Number(args.pitchmultiplier ?? 1)));
      gain.gain.value = Math.min(4, Math.max(0, Number(args.volumemultiplier ?? 1)));
      source.connect(gain);
      const location = args.spatialLocation;
      if (location && typeof context.createPanner === 'function') {
        const panner = context.createPanner();
        panner.panningModel = 'HRTF';
        panner.distanceModel = 'inverse';
        panner.refDistance = 1;
        panner.maxDistance = 10000;
        panner.rolloffFactor = 1;
        setPosition(panner, location, context.currentTime);
        gain.connect(panner);
        panner.connect(context.destination);
      } else {
        gain.connect(context.destination);
      }
      source.addEventListener?.('ended', () => this.sources.delete(source), { once: true });
      this.sources.add(source);
      source.start(0, Math.max(0, Number(args.starttime || 0)));
    }).catch((error) => this.onWarning(`Could not play ${entry.source}: ${error.message || error}`));
    return true;
  }

  playAtLocation(value, args = {}) {
    const location = args.location ?? args.soundlocation ?? args.worldlocation;
    return this.play(value, {
      ...args,
      spatialLocation: unrealAudioLocationToWebAudio(location),
    });
  }

  updateListener(position, forward, up) {
    if (!this.context?.listener) return;
    setPosition(this.context.listener, position, this.context.currentTime);
    setOrientation(this.context.listener, forward, up, this.context.currentTime);
  }

  dispose() {
    for (const type of ['pointerdown', 'keydown', 'touchstart']) {
      this.eventTarget?.removeEventListener?.(type, this.unlock, { passive: true });
    }
    for (const source of this.sources) {
      try { source.stop(); } catch { /* already stopped */ }
    }
    this.sources.clear();
    this.buffers.clear();
    this.context?.close?.().catch?.(() => {});
    this.context = null;
  }
}
