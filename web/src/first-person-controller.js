import * as THREE from 'three';
import { Capsule } from 'three/addons/math/Capsule.js';
import { Octree } from 'three/addons/math/Octree.js';

export function unrealVectorToThree(value = {}) {
  return new THREE.Vector3(
    Number(value.x || 0) / 100,
    Number(value.z || 0) / 100,
    -Number(value.y || 0) / 100,
  );
}

export class FirstPersonController {
  constructor(camera, canvas, world, gameplay = {}, hooks = {}, eventTarget = globalThis.window) {
    this.camera = camera;
    this.canvas = canvas;
    this.world = world;
    this.gameplay = gameplay;
    this.hooks = hooks;
    this.eventTarget = eventTarget;
    this.document = canvas?.ownerDocument || globalThis.document;
    this.enabled = gameplay.profile === 'firstPerson';
    this.keys = new Set();
    this.velocity = new THREE.Vector3();
    this.pendingMovement = new THREE.Vector3();
    this.worldOctree = new Octree();
    this.raycaster = new THREE.Raycaster();
    this.handlers = [];
    this.onFloor = false;
    this.groundGrace = 0;

    const movement = gameplay.movement || {};
    this.moveSpeed = Math.max(0.1, Number(movement.maxWalkSpeed || 600) / 100);
    this.jumpVelocity = Math.max(0.1, Number(movement.jumpVelocity || 500) / 100);
    this.gravity = 9.8 * Math.max(0, Number(movement.gravityScale ?? 1));
    this.radius = Math.max(0.05, Number(movement.capsuleRadius || 42) / 100);
    this.halfHeight = Math.max(this.radius, Number(movement.capsuleHalfHeight || 96) / 100);
    const cameraRelativeHeight = Number(movement.cameraRelativeLocation?.z || 0);
    this.cameraHeight = (Math.abs(cameraRelativeHeight) > 1 ? cameraRelativeHeight : Number(movement.baseEyeHeight || 64)) / 100;
    this.start = unrealVectorToThree(gameplay.playerStart?.location);
    const rotation = gameplay.playerStart?.rotation || {};
    this.yaw = THREE.MathUtils.degToRad(Number(rotation.yaw || 0) - 90);
    this.pitch = THREE.MathUtils.degToRad(Number(rotation.pitch || 0));
    this.capsule = new Capsule();

    if (this.enabled) this.activate();
  }

  activate() {
    this.worldOctree.fromGraphNode(this.world);
    this.camera.fov = Number(this.gameplay.movement?.cameraFov || this.camera.fov);
    this.camera.near = Math.min(this.camera.near, 0.05);
    this.camera.updateProjectionMatrix();
    this.teleportToStart();
    this.bind();
    this.hooks.state?.({ enabled: true, locked: false });
  }

  bind() {
    const add = (target, type, listener, options) => {
      target?.addEventListener(type, listener, options);
      this.handlers.push([target, type, listener, options]);
    };
    add(this.eventTarget, 'keydown', (event) => {
      const code = event.code || event.key;
      this.keys.add(code);
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(code)) event.preventDefault();
      if (code === 'Space' && !event.repeat) this.jump();
    });
    add(this.eventTarget, 'keyup', (event) => this.keys.delete(event.code || event.key));
    add(this.canvas, 'click', () => {
      if (this.document?.pointerLockElement !== this.canvas) this.canvas?.requestPointerLock?.();
    });
    add(this.document, 'pointerlockchange', () => {
      this.hooks.state?.({ enabled: true, locked: this.document.pointerLockElement === this.canvas });
    });
    add(this.document, 'mousemove', (event) => {
      if (this.document.pointerLockElement !== this.canvas) return;
      this.addLookInput(event.movementX, -event.movementY);
    });
    add(this.canvas, 'mousedown', (event) => {
      if (event.button === 0 && this.document?.pointerLockElement === this.canvas) this.shoot();
    });
  }

  teleportToStart() {
    const bottom = this.start.y - this.halfHeight;
    this.capsule.start.set(this.start.x, bottom + this.radius, this.start.z);
    this.capsule.end.set(this.start.x, this.start.y + this.halfHeight - this.radius, this.start.z);
    this.velocity.set(0, 0, 0);
    this.updateCamera();
  }

  actorPosition() {
    return this.capsule.start.clone().add(this.capsule.end).multiplyScalar(0.5);
  }

  updateCamera() {
    const position = this.actorPosition();
    position.y += this.cameraHeight;
    this.camera.position.copy(position);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }

  forward() {
    const direction = new THREE.Vector3();
    this.camera.getWorldDirection(direction);
    direction.y = 0;
    return direction.lengthSq() ? direction.normalize() : direction.set(1, 0, 0);
  }

  right() {
    return this.forward().cross(this.camera.up).normalize().negate();
  }

  addMovementInput(direction, scale = 1) {
    const converted = direction?.isVector3 ? direction : unrealVectorToThree(direction);
    if (converted.lengthSq()) this.pendingMovement.addScaledVector(converted.normalize(), Number(scale || 0));
  }

  addLookInput(yaw, pitch = 0) {
    const sensitivity = 0.002;
    this.yaw += Number(yaw || 0) * sensitivity;
    this.pitch = THREE.MathUtils.clamp(this.pitch + Number(pitch || 0) * sensitivity, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
  }

  jump() {
    if (!this.onFloor && this.groundGrace <= 0) return false;
    this.velocity.y = this.jumpVelocity;
    this.onFloor = false;
    this.groundGrace = 0;
    return true;
  }

  shoot() {
    this.raycaster.setFromCamera({ x: 0, y: 0 }, this.camera);
    const hit = this.raycaster.intersectObject(this.world, true).find((entry) => !entry.object.userData.ue5HitMarker);
    if (hit) {
      const geometry = new THREE.SphereGeometry(0.035, 8, 6);
      const material = new THREE.MeshBasicMaterial({ color: 0xffc45c });
      const marker = new THREE.Mesh(geometry, material);
      marker.userData.ue5HitMarker = true;
      marker.position.copy(hit.point).addScaledVector(hit.face?.normal || new THREE.Vector3(0, 1, 0), 0.015);
      this.world.add(marker);
      setTimeout(() => {
        marker.removeFromParent();
        geometry.dispose();
        material.dispose();
      }, 180);
    }
    const payload = hit ? { point: hit.point.clone(), normal: hit.face?.normal?.clone(), object: hit.object } : null;
    this.hooks.shoot?.(payload);
    return payload;
  }

  collide() {
    const result = this.worldOctree.capsuleIntersect(this.capsule);
    this.onFloor = false;
    if (!result) return;
    this.onFloor = result.normal.y > 0;
    if (this.onFloor) this.groundGrace = 0.15;
    if (!this.onFloor) this.velocity.addScaledVector(result.normal, -result.normal.dot(this.velocity));
    else this.velocity.y = Math.max(0, this.velocity.y);
    this.capsule.translate(result.normal.multiplyScalar(result.depth));
  }

  update(delta) {
    if (!this.enabled) return;
    this.groundGrace = Math.max(0, this.groundGrace - delta);
    const forwardAxis = Number(this.keys.has('KeyW') || this.keys.has('ArrowUp')) - Number(this.keys.has('KeyS') || this.keys.has('ArrowDown'));
    const rightAxis = Number(this.keys.has('KeyD') || this.keys.has('ArrowRight')) - Number(this.keys.has('KeyA') || this.keys.has('ArrowLeft'));
    const movement = this.forward().multiplyScalar(forwardAxis).addScaledVector(this.right(), rightAxis).add(this.pendingMovement);
    this.pendingMovement.set(0, 0, 0);
    if (movement.lengthSq()) {
      movement.normalize().multiplyScalar(this.moveSpeed);
      this.velocity.x = movement.x;
      this.velocity.z = movement.z;
    } else {
      const damping = Math.exp(-12 * delta);
      this.velocity.x *= damping;
      this.velocity.z *= damping;
    }
    if (!this.onFloor) this.velocity.y -= this.gravity * delta;

    const steps = 4;
    for (let index = 0; index < steps; index += 1) {
      this.capsule.translate(this.velocity.clone().multiplyScalar(delta / steps));
      this.collide();
    }
    if (this.camera.position.y < -50) this.teleportToStart();
    this.updateCamera();
  }

  dispose() {
    for (const [target, type, listener, options] of this.handlers) target?.removeEventListener(type, listener, options);
    this.handlers = [];
    this.keys.clear();
  }
}
