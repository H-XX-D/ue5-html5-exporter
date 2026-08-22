# Runtime adapters

The exporter serializes Blueprint graphs and supporting assets into `logic/blueprints.json`. The browser VM executes the graph while `BrowserRuntimeAdapters` translates Unreal-facing calls into portable browser and Three.js behavior.

This is a compatibility runtime, not Unreal Engine running in WebAssembly. A reported adapter-supported node means the browser has a defined implementation; it does not promise bit-for-bit engine parity.

## Enhanced Input

Legacy project mappings and every `UInputMappingContext` asset are exported. Enhanced mappings retain context, action, key, value type, modifier class names, and trigger class names. The browser emits `Started`, `Triggered`, and `Completed`; Negate modifiers are applied. Blueprint calls to `AddMappingContext` and `RemoveMappingContext` activate or deactivate a context.

Complex chord, hold, combo, dead-zone, and custom trigger semantics need a project adapter.

## Replication and RPCs

Blueprint properties carrying `CPF_Net` are marked replicated. Changes are synchronized between tabs with `BroadcastChannel`. Add this optional field to the exported IR to use a server transport:

```json
{
  "network": { "websocketUrl": "wss://game.example/ws" }
}
```

Messages use `property` and `rpc` envelopes. Function names beginning with `Server`, `Client`, or `Multicast` are transported as RPC-style calls. A production server must authenticate clients, enforce ownership/authority, validate payloads, and decide routing. This adapter does not reproduce Unreal's replication graph, relevancy, prediction, rollback, or serialization protocol.

## Interfaces and delegates

Interface messages dispatch to the target actor's exported event/function. Delegate and broadcast nodes use `runtimeAdapters.events`:

```js
const unsubscribe = window.UE5HTML5.adapters.events.on('OnDamaged', ({ args, instance }) => {
  console.log(instance.actor.objectName, args);
});
```

## Latent and async operations

The runtime supports `Delay`, timers by function name, async JSON requests, async asset fetches, and `MoveComponentTo`. Promise-backed adapters resume `Completed`/`Success` or `Failed` execution pins. Register additional latent operations using the same custom-function bridge described below and return a Promise.

## Physics and collision

`SetSimulatePhysics`, `SetEnableGravity`, linear velocity, force, and impulse calls drive a lightweight kinematic integrator in Three.js coordinates. Actor/component begin/end overlap and hit-style events are produced from world-space mesh bounding boxes.

This is suitable for interaction prototypes. It is not Chaos: shapes, constraints, mass, friction, restitution, sweep resolution, sub-stepping, and deterministic networking require a dedicated physics engine adapter such as Rapier or Ammo.

## Gameplay Ability System

The GAS adapter provides loose gameplay tags, numeric attributes, simple additive effect modifiers, cooldowns, and `TryActivateAbility` results. Ability tasks, prediction keys, stacking policies, cues, replication, and authoritative validation are project-level extensions.

## AI and Behavior Trees

Behavior Tree assets are exported recursively with editable node properties. The browser scheduler executes Wait leaves directly and emits other leaf nodes as Blueprint events. `RunBehaviorTree` starts a serialized tree for an actor.

Composite policy is currently flattened in asset order. Decorators, services, blackboard observers, abort modes, EQS, navigation, and perception need dedicated implementations.

## UMG

Widget Blueprint trees and editable widget properties are exported. `CreateWidget` resolves the exported definition and creates DOM for common panels, text, images, and buttons. `AddToViewport`, `RemoveFromParent`, `SetText`, `SetVisibility`, and `SetPercent` are bridged. A button emits `OnClicked_<WidgetName>` into the Blueprint runtime.

Exact anchors, slots, DPI scaling, font/material rendering, animation timelines, accessibility behavior, and custom Slate widgets require web styling or components.

## Niagara and Cascade

`SpawnSystem*` and `SpawnEmitter*` create a bounded Three.js point system. Activate, reset, and deactivate calls are supported. The fallback preserves gameplay flow and a visible effect, but it does not execute Niagara graphs, modules, data interfaces, GPU simulations, or renderer-specific materials.

## User C++ replacements

Native C++ cannot be translated safely from compiled Unreal modules. Register a JavaScript implementation before or after the scene loads:

```js
window.UE5HTML5.registerFunction('NativeApplyDamage', ({ target, amount }, instance, runtime) => {
  const next = Math.max(0, Number(instance.state.Health || 0) - Number(amount || 0));
  instance.state.Health = next;
  return next;
});

window.UE5HTML5.registerFunction('NativeLoadProfile', async ({ url }) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
});
```

The function name is normalized, so spaces, underscores, and case do not affect lookup. A returned Promise is treated as a latent action.

## Extension point

The main browser API is:

```js
window.UE5HTML5.call('OpenDoor', 'BP_Door_C_0', { speed: 2 });
window.UE5HTML5.registerFunction('ProjectSpecificNode', implementation);
window.UE5HTML5.runtime;
window.UE5HTML5.adapters;
```

Unsupported nodes remain in the IR with their original class, title, GUID, graph coordinates, typed pins, defaults, and links. That makes project adapters additive: the Unreal project does not need to be exported through a lossy intermediate representation again.
