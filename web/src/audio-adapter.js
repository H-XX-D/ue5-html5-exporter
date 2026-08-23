export const AUDIO_ASSET_SCHEMA = 'ue5-html5-audio-assets/v1';

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
      gain.connect(context.destination);
      source.addEventListener?.('ended', () => this.sources.delete(source), { once: true });
      this.sources.add(source);
      source.start(0, Math.max(0, Number(args.starttime || 0)));
    }).catch((error) => this.onWarning(`Could not play ${entry.source}: ${error.message || error}`));
    return true;
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
