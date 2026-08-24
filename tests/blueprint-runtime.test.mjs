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
  assert.equal(runtime.call('EnableActor', 'Test Actor'), true);
  assert.equal(runtime.call('MissingEvent', 'Test Actor'), false);
  assert.equal(runtime.instances[0].state.Enabled, true);
});

test('routes stock First Person touch axes through event output pins', () => {
  const nodes = [
    { id: 'touch', kind: 'event', event: 'Primary Thumbstick', eventAdapter: 'browser-touch-controls', pins: [
      pin('then', 'output', 'exec', { links: [link('set', 'execute')] }),
      pin('Axis', 'output', 'struct'), pin('Axis_X', 'output', 'real'), pin('Axis_Y', 'output', 'real'),
    ] },
    { id: 'set', kind: 'variableSet', variable: 'Horizontal', pins: [
      pin('execute', 'input', 'exec'),
      pin('Horizontal', 'input', 'real', { links: [link('touch', 'Axis_X')] }),
      pin('then', 'output', 'exec'),
    ] },
  ];
  const runtime = new BlueprintRuntime(program(nodes, { Horizontal: { value: '0', category: 'real' } }));
  runtime.start();

  assert.equal(runtime.call('Primary Thumbstick', null, {
    Axis: { x: 0.75, y: -0.25 }, Axis_X: 0.75, Axis_Y: -0.25,
  }), true);
  assert.equal(runtime.instances[0].state.Horizontal, 0.75);
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

test('bridges replicated properties and RPC calls over private Activity Broadcast', async () => {
  const originalBroadcastChannel = globalThis.BroadcastChannel;
  globalThis.BroadcastChannel = undefined;
  let first;
  let second;
  try {
    const peers = new Set();
    class ActivityPeer extends EventTarget {
      constructor() {
        super();
        this.mode = 'ready';
        this.publicState = { mode: 'ready' };
        peers.add(this);
      }
      async broadcast(event, payload) {
        for (const peer of peers) {
          const message = new Event('broadcast');
          Object.defineProperty(message, 'detail', { value: { event, payload, meta: { replayed: false } } });
          peer.dispatchEvent(message);
        }
        return { status: 'ok' };
      }
    }

    const firstActivity = new ActivityPeer();
    const secondActivity = new ActivityPeer();
    const activityWindow = (activity) => ({
      UE5HTML5: { activity },
      addEventListener() {},
      removeEventListener() {},
    });
    const replicationWarnings = [];
    first = new BrowserRuntimeAdapters(new THREE.Group(), {}, {
      replicationWarning: (warning) => replicationWarnings.push(warning),
    }, activityWindow(firstActivity));
    second = new BrowserRuntimeAdapters(new THREE.Group(), {}, {}, activityWindow(secondActivity));
    const replicated = [];
    const rpcCalls = [];
    const publicBroadcasts = [];
    const actor = {
      objectName: 'ReplicatedActor_C_0',
      initialState: { Score: { value: '0', category: 'int', replicated: true } },
    };
    const instance = { actor, object: null, program: { name: 'BP_ReplicatedActor' } };
    first.attachRuntime({
      instances: [instance],
      applyReplicatedState() {},
      call() {},
    });
    second.attachRuntime({
      instances: [instance],
      applyReplicatedState(programName, actorName, variable, value) {
        replicated.push({ programName, actorName, variable, value });
      },
      call(functionName, actorName, args) {
        if (functionName === 'DiscordActivityBroadcastReceived') publicBroadcasts.push(args);
        if (functionName === 'ServerFire') rpcCalls.push({ functionName, actorName, args });
      },
    });

    first.variableChanged(instance, 'Score', 25);
    assert.equal(first.call('ServerFire', { damage: 10 }, instance).handled, true);
    await Promise.resolve();

    assert.deepEqual(replicated, [{
      programName: 'BP_ReplicatedActor', actorName: 'ReplicatedActor_C_0', variable: 'Score', value: 25,
    }]);
    assert.deepEqual(rpcCalls, [{
      functionName: 'ServerFire', actorName: 'ReplicatedActor_C_0', args: { damage: 10 },
    }]);
    assert.deepEqual(publicBroadcasts, [], 'reserved replication frames must not enter the public Blueprint Broadcast event');

    const malformed = new Event('broadcast');
    Object.defineProperty(malformed, 'detail', { value: {
      event: '__ue5html5_replication_v1',
      payload: { schema: 'ue5-html5-replication/v1', type: 'rpc', function: 'DestroyEverything' },
    } });
    secondActivity.dispatchEvent(malformed);
    assert.equal(rpcCalls.length, 1, 'malformed or non-RPC-prefixed internal frames must be ignored');

    const circularArgs = {};
    circularArgs.self = circularArgs;
    assert.equal(first.call('ServerCircular', circularArgs, instance).handled, true);
    first.variableChanged(instance, 'Score', 'x'.repeat(65 * 1024));
    assert.deepEqual(replicationWarnings, [
      { code: 'REPLICATION_PAYLOAD_REJECTED' },
      { code: 'REPLICATION_PAYLOAD_REJECTED' },
    ]);
    assert.equal(rpcCalls.length, 1, 'rejected private frames must not reach peers');
  } finally {
    first?.dispose();
    second?.dispose();
    globalThis.BroadcastChannel = originalBroadcastChannel;
  }
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

test('redirects an unsupported action call to its exported Blueprint web fallback', () => {
  const nodes = [
    { id: 'begin', kind: 'event', event: 'ReceiveBeginPlay', pins: [pin('then', 'output', 'exec', { links: [link('native', 'execute')] })] },
    { id: 'native', kind: 'callFunction', function: 'NativeApplyDamage', webFallbackFunction: 'Web_NativeApplyDamage', pins: [
      pin('execute', 'input', 'exec'), pin('Amount', 'input', 'int', { default: '25' }),
      pin('then', 'output', 'exec', { links: [link('after', 'execute')] }),
    ] },
    { id: 'entry', kind: 'functionEntry', function: 'Web_NativeApplyDamage', pins: [
      pin('Amount', 'output', 'int'), pin('then', 'output', 'exec', { links: [link('damage', 'execute')] }),
    ] },
    { id: 'damage', kind: 'variableSet', variable: 'Damage', pins: [
      pin('execute', 'input', 'exec'), pin('Damage', 'input', 'int', { links: [link('entry', 'Amount')] }), pin('then', 'output', 'exec'),
    ] },
    { id: 'after', kind: 'variableSet', variable: 'Continued', pins: [
      pin('execute', 'input', 'exec'), pin('Continued', 'input', 'bool', { default: 'true' }), pin('then', 'output', 'exec'),
    ] },
  ];
  const runtime = new BlueprintRuntime(program(nodes, {
    Damage: { value: '0', category: 'int' },
    Continued: { value: 'false', category: 'bool' },
  }));
  runtime.start();
  assert.equal(runtime.instances[0].state.Damage, 25);
  assert.equal(runtime.instances[0].state.Continued, true);
  assert.deepEqual(runtime.diagnostics, []);
});

test('returns synchronous output pins from an impure Blueprint web fallback before caller continuation', () => {
  const nodes = [
    { id: 'begin', kind: 'event', event: 'ReceiveBeginPlay', pins: [pin('then', 'output', 'exec', { links: [link('native', 'execute')] })] },
    { id: 'native', kind: 'callFunction', function: 'NativeApplyDamage', webFallbackFunction: 'Web_NativeApplyDamage', webFallbackReturnsValue: true, pins: [
      pin('execute', 'input', 'exec'), pin('Amount', 'input', 'int', { default: '25' }),
      pin('ReturnValue', 'output', 'bool', { links: [link('set-result', 'Succeeded')] }),
      pin('then', 'output', 'exec', { links: [link('set-result', 'execute')] }),
    ] },
    { id: 'entry', kind: 'functionEntry', function: 'Web_NativeApplyDamage', pins: [
      pin('Amount', 'output', 'int'), pin('then', 'output', 'exec', { links: [link('return', 'execute')] }),
    ] },
    { id: 'return', kind: 'functionResult', pins: [
      pin('execute', 'input', 'exec'), pin('ReturnValue', 'input', 'bool', { default: 'true' }),
    ] },
    { id: 'set-result', kind: 'variableSet', variable: 'Succeeded', pins: [
      pin('execute', 'input', 'exec'), pin('Succeeded', 'input', 'bool', { links: [link('native', 'ReturnValue')] }),
      pin('then', 'output', 'exec', { links: [link('set-continued', 'execute')] }),
    ] },
    { id: 'set-continued', kind: 'variableSet', variable: 'Continued', pins: [
      pin('execute', 'input', 'exec'), pin('Continued', 'input', 'bool', { default: 'true' }), pin('then', 'output', 'exec'),
    ] },
  ];
  const runtime = new BlueprintRuntime(program(nodes, {
    Succeeded: { value: 'false', category: 'bool' },
    Continued: { value: 'false', category: 'bool' },
  }));
  runtime.start();
  assert.equal(runtime.instances[0].state.Succeeded, true);
  assert.equal(runtime.instances[0].state.Continued, true);
  assert.deepEqual(runtime.diagnostics, []);
});

test('reports a return-valued web fallback that cannot produce a synchronous Function Result', () => {
  const nodes = [
    { id: 'begin', kind: 'event', event: 'ReceiveBeginPlay', pins: [pin('then', 'output', 'exec', { links: [link('native', 'execute')] })] },
    { id: 'native', kind: 'callFunction', function: 'NativeQuery', webFallbackFunction: 'Web_NativeQuery', webFallbackReturnsValue: true, pins: [
      pin('execute', 'input', 'exec'), pin('ReturnValue', 'output', 'bool'), pin('then', 'output', 'exec'),
    ] },
    { id: 'entry', kind: 'functionEntry', function: 'Web_NativeQuery', pins: [pin('then', 'output', 'exec')] },
  ];
  const runtime = new BlueprintRuntime(program(nodes));
  runtime.start();
  assert.equal(runtime.diagnostics.length, 1);
  assert.equal(runtime.diagnostics[0].level, 'error');
  assert.match(runtime.diagnostics[0].message, /did not reach a Function Result node synchronously/);
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
  adapters.tick(0);
  assert.equal(runtime.instances[0].state.Jumped, true);
  runtime.stop();
  adapters.dispose();
});

test('polls standard browser gamepads for UE Enhanced Input phases and stick axes', () => {
  const buttons = Array.from({ length: 16 }, () => ({ pressed: false, value: 0 }));
  const gamepad = { connected: true, mapping: 'standard', axes: [0.6, -0.4, -0.25, 0.5], buttons };
  let connected = [gamepad];
  const eventTarget = {
    navigator: { getGamepads: () => connected },
    addEventListener() {},
    removeEventListener() {},
  };
  const document = {
    inputMappings: [
      { action: 'IA_Move', context: '/Game/Input/IMC_Player', key: 'Gamepad_Left2D', valueType: 2, modifiers: ['InputModifierDeadZone'] },
      { action: 'IA_Look', context: '/Game/Input/IMC_Player', key: 'Gamepad_Right2D', valueType: 2, modifiers: ['InputModifierDeadZone'] },
      { action: 'IA_Jump', context: '/Game/Input/IMC_Player', key: 'Gamepad_FaceButton_Bottom', valueType: 0 },
    ],
  };
  const calls = [];
  const adapters = new BrowserRuntimeAdapters(new THREE.Group(), document, {}, eventTarget);
  adapters.attachRuntime({ instances: [], call(action, actor, args) { calls.push({ action, actor, args }); } });

  buttons[0] = { pressed: true, value: 1 };
  adapters.tick(1 / 60);
  const startedMove = calls.find((call) => call.action === 'IA_Move');
  const startedLook = calls.find((call) => call.action === 'IA_Look');
  assert.equal(startedMove.args.triggerEvent, 'Started');
  assert.ok(startedMove.args.value.x > startedMove.args.value.y && startedMove.args.value.y > 0, 'left-stick Y must be converted from browser-down to UE-up');
  assert.equal(startedMove.args.actionValue_X, startedMove.args.value.x);
  assert.equal(startedMove.args.actionValue_Y, startedMove.args.value.y);
  assert.equal(startedLook.args.triggerEvent, 'Started');
  assert.ok(startedLook.args.value.x < 0 && startedLook.args.value.y < 0, 'right-stick axes must preserve X and invert browser Y');
  assert.equal(startedLook.args.actionValue_X, startedLook.args.value.x);
  assert.equal(startedLook.args.actionValue_Y, startedLook.args.value.y);
  assert.equal(calls.find((call) => call.action === 'IA_Jump').args.triggerEvent, 'Started');

  calls.length = 0;
  adapters.tick(1 / 60);
  assert.deepEqual(calls.filter((call) => !call.action.startsWith('InputAction_')).map((call) => call.args.triggerEvent), ['Triggered', 'Triggered', 'Triggered']);

  calls.length = 0;
  adapters.input.removeContext('/Game/Input/IMC_Player');
  adapters.tick(1 / 60);
  assert.deepEqual(calls.filter((call) => !call.action.startsWith('InputAction_')).map((call) => call.args.triggerEvent), ['Completed', 'Completed', 'Completed']);

  calls.length = 0;
  adapters.input.addContext('/Game/Input/IMC_Player');
  adapters.tick(1 / 60);
  assert.deepEqual(calls.filter((call) => !call.action.startsWith('InputAction_')).map((call) => call.args.triggerEvent), [
    'Started', 'Triggered', 'Started', 'Triggered', 'Started', 'Triggered',
  ]);

  calls.length = 0;
  connected = [];
  adapters.tick(1 / 60);
  assert.deepEqual(calls.filter((call) => !call.action.startsWith('InputAction_')).map((call) => call.args.triggerEvent), ['Completed', 'Completed', 'Completed']);
  adapters.dispose();
});

test('evaluates common UE Enhanced Input timed and edge triggers for keyboard mappings', () => {
  const listeners = new Map();
  const eventTarget = {
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatch(type, event) { for (const listener of listeners.get(type) || []) listener(event); },
  };
  const document = {
    inputMappings: [
      {
        action: 'IA_Hold', key: 'SpaceBar', valueType: 0,
        triggerDetails: [{ class: 'InputTriggerHold', actuationThreshold: 0.5, holdTimeThreshold: 0.5, oneShot: true }],
      },
      {
        action: 'IA_Tap', key: 'KeyT', valueType: 0,
        triggerDetails: [{ class: 'InputTriggerTap', actuationThreshold: 0.5, tapReleaseTimeThreshold: 0.2 }],
      },
      {
        action: 'IA_Edges', key: 'KeyE', valueType: 0,
        triggerDetails: [{ class: 'InputTriggerPressed' }, { class: 'InputTriggerReleased' }],
      },
      {
        action: 'IA_Pulse', key: 'KeyP', valueType: 0,
        triggerDetails: [{ class: 'InputTriggerPulse', interval: 0.2, triggerLimit: 2, triggerOnStart: true }],
      },
    ],
  };
  const calls = [];
  const adapters = new BrowserRuntimeAdapters(new THREE.Group(), document, {}, eventTarget);
  adapters.attachRuntime({ instances: [], call(action, actor, args) { if (!action.startsWith('InputAction_')) calls.push({ action, args }); } });
  const phases = (action) => calls.filter((call) => call.action === action).map((call) => call.args.triggerEvent);

  eventTarget.dispatch('keydown', { code: 'Space', key: ' ', repeat: false });
  adapters.tick(0);
  adapters.tick(0.3);
  adapters.tick(0.3);
  adapters.tick(0.1);
  eventTarget.dispatch('keyup', { code: 'Space', key: ' ', repeat: false });
  adapters.tick(0);
  assert.deepEqual(phases('IA_Hold'), ['Started', 'Ongoing', 'Triggered', 'Completed']);
  const holdTriggered = calls.find((call) => call.action === 'IA_Hold' && call.args.triggerEvent === 'Triggered');
  const holdCompleted = calls.find((call) => call.action === 'IA_Hold' && call.args.triggerEvent === 'Completed');
  assert.ok(holdTriggered.args.elapsedSeconds >= 0.5);
  assert.ok(holdCompleted.args.triggeredSeconds >= 0.1);

  eventTarget.dispatch('keydown', { code: 'KeyT', key: 't', repeat: false });
  adapters.tick(0);
  adapters.tick(0.1);
  eventTarget.dispatch('keyup', { code: 'KeyT', key: 't', repeat: false });
  adapters.tick(0);
  adapters.tick(0);
  assert.deepEqual(phases('IA_Tap'), ['Started', 'Ongoing', 'Triggered', 'Completed']);

  const tapCount = phases('IA_Tap').length;
  eventTarget.dispatch('keydown', { code: 'KeyT', key: 't', repeat: false });
  adapters.tick(0);
  adapters.tick(0.25);
  eventTarget.dispatch('keyup', { code: 'KeyT', key: 't', repeat: false });
  adapters.tick(0);
  assert.deepEqual(phases('IA_Tap').slice(tapCount), ['Started', 'Ongoing', 'Canceled']);

  eventTarget.dispatch('keydown', { code: 'KeyE', key: 'e', repeat: false });
  adapters.tick(0);
  eventTarget.dispatch('keyup', { code: 'KeyE', key: 'e', repeat: false });
  adapters.tick(0);
  adapters.tick(0);
  assert.deepEqual(phases('IA_Edges'), ['Started', 'Triggered', 'Triggered', 'Completed']);

  eventTarget.dispatch('keydown', { code: 'KeyP', key: 'p', repeat: false });
  adapters.tick(0);
  adapters.tick(0.21);
  adapters.tick(0.21);
  eventTarget.dispatch('keyup', { code: 'KeyP', key: 'p', repeat: false });
  adapters.tick(0);
  assert.deepEqual(phases('IA_Pulse'), ['Started', 'Triggered', 'Triggered', 'Completed']);
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
    async chooseAndShareImage() { calls.push('share-image'); return { shared: true, supported: true }; },
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
  const sharedImage = await adapters.call('DiscordActivityChooseAndShareImage', {}).promise;
  const launch = adapters.call('DiscordActivityGetLaunchContext', {}).value;

  assert.deepEqual(presence, { returnvalue: true });
  assert.deepEqual(cleared, { returnvalue: true });
  assert.equal(shared.returnvalue, true);
  assert.equal(JSON.parse(shared.outshareresultjson).didSendMessage, true);
  assert.deepEqual(opened, { returnvalue: true });
  assert.deepEqual(sharedImage, { returnvalue: true });
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
    'share-image',
  ]);
  adapters.dispose();
});

test('Discord display nodes and mobile lifecycle events map directly to Blueprint', async () => {
  const activity = new EventTarget();
  activity.mode = 'ready';
  const commands = [];
  activity.setOrientationLock = async (...args) => { commands.push(['orientation', ...args]); return { supported: true }; };
  activity.setInteractivePip = async (enabled) => { commands.push(['pip', enabled]); return { supported: true }; };
  activity.getPlatformBehaviors = async () => ({ supported: true, behaviors: { iosKeyboardResizesView: true } });
  activity.getLocale = async () => ({ supported: true, locale: 'en-US' });
  const eventCalls = [];
  const eventTarget = new EventTarget();
  eventTarget.UE5HTML5 = { activity, activityReady: Promise.resolve(activity) };
  const adapters = new BrowserRuntimeAdapters(new THREE.Group(), {}, {}, eventTarget);
  adapters.attachRuntime({ call: (...args) => eventCalls.push(args) });

  const orientation = await adapters.call('DiscordActivitySetOrientationLock', {
    lockstate: 'EUE5HTML5DiscordOrientationLock::Landscape',
    pictureinpicturelockstate: 'Portrait',
    gridlockstate: 'Default',
  }).promise;
  const pip = await adapters.call('DiscordActivitySetInteractivePip', { benabled: true }).promise;
  const behaviors = await adapters.call('DiscordActivityGetPlatformBehaviors', {}).promise;
  const locale = await adapters.call('DiscordActivityGetLocale', {}).promise;
  assert.deepEqual(orientation, { returnvalue: true });
  assert.deepEqual(pip, { returnvalue: true });
  assert.deepEqual(commands, [['orientation', 3, 2, -1], ['pip', true]]);
  assert.deepEqual(behaviors, {
    returnvalue: true, outplatformbehaviorsjson: '{"iosKeyboardResizesView":true}',
  });
  assert.deepEqual(locale, { returnvalue: true, outlocale: 'en-US' });

  activity.dispatchEvent(new CustomEvent('thermalstate', {
    detail: { thermalState: 3, thermalStateName: 'Critical' },
  }));
  activity.dispatchEvent(new CustomEvent('orientation', {
    detail: { orientation: 0, orientationName: 'Portrait' },
  }));
  activity.dispatchEvent(new CustomEvent('layoutmode', {
    detail: { layoutMode: 2, layoutModeName: 'Grid' },
  }));
  assert.deepEqual(eventCalls.filter(([name]) => [
    'DiscordActivityThermalStateChanged',
    'DiscordActivityOrientationChanged',
    'DiscordActivityLayoutModeChanged',
  ].includes(name)), [
    ['DiscordActivityThermalStateChanged', null, { thermalState: 3, thermalStateName: 'Critical' }],
    ['DiscordActivityOrientationChanged', null, { orientation: 0, orientationName: 'Portrait' }],
    ['DiscordActivityLayoutModeChanged', null, { layoutMode: 2, layoutModeName: 'Grid' }],
  ]);
  adapters.dispose();
  activity.dispatchEvent(new CustomEvent('layoutmode', { detail: { layoutMode: 0 } }));
  assert.equal(eventCalls.filter(([name]) => name === 'DiscordActivityLayoutModeChanged').length, 1);
});

test('authenticated inbound Activity updates become transient Blueprint events', async () => {
  const activity = new EventTarget();
  activity.mode = 'ready';
  activity.entitlements = [{ skuId: 'premium', consumed: false }];
  activity.getPresenceState = () => ({ 'opaque-connection': [{ connected: true }] });
  activity.getParticipants = async () => ({ participants: [{ id: '42', username: 'player' }] });
  const eventCalls = [];
  const eventTarget = new EventTarget();
  eventTarget.UE5HTML5 = { activity, activityReady: Promise.resolve(activity) };
  const adapters = new BrowserRuntimeAdapters(new THREE.Group(), {}, {}, eventTarget);
  let beginPlayComplete = false;
  adapters.attachRuntime({ call: (...args) => {
    assert.equal(beginPlayComplete, true, 'initial Activity state must follow Blueprint BeginPlay');
    eventCalls.push(args);
  } });
  beginPlayComplete = true;
  await Promise.resolve();
  await Promise.resolve();

  activity.dispatchEvent(new CustomEvent('broadcast', { detail: {
    type: 'broadcast', event: 'player-input', payload: { x: 1 }, meta: { replayed: true },
  } }));
  activity.dispatchEvent(new CustomEvent('presence', {
    detail: { 'opaque-connection': [{ connected: false }] },
  }));
  activity.dispatchEvent(new CustomEvent('participants', {
    detail: { participants: [{ id: '42' }, { id: '77' }] },
  }));
  activity.dispatchEvent(new CustomEvent('entitlements', {
    detail: [{ skuId: 'premium' }, { skuId: 'season-pass' }],
  }));

  assert.deepEqual(eventCalls, [
    ['DiscordActivityConnectionStateChanged', null, { stateName: 'Ready' }],
    ['DiscordActivityReady', null, {}],
    ['DiscordActivityPresenceChanged', null, {
      presenceJson: '{"opaque-connection":[{"connected":true}]}',
    }],
    ['DiscordActivityVerifiedEntitlementsChanged', null, {
      entitlementsJson: '[{"skuId":"premium","consumed":false}]', entitlementCount: 1,
    }],
    ['DiscordActivityParticipantsChanged', null, {
      participantsJson: '{"participants":[{"id":"42","username":"player"}]}', participantCount: 1,
    }],
    ['DiscordActivityBroadcastReceived', null, {
      event: 'player-input', jsonPayload: '{"x":1}', bReplayed: true,
    }],
    ['DiscordActivityPresenceChanged', null, {
      presenceJson: '{"opaque-connection":[{"connected":false}]}',
    }],
    ['DiscordActivityParticipantsChanged', null, {
      participantsJson: '{"participants":[{"id":"42"},{"id":"77"}]}', participantCount: 2,
    }],
    ['DiscordActivityVerifiedEntitlementsChanged', null, {
      entitlementsJson: '[{"skuId":"premium"},{"skuId":"season-pass"}]', entitlementCount: 2,
    }],
  ]);
  adapters.dispose();
  activity.dispatchEvent(new CustomEvent('broadcast', { detail: { event: 'late', payload: {} } }));
  assert.equal(eventCalls.length, 9);
});

test('Discord lifecycle transitions and warnings reach Blueprint without raw diagnostics', async () => {
  const activity = new EventTarget();
  activity.mode = 'connecting';
  activity.publicState = { mode: 'connecting' };
  activity.entitlements = [{ skuId: 'premium' }];
  activity.getPresenceState = () => ({ connection: [{ connected: true }] });
  activity.getParticipants = async () => ({ participants: [{ id: 'opaque-player' }] });
  const eventCalls = [];
  const eventTarget = new EventTarget();
  eventTarget.UE5HTML5 = { activity, activityReady: Promise.resolve(activity) };
  const adapters = new BrowserRuntimeAdapters(new THREE.Group(), {}, {}, eventTarget);
  adapters.attachRuntime({ call: (...args) => eventCalls.push(args) });
  await Promise.resolve();
  await Promise.resolve();

  activity.dispatchEvent(new CustomEvent('warning', { detail: {
    command: 'shareLink',
    error: Object.assign(new Error('token=discord-access-token player@example.test'), { code: 4002 }),
  } }));
  activity.dispatchEvent(new CustomEvent('warning', { detail: {
    command: 'player@example.test',
    event: 'discord-access-token',
    error: new Error('Bearer discord-access-token player@example.test'),
  } }));
  activity.dispatchEvent(new CustomEvent('statechange', { detail: {
    mode: 'error',
    errorCode: '401 invalid token',
    error: new Error('Bearer discord-access-token player@example.test'),
  } }));
  activity.mode = 'ready';
  activity.publicState = { mode: 'ready' };
  activity.dispatchEvent(new CustomEvent('statechange', { detail: { mode: 'ready' } }));
  await Promise.resolve();
  await Promise.resolve();
  activity.dispatchEvent(new CustomEvent('statechange', {
    detail: { mode: 'standalone', reason: 'ConfigurationDisabled' },
  }));

  assert.deepEqual(eventCalls, [
    ['DiscordActivityConnectionStateChanged', null, { stateName: 'Connecting' }],
    ['DiscordActivityWarning', null, {
      warningCode: 'UnsupportedCommand:shareLink',
      warningMessage: 'This Discord client does not support shareLink.',
    }],
    ['DiscordActivityWarning', null, {
      warningCode: 'EventSubscription',
      warningMessage: 'A Discord event could not be subscribed.',
    }],
    ['DiscordActivityConnectionStateChanged', null, { stateName: 'Error' }],
    ['DiscordActivityError', null, {
      errorCode: 'ACTIVITY_CONNECTION_FAILED',
      errorMessage: 'Discord Activity connection failed. Check browser diagnostics for details.',
    }],
    ['DiscordActivityConnectionStateChanged', null, { stateName: 'Ready' }],
    ['DiscordActivityReady', null, {}],
    ['DiscordActivityPresenceChanged', null, {
      presenceJson: '{"connection":[{"connected":true}]}',
    }],
    ['DiscordActivityVerifiedEntitlementsChanged', null, {
      entitlementsJson: '[{"skuId":"premium"}]', entitlementCount: 1,
    }],
    ['DiscordActivityParticipantsChanged', null, {
      participantsJson: '{"participants":[{"id":"opaque-player"}]}', participantCount: 1,
    }],
    ['DiscordActivityConnectionStateChanged', null, { stateName: 'Unavailable' }],
    ['DiscordActivityUnavailable', null, { reason: 'ConfigurationDisabled' }],
  ]);
  assert.doesNotMatch(JSON.stringify(eventCalls), /discord-access-token|player@example\.test/);

  adapters.dispose();
  activity.dispatchEvent(new CustomEvent('warning', { detail: { command: 'lateCommand' } }));
  assert.equal(eventCalls.length, 12);
});
