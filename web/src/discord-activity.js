import { DiscordSDK, Events, patchUrlMappings } from '@discord/embedded-app-sdk';
import { createClient } from '@supabase/supabase-js';

const DEFAULT_CONFIG_URL = '/api/activity';
const DEFAULT_SCOPES = ['identify'];

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

export class DiscordActivityBridge extends EventTarget {
  constructor({
    fetchImpl = globalThis.fetch?.bind(globalThis),
    DiscordSDKClass = DiscordSDK,
    patchMappings = patchUrlMappings,
    createSupabaseClient = createClient,
    locationObject = globalThis.location,
    randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto),
    configUrl = resolveActivityApiUrl(),
  } = {}) {
    super();
    this.fetchImpl = fetchImpl;
    this.DiscordSDKClass = DiscordSDKClass;
    this.patchMappings = patchMappings;
    this.createSupabaseClient = createSupabaseClient;
    this.locationObject = locationObject;
    this.randomUUID = randomUUID || (() => `${Date.now()}-${Math.random()}`);
    this.configUrl = configUrl;
    this.mode = 'idle';
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
  }

  setMode(mode, detail = {}) {
    this.mode = mode;
    this.dispatchEvent(activityEvent('statechange', { mode, ...detail }));
  }

  async start() {
    if (!this.fetchImpl) throw new Error('A fetch implementation is required.');
    this.setMode('checking');
    let response;
    try {
      response = await this.fetchImpl(this.configUrl, { cache: 'no-store' });
    } catch {
      this.setMode('standalone');
      return this;
    }
    if (!response.ok) {
      this.setMode('standalone');
      return this;
    }

    this.config = await responseJson(response);
    if (!this.config.enabled || !isDiscordActivityContext(this.locationObject)) {
      this.setMode('standalone', { configured: Boolean(this.config.enabled) });
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
    this.discord.subscribe(Events.ENTITLEMENT_CREATE, this.entitlementHandler);
    this.discord.subscribe(Events.ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE, this.participantsHandler);
  }

  async broadcast(event, payload) {
    if (this.mode !== 'ready' || !this.channel) throw new Error('Discord Activity is not ready.');
    return this.channel.send({ type: 'broadcast', event, payload });
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

  async verifyEntitlements() {
    const result = await this.callApi('verify-entitlements', { instanceId: this.discord.instanceId });
    this.entitlements = result.entitlements || [];
    this.dispatchEvent(activityEvent('entitlements', this.entitlements));
    return this.entitlements;
  }

  async startPurchase(skuId) {
    const purchase = await this.discord.commands.startPurchase({ sku_id: String(skuId) });
    const entitlements = await this.verifyEntitlements();
    return { purchase, entitlements };
  }

  async loadWorld() {
    return this.callApi('load-world', { instanceId: this.discord.instanceId });
  }

  async saveWorld(state, expectedRevision) {
    return this.callApi('save-world', {
      instanceId: this.discord.instanceId,
      state,
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    });
  }

  async loadPlayerState() {
    return this.callApi('load-player', { instanceId: this.discord.instanceId });
  }

  async savePlayerState(state, expectedRevision) {
    return this.callApi('save-player', {
      instanceId: this.discord.instanceId,
      state,
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    });
  }

  async dispose() {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    if (this.discord && this.entitlementHandler) {
      this.discord.unsubscribe?.(Events.ENTITLEMENT_CREATE, this.entitlementHandler);
    }
    if (this.discord && this.participantsHandler) {
      this.discord.unsubscribe?.(Events.ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE, this.participantsHandler);
    }
    if (this.channel && this.supabase) await this.supabase.removeChannel(this.channel);
    this.discord?.close?.(1000, 'Activity disposed');
    this.channel = null;
    this.discordAccessToken = null;
    this.realtimeToken = null;
    this.entitlementHandler = null;
    this.participantsHandler = null;
    this.setMode('disposed');
  }
}

export function createDiscordActivityBridge(options) {
  return new DiscordActivityBridge(options);
}
