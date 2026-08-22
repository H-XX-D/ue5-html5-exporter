function normalized(value) {
  return String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function vector(value = {}) {
  return {
    x: Number(value.x ?? 0) / 100,
    y: Number(value.z ?? 0) / 100,
    z: -Number(value.y ?? 0) / 100,
  };
}

export class ThreeBlueprintAdapter {
  constructor(root, hooks = {}) {
    this.root = root;
    this.hooks = hooks;
  }

  findActor(actor) {
    const wanted = [actor.objectName, actor.label, actor.path].map(normalized).filter(Boolean);
    let result = null;
    this.root?.traverse((object) => {
      if (!result && wanted.includes(normalized(object.name))) result = object;
    });
    return result;
  }

  print(message, instance) {
    this.hooks.print?.(message, instance);
  }

  diagnostic(entry) {
    this.hooks.diagnostic?.(entry);
  }

  call(functionName, args, instance) {
    const name = normalized(functionName);
    const target = args.target || args.self || instance.object;
    if (!target) return { handled: false };

    if (name === 'setactorlocation' || name === 'k2setactorlocation') {
      const next = vector(args.newlocation || args.location);
      target.position.set(next.x, next.y, next.z);
      return { handled: true, value: true };
    }
    if (name === 'addactorworldoffset' || name === 'k2addactorworldoffset' || name === 'addactorlocaloffset') {
      const offset = vector(args.deltalocation || args.offset);
      target.position.x += offset.x;
      target.position.y += offset.y;
      target.position.z += offset.z;
      return { handled: true, value: true };
    }
    if (name === 'setactorrotation' || name === 'k2setactorrotation') {
      const rotation = args.newrotation || args.rotation || {};
      target.rotation.set(
        Number(rotation.roll || 0) * Math.PI / 180,
        Number(rotation.yaw || 0) * Math.PI / 180,
        -Number(rotation.pitch || 0) * Math.PI / 180,
      );
      return { handled: true, value: true };
    }
    if (name === 'setactorscale3d') {
      const scale = args.newscale3d || args.scale || {};
      target.scale.set(Number(scale.x ?? 1), Number(scale.z ?? 1), Number(scale.y ?? 1));
      return { handled: true };
    }
    if (name === 'setactorhiddeningame' || name === 'setvisibility') {
      target.visible = !(args.bnewhidden ?? args.newhidden ?? false) && (args.bnewvisibility ?? args.newvisibility ?? true);
      return { handled: true };
    }
    if (name === 'destroyactor') {
      target.removeFromParent();
      return { handled: true };
    }
    if (name === 'getactorlocation' || name === 'k2getactorlocation') {
      return { handled: true, value: { x: target.position.x * 100, y: -target.position.z * 100, z: target.position.y * 100 } };
    }
    if (name === 'getactorscale3d') {
      return { handled: true, value: { x: target.scale.x, y: target.scale.z, z: target.scale.y } };
    }
    return { handled: false };
  }
}
