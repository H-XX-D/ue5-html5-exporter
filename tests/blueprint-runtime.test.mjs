import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BlueprintRuntime, parseBlueprintValue } from '../web/src/blueprint-runtime.js';
import { ThreeBlueprintAdapter } from '../web/src/three-blueprint-adapter.js';
import { BrowserRuntimeAdapters, RuntimeEventBus } from '../web/src/runtime-adapters.js';
import * as THREE from 'three';

const link = (node, pin) => ({ node, pin });
const pin = (name, direction, category, options = {}) => ({ name, direction, category, default: '', links: [], ...options });

function program(nodes, initialState = {}) {
  return {
    schema: 'ue-blueprint-ir/v1',
    programs: [{
      name: 'BP_Test',
      actors: [{ label: 'Test Actor', objectName: 'TestActor_C_0', initialState }],
      graphs: [{ name: 'EventGraph', nodes }],
      compatibility: { unsupported: [] },
    }],
  };
}

test('parses common Unreal pin and property values', () => {
  assert.equal(parseBlueprintValue('True'), true);
  assert.equal(parseBlueprintValue('12.5'), 12.5);
  assert.deepEqual(parseBlueprintValue('(X=100.0,Y=-20,Z=5)'), { x: 100, y: -20, z: 5 });
  assert.deepEqual(parseBlueprintValue('(Pitch=10,Yaw=90,Roll=0)'), { pitch: 10, yaw: 90, roll: 0 });
});

test('executes BeginPlay through pure math, variable set, and Print String', () => {
  const nodes = [
    { id: 'begin', kind: 'event', event: 'ReceiveBeginPlay', pins: [pin('then', 'output', 'exec', { links: [link('set', 'execute')] })] },
    { id: 'add', kind: 'callFunction', function: 'Add_DoubleDouble', pure: true, pins: [
      pin('A', 'input', 'real', { default: '2' }), pin('B', 'input', 'real', { default: '3' }), pin('ReturnValue', 'output', 'real'),
    ] },
    { id: 'set', kind: 'variableSet', variable: 'Score', pins: [
      pin('execute', 'input', 'exec', { links: [link('begin', 'then')] }),
      pin('Score', 'input', 'real', { links: [link('add', 'ReturnValue')] }),
      pin('then', 'output', 'exec', { links: [link('print', 'execute')] }),
    ] },
    { id: 'get', kind: 'variableGet', variable: 'Score', pins: [pin('Score', 'output', 'real')] },
    { id: 'print', kind: 'callFunction', function: 'PrintString', pins: [
      pin('execute', 'input', 'exec', { links: [link('set', 'then')] }),
      pin('InString', 'input', 'string', { links: [link('get', 'Score')] }),
      pin('then', 'output', 'exec'),
    ] },
  ];
  const messages = [];
  const runtime = new BlueprintRuntime(program(nodes, { Score: { value: '0', category: 'real' } }), {
    print: (message) => messages.push(message),
  });
  runtime.start();
  assert.equal(runtime.instances[0].state.Score, 5);
  assert.deepEqual(messages, ['5']);
});

test('routes a custom event through a branch', () => {
  const nodes = [
    { id: 'event', kind: 'event', event: 'EnableActor', pins: [pin('then', 'output', 'exec', { links: [link('branch', 'execute')] })] },
    { id: 'branch', kind: 'branch', pins: [
      pin('execute', 'input', 'exec'), pin('Condition', 'input', 'bool', { default: 'true' }),
      pin('true', 'output', 'exec', { links: [link('set', 'execute')] }), pin('false', 'output', 'exec'),
    ] },
    { id: 'set', kind: 'variableSet', variable: 'Enabled', pins: [
      pin('execute', 'input', 'exec'), pin('Enabled', 'input', 'bool', { default: 'true' }), pin('then', 'output', 'exec'),
    ] },
  ];
  const runtime = new BlueprintRuntime(program(nodes, { Enabled: { value: 'false', category: 'bool' } }));
  runtime.start();
  runtime.call('EnableActor', 'Test Actor');
  assert.equal(runtime.instances[0].state.Enabled, true);
});

test('routes Switch on String cases with Unreal case-sensitivity semantics', () => {
  const nodes = [
    { id: 'event', kind: 'event', event: 'ChoosePlatform', pins: [pin('then', 'output', 'exec', { links: [link('switch', 'execute')] })] },
    { id: 'switch', kind: 'switchString', caseSensitive: false, pins: [
      pin('execute', 'input', 'exec'), pin('Selection', 'input', 'string', { default: 'ios' }),
      pin('iOS', 'output', 'exec', { links: [link('set', 'execute')] }), pin('Default', 'output', 'exec'),
    ] },
    { id: 'set', kind: 'variableSet', variable: 'Touch', pins: [
      pin('execute', 'input', 'exec'), pin('Touch', 'input', 'bool', { default: 'true' }), pin('then', 'output', 'exec'),
    ] },
  ];
  const runtime = new BlueprintRuntime(program(nodes, { Touch: { value: 'false', category: 'bool' } }));
  runtime.start();
  runtime.call('ChoosePlatform', 'Test Actor');
  assert.equal(runtime.instances[0].state.Touch, true);
});

test('maps UE transform calls onto a Three-style actor object', () => {
  const object = {
    name: 'TestActor_C_0',
    position: { set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
    rotation: { set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
    scale: { set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
    traverse(visitor) { visitor(this); },
  };
  const adapter = new ThreeBlueprintAdapter(object);
  const actor = { objectName: object.name };
  const instance = { object };
  assert.equal(adapter.findActor(actor), object);
  assert.equal(adapter.call('SetActorLocation', { newlocation: { x: 100, y: 200, z: 300 } }, instance).handled, true);
  assert.deepEqual({ x: object.position.x, y: object.position.y, z: object.position.z }, { x: 1, y: 3, z: -2 });
});

test('dispatches delegates through the runtime event bus', () => {
  const bus = new RuntimeEventBus();
  const received = [];
  const unsubscribe = bus.on('OnDamaged', (payload) => received.push(payload));
  bus.emit('On Damaged', { amount: 12 });
  unsubscribe();
  bus.emit('OnDamaged', { amount: 99 });
  assert.deepEqual(received, [{ amount: 12 }]);
});

test('supports GAS-style tags and registered C++ replacement functions', () => {
  const root = { traverse() {}, add() {} };
  const adapters = new BrowserRuntimeAdapters(root, {}, {}, null);
  const instance = { actor: { objectName: 'Actor' }, object: null };
  assert.equal(adapters.call('AddLooseGameplayTag', { tag: 'State.Burning' }, instance).handled, true);
  assert.equal(adapters.call('HasMatchingGameplayTag', { tag: 'State.Burning' }, instance).value, true);
  adapters.registerFunction('NativeDamage', ({ amount }) => amount * 2);
  assert.equal(adapters.call('NativeDamage', { amount: 7 }, instance).value, 14);
  adapters.dispose();
});

test('invokes exported Blueprint function entries by name', () => {
  const nodes = [
    { id: 'entry', kind: 'functionEntry', function: 'ServerApplyDamage', pins: [pin('then', 'output', 'exec', { links: [link('set', 'execute')] })] },
    { id: 'set', kind: 'variableSet', variable: 'Damaged', pins: [
      pin('execute', 'input', 'exec'), pin('Damaged', 'input', 'bool', { default: 'true' }), pin('then', 'output', 'exec'),
    ] },
  ];
  const runtime = new BlueprintRuntime(program(nodes, { Damaged: { value: 'false', category: 'bool' } }));
  runtime.start();
  runtime.call('ServerApplyDamage', 'TestActor_C_0');
  assert.equal(runtime.instances[0].state.Damaged, true);
});

test('passes Blueprint function arguments through reroute nodes', () => {
  const nodes = [
    { id: 'entry', kind: 'functionEntry', function: 'Aim', pins: [
      pin('then', 'output', 'exec', { links: [link('call', 'execute')] }), pin('Yaw', 'output', 'real'),
    ] },
    { id: 'knot', kind: 'knot', pins: [
      pin('InputPin', 'input', 'real', { links: [link('entry', 'Yaw')] }), pin('OutputPin', 'output', 'real', { links: [link('call', 'Val')] }),
    ] },
    { id: 'call', kind: 'callFunction', function: 'AddControllerYawInput', pure: false, pins: [
      pin('execute', 'input', 'exec'), pin('Val', 'input', 'real', { links: [link('knot', 'OutputPin')] }), pin('then', 'output', 'exec'),
    ] },
  ];
  let captured;
  const runtime = new BlueprintRuntime(program(nodes), { call(name, args) {
    if (name === 'AddControllerYawInput') { captured = args.val; return { handled: true }; }
    return { handled: false };
  } });
  runtime.start();
  runtime.call('Aim', 'Test Actor', { Yaw: 2.5 });
  assert.equal(captured, 2.5);
});

test('applies browser physics impulses to Three actor transforms', () => {
  const root = new THREE.Group();
  const object = new THREE.Object3D();
  root.add(object);
  const adapters = new BrowserRuntimeAdapters(root, {}, {}, null);
  const instance = { actor: { objectName: 'PhysicsActor' }, object, program: { name: 'BP_Physics' } };
  adapters.call('SetEnableGravity', { enabled: false }, instance);
  adapters.call('AddImpulse', { impulse: { x: 100, y: 0, z: 0 } }, instance);
  adapters.tick(0.5);
  assert.equal(object.position.x, 0.5);
  adapters.dispose();
});

test('routes Enhanced Input mapping phases through matching exec pins', () => {
  const listeners = new Map();
  const eventTarget = {
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatch(type, event) { for (const listener of listeners.get(type) || []) listener(event); },
  };
  const nodes = [
    { id: 'input', kind: 'inputAction', event: 'IA_Jump', pins: [pin('Started', 'output', 'exec', { links: [link('set', 'execute')] })] },
    { id: 'set', kind: 'variableSet', variable: 'Jumped', pins: [
      pin('execute', 'input', 'exec'), pin('Jumped', 'input', 'bool', { default: 'true' }), pin('then', 'output', 'exec'),
    ] },
  ];
  const document = program(nodes, { Jumped: { value: 'false', category: 'bool' } });
  document.inputMappings = [{ action: 'IA_Jump', context: '/Game/Input/IMC_Player', key: 'SpaceBar', scale: 1 }];
  const root = new THREE.Group();
  const adapters = new BrowserRuntimeAdapters(root, document, {}, eventTarget);
  const runtime = new BlueprintRuntime(document, adapters, { eventTarget });
  adapters.attachRuntime(runtime);
  runtime.start();
  eventTarget.dispatch('keydown', { code: 'Space', key: ' ', repeat: false });
  assert.equal(runtime.instances[0].state.Jumped, true);
  runtime.stop();
  adapters.dispose();
});

test('maps asynchronous Blueprint function output fields after the latent action completes', async () => {
  const nodes = [
    { id: 'begin', kind: 'event', event: 'ReceiveBeginPlay', pins: [pin('then', 'output', 'exec', { links: [link('save', 'execute')] })] },
    { id: 'save', kind: 'callFunction', function: 'DiscordActivitySavePlayerState', pins: [
      pin('execute', 'input', 'exec'), pin('JsonState', 'input', 'string', { default: '{"checkpoint":1}' }),
      pin('ExpectedRevision', 'input', 'int64', { default: '-1' }),
      pin('OutRevision', 'output', 'int64', { links: [link('set', 'Revision')] }),
      pin('ReturnValue', 'output', 'bool'), pin('then', 'output', 'exec', { links: [link('set', 'execute')] }),
    ] },
    { id: 'set', kind: 'variableSet', variable: 'Revision', pins: [
      pin('execute', 'input', 'exec'), pin('Revision', 'input', 'int64', { links: [link('save', 'OutRevision')] }), pin('then', 'output', 'exec'),
    ] },
  ];
  const runtime = new BlueprintRuntime(program(nodes, { Revision: { value: '0', category: 'int64' } }), {
    call: () => ({ handled: true, promise: Promise.resolve({ returnvalue: true, outrevision: 12 }) }),
  });
  runtime.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(runtime.instances[0].state.Revision, 12);
});

test('Discord Blueprint adapter routes JSON state, participants, and revisions to the Activity bridge', async () => {
  const calls = [];
  const activity = {
    mode: 'ready',
    async savePlayerState(state, revision) { calls.push({ state, revision }); return { revision: 4 }; },
    async loadPlayerState() { return { state: { checkpoint: 3 }, revision: 3 }; },
    async getParticipants() { return { participants: [{ id: '42' }] }; },
  };
  const adapters = new BrowserRuntimeAdapters(new THREE.Group(), {}, {}, { UE5HTML5: { activity } });

  const saved = await adapters.call('DiscordActivitySavePlayerState', {
    jsonstate: '{"checkpoint":4}', expectedrevision: 3,
  }).promise;
  const loaded = await adapters.call('DiscordActivityLoadPlayerState', {}).promise;
  const participants = await adapters.call('DiscordActivityGetParticipants', {}).promise;

  assert.deepEqual(calls, [{ state: { checkpoint: 4 }, revision: 3 }]);
  assert.deepEqual(saved, { returnvalue: true, outrevision: 4 });
  assert.deepEqual(loaded, { returnvalue: true, outjsonstate: '{"checkpoint":3}', outrevision: 3 });
  assert.match(participants.outparticipantsjson, /"id":"42"/);
  adapters.dispose();
});

test('Discord Blueprint monetization nodes list SKUs and use server-verified entitlements', async () => {
  const calls = [];
  const activity = {
    mode: 'ready',
    async getSkus() { return { skus: [{ id: 'sku-premium', name: 'Premium' }] }; },
    async verifyEntitlements() {
      calls.push('verify');
      return [{ skuId: 'sku-premium', consumed: false }];
    },
    async startPurchase(skuId) {
      calls.push({ purchase: skuId });
      return { purchase: { opened: true }, entitlements: [{ skuId }] };
    },
  };
  const adapters = new BrowserRuntimeAdapters(new THREE.Group(), {}, {}, { UE5HTML5: { activity } });

  const skus = await adapters.call('DiscordActivityGetSkus', {}).promise;
  const entitlements = await adapters.call('DiscordActivityGetVerifiedEntitlements', {}).promise;
  const hasPremium = await adapters.call('DiscordActivityHasEntitlement', { skuid: 'sku-premium' }).promise;
  const hasMissing = await adapters.call('DiscordActivityHasEntitlement', { skuid: 'sku-missing' }).promise;
  const purchased = await adapters.call('DiscordActivityStartPurchase', { skuid: 'sku-premium' }).promise;

  assert.match(skus.outskusjson, /sku-premium/);
  assert.match(entitlements.outentitlementsjson, /sku-premium/);
  assert.deepEqual(hasPremium, { returnvalue: true });
  assert.deepEqual(hasMissing, { returnvalue: false });
  assert.equal(JSON.parse(purchased.outpurchasejson).entitlements[0].skuId, 'sku-premium');
  assert.deepEqual(calls, ['verify', 'verify', 'verify', { purchase: 'sku-premium' }]);
  adapters.dispose();
});

test('Discord Blueprint social nodes expose distribution features without raw referrer identity', async () => {
  const calls = [];
  const activity = {
    mode: 'ready',
    async setRichPresence(options) { calls.push({ presence: options }); return { supported: true }; },
    async clearRichPresence() { calls.push('clear'); return { supported: true }; },
    async shareLink(message, customId, linkId) {
      calls.push({ share: { message, customId, linkId } });
      return { success: true, supported: true, didSendMessage: true };
    },
    async openExternalLink(url) { calls.push({ external: url }); return { opened: true, supported: true }; },
    getLaunchContext() { return { customId: 'campaign-one', hasReferrer: true }; },
  };
  const adapters = new BrowserRuntimeAdapters(new THREE.Group(), {}, {}, { UE5HTML5: { activity } });

  const presence = await adapters.call('DiscordActivitySetRichPresence', {
    details: 'Round 3', state: 'In match', currentpartysize: 2, maximumpartysize: 4,
    largeimage: 'arena', largetext: 'Arena',
  }).promise;
  const cleared = await adapters.call('DiscordActivityClearRichPresence', {}).promise;
  const shared = await adapters.call('DiscordActivityShareLink', {
    message: 'Join me', customid: 'campaign-one', linkid: '',
  }).promise;
  const opened = await adapters.call('DiscordActivityOpenExternalLink', { url: 'https://example.com/help' }).promise;
  const launch = adapters.call('DiscordActivityGetLaunchContext', {}).value;

  assert.deepEqual(presence, { returnvalue: true });
  assert.deepEqual(cleared, { returnvalue: true });
  assert.equal(shared.returnvalue, true);
  assert.equal(JSON.parse(shared.outshareresultjson).didSendMessage, true);
  assert.deepEqual(opened, { returnvalue: true });
  assert.deepEqual(launch, {
    returnvalue: true,
    outcustomid: 'campaign-one',
    bouthasreferrer: true,
  });
  assert.equal(JSON.stringify(launch).includes('referrerId'), false);
  assert.deepEqual(calls, [
    { presence: {
      details: 'Round 3', state: 'In match', currentPartySize: 2, maximumPartySize: 4,
      largeImage: 'arena', largeText: 'Arena',
    } },
    'clear',
    { share: { message: 'Join me', customId: 'campaign-one', linkId: '' } },
    { external: 'https://example.com/help' },
  ]);
  adapters.dispose();
});
