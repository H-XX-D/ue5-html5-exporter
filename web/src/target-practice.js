function normalizeName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function targetDefinition(raw, index) {
  return {
    id: String(raw?.id || `target-${index + 1}`),
    label: String(raw?.label || raw?.objectName || `Target ${index + 1}`),
    objectName: String(raw?.objectName || ''),
    maxHealth: Math.max(1, Math.round(Number(raw?.maxHealth || 1))),
    damagePerShot: Math.max(1, Math.round(Number(raw?.damagePerShot || 1))),
    scoreValue: Math.max(0, Math.round(Number(raw?.scoreValue || 0))),
    respawn: raw?.respawn !== false,
    respawnDelaySeconds: Math.max(0.05, Number(raw?.respawnDelaySeconds || 2)),
    hitFlashSeconds: Math.max(0, Number(raw?.hitFlashSeconds || 0)),
  };
}

export class TargetPracticeRuntime {
  constructor(world, definitions = [], hooks = {}) {
    this.world = world;
    this.hooks = hooks;
    this.schedule = hooks.schedule || ((callback, delay) => setTimeout(callback, delay));
    this.cancelSchedule = hooks.cancelSchedule || ((handle) => clearTimeout(handle));
    this.targets = [];
    this.objectTargets = new WeakMap();
    this.score = 0;
    this.disposed = false;

    const objectsByName = new Map();
    world?.traverse?.((object) => {
      const name = normalizeName(object?.name);
      if (!name) return;
      const objects = objectsByName.get(name) || [];
      objects.push(object);
      objectsByName.set(name, objects);
    });

    for (const [index, raw] of Array.from(definitions || []).entries()) {
      const definition = targetDefinition(raw, index);
      const aliases = new Set([
        normalizeName(definition.label),
        normalizeName(definition.objectName),
      ].filter(Boolean));
      const objects = new Set();
      for (const alias of aliases) {
        for (const object of objectsByName.get(alias) || []) objects.add(object);
      }
      const state = {
        ...definition,
        health: definition.maxHealth,
        depleted: false,
        objects,
        baseScales: new Map(Array.from(objects, (object) => [object, object.scale?.clone?.()])),
        baseVisibility: new Map(Array.from(objects, (object) => [object, object.visible])),
        flashTimer: null,
        respawnTimer: null,
      };
      this.targets.push(state);
      for (const object of objects) this.objectTargets.set(object, state);
    }
    this.emitState('ready');
  }

  get enabled() {
    return this.targets.length > 0;
  }

  snapshot(reason = 'update', target = null) {
    return {
      reason,
      score: this.score,
      configuredTargets: this.targets.length,
      boundTargets: this.targets.filter((state) => state.objects.size > 0).length,
      activeTargets: this.targets.filter((state) => state.objects.size > 0 && !state.depleted).length,
      depletedTargets: this.targets.filter((state) => state.objects.size > 0 && state.depleted).length,
      target: target ? {
        id: target.id,
        label: target.label,
        health: target.health,
        maxHealth: target.maxHealth,
        depleted: target.depleted,
      } : null,
    };
  }

  emitState(reason, target = null) {
    const snapshot = this.snapshot(reason, target);
    this.hooks.state?.(snapshot);
    return snapshot;
  }

  resolveTarget(hit) {
    for (let object = hit?.object; object; object = object.parent) {
      const target = this.objectTargets.get(object);
      if (target) return target;
    }
    return null;
  }

  flash(target) {
    if (target.hitFlashSeconds <= 0) return;
    if (target.flashTimer !== null) this.cancelSchedule(target.flashTimer);
    for (const [object, baseScale] of target.baseScales) {
      if (baseScale && object.scale?.copy) object.scale.copy(baseScale).multiplyScalar(0.94);
    }
    target.flashTimer = this.schedule(() => {
      target.flashTimer = null;
      for (const [object, baseScale] of target.baseScales) {
        if (baseScale && object.scale?.copy) object.scale.copy(baseScale);
      }
    }, target.hitFlashSeconds * 1000);
  }

  applyHit(hit) {
    if (this.disposed) return null;
    const target = this.resolveTarget(hit);
    if (!target || target.depleted) return null;

    target.health = Math.max(0, target.health - target.damagePerShot);
    this.flash(target);
    let scoreDelta = 0;
    if (target.health === 0) {
      target.depleted = true;
      scoreDelta = target.scoreValue;
      this.score += scoreDelta;
      for (const object of target.objects) object.visible = false;
      if (target.respawn) {
        target.respawnTimer = this.schedule(() => this.respawn(target), target.respawnDelaySeconds * 1000);
      }
    }

    const state = this.emitState(target.depleted ? 'depleted' : 'hit', target);
    const result = { ...state.target, scoreDelta, score: this.score };
    this.hooks.hit?.(result);
    if (target.depleted) this.hooks.depleted?.(result);
    return result;
  }

  respawn(target) {
    if (this.disposed || !target) return;
    target.respawnTimer = null;
    target.health = target.maxHealth;
    target.depleted = false;
    for (const [object, baseScale] of target.baseScales) {
      object.visible = target.baseVisibility.get(object) !== false;
      if (baseScale && object.scale?.copy) object.scale.copy(baseScale);
    }
    const state = this.emitState('respawned', target);
    this.hooks.respawned?.(state.target);
  }

  reset() {
    this.score = 0;
    for (const target of this.targets) {
      if (target.flashTimer !== null) this.cancelSchedule(target.flashTimer);
      if (target.respawnTimer !== null) this.cancelSchedule(target.respawnTimer);
      target.flashTimer = null;
      target.respawnTimer = null;
      target.health = target.maxHealth;
      target.depleted = false;
      for (const [object, baseScale] of target.baseScales) {
        object.visible = target.baseVisibility.get(object) !== false;
        if (baseScale && object.scale?.copy) object.scale.copy(baseScale);
      }
    }
    return this.emitState('reset');
  }

  dispose() {
    if (this.disposed) return;
    for (const target of this.targets) {
      if (target.flashTimer !== null) this.cancelSchedule(target.flashTimer);
      if (target.respawnTimer !== null) this.cancelSchedule(target.respawnTimer);
      for (const [object, baseScale] of target.baseScales) {
        object.visible = target.baseVisibility.get(object) !== false;
        if (baseScale && object.scale?.copy) object.scale.copy(baseScale);
      }
    }
    this.disposed = true;
  }
}
