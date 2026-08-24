const EXEC_CATEGORIES = new Set(['exec', 'delegate']);

export function parseBlueprintValue(value, category = '') {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text || text === 'None') return null;
  if (/^(true|false)$/i.test(text)) return text.toLowerCase() === 'true';
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return Number(text);

  const fields = {};
  const fieldPattern = /([A-Za-z][A-Za-z0-9_]*)=(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?|True|False|"[^"]*")/gi;
  let match;
  while ((match = fieldPattern.exec(text))) {
    fields[match[1].toLowerCase()] = parseBlueprintValue(match[2].replace(/^"|"$/g, ''));
  }
  if (Object.keys(fields).length) return fields;

  if ((category === 'array' || (text.startsWith('(') && text.endsWith(')'))) && text.includes(',')) {
    return text.slice(1, -1).split(',').map((part) => parseBlueprintValue(part));
  }
  return text.replace(/^"|"$/g, '');
}

function normalized(value) {
  return String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function foldedName(value) {
  return String(value ?? '').toLocaleLowerCase();
}

function enumEntry(value) {
  return String(value ?? '').split('::').at(-1);
}

function sameEnumEntry(left, right) {
  return foldedName(enumEntry(left)) === foldedName(enumEntry(right));
}

function pinNamed(node, ...names) {
  const wanted = names.map(normalized);
  return node.pins.find((pin) => wanted.includes(normalized(pin.name)));
}

function inputPins(node) {
  return node.pins.filter((pin) => pin.direction === 'input' && !EXEC_CATEGORIES.has(pin.category));
}

function outputExecPins(node) {
  return node.pins.filter((pin) => pin.direction === 'output' && pin.category === 'exec');
}

function binary(args, operation) {
  const values = Object.values(args);
  return operation(args.a ?? values[0], args.b ?? values[1]);
}

export class BlueprintRuntime {
  constructor(document, adapter = {}, options = {}) {
    this.document = document || { programs: [] };
    this.adapter = adapter;
    this.logger = options.logger || (() => {});
    this.eventTarget = options.eventTarget || null;
    this.maxSteps = options.maxSteps || 10000;
    this.instances = [];
    this.keyHandlers = [];
    this.started = false;
    this.diagnostics = [];
    this.buildInstances();
  }

  buildInstances() {
    for (const program of this.document.programs || []) {
      const nodes = (program.graphs || []).flatMap((graph) => graph.nodes || []);
      const nodeMap = new Map(nodes.map((node) => [node.id, node]));
      const actors = program.actors?.length ? program.actors : [{ objectName: program.name, initialState: {} }];
      for (const actor of actors) {
        const instance = {
          program,
          actor,
          object: this.adapter.findActor?.(actor) || null,
          state: Object.fromEntries(Object.entries(actor.initialState || {}).map(([key, entry]) => [key, parseBlueprintValue(entry?.value ?? entry, entry?.category)])),
          internal: new Map(),
          nodes,
          nodeMap,
          events: new Map(),
          functionEntries: new Map(),
          eventArgs: new Map(),
        };
        for (const node of nodes) {
          if (node.kind === 'event' || node.kind === 'inputKey' || node.kind === 'inputAction') {
            const key = normalized(node.event || node.function || node.title);
            if (!instance.events.has(key)) instance.events.set(key, []);
            instance.events.get(key).push(node);
          }
          if (node.kind === 'functionEntry') instance.functionEntries.set(normalized(node.function || node.title), node);
        }
        this.instances.push(instance);
      }
    }
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.bindInput();
    for (const instance of this.instances) {
      this.emit(instance, ['receivebeginplay', 'beginplay']);
    }
  }

  stop() {
    for (const [type, handler] of this.keyHandlers) this.eventTarget?.removeEventListener(type, handler);
    this.keyHandlers = [];
    this.started = false;
  }

  tick(deltaSeconds) {
    if (!this.started) return;
    for (const instance of this.instances) {
      this.emit(instance, ['receivetick', 'tick'], { deltaseconds: deltaSeconds });
    }
  }

  call(eventName, actorName, args = {}) {
    const actorKey = normalized(actorName);
    let handledAny = false;
    for (const instance of this.instances) {
      if (!actorName || [instance.actor.objectName, instance.actor.label, instance.actor.path].some((value) => normalized(value) === actorKey)) {
        const name = normalized(eventName);
        const handled = this.emit(instance, [name], args);
        handledAny ||= handled;
        const entry = instance.functionEntries.get(name);
        if (!handled && entry) {
          instance.eventArgs.set(entry.id, Object.fromEntries(Object.entries(args).map(([key, value]) => [normalized(key), value])));
          this.runOutputWithContext(instance, entry, ['then'], { steps: 0 });
          handledAny = true;
        }
      }
    }
    return handledAny;
  }

  bindInput() {
    if (!this.eventTarget) return;
    const bind = (type, phase) => {
      const handler = (event) => {
        for (const instance of this.instances) {
          for (const node of instance.nodes.filter((candidate) => candidate.kind === 'inputKey')) {
            const configuredPhase = normalized(node.inputEvent || 'pressed');
            if (configuredPhase !== 'both' && configuredPhase !== phase) continue;
            if (!this.keyMatches(node, event)) continue;
            this.runOutput(instance, node, phase === 'pressed' ? ['pressed', 'then'] : ['released', 'then']);
          }
        }
      };
      this.eventTarget.addEventListener(type, handler);
      this.keyHandlers.push([type, handler]);
    };
    bind('keydown', 'pressed');
    bind('keyup', 'released');
  }

  keyMatches(node, event) {
    const aliases = {
      spacebar: 'space', leftmousebutton: 'mouse0', rightmousebutton: 'mouse2',
      up: 'arrowup', down: 'arrowdown', left: 'arrowleft', right: 'arrowright',
    };
    const expected = aliases[normalized(node.inputKey)] || normalized(node.inputKey);
    const actual = normalized(event.code?.replace(/^Key/, '').replace(/^Digit/, '') || event.key);
    return expected === actual
      && (!node.modifiers?.shift || event.shiftKey)
      && (!node.modifiers?.control || event.ctrlKey)
      && (!node.modifiers?.alt || event.altKey)
      && (!node.modifiers?.command || event.metaKey);
  }

  emit(instance, eventNames, args = {}) {
    for (const eventName of eventNames) {
      const events = instance.events.get(normalized(eventName)) || [];
      for (const node of events) {
        instance.eventArgs.set(node.id, Object.fromEntries(Object.entries(args).map(([key, value]) => [normalized(key), value])));
        const outputs = node.kind === 'inputAction' && args.triggerEvent ? [args.triggerEvent, 'then'] : ['then'];
        this.runOutput(instance, node, outputs);
      }
      if (events.length) return true;
    }
    return false;
  }

  runOutput(instance, node, names) {
    for (const name of names) {
      const pin = pinNamed(node, name);
      if (pin) for (const link of pin.links || []) this.execute(instance, link.node, link.pin);
    }
  }

  execute(instance, nodeId, incomingPin = '', context = { steps: 0 }) {
    if (++context.steps > this.maxSteps) {
      this.report('error', instance, null, `Execution stopped after ${this.maxSteps} steps; the graph may contain an unbounded synchronous loop.`);
      return;
    }
    const node = instance.nodeMap.get(nodeId);
    if (!node) return;

    switch (node.kind) {
      case 'branch': {
        const condition = Boolean(this.readInput(instance, node, ['condition'], false));
        this.runOutputWithContext(instance, node, [condition ? 'true' : 'false'], context);
        break;
      }
      case 'switchString': {
        const selection = String(this.readInput(instance, node, ['selection'], '') ?? '');
        const match = outputExecPins(node).find((pin) => pin.name !== 'Default'
          && (node.caseSensitive ? pin.name === selection : pin.name.toLocaleLowerCase() === selection.toLocaleLowerCase()));
        this.runOutputWithContext(instance, node, [match?.name || 'Default'], context);
        break;
      }
      case 'switchInteger': {
        const selection = Number(this.readInput(instance, node, ['selection'], 0));
        const match = outputExecPins(node).find((pin) => foldedName(pin.name) !== 'default'
          && Number(pin.name) === selection);
        this.runOutputWithContext(instance, node, [match?.name || 'Default'], context);
        break;
      }
      case 'switchName': {
        const selection = this.readInput(instance, node, ['selection'], '');
        const match = outputExecPins(node).find((pin) => foldedName(pin.name) !== 'default'
          && foldedName(pin.name) === foldedName(selection));
        this.runOutputWithContext(instance, node, [match?.name || 'Default'], context);
        break;
      }
      case 'switchEnum': {
        const selection = this.readInput(instance, node, ['selection'], '');
        const match = outputExecPins(node).find((pin) => foldedName(pin.name) !== 'default'
          && sameEnumEntry(pin.name, selection));
        this.runOutputWithContext(instance, node, [match?.name || 'Default'], context);
        break;
      }
      case 'sequence': {
        for (const pin of outputExecPins(node).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
          for (const link of pin.links || []) this.execute(instance, link.node, link.pin, context);
        }
        break;
      }
      case 'variableSet': {
        const value = this.readInput(instance, node, [node.variable, 'value'], null, ['self']);
        instance.state[node.variable] = value;
        this.adapter.variableChanged?.(instance, node.variable, value);
        this.runOutputWithContext(instance, node, ['then'], context);
        break;
      }
      case 'callFunction': {
        const result = this.invoke(instance, node, context);
        if (!result?.latent) {
          instance.internal.set(`result:${node.id}`, result?.value ?? null);
          this.runOutputWithContext(instance, node, ['then', 'completed'], context);
        }
        break;
      }
      case 'createWidget':
      case 'getSubsystem': {
        const result = this.invoke(instance, node, context);
        if (!result?.latent) this.runOutputWithContext(instance, node, ['then', 'completed'], context);
        break;
      }
      case 'delegate':
      case 'interfaceCall': {
        this.invoke(instance, node, context);
        this.runOutputWithContext(instance, node, ['then', 'completed'], context);
        break;
      }
      case 'doOnce': {
        const key = `doOnce:${node.id}`;
        const resetPin = normalized(incomingPin) === 'reset';
        if (resetPin) instance.internal.delete(key);
        else if (!instance.internal.get(key)) {
          instance.internal.set(key, true);
          this.runOutputWithContext(instance, node, ['completed'], context);
        }
        break;
      }
      case 'flipFlop': {
        const key = `flipFlop:${node.id}`;
        const next = !instance.internal.get(key);
        instance.internal.set(key, next);
        this.runOutputWithContext(instance, node, [next ? 'a' : 'b'], context);
        break;
      }
      case 'knot':
      case 'functionEntry':
        this.runOutputWithContext(instance, node, ['then'], context);
        break;
      case 'functionResult': {
        context.returnValue = Object.fromEntries(inputPins(node)
          .filter((pin) => normalized(pin.name) !== 'self' && normalized(pin.category) !== 'exec')
          .map((pin) => [normalized(pin.name), this.readSpecificPin(instance, pin)]));
        context.didReturn = true;
        break;
      }
      case 'comment':
        break;
      default:
        this.report('warning', instance, node, `Unsupported execution node ${node.class || node.kind}; branch skipped.`);
    }
  }

  runOutputWithContext(instance, node, names, context) {
    for (const name of names) {
      const pin = pinNamed(node, name);
      if (pin) for (const link of pin.links || []) this.execute(instance, link.node, link.pin, context);
    }
  }

  readInput(instance, node, names, fallback = null, excluded = []) {
    const pin = names.map((name) => pinNamed(node, name)).find(Boolean)
      || inputPins(node).find((candidate) => !excluded.map(normalized).includes(normalized(candidate.name)));
    if (!pin) return fallback;
    const source = (pin.links || [])[0];
    if (source) return this.evaluate(instance, source.node, source.pin);
    return parseBlueprintValue(pin.default, pin.category) ?? fallback;
  }

  evaluate(instance, nodeId, outputPin = '', stack = new Set()) {
    const stackKey = `${nodeId}:${outputPin}`;
    if (stack.has(stackKey)) return null;
    stack.add(stackKey);
    const node = instance.nodeMap.get(nodeId);
    if (!node) return null;
    let value = null;
    if (node.kind === 'variableGet') value = instance.state[node.variable];
    else if (node.kind === 'self') value = instance.object;
    else if (node.kind === 'knot') {
      const input = inputPins(node)[0];
      value = input ? this.readSpecificPin(instance, input, stack) : null;
    }
    else if (node.kind === 'event' || node.kind === 'inputKey' || node.kind === 'inputAction' || node.kind === 'functionEntry') {
      value = instance.eventArgs.get(node.id)?.[normalized(outputPin)];
    } else if (node.kind === 'literal') {
      const pin = pinNamed(node, outputPin) || node.pins.find((candidate) => candidate.direction === 'output');
      value = parseBlueprintValue(pin?.default, pin?.category);
    } else if (node.kind === 'makeStruct') {
      value = Object.fromEntries(inputPins(node).filter((pin) => normalized(pin.name) !== 'self').map((pin) => [pin.name.toLowerCase(), this.readSpecificPin(instance, pin, stack)]));
    } else if (node.kind === 'breakStruct') {
      const source = this.readInput(instance, node, ['struct', 'input'], {});
      value = source?.[normalized(outputPin)] ?? source?.[String(outputPin).toLowerCase()] ?? null;
    } else if (node.kind === 'select') {
      const indexPin = pinNamed(node, 'Index');
      const options = inputPins(node).filter((pin) => normalized(pin.name) !== 'index');
      const index = indexPin ? this.readSpecificPin(instance, indexPin, stack) : 0;
      const indexCategory = normalized(indexPin?.category);
      const isEnum = indexCategory === 'enum'
        || (indexCategory === 'byte' && Boolean(indexPin?.typeObject));
      let selected = options[0];
      if (indexCategory === 'bool' || indexCategory === 'boolean') {
        selected = options[Boolean(index) ? 1 : 0] || selected;
      } else if (isEnum) {
        selected = options.find((pin) => sameEnumEntry(pin.name, index)) || selected;
      } else if (Number.isInteger(Number(index))) {
        selected = options[Number(index)] || selected;
      }
      value = selected ? this.readSpecificPin(instance, selected, stack) : null;
    } else if (node.kind === 'callFunction' || node.kind === 'createWidget' || node.kind === 'getSubsystem') {
      const result = instance.internal.has(`result:${node.id}`)
        ? instance.internal.get(`result:${node.id}`)
        : this.invoke(instance, node, { steps: 0 }, stack)?.value;
      const outputName = normalized(outputPin);
      if (result && typeof result === 'object' && !Array.isArray(result)) {
        const resultEntry = Object.entries(result).find(([key]) => normalized(key) === outputName);
        value = resultEntry ? resultEntry[1] : result;
      } else value = result;
    }
    stack.delete(stackKey);
    return value;
  }

  readSpecificPin(instance, pin, stack = new Set()) {
    const source = (pin.links || [])[0];
    return source ? this.evaluate(instance, source.node, source.pin, stack) : parseBlueprintValue(pin.default, pin.category);
  }

  collectArgs(instance, node, stack = new Set()) {
    const args = {};
    for (const pin of inputPins(node)) {
      if (normalized(pin.name) === 'self' && !(pin.links || []).length) continue;
      args[normalized(pin.name)] = this.readSpecificPin(instance, pin, stack);
    }
    return args;
  }

  invoke(instance, node, context, stack = new Set()) {
    const name = normalized(node.function);
    const args = this.collectArgs(instance, node, stack);
    const values = Object.values(args);

    if (node.pure) {
      if (name.startsWith('add')) return { value: binary(args, (a, b) => a + b) };
      if (name.startsWith('subtract')) return { value: binary(args, (a, b) => a - b) };
      if (name.startsWith('multiply')) return { value: binary(args, (a, b) => a * b) };
      if (name.startsWith('divide')) return { value: binary(args, (a, b) => b === 0 ? 0 : a / b) };
      if (name.startsWith('greaterorequal')) return { value: binary(args, (a, b) => a >= b) };
      if (name.startsWith('lessorequal')) return { value: binary(args, (a, b) => a <= b) };
      if (name.startsWith('greater')) return { value: binary(args, (a, b) => a > b) };
      if (name.startsWith('less')) return { value: binary(args, (a, b) => a < b) };
      if (name.startsWith('notequal')) return { value: binary(args, (a, b) => a !== b) };
      if (name.startsWith('equalequal')) return { value: binary(args, (a, b) => a === b) };
      if (name.includes('booleanand') || name === 'andandboolbool') return { value: binary(args, (a, b) => Boolean(a && b)) };
      if (name.includes('booleanor') || name === 'ororboolbool') return { value: binary(args, (a, b) => Boolean(a || b)) };
      if (name.startsWith('not')) return { value: !Boolean(args.a ?? values[0]) };
      if (name.startsWith('clamp')) return { value: Math.min(args.max ?? values[2], Math.max(args.min ?? values[1], args.value ?? values[0])) };
      if (name.startsWith('abs')) return { value: Math.abs(args.a ?? values[0]) };
      if (name.startsWith('lerp')) return { value: (args.a ?? values[0]) + ((args.b ?? values[1]) - (args.a ?? values[0])) * (args.alpha ?? values[2]) };
    }

    if (name === 'delay' || name.endsWith('delay')) {
      const duration = Number(args.duration ?? values[0] ?? 0);
      setTimeout(() => this.runOutput(instance, node, ['completed', 'then']), Math.max(0, duration * 1000));
      return { latent: true };
    }
    if (name === 'printstring' || name === 'printtext') {
      const message = String(args.instring ?? args.intext ?? values[0] ?? '');
      this.logger(message, instance);
      this.adapter.print?.(message, instance);
      return { value: null };
    }

    const adapterFunction = node.kind === 'delegate' ? 'BroadcastDelegate'
      : node.kind === 'interfaceCall' ? 'ExecuteInterface'
        : node.function;
    const adapterArgs = node.kind === 'delegate' ? { ...args, event: node.function }
      : node.kind === 'interfaceCall' ? { ...args, functionname: node.function }
        : args;
    const adapterResult = this.adapter.call?.(adapterFunction, adapterArgs, instance);
    if (adapterResult?.handled) {
      if (adapterResult.promise) {
        adapterResult.promise.then((value) => {
          instance.internal.set(`result:${node.id}`, value);
          this.runOutput(instance, node, ['completed', 'then', 'success']);
        }).catch((error) => {
          instance.internal.set(`result:${node.id}`, error);
          this.report('error', instance, node, `Async action failed: ${error.message || error}`);
          this.runOutput(instance, node, ['failed', 'then']);
        });
        return { handled: true, latent: true };
      }
      return adapterResult;
    }

    const fallbackName = normalized(node.webFallbackFunction || node.function);
    const entry = instance.functionEntries.get(fallbackName);
    if (entry) {
      instance.eventArgs.set(entry.id, args);
      const functionContext = { steps: context?.steps || 0, didReturn: false, returnValue: null };
      this.runOutputWithContext(instance, entry, ['then'], functionContext);
      if (context) context.steps = functionContext.steps;
      if (node.webFallbackReturnsValue && !functionContext.didReturn) {
        this.report('error', instance, node, `Blueprint web fallback ${node.webFallbackFunction} did not reach a Function Result node synchronously.`);
      }
      return { handled: true, value: functionContext.didReturn ? functionContext.returnValue : null };
    }
    this.report('warning', instance, node, `Unsupported Blueprint function ${node.function}; execution continues.`);
    return { value: null };
  }

  applyReplicatedState(programName, actorName, variable, value) {
    const programKey = normalized(programName);
    const actorKey = normalized(actorName);
    for (const instance of this.instances) {
      if (normalized(instance.program.name) !== programKey || normalized(instance.actor.objectName) !== actorKey) continue;
      instance.state[variable] = value;
      this.emit(instance, [`onrep${normalized(variable)}`], { value });
    }
  }

  report(level, instance, node, message) {
    const key = `${level}:${instance.program.name}:${node?.id || ''}:${message}`;
    if (this.diagnostics.some((entry) => entry.key === key)) return;
    const entry = { key, level, blueprint: instance.program.name, actor: instance.actor.label || instance.actor.objectName, node: node?.title, message };
    this.diagnostics.push(entry);
    this.adapter.diagnostic?.(entry);
  }
}
