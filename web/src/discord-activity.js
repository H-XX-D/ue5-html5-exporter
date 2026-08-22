import {
  DiscordSDK,
  DiscordSDKMock,
  Events,
  RPCErrorCodes,
  patchUrlMappings,
} from '@discord/embedded-app-sdk';
import { createClient } from '@supabase/supabase-js';

const DEFAULT_CONFIG_URL = '/api/activity';
const DEFAULT_SCOPES = ['identify'];
const PREVIEW_CLIENT_ID = '123456789012345678';
const PREVIEW_STATE_BYTES = 512 * 1024;
const PREVIEW_STORAGE_PREFIX = 'ue5-html5-discord-preview';
const THERMAL_STATE_NAMES = Object.freeze({
  [-1]: 'Unhandled', 0: 'Nominal', 1: 'Fair', 2: 'Serious', 3: 'Critical',
});
const ORIENTATION_NAMES = Object.freeze({
  [-1]: 'Unhandled', 0: 'Portrait', 1: 'Landscape',
});
const LAYOUT_MODE_NAMES = Object.freeze({
  [-1]: 'Unhandled', 0: 'Focused', 1: 'PictureInPicture', 2: 'Grid',
});

export function resolveActivityApiUrl(documentObject = globalThis.document) {
  const configured = documentObject
    ?.querySelector?.('meta[name="ue5-activity-api"]')
    ?.getAttribute?.('content')
    ?.trim();
  return configured || DEFAULT_CONFIG_URL;
}

function activityEvent(type, detail) {
  return new CustomEvent(type, { detail });
}

function optionalText(value) {
  const text = String(value || '').trim();
  return text || undefined;
}

function publicActivityErrorCode(error) {
  const candidate = error?.code ?? error?.status
    ?? (error?.name && error.name !== 'Error' ? error.name : undefined);
  const normalized = String(candidate || '').trim();
  if (/^\d{3,6}$/.test(normalized) || /^[A-Z][A-Z0-9_]{1,63}$/.test(normalized)) {
    return normalized;
  }
  return 'ACTIVITY_CONNECTION_FAILED';
}

function partySize(value, label) {
  const number = Number(value || 0);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return number;
}

function namedDiscordState(payload, field, names) {
  const state = Number(payload?.[field] ?? payload);
  return {
    state: Number.isInteger(state) ? state : -1,
    name: names[Number.isInteger(state) ? state : -1] || 'Unknown',
  };
}

async function responseJson(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `Activity API returned HTTP ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

export function isDiscordActivityContext(locationObject = globalThis.location) {
  if (!locationObject) return false;
  const hostname = String(locationObject.hostname || '').toLowerCase();
  const search = String(locationObject.search || '');
  return hostname.endsWith('.discordsays.com') || new URLSearchParams(search).has('frame_id');
}

export function isDiscordActivityPreviewContext(locationObject = globalThis.location) {
  if (!locationObject) return false;
  const hostname = String(locationObject.hostname || '').toLowerCase();
  const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
  return loopback && new URLSearchParams(String(locationObject.search || '')).get('ue5_discord_preview') === '1';
}

function previewStorageKey(kind) {
  return `${PREVIEW_STORAGE_PREFIX}:${kind}`;
}

function previewStateSize(state) {
  return new TextEncoder().encode(JSON.stringify(state)).byteLength;
}

export class DiscordActivityBridge extends EventTarget {
  constructor({
    fetchImpl = globalThis.fetch?.bind(globalThis),
    DiscordSDKClass = DiscordSDK,
    DiscordSDKMockClass = DiscordSDKMock,
    patchMappings = patchUrlMappings,
    createSupabaseClient = createClient,
    locationObject = globalThis.location,
    storage,
    previewMode = false,
    randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto),
    configUrl = resolveActivityApiUrl(),
  } = {}) {
    super();
    this.fetchImpl = fetchImpl;
    this.DiscordSDKClass = DiscordSDKClass;
    this.DiscordSDKMockClass = DiscordSDKMockClass;
    this.patchMappings = patchMappings;
    this.createSupabaseClient = createSupabaseClient;
    this.locationObject = locationObject;
    this.previewMode = Boolean(previewMode) && isDiscordActivityPreviewContext(locationObject);
    this.storage = storage;
    if (this.previewMode && !this.storage) {
      try { this.storage = globalThis.localStorage; }
      catch { this.storage = null; }
    }
    this.randomUUID = randomUUID || (() => `${Date.now()}-${Math.random()}`);
    this.configUrl = configUrl;
    this.mode = 'idle';
    this.publicState = { mode: 'idle' };
    this.config = null;
    this.discord = null;
    this.discordAccessToken = null;
    this.realtimeToken = null;
    this.realtimeExpiresAt = null;
    this.entitlements = [];
    this.supabase = null;
    this.user = null;
    this.topic = null;
    this.channel = null;
    this.refreshTimer = null;
    this.entitlementHandler = null;
    this.participantsHandler = null;
    this.discordEventSubscriptions = [];
  }

  setMode(mode, detail = {}) {
    this.mode = mode;
    this.publicState = {
      mode,
      ...(optionalText(detail.reason) ? { reason: optionalText(detail.reason) } : {}),
      ...(detail.error ? { errorCode: publicActivityErrorCode(detail.error) } : {}),
      ...(detail.preview ? { preview: true } : {}),
    };
    this.dispatchEvent(activityEvent('statechange', { mode, ...detail, ...this.publicState }));
  }

  async start() {
    if (this.previewMode) return this.startPreview();
    if (!this.fetchImpl) throw new Error('A fetch implementation is required.');
    this.setMode('checking');
    let response;
    try {
      response = await this.fetchImpl(this.configUrl, { cache: 'no-store' });
    } catch {
      this.setMode('standalone', { reason: 'ConfigurationUnavailable' });
      return this;
    }
    if (!response.ok) {
      this.setMode('standalone', { reason: 'ConfigurationUnavailable' });
      return this;
    }

    this.config = await responseJson(response);
    if (!this.config.enabled || !isDiscordActivityContext(this.locationObject)) {
      this.setMode('standalone', {
        configured: Boolean(this.config.enabled),
        reason: this.config.enabled ? 'OutsideDiscord' : 'ConfigurationDisabled',
      });
      return this;
    }

    try {
      this.setMode('connecting');
      const supabaseUrl = this.configureSupabaseProxy();
      this.discord = new this.DiscordSDKClass(this.config.discordClientId);
      await this.discord.ready();
      const { code } = await this.discord.commands.authorize({
        client_id: this.config.discordClientId,
        response_type: 'code',
        prompt: 'none',
        scope: this.config.oauthScopes || DEFAULT_SCOPES,
      });

      const authenticated = await this.callApi('authenticate', {
        code,
        instanceId: this.discord.instanceId,
      });
      this.discordAccessToken = authenticated.accessToken;
      this.realtimeToken = authenticated.realtimeToken;
      this.realtimeExpiresAt = authenticated.realtimeExpiresAt;
      this.entitlements = authenticated.entitlements || [];

      const discordAuth = await this.discord.commands.authenticate({
        access_token: this.discordAccessToken,
      });
      if (!discordAuth?.user) throw new Error('Discord authenticate returned no user.');
      // The OAuth token is needed only for Discord SDK authenticate. All later
      // backend calls use the signed, HttpOnly, opaque Activity session cookie.
      this.discordAccessToken = null;
      this.user = discordAuth.user;
      this.topic = authenticated.topic;

      this.supabase = this.createSupabaseClient(supabaseUrl, this.config.supabasePublishableKey, {
        accessToken: async () => this.realtimeToken,
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
      this.supabase.realtime.setAuth(this.realtimeToken);
      await this.joinRealtime();
      this.subscribeToDiscordEvents();
      this.scheduleRealtimeRefresh();
      this.setMode('ready', { user: this.user, topic: this.topic, entitlements: this.entitlements });
      return this;
    } catch (error) {
      this.setMode('error', { error });
      throw error;
    }
  }

  async startPreview() {
    this.setMode('connecting', { preview: true });
    this.config = {
      enabled: true,
      discordClientId: PREVIEW_CLIENT_ID,
      oauthScopes: DEFAULT_SCOPES,
      richPresenceEnabled: true,
      preview: true,
    };
    this.user = {
      id: 'preview-player',
      username: 'PreviewPlayer',
      global_name: 'Mock Player',
      discriminator: '0',
      avatar: null,
      bot: false,
      flags: 0,
    };
    this.entitlements = [];
    this.discord = new this.DiscordSDKMockClass(
      PREVIEW_CLIENT_ID,
      null,
      'preview-channel',
      'preview-location',
    );
    this.discord._updateCommandMocks?.({
      getInstanceConnectedParticipants: async () => ({ participants: [this.user] }),
      getActivityInstanceConnectedParticipants: async () => ({ participants: [this.user] }),
      getSkus: async () => ({ skus: [] }),
      getEntitlements: async () => ({ entitlements: this.entitlements }),
      userSettingsGetLocale: async () => ({ locale: 'en-US' }),
      openInviteDialog: async () => ({}),
      encourageHardwareAcceleration: async () => ({ enabled: true }),
      setActivity: async ({ activity }) => activity || {},
      setConfig: async ({ use_interactive_pip: enabled }) => ({ use_interactive_pip: Boolean(enabled) }),
      setOrientationLockState: async () => ({}),
      shareLink: async () => ({ success: true, didCopyLink: true, didSendMessage: false }),
      openExternalLink: async () => ({ opened: true }),
    });
    await this.discord.ready();
    this.subscribeToDiscordEvents();
    this.setMode('ready', {
      preview: true,
      user: this.user,
      topic: 'preview:local-only',
      entitlements: this.entitlements,
    });
    return this;
  }

  configureSupabaseProxy() {
    const directUrl = this.config.supabaseUrl;
    if (!this.config.supabaseProxyPrefix || !this.config.supabaseProxyTarget) return directUrl;
    this.patchMappings([{
      prefix: this.config.supabaseProxyPrefix,
      target: this.config.supabaseProxyTarget,
    }]);
    return `${this.locationObject.origin}${this.config.supabaseProxyPrefix}`;
  }

  async callApi(action, body = {}) {
    const response = await this.fetchImpl(this.configUrl, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action,
        ...body,
      }),
    });
    return responseJson(response);
  }

  async callOptionalCommand(name, args, fallback) {
    const command = this.discord?.commands?.[name];
    if (typeof command !== 'function') {
      this.dispatchEvent(activityEvent('warning', {
        command: name,
        error: new Error(`This Discord client does not support ${name}.`),
      }));
      return fallback;
    }
    try {
      return await command.call(this.discord.commands, args);
    } catch (error) {
      if (Number(error?.code) !== RPCErrorCodes.INVALID_COMMAND) throw error;
      this.dispatchEvent(activityEvent('warning', { command: name, error }));
      return fallback;
    }
  }

  async refreshRealtimeToken() {
    const refreshed = await this.callApi('refresh', { instanceId: this.discord.instanceId });
    this.realtimeToken = refreshed.realtimeToken;
    this.realtimeExpiresAt = refreshed.realtimeExpiresAt;
    this.supabase.realtime.setAuth(this.realtimeToken);
    this.scheduleRealtimeRefresh();
    return refreshed;
  }

  scheduleRealtimeRefresh() {
    clearTimeout(this.refreshTimer);
    const expiresInMs = Number(this.realtimeExpiresAt) * 1000 - Date.now();
    const refreshInMs = Math.max(30_000, Math.min(8 * 60 * 1000, expiresInMs - 60_000));
    this.refreshTimer = setTimeout(() => this.refreshRealtimeToken().catch((error) => {
      this.dispatchEvent(activityEvent('warning', { error }));
      this.refreshTimer = setTimeout(() => this.scheduleRealtimeRefresh(), 30_000);
    }), refreshInMs);
  }

  async joinRealtime() {
    if (!this.topic) return;
    this.channel = this.supabase.channel(this.topic, {
      config: {
        private: true,
        presence: { key: this.randomUUID() },
      },
    });
    this.channel.on('broadcast', { event: '*' }, (payload) => {
      this.dispatchEvent(activityEvent('broadcast', payload));
    });
    this.channel.on('presence', { event: 'sync' }, () => {
      this.dispatchEvent(activityEvent('presence', this.channel.presenceState()));
    });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Supabase Realtime join timed out.')), 10000);
      this.channel.subscribe(async (status, error) => {
        if (status === 'SUBSCRIBED') {
          clearTimeout(timeout);
          await this.channel.track({ connected: true });
          resolve();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          clearTimeout(timeout);
          reject(error || new Error(`Supabase Realtime status: ${status}`));
        }
      });
    });
  }

  subscribeToDiscordEvents() {
    this.entitlementHandler = () => {
      this.verifyEntitlements().catch((error) => this.dispatchEvent(activityEvent('warning', { error })));
    };
    this.participantsHandler = (participants) => {
      this.dispatchEvent(activityEvent('participants', participants));
    };
    this.subscribeDiscordEvent(Events.ENTITLEMENT_CREATE, this.entitlementHandler);
    this.subscribeDiscordEvent(Events.ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE, this.participantsHandler);
    this.subscribeDiscordEvent(Events.THERMAL_STATE_UPDATE, (payload) => {
      const { state, name } = namedDiscordState(payload, 'thermal_state', THERMAL_STATE_NAMES);
      this.dispatchEvent(activityEvent('thermalstate', { thermalState: state, thermalStateName: name }));
    });
    this.subscribeDiscordEvent(Events.ORIENTATION_UPDATE, (payload) => {
      const { state, name } = namedDiscordState(payload, 'screen_orientation', ORIENTATION_NAMES);
      this.dispatchEvent(activityEvent('orientation', { orientation: state, orientationName: name }));
    });
    this.subscribeDiscordEvent(Events.ACTIVITY_LAYOUT_MODE_UPDATE, (payload) => {
      const { state, name } = namedDiscordState(payload, 'layout_mode', LAYOUT_MODE_NAMES);
      this.dispatchEvent(activityEvent('layoutmode', { layoutMode: state, layoutModeName: name }));
    });
  }

  subscribeDiscordEvent(event, handler) {
    if (!event || typeof this.discord?.subscribe !== 'function') return;
    try {
      const result = this.discord.subscribe(event, handler);
      this.discordEventSubscriptions.push([event, handler]);
      Promise.resolve(result).catch((error) => {
        this.dispatchEvent(activityEvent('warning', { event, error }));
      });
    } catch (error) {
      this.dispatchEvent(activityEvent('warning', { event, error }));
    }
  }

  async broadcast(event, payload) {
    if (this.mode !== 'ready') throw new Error('Discord Activity is not ready.');
    if (this.previewMode) {
      this.dispatchEvent(activityEvent('broadcast', { event, payload, meta: { replayed: false, preview: true } }));
      return { status: 'ok', preview: true };
    }
    if (!this.channel) throw new Error('Discord Activity Realtime is not connected.');
    return this.channel.send({ type: 'broadcast', event, payload });
  }

  getPresenceState() {
    if (this.previewMode) return { preview: [{ connected: true, player: 'preview-player' }] };
    return this.channel?.presenceState?.() || {};
  }

  async getSkus() {
    return this.discord.commands.getSkus();
  }

  async getClientEntitlements() {
    return this.discord.commands.getEntitlements();
  }

  async getParticipants() {
    return this.discord.commands.getInstanceConnectedParticipants();
  }

  async openInviteDialog() {
    return this.discord.commands.openInviteDialog();
  }

  async encourageHardwareAcceleration() {
    return this.discord.commands.encourageHardwareAcceleration();
  }

  async setOrientationLock(lockState, pictureInPictureLockState = -1, gridLockState = -1) {
    const args = { lock_state: Number(lockState) };
    if (Number(pictureInPictureLockState) !== -1) {
      args.picture_in_picture_lock_state = Number(pictureInPictureLockState);
    }
    if (Number(gridLockState) !== -1) args.grid_lock_state = Number(gridLockState);
    const result = await this.callOptionalCommand('setOrientationLockState', args, { supported: false });
    return result?.supported === false ? result : { supported: true, result };
  }

  async setInteractivePip(enabled) {
    const result = await this.callOptionalCommand('setConfig', {
      use_interactive_pip: Boolean(enabled),
    }, { supported: false });
    return result?.supported === false ? result : { supported: true, result };
  }

  async getPlatformBehaviors() {
    const result = await this.callOptionalCommand('getPlatformBehaviors', undefined, { supported: false });
    return result?.supported === false ? result : { supported: true, behaviors: result || {} };
  }

  async getLocale() {
    const result = await this.callOptionalCommand('userSettingsGetLocale', undefined, { supported: false });
    return result?.supported === false ? result : { supported: true, locale: String(result?.locale || '') };
  }

  async setRichPresence({
    details = '',
    state = '',
    currentPartySize = 0,
    maximumPartySize = 0,
    largeImage = '',
    largeText = '',
  } = {}) {
    if (!this.config.richPresenceEnabled) {
      throw new Error('Rich Presence is disabled. Set DISCORD_ENABLE_RICH_PRESENCE=true on the Activity API.');
    }
    const current = partySize(currentPartySize, 'Current party size');
    const maximum = partySize(maximumPartySize, 'Maximum party size');
    if (maximum && current > maximum) throw new Error('Current party size cannot exceed maximum party size.');

    const activity = {
      type: 0,
      instance: true,
      ...(optionalText(details) ? { details: optionalText(details) } : {}),
      ...(optionalText(state) ? { state: optionalText(state) } : {}),
      ...(maximum ? { party: { id: this.discord.instanceId, size: [current, maximum] } } : {}),
      ...(optionalText(largeImage) || optionalText(largeText) ? {
        assets: {
          ...(optionalText(largeImage) ? { large_image: optionalText(largeImage) } : {}),
          ...(optionalText(largeText) ? { large_text: optionalText(largeText) } : {}),
        },
      } : {}),
    };
    const result = await this.callOptionalCommand('setActivity', { activity }, { supported: false });
    return result?.supported === false ? result : { supported: true, activity: result };
  }

  async clearRichPresence() {
    if (!this.config.richPresenceEnabled) return { supported: false };
    const result = await this.callOptionalCommand('setActivity', { activity: null }, { supported: false });
    return result?.supported === false ? result : { supported: true, activity: result };
  }

  async shareLink(message, customId = '', linkId = '') {
    const text = optionalText(message);
    if (!text) throw new Error('A Discord Activity share message is required.');
    const result = await this.callOptionalCommand('shareLink', {
      message: text,
      ...(optionalText(customId) ? { custom_id: optionalText(customId) } : {}),
      ...(optionalText(linkId) ? { link_id: optionalText(linkId) } : {}),
    }, { success: false, didCopyLink: false, didSendMessage: false, supported: false });
    return result?.supported === false ? result : { ...result, supported: true };
  }

  async openExternalLink(url) {
    let target;
    try { target = new URL(String(url)); }
    catch { throw new Error('Discord external links must be valid HTTPS URLs.'); }
    if (target.protocol !== 'https:') throw new Error('Discord external links must use HTTPS.');
    const result = await this.callOptionalCommand('openExternalLink', { url: target.href }, { opened: false, supported: false });
    return result?.supported === false ? result : { ...result, supported: true };
  }

  getLaunchContext() {
    return {
      customId: optionalText(this.discord?.customId) || '',
      hasReferrer: Boolean(optionalText(this.discord?.referrerId)),
    };
  }

  async verifyEntitlements() {
    if (this.previewMode) {
      this.dispatchEvent(activityEvent('entitlements', this.entitlements));
      return this.entitlements;
    }
    const result = await this.callApi('verify-entitlements', { instanceId: this.discord.instanceId });
    this.entitlements = result.entitlements || [];
    this.dispatchEvent(activityEvent('entitlements', this.entitlements));
    return this.entitlements;
  }

  async startPurchase(skuId) {
    if (this.previewMode) {
      const normalizedSkuId = String(skuId);
      if (!this.entitlements.some((item) => item.skuId === normalizedSkuId)) {
        this.entitlements.push({ skuId: normalizedSkuId, type: 1, consumed: false, preview: true });
      }
      this.dispatchEvent(activityEvent('entitlements', this.entitlements));
      return { purchase: { preview: true, skuId: normalizedSkuId }, entitlements: this.entitlements };
    }
    const purchase = await this.discord.commands.startPurchase({ sku_id: String(skuId) });
    const entitlements = await this.verifyEntitlements();
    return { purchase, entitlements };
  }

  async loadWorld() {
    if (this.previewMode) return this.loadPreviewState('world');
    return this.callApi('load-world', { instanceId: this.discord.instanceId });
  }

  async saveWorld(state, expectedRevision) {
    if (this.previewMode) return this.savePreviewState('world', state, expectedRevision);
    return this.callApi('save-world', {
      instanceId: this.discord.instanceId,
      state,
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    });
  }

  async loadPlayerState() {
    if (this.previewMode) return this.loadPreviewState('player');
    return this.callApi('load-player', { instanceId: this.discord.instanceId });
  }

  async savePlayerState(state, expectedRevision) {
    if (this.previewMode) return this.savePreviewState('player', state, expectedRevision);
    return this.callApi('save-player', {
      instanceId: this.discord.instanceId,
      state,
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    });
  }

  loadPreviewState(kind) {
    let saved = null;
    try { saved = JSON.parse(this.storage?.getItem?.(previewStorageKey(kind)) || 'null'); }
    catch { saved = null; }
    return {
      state: saved?.state ?? null,
      revision: Number.isSafeInteger(saved?.revision) ? saved.revision : 0,
      updatedAt: saved?.updatedAt || null,
      preview: true,
    };
  }

  savePreviewState(kind, state, expectedRevision) {
    if (previewStateSize(state) > PREVIEW_STATE_BYTES) {
      const error = new Error(`Preview game state exceeds ${PREVIEW_STATE_BYTES} bytes.`);
      error.status = 413;
      throw error;
    }
    const current = this.loadPreviewState(kind);
    if (expectedRevision !== undefined && expectedRevision !== current.revision) {
      const error = new Error('Preview game state changed; reload before saving.');
      error.status = 409;
      error.revision = current.revision;
      throw error;
    }
    const next = {
      state,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    this.storage?.setItem?.(previewStorageKey(kind), JSON.stringify(next));
    return { saved: true, revision: next.revision, updatedAt: next.updatedAt, preview: true };
  }

  async dispose() {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    for (const [event, handler] of this.discordEventSubscriptions) {
      try { await this.discord?.unsubscribe?.(event, handler); }
      catch (error) { this.dispatchEvent(activityEvent('warning', { event, error })); }
    }
    if (this.channel && this.supabase) await this.supabase.removeChannel(this.channel);
    this.discord?.close?.(1000, 'Activity disposed');
    this.channel = null;
    this.discordAccessToken = null;
    this.realtimeToken = null;
    this.entitlementHandler = null;
    this.participantsHandler = null;
    this.discordEventSubscriptions = [];
    this.setMode('disposed');
  }
}

export function createDiscordActivityBridge(options) {
  return new DiscordActivityBridge(options);
}
