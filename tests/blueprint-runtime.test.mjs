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
