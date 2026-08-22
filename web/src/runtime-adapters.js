import * as THREE from 'three';
import { shouldUseTouchControls } from './first-person-controller.js';
import { ThreeBlueprintAdapter } from './three-blueprint-adapter.js';

const normalize = (value) => String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
const normalizeInputKey = (value) => {
  const key = normalize(String(value || '').replace(/^Key/, '').replace(/^Digit/, ''));
  return { spacebar: 'space', up: 'arrowup', down: 'arrowdown', left: 'arrowleft', right: 'arrowright' }[key] || key;
};

function discordOrientationLock(value) {
  const number = Number(value);
  if (Number.isInteger(number)) return number === 0 ? -1 : number;
  const name = normalize(value);
  if (name.endsWith('unlocked')) return 1;
  if (name.endsWith('portrait')) return 2;
  if (name.endsWith('landscape')) return 3;
  return -1;
}

function blueprintJson(value) {
  try {
    const serialized = JSON.stringify(value ?? null);
    return serialized === undefined ? 'null' : serialized;
  } catch {
    return 'null';
  }
}

const STANDARD_GAMEPAD_BUTTONS = Object.freeze({
  gamepadfacebuttonbottom: 0,
  gamepadfacebuttonright: 1,
  gamepadfacebuttonleft: 2,
  gamepadfacebuttontop: 3,
  gamepadleftshoulder: 4,
  gamepadrightshoulder: 5,
  gamepadlefttrigger: 6,
  gamepadlefttriggeraxis: 6,
  gamepadrighttrigger: 7,
  gamepadrighttriggeraxis: 7,
  gamepadspecialleft: 8,
  gamepadspecialright: 9,
  gamepadleftthumbstick: 10,
  gamepadrightthumbstick: 11,
  gamepaddpadup: 12,
  gamepaddpaddown: 13,
  gamepaddpadleft: 14,
  gamepaddpadright: 15,
});

const STANDARD_GAMEPAD_AXES = Object.freeze({
  gamepadleftx: [0, 1],
  gamepadlefty: [1, -1],
  gamepadrightx: [2, 1],
  gamepadrighty: [3, -1],
});

const STANDARD_GAMEPAD_DIRECTIONS = Object.freeze({
  gamepadleftstickup: [1, -1],
  gamepadleftstickdown: [1, 1],
  gamepadleftstickleft: [0, -1],
  gamepadleftstickright: [0, 1],
  gamepadrightstickup: [3, -1],
  gamepadrightstickdown: [3, 1],
  gamepadrightstickleft: [2, -1],
  gamepadrightstickright: [2, 1],
});

const inputMagnitude = (value) => typeof value === 'number'
  ? Math.abs(value)
  : Math.hypot(Number(value?.x || 0), Number(value?.y || 0));

const applyDeadZone = (value, threshold = 0.2) => {
  const magnitude = inputMagnitude(value);
  if (magnitude <= threshold) return typeof value === 'number' ? 0 : { x: 0, y: 0 };
  const scaledMagnitude = Math.min(1, (magnitude - threshold) / (1 - threshold));
  if (typeof value === 'number') return Math.sign(value) * scaledMagnitude;
  const scale = scaledMagnitude / magnitude;
  return { x: Number(value?.x || 0) * scale, y: Number(value?.y || 0) * scale };
};

const inputActionArgs = (value, triggerEvent, context) => {
  const vector = value && typeof value === 'object' ? value : null;
  return {
    value,
    actionValue: value,
    actionValue_X: vector ? Number(vector.x || 0) : Number(value || 0),
    actionValue_Y: vector ? Number(vector.y || 0) : 0,
    actionValue_Z: vector ? Number(vector.z || 0) : 0,
    triggerEvent,
    context,
  };
};

export class RuntimeEventBus {
  constructor() { this.listeners = new Map(); }
  on(event, listener) {
    const key = normalize(event);
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key).add(listener);
    return () => this.listeners.get(key)?.delete(listener);
  }
  emit(event, payload) {
    for (const listener of this.listeners.get(normalize(event)) || []) listener(payload);
  }
}

class ReplicationAdapter {
  constructor(blueprintIr, hooks = {}) {
    this.hooks = hooks;
    this.runtime = null;
    this.origin = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    this.seen = new Set();
    const channelName = `ue5-html5:${globalThis.location?.pathname || 'local'}`;
    this.channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(channelName) : null;
    this.socket = null;
    this.channel?.addEventListener('message', (event) => this.receive(event.data));
    const socketUrl = blueprintIr.network?.websocketUrl;
    if (socketUrl && typeof WebSocket !== 'undefined') {
      this.socket = new WebSocket(socketUrl);
      this.socket.addEventListener('message', (event) => {
        try { this.receive(JSON.parse(event.data)); } catch { /* unrelated payload */ }
      });
    }
  }
  attach(runtime) { this.runtime = runtime; }
  isReplicated(instance, variable) {
    return Boolean(instance.actor.initialState?.[variable]?.replicated)
      || (instance.program.replication?.variables || []).includes(variable);
  }
  changed(instance, variable, value) {
    if (!this.isReplicated(instance, variable)) return;
    const message = this.envelope({ type: 'property', program: instance.program.name, actor: instance.actor.objectName, variable, value });
    this.send(message);
  }
  envelope(message) {
    return { ...message, id: globalThis.crypto?.randomUUID?.() || `${this.origin}-${Date.now()}-${Math.random()}`, origin: this.origin };
  }
  send(message) {
    this.channel?.postMessage(message);
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }
  remoteCall(functionName, args, instance) {
    if (!/^(server|client|multicast)/i.test(String(functionName))) return false;
    this.send(this.envelope({
      type: 'rpc',
      program: instance.program.name,
      actor: instance.actor.objectName,
      function: functionName,
      args,
    }));
    return true;
  }
  receive(message) {
    if (!message || message.origin === this.origin || (message.id && this.seen.has(message.id))) return;
    if (message.id) {
      this.seen.add(message.id);
      if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value);
    }
    if (message.type === 'property') {
      this.runtime?.applyReplicatedState(message.program, message.actor, message.variable, message.value);
      this.hooks.replicated?.(message);
    } else if (message.type === 'rpc') {
      this.runtime?.call(message.function, message.actor, message.args || {});
      this.hooks.rpc?.(message);
    }
  }
  dispose() { this.channel?.close(); this.socket?.close(); }
}

class EnhancedInputAdapter {
  constructor(blueprintIr, eventTarget) {
    this.blueprintIr = blueprintIr;
    this.eventTarget = eventTarget;
    this.runtime = null;
    this.down = new Set();
    this.handlers = [];
    this.gamepadState = new Map();
    this.activeContexts = new Set((blueprintIr.inputMappings || []).map((mapping) => normalize(mapping.context)).filter(Boolean));
  }
  attach(runtime) {
    this.runtime = runtime;
    if (!this.eventTarget) return;
    const bind = (type, pressed) => {
      const listener = (event) => {
        const code = normalizeInputKey(event.code || event.key);
        pressed ? this.down.add(code) : this.down.delete(code);
        for (const mapping of this.blueprintIr.inputMappings || []) {
          if (mapping.context && !this.activeContexts.has(normalize(mapping.context))) continue;
          if (normalizeInputKey(mapping.key) !== code) continue;
          const triggerEvent = pressed && !event.repeat ? 'Started' : pressed ? 'Triggered' : 'Completed';
          const negated = (mapping.modifiers || []).some((modifier) => normalize(modifier).includes('negate'));
          const scalar = pressed ? Number(mapping.scale ?? 1) * (negated ? -1 : 1) : 0;
          const swizzled = (mapping.modifiers || []).some((modifier) => normalize(modifier).includes('swizzle'));
          const value = Number(mapping.valueType) === 2 ? { x: swizzled ? 0 : scalar, y: swizzled ? scalar : 0 } : scalar;
          const args = inputActionArgs(value, triggerEvent, mapping.context);
          this.runtime.call(mapping.action, null, args);
          this.runtime.call(`InputAction_${mapping.action}`, null, args);
        }
      };
      this.eventTarget.addEventListener(type, listener);
      this.handlers.push([type, listener]);
    };
    bind('keydown', true);
    bind('keyup', false);
    const mouseListener = (event) => {
      for (const mapping of this.blueprintIr.inputMappings || []) {
        if (normalize(mapping.key) !== 'mouse2d') continue;
        if (mapping.context && !this.activeContexts.has(normalize(mapping.context))) continue;
        const negated = (mapping.modifiers || []).some((modifier) => normalize(modifier).includes('negate'));
        const value = { x: event.movementX, y: event.movementY * (negated ? -1 : 1) };
        const args = inputActionArgs(value, 'Triggered', mapping.context);
        this.runtime.call(mapping.action, null, args);
        this.runtime.call(`InputAction_${mapping.action}`, null, args);
      }
    };
    this.eventTarget.addEventListener('mousemove', mouseListener);
    this.handlers.push(['mousemove', mouseListener]);
  }
  addContext(context) { this.activeContexts.add(normalize(context?.name || context)); }
  removeContext(context) { this.activeContexts.delete(normalize(context?.name || context)); }
  axis(positive, negative) { return Number(this.down.has(normalize(positive))) - Number(this.down.has(normalize(negative))); }
  gamepads() {
    const source = this.eventTarget?.navigator || globalThis.navigator;
    if (typeof source?.getGamepads !== 'function') return [];
    try { return Array.from(source.getGamepads() || []).filter((gamepad) => gamepad && gamepad.connected !== false); }
    catch { return []; }
  }
  buttonValue(gamepad, index) {
    const button = gamepad?.buttons?.[index];
    if (typeof button === 'number') return button;
    return Math.max(Number(button?.value || 0), button?.pressed ? 1 : 0);
  }
  rawGamepadValue(mapping, gamepad) {
    const key = normalize(mapping.key);
    if (key === 'gamepadleft2d') return { x: Number(gamepad?.axes?.[0] || 0), y: -Number(gamepad?.axes?.[1] || 0) };
    if (key === 'gamepadright2d') return { x: Number(gamepad?.axes?.[2] || 0), y: -Number(gamepad?.axes?.[3] || 0) };
    if (STANDARD_GAMEPAD_BUTTONS[key] !== undefined) return this.buttonValue(gamepad, STANDARD_GAMEPAD_BUTTONS[key]);
    if (STANDARD_GAMEPAD_AXES[key]) {
      const [axis, direction] = STANDARD_GAMEPAD_AXES[key];
      return Number(gamepad?.axes?.[axis] || 0) * direction;
    }
    if (STANDARD_GAMEPAD_DIRECTIONS[key]) {
      const [axis, direction] = STANDARD_GAMEPAD_DIRECTIONS[key];
      return Math.max(0, Number(gamepad?.axes?.[axis] || 0) * direction);
    }
    return undefined;
  }
  gamepadValue(mapping, gamepads) {
    let selected;
    for (const gamepad of gamepads) {
      const candidate = this.rawGamepadValue(mapping, gamepad);
      if (candidate === undefined) continue;
      if (selected === undefined || inputMagnitude(candidate) > inputMagnitude(selected)) selected = candidate;
    }
    if (selected === undefined) return undefined;
    const modifiers = (mapping.modifiers || []).map(normalize);
    const deadZoned = modifiers.some((modifier) => modifier.includes('deadzone')) ? applyDeadZone(selected) : selected;
    const scale = Number(mapping.scale ?? 1);
    return typeof deadZoned === 'number'
      ? deadZoned * scale
      : { x: deadZoned.x * scale, y: deadZoned.y * scale };
  }
  tick() {
    if (!this.runtime) return;
    const gamepads = this.gamepads();
    for (const [index, mapping] of (this.blueprintIr.inputMappings || []).entries()) {
      const raw = this.rawGamepadValue(mapping, gamepads[0]);
      if (raw === undefined && !this.gamepadState.has(index)) continue;
      const contextActive = !mapping.context || this.activeContexts.has(normalize(mapping.context));
      const value = contextActive ? this.gamepadValue(mapping, gamepads) : undefined;
      const current = value ?? (Number(mapping.valueType) === 2 ? { x: 0, y: 0 } : 0);
      const active = inputMagnitude(current) > 0.0001;
      const previous = this.gamepadState.get(index) || { active: false };
      const triggerEvent = active ? (previous.active ? 'Triggered' : 'Started') : (previous.active ? 'Completed' : null);
      if (triggerEvent) {
        const args = inputActionArgs(current, triggerEvent, mapping.context);
        this.runtime.call(mapping.action, null, args);
        this.runtime.call(`InputAction_${mapping.action}`, null, args);
      }
      this.gamepadState.set(index, { active });
    }
  }
  dispose() {
    for (const [type, listener] of this.handlers) this.eventTarget?.removeEventListener(type, listener);
    this.gamepadState.clear();
  }
}

class CollisionAdapter {
  constructor() { this.runtime = null; this.active = new Set(); }
  attach(runtime) { this.runtime = runtime; }
  tick() {
    if (!this.runtime) return;
    const instances = this.runtime.instances.filter((instance) => instance.object).slice(0, 200);
    const boxes = instances.map((instance) => new THREE.Box3().setFromObject(instance.object));
    const next = new Set();
    for (let left = 0; left < instances.length; left += 1) {
      if (boxes[left].isEmpty()) continue;
      for (let right = left + 1; right < instances.length; right += 1) {
        if (boxes[right].isEmpty() || !boxes[left].intersectsBox(boxes[right])) continue;
        const key = [instances[left].actor.objectName, instances[right].actor.objectName].sort().join('|');
        next.add(key);
        if (!this.active.has(key)) {
          for (const event of ['ActorBeginOverlap', 'ReceiveActorBeginOverlap', 'ComponentBeginOverlap', 'ReceiveHit']) {
            this.runtime.call(event, instances[left].actor.objectName, { otherActor: instances[right].object });
            this.runtime.call(event, instances[right].actor.objectName, { otherActor: instances[left].object });
          }
        }
      }
    }
    for (const key of this.active) {
      if (next.has(key)) continue;
      const [left, right] = key.split('|');
      this.runtime.call('ActorEndOverlap', left, { otherActor: right });
      this.runtime.call('ActorEndOverlap', right, { otherActor: left });
      this.runtime.call('ComponentEndOverlap', left, { otherActor: right });
      this.runtime.call('ComponentEndOverlap', right, { otherActor: left });
    }
    this.active = next;
  }
}

class PhysicsAdapter {
  constructor() { this.bodies = new Map(); }
  body(instance) {
    if (!this.bodies.has(instance)) this.bodies.set(instance, { velocity: new THREE.Vector3(), force: new THREE.Vector3(), gravity: true, simulating: true });
    return this.bodies.get(instance);
  }
  vector(value = {}) { return new THREE.Vector3(Number(value.x || 0) / 100, Number(value.z || 0) / 100, -Number(value.y || 0) / 100); }
  call(name, args, instance) {
    if (!instance?.object) return { handled: false };
    const body = this.body(instance);
    if (name === 'setsimulatephysics') { body.simulating = Boolean(args.bsimulate ?? args.simulate ?? true); return { handled: true }; }
    if (name === 'setenablegravity') { body.gravity = Boolean(args.bgravityenabled ?? args.enabled ?? true); return { handled: true }; }
    if (name === 'setphysicslinearvelocity') { body.velocity.copy(this.vector(args.newvel || args.velocity)); return { handled: true }; }
    if (name === 'getphysicslinearvelocity') return { handled: true, value: { x: body.velocity.x * 100, y: -body.velocity.z * 100, z: body.velocity.y * 100 } };
    if (name === 'addimpulse' || name === 'addimpulseatlocation') { body.velocity.add(this.vector(args.impulse || args.vector)); return { handled: true }; }
    if (name === 'addforce' || name === 'addforceatlocation') { body.force.add(this.vector(args.force || args.vector)); return { handled: true }; }
    return { handled: false };
  }
  tick(delta) {
    for (const [instance, body] of this.bodies) {
      if (!body.simulating || !instance.object?.position) continue;
      if (body.gravity) body.velocity.y -= 9.81 * delta;
      body.velocity.addScaledVector(body.force, delta);
      instance.object.position.addScaledVector(body.velocity, delta);
      body.force.set(0, 0, 0);
    }
  }
}

class AbilitySystemAdapter {
  constructor() { this.state = new WeakMap(); }
  for(instance) {
    if (!this.state.has(instance)) this.state.set(instance, { attributes: { health: 100, maxhealth: 100 }, tags: new Set(), cooldowns: new Map(), effects: [] });
    return this.state.get(instance);
  }
  call(name, args, instance) {
    const state = this.for(instance);
    if (name.includes('hasmatchinggameplaytag')) return { handled: true, value: state.tags.has(String(args.tag || args.tagtocheck)) };
    if (name.includes('addloosegameplaytag')) { state.tags.add(String(args.gameplaytag || args.tag)); return { handled: true }; }
    if (name.includes('removeloosegameplaytag')) { state.tags.delete(String(args.gameplaytag || args.tag)); return { handled: true }; }
    if (name.includes('getnumericattribute')) return { handled: true, value: state.attributes[normalize(args.attribute)] ?? 0 };
    if (name.includes('setnumericattributebase')) { state.attributes[normalize(args.attribute)] = Number(args.newbasevalue ?? args.value); return { handled: true }; }
    if (name.includes('applygameplayeffect')) {
      const effect = args.gameplayeffectclass || args.effect || {};
      state.effects.push(effect);
      for (const [attribute, magnitude] of Object.entries(effect.modifiers || {})) state.attributes[normalize(attribute)] = (state.attributes[normalize(attribute)] || 0) + Number(magnitude);
      return { handled: true, value: state.effects.length };
    }
    if (name.includes('tryactivateability')) {
      const ability = normalize(args.abilitytoclass || args.ability || args.inabilityclass);
      const expiry = state.cooldowns.get(ability) || 0;
      if (performance.now() < expiry) return { handled: true, value: false };
      state.cooldowns.set(ability, performance.now() + Number(args.cooldown || 0) * 1000);
      return { handled: true, value: true };
    }
    return { handled: false };
  }
}

class WidgetAdapter {
  constructor(blueprintIr) {
    this.definitions = blueprintIr.widgetBlueprints || [];
    this.runtime = null;
    this.layer = globalThis.document?.createElement('div');
    if (!this.layer) return;
    this.layer.id = 'ue-widget-layer';
    Object.assign(this.layer.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: 20 });
    globalThis.document.body.append(this.layer);
  }
  attach(runtime) { this.runtime = runtime; }
  property(properties, name) {
    const key = Object.keys(properties || {}).find((candidate) => normalize(candidate) === normalize(name));
    return key ? properties[key] : undefined;
  }
  text(value) {
    const source = String(value ?? '');
    const quoted = [...source.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)];
    return quoted.length ? quoted.at(-1)[1].replace(/\\"/g, '"') : source;
  }
  render(definition) {
    const className = normalize(definition?.class);
    const tag = className.includes('button') ? 'button' : className.includes('text') ? 'span' : className.includes('image') ? 'img' : 'div';
    const element = globalThis.document.createElement(tag);
    element.dataset.widgetName = definition?.name || '';
    element.dataset.widgetClass = definition?.class || 'Widget';
    element.className = `ue-widget ue-${className || 'widget'}`;
    const text = this.property(definition?.properties, 'Text');
    if (text !== undefined && tag !== 'img') element.textContent = this.text(text);
    if (className.includes('verticalbox')) Object.assign(element.style, { display: 'flex', flexDirection: 'column' });
    if (className.includes('horizontalbox')) Object.assign(element.style, { display: 'flex', flexDirection: 'row' });
    if (className.includes('overlay')) element.style.display = 'grid';
    if (className.includes('canvaspanel')) element.style.position = 'relative';
    if (tag === 'button') element.addEventListener('click', () => this.runtime?.call(`OnClicked_${definition.name}`, null, { widget: element }));
    for (const child of definition?.children || []) element.append(this.render(child));
    return element;
  }
  create(args) {
    const requested = String(args.class || args.widgetclass || args.userwidgetclass || 'Widget');
    const key = normalize(requested.split(/[.'/]/).at(-1));
    const definition = this.definitions.find((candidate) => normalize(candidate.name) === key || normalize(candidate.path) === normalize(requested));
    const element = definition?.root ? this.render(definition.root) : globalThis.document.createElement('div');
    element.dataset.widgetClass ||= requested;
    if (!definition && args.text !== undefined) element.textContent = String(args.text);
    Object.assign(element.style, { position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', pointerEvents: 'auto' });
    return element;
  }
  call(name, args) {
    if (!this.layer) return { handled: false };
    if (name === 'createwidget') return { handled: true, value: this.create(args) };
    const target = args.target || args.self || args.widget;
    const isElement = Boolean(globalThis.Element && target instanceof globalThis.Element);
    if (name === 'addtoviewport' || name === 'addtoplayerscreen') { if (isElement) this.layer.append(target); return { handled: true }; }
    if (name === 'removefromparent') { target?.remove?.(); return { handled: true }; }
    if (name === 'settext' && isElement) { target.textContent = String(args.intext ?? args.text ?? ''); return { handled: true }; }
    if (name === 'setvisibility' && isElement) { target.hidden = /hidden|collapsed/i.test(String(args.invisibility)); return { handled: true }; }
    if (name === 'setpercent' && isElement) { target.style.setProperty('--ue-percent', String(Number(args.inpercent ?? args.percent ?? 0))); return { handled: true }; }
    return { handled: false };
  }
  dispose() { this.layer?.remove(); }
}

class ParticleAdapter {
  constructor(root) { this.root = root; this.systems = new Set(); }
  spawn(args) {
    const count = Math.min(Number(args.count || 96), 2000);
    const positions = new Float32Array(count * 3);
    for (let index = 0; index < count; index += 1) {
      positions[index * 3] = (Math.random() - 0.5) * 0.25;
      positions[index * 3 + 1] = Math.random() * 0.4;
      positions[index * 3 + 2] = (Math.random() - 0.5) * 0.25;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({ color: args.color || 0x6fe7cb, size: Number(args.size || 0.035), transparent: true, opacity: 0.85 });
    const points = new THREE.Points(geometry, material);
    const location = args.location || args.spawnlocation || {};
    points.position.set(Number(location.x || 0) / 100, Number(location.z || 0) / 100, -Number(location.y || 0) / 100);
    this.root?.add(points);
    this.systems.add(points);
    return points;
  }
  call(name, args) {
    if (name.includes('spawnsystem') || name.includes('spawnemitter')) return { handled: true, value: this.spawn(args) };
    if (name === 'deactivate' || name === 'deactivateimmediate') { const target = args.target || args.self; if (this.systems.has(target)) target.visible = false; return { handled: true }; }
    if (name === 'activate' || name === 'resetsystem') { const target = args.target || args.self; if (this.systems.has(target)) target.visible = true; return { handled: true }; }
    return { handled: false };
  }
  dispose() { for (const points of this.systems) { points.removeFromParent(); points.geometry.dispose(); points.material.dispose(); } }
}

class BehaviorTreeAdapter {
  constructor(blueprintIr) { this.trees = blueprintIr.behaviorTrees || []; this.runtime = null; this.running = []; }
  attach(runtime) {
    this.runtime = runtime;
    for (const tree of this.trees) {
      const instance = runtime.instances.find((candidate) => normalize(candidate.actor.objectName) === normalize(tree.actor));
      if (instance) this.running.push({ tree, instance, cursor: 0, wait: 0 });
    }
  }
  flatten(node, output = []) {
    if (!node) return output;
    if (!(node.children || []).length) {
      const className = normalize(node.class);
      if (className.includes('wait')) {
        const match = String(node.properties?.WaitTime || node.properties?.waitTime || '1').match(/-?\d+(?:\.\d+)?/);
        output.push({ type: 'wait', seconds: Number(match?.[0] || 1) });
      } else {
        output.push({ type: 'event', event: node.name || node.class, args: { behaviorNode: node } });
      }
    }
    for (const child of node.children || []) this.flatten(child, output);
    return output;
  }
  start(asset, instance) {
    const key = normalize(asset?.name || asset);
    const tree = this.trees.find((candidate) => normalize(candidate.name) === key || normalize(candidate.path) === key);
    if (!tree || !instance) return false;
    const runnable = { ...tree, tasks: tree.tasks || this.flatten(tree.root) };
    this.running.push({ tree: runnable, instance, cursor: 0, wait: 0 });
    return true;
  }
  tick(delta) {
    for (const run of this.running) {
      if ((run.wait -= delta) > 0) continue;
      const tasks = run.tree.tasks || [];
      if (!tasks.length) continue;
      const task = tasks[run.cursor++ % tasks.length];
      if (task.type === 'wait') run.wait = Number(task.seconds || 1);
      else if (task.type === 'event') this.runtime.call(task.event, run.instance.actor.objectName, task.args || {});
      else if (task.type === 'set') run.instance.state[task.variable] = task.value;
    }
  }
}

export class BrowserRuntimeAdapters extends ThreeBlueprintAdapter {
  constructor(root, blueprintIr, hooks = {}, eventTarget = globalThis.window) {
    super(root, hooks);
    this.blueprintIr = blueprintIr;
    this.eventTarget = eventTarget;
    this.events = new RuntimeEventBus();
    this.customFunctions = new Map();
    this.replication = new ReplicationAdapter(blueprintIr, hooks);
    this.input = new EnhancedInputAdapter(blueprintIr, eventTarget);
    this.collisions = new CollisionAdapter();
    this.physics = new PhysicsAdapter();
    this.abilities = new AbilitySystemAdapter();
    this.widgets = new WidgetAdapter(blueprintIr);
    this.particles = new ParticleAdapter(root);
    this.behaviors = new BehaviorTreeAdapter(blueprintIr);
    this.timers = new Map();
    this.gameplayController = null;
    this.discordEventSource = null;
    this.discordEventHandlers = [];
    this.discordAttachment = 0;
  }
  attachRuntime(runtime) {
    this.runtime = runtime;
    for (const adapter of [this.replication, this.input, this.collisions, this.widgets, this.behaviors]) adapter.attach(runtime);
    this.attachDiscordActivityEvents();
  }
  registerFunction(name, implementation) { this.customFunctions.set(normalize(name), implementation); }
  attachGameplayController(controller) { this.gameplayController = controller; }
  variableChanged(instance, variable, value) { this.replication.changed(instance, variable, value); }
  tick(delta) { this.input.tick(); this.physics.tick(delta); this.collisions.tick(delta); this.behaviors.tick(delta); }
  discordActivity() { return this.eventTarget?.UE5HTML5?.activity || null; }
  attachDiscordActivityEvents() {
    const attachment = ++this.discordAttachment;
    const attach = (activity) => {
      if (!activity || attachment !== this.discordAttachment || activity === this.discordEventSource) return;
      for (const [type, handler] of this.discordEventHandlers) {
        this.discordEventSource?.removeEventListener?.(type, handler);
      }
      this.discordEventHandlers = [
        ['thermalstate', ({ detail = {} }) => this.runtime?.call('DiscordActivityThermalStateChanged', null, detail)],
        ['orientation', ({ detail = {} }) => this.runtime?.call('DiscordActivityOrientationChanged', null, detail)],
        ['layoutmode', ({ detail = {} }) => this.runtime?.call('DiscordActivityLayoutModeChanged', null, detail)],
        ['broadcast', ({ detail = {} }) => this.runtime?.call('DiscordActivityBroadcastReceived', null, {
          event: String(detail.event || 'message'),
          jsonPayload: blueprintJson(detail.payload),
          bReplayed: Boolean(detail.meta?.replayed),
        })],
        ['presence', ({ detail = {} }) => this.runtime?.call('DiscordActivityPresenceChanged', null, {
          presenceJson: blueprintJson(detail),
        })],
        ['participants', ({ detail = {} }) => this.emitDiscordParticipants(detail)],
        ['entitlements', ({ detail = [] }) => this.emitDiscordEntitlements(detail)],
      ];
      this.discordEventSource = activity;
      for (const [type, handler] of this.discordEventHandlers) activity.addEventListener?.(type, handler);
      if (activity.mode === 'ready') {
        this.runtime?.call('DiscordActivityPresenceChanged', null, {
          presenceJson: blueprintJson(activity.getPresenceState?.() || {}),
        });
        if (Array.isArray(activity.entitlements)) this.emitDiscordEntitlements(activity.entitlements);
        Promise.resolve(activity.getParticipants?.()).then((participants) => {
          if (participants && attachment === this.discordAttachment) this.emitDiscordParticipants(participants);
        }).catch(() => {});
      }
    };
    attach(this.discordActivity());
    const ready = this.eventTarget?.UE5HTML5?.activityReady;
    if (ready?.then) ready.then(attach).catch(() => {});
  }
  emitDiscordParticipants(participants = {}) {
    const list = Array.isArray(participants) ? participants : participants.participants || [];
    this.runtime?.call('DiscordActivityParticipantsChanged', null, {
      participantsJson: blueprintJson({ participants: list }),
      participantCount: list.length,
    });
  }
  emitDiscordEntitlements(entitlements = []) {
    const list = Array.isArray(entitlements) ? entitlements : entitlements.entitlements || [];
    this.runtime?.call('DiscordActivityVerifiedEntitlementsChanged', null, {
      entitlementsJson: blueprintJson(list),
      entitlementCount: list.length,
    });
  }
  callDiscordActivity(name, args) {
    const activity = this.discordActivity();
    if (name === 'isdiscordactivityready') return { handled: true, value: activity?.mode === 'ready' };
    if (!name.startsWith('discordactivity')) return null;
    if (!activity || activity.mode !== 'ready') {
      return { handled: true, promise: Promise.reject(new Error('Discord Activity is not ready.')) };
    }
    const parseJson = (value) => {
      if (typeof value !== 'string') return value;
      try { return JSON.parse(value); }
      catch { throw new Error('Discord Activity Blueprint node received invalid JSON.'); }
    };
    const expectedRevision = Number(args.expectedrevision);
    const revision = Number.isSafeInteger(expectedRevision) && expectedRevision >= 0 ? expectedRevision : undefined;
    if (name === 'discordactivitybroadcast') {
      return { handled: true, promise: activity.broadcast(String(args.event || 'message'), parseJson(args.jsonpayload || '{}')).then(() => true) };
    }
    if (name === 'discordactivityopeninvitedialog') {
      return { handled: true, promise: activity.openInviteDialog().then(() => true) };
    }
    if (name === 'discordactivityencouragehardwareacceleration') {
      return { handled: true, promise: activity.encourageHardwareAcceleration().then(() => true) };
    }
    if (name === 'discordactivitysetorientationlock') {
      return { handled: true, promise: activity.setOrientationLock(
        discordOrientationLock(args.lockstate),
        discordOrientationLock(args.pictureinpicturelockstate),
        discordOrientationLock(args.gridlockstate),
      ).then((result) => ({ returnvalue: result?.supported !== false })) };
    }
    if (name === 'discordactivitysetinteractivepip') {
      return { handled: true, promise: activity.setInteractivePip(Boolean(args.benabled ?? args.enabled))
        .then((result) => ({ returnvalue: result?.supported !== false })) };
    }
    if (name === 'discordactivitygetplatformbehaviors') {
      return { handled: true, promise: activity.getPlatformBehaviors().then((result) => ({
        returnvalue: result?.supported !== false,
        outplatformbehaviorsjson: JSON.stringify(result?.behaviors || {}),
      })) };
    }
    if (name === 'discordactivitygetlocale') {
      return { handled: true, promise: activity.getLocale().then((result) => ({
        returnvalue: result?.supported !== false,
        outlocale: String(result?.locale || ''),
      })) };
    }
    if (name === 'discordactivitysetrichpresence') {
      return { handled: true, promise: activity.setRichPresence({
        details: String(args.details || ''),
        state: String(args.state || ''),
        currentPartySize: Number(args.currentpartysize || 0),
        maximumPartySize: Number(args.maximumpartysize || 0),
        largeImage: String(args.largeimage || ''),
        largeText: String(args.largetext || ''),
      }).then((result) => ({ returnvalue: result?.supported !== false })) };
    }
    if (name === 'discordactivityclearrichpresence') {
      return { handled: true, promise: activity.clearRichPresence()
        .then((result) => ({ returnvalue: result?.supported !== false })) };
    }
    if (name === 'discordactivitysharelink') {
      return { handled: true, promise: activity.shareLink(
        String(args.message || ''),
        String(args.customid || ''),
        String(args.linkid || ''),
      ).then((result) => ({
        returnvalue: Boolean(result?.success),
        outshareresultjson: JSON.stringify(result),
      })) };
    }
    if (name === 'discordactivityopenexternallink') {
      return { handled: true, promise: activity.openExternalLink(String(args.url || ''))
        .then((result) => ({ returnvalue: result?.supported !== false && result?.opened !== false })) };
    }
    if (name === 'discordactivitygetlaunchcontext') {
      const context = activity.getLaunchContext();
      return { handled: true, value: {
        returnvalue: true,
        outcustomid: String(context.customId || ''),
        bouthasreferrer: Boolean(context.hasReferrer),
      } };
    }
    if (name === 'discordactivitygetparticipants') {
      return { handled: true, promise: activity.getParticipants().then((result) => ({
        returnvalue: true,
        outparticipantsjson: JSON.stringify(result),
      })) };
    }
    if (name === 'discordactivitygetskus') {
      return { handled: true, promise: activity.getSkus().then((result) => ({
        returnvalue: true,
        outskusjson: JSON.stringify(result?.skus ?? result ?? []),
      })) };
    }
    if (name === 'discordactivitygetverifiedentitlements') {
      return { handled: true, promise: activity.verifyEntitlements().then((entitlements) => ({
        returnvalue: true,
        outentitlementsjson: JSON.stringify(entitlements),
      })) };
    }
    if (name === 'discordactivityhasentitlement') {
      const skuId = String(args.skuid || '');
      if (!skuId) return { handled: true, promise: Promise.reject(new Error('Discord SKU ID is required.')) };
      return { handled: true, promise: activity.verifyEntitlements().then((entitlements) => ({
        returnvalue: entitlements.some((item) => String(item.skuId ?? item.sku_id) === skuId),
      })) };
    }
    if (name === 'discordactivitystartpurchase') {
      const skuId = String(args.skuid || '');
      if (!skuId) return { handled: true, promise: Promise.reject(new Error('Discord SKU ID is required.')) };
      return { handled: true, promise: activity.startPurchase(skuId).then((result) => ({
        returnvalue: true,
        outpurchasejson: JSON.stringify(result),
      })) };
    }
    if (name === 'discordactivityloadworldstate' || name === 'discordactivityloadplayerstate') {
      const load = name.includes('world') ? activity.loadWorld() : activity.loadPlayerState();
      return { handled: true, promise: load.then((result) => ({
        returnvalue: true,
        outjsonstate: JSON.stringify(result.state),
        outrevision: Number(result.revision || 0),
      })) };
    }
    if (name === 'discordactivitysaveworldstate' || name === 'discordactivitysaveplayerstate') {
      const state = parseJson(args.jsonstate || 'null');
      const save = name.includes('world')
        ? activity.saveWorld(state, revision)
        : activity.savePlayerState(state, revision);
      return { handled: true, promise: save.then((result) => ({
        returnvalue: true,
        outrevision: Number(result.revision),
      })) };
    }
    return null;
  }
  call(functionName, args, instance) {
    const name = normalize(functionName);
    const custom = this.customFunctions.get(name);
    if (custom) {
      const output = custom(args, instance, this.runtime);
      return output?.then ? { handled: true, promise: output } : { handled: true, value: output };
    }
    const discord = this.callDiscordActivity(name, args);
    if (discord) return discord;
    if (name === 'addmappingcontext') { this.input.addContext(args.mappingcontext || args.context); return { handled: true }; }
    if (name === 'removemappingcontext') { this.input.removeContext(args.mappingcontext || args.context); return { handled: true }; }
    if (name === 'addmovementinput' && this.gameplayController) {
      this.gameplayController.addMovementInput(args.worlddirection || args.direction, args.scalevalue ?? args.scale ?? 1);
      return { handled: true };
    }
    if (name === 'jump' && this.gameplayController) return { handled: true, value: this.gameplayController.jump() };
    if (name === 'stopjumping' && this.gameplayController) return { handled: true, value: this.gameplayController.stopJumping() };
    if (name === 'addcontrolleryawinput' && this.gameplayController) { this.gameplayController.addLookInput(args.val ?? args.value); return { handled: true }; }
    if (name === 'addcontrollerpitchinput' && this.gameplayController) { this.gameplayController.addLookInput(0, args.val ?? args.value); return { handled: true }; }
    if (name === 'getactorforwardvector' && this.gameplayController) {
      const value = this.gameplayController.forward();
      return { handled: true, value: { x: value.x * 100, y: -value.z * 100, z: value.y * 100 } };
    }
    if (name === 'getactorrightvector' && this.gameplayController) {
      const value = this.gameplayController.right();
      return { handled: true, value: { x: value.x * 100, y: -value.z * 100, z: value.y * 100 } };
    }
    if (name === 'islocalplayercontroller') return { handled: true, value: true };
    if (name === 'getplatformname') return { handled: true, value: 'Web' };
    if (name === 'shouldusetouchcontrols') {
      return { handled: true, value: shouldUseTouchControls(this.eventTarget, this.eventTarget?.navigator) };
    }
    if (name === 'getsubsystem') return { handled: true, value: this.input };
    if (name === 'delayuntilnextframe') return { handled: true, promise: new Promise((resolve) => requestAnimationFrame(() => resolve(true))) };
    if (this.replication.remoteCall(functionName, args, instance)) return { handled: true };
    const three = super.call(functionName, args, instance);
    if (three.handled) return three;
    for (const adapter of [this.physics, this.abilities, this.widgets, this.particles]) {
      const result = adapter.call(name, args, instance);
      if (result.handled) return result;
    }
    if (name.includes('broadcast') || name.includes('delegate')) { this.events.emit(args.event || functionName, { args, instance }); return { handled: true }; }
    if (name.startsWith('execute') || name.includes('interface')) { this.runtime.call(args.functionname || functionName, args.target?.name, args); return { handled: true }; }
    if (name === 'settimerbyfunctionname') {
      const key = `${instance.actor.objectName}:${args.functionname}`;
      clearInterval(this.timers.get(key));
      const invoke = () => this.runtime.call(args.functionname, instance.actor.objectName);
      const id = args.blooping ? setInterval(invoke, Number(args.time || 0) * 1000) : setTimeout(invoke, Number(args.time || 0) * 1000);
      this.timers.set(key, id);
      return { handled: true, value: key };
    }
    if (name === 'cleartimerbyhandle' || name === 'cleartimerbyfunctionname') { const key = args.handle || `${instance.actor.objectName}:${args.functionname}`; clearTimeout(this.timers.get(key)); clearInterval(this.timers.get(key)); return { handled: true }; }
    if (name === 'httpgetjson' || name === 'asyncdownloadjson') {
      return { handled: true, promise: fetch(String(args.url)).then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      }) };
    }
    if (name === 'asyncloadasset' || name === 'loadasset') {
      return { handled: true, promise: fetch(String(args.softobjectreference || args.asset || args.url)).then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.blob();
      }) };
    }
    if (name === 'movecomponentto') {
      const target = args.component || args.target || instance.object;
      const destination = args.targetrelativelocation || args.location || {};
      const start = target?.position?.clone?.();
      if (!target || !start) return { handled: true, value: false };
      const end = new THREE.Vector3(Number(destination.x || 0) / 100, Number(destination.z || 0) / 100, -Number(destination.y || 0) / 100);
      const duration = Math.max(0.001, Number(args.overtime || args.duration || 0.2));
      return { handled: true, promise: new Promise((resolve) => {
        const started = performance.now();
        const animate = (now) => {
          const alpha = Math.min(1, (now - started) / (duration * 1000));
          target.position.lerpVectors(start, end, alpha);
          if (alpha < 1) requestAnimationFrame(animate); else resolve(true);
        };
        requestAnimationFrame(animate);
      }) };
    }
    if (name === 'runbehaviortree') return { handled: true, value: this.behaviors.start(args.btasset || args.behaviortree || args.asset, instance) };
    if (name === 'openurl') { window.open(String(args.url), '_blank', 'noopener'); return { handled: true }; }
    return { handled: false };
  }
  dispose() {
    ++this.discordAttachment;
    for (const [type, handler] of this.discordEventHandlers) {
      this.discordEventSource?.removeEventListener?.(type, handler);
    }
    this.discordEventHandlers = [];
    this.discordEventSource = null;
    this.input.dispose();
    this.replication.dispose();
    this.widgets.dispose();
    this.particles.dispose();
    for (const id of this.timers.values()) { clearTimeout(id); clearInterval(id); }
  }
}
