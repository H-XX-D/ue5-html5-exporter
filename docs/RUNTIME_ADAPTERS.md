# Runtime adapters

The exporter serializes Blueprint graphs and supporting assets into `logic/blueprints.json`. The browser VM executes the graph while `BrowserRuntimeAdapters` translates Unreal-facing calls into portable browser and Three.js behavior.

This is a compatibility runtime, not Unreal Engine running in WebAssembly. A reported adapter-supported node means the browser has a defined implementation; it does not promise bit-for-bit engine parity.

## Enhanced Input

Legacy project mappings and every `UInputMappingContext` asset are exported. Enhanced mappings retain context, action, key, value type, mapping-level modifiers/triggers, and the modifiers/triggers inherited from the `UInputAction` asset. Trigger metadata includes actuation, Hold, Tap, and Pulse thresholds plus one-shot/start/limit settings.

Keyboard and standard gamepad mappings share one frame-driven trigger evaluator. Default/Down, Pressed, Released, Hold, Hold-and-Release, Tap, and Pulse mappings emit the corresponding `Started`, `Ongoing`, `Triggered`, `Canceled`, and `Completed` Blueprint execution phases. The exported action value also includes `Elapsed Seconds` and `Triggered Seconds`. Blueprint calls to `AddMappingContext` and `RemoveMappingContext` activate or deactivate a context and complete any active mapping cleanly.

The runtime polls the browser's standard Gamepad API on every frame. UE face buttons, shoulders, triggers, special buttons, thumbstick clicks, D-pad buttons, `Gamepad_Left2D`, `Gamepad_Right2D`, component axes, and stick-direction keys map to the standard browser layout. Browser-positive-down stick Y is converted to UE-positive-up, disconnected devices emit `Completed`, and exported `InputModifierDeadZone` mappings receive a radial 0.2 dead zone. When several controllers are connected, each mapping uses the controller with the strongest current value.

Negate, Swizzle, and the default radial Dead Zone are portable. Custom dead-zone/scalar parameters, Chorded Action dependencies, Combo/Repeated Tap, blockers, trigger-priority edge cases, and custom modifier/trigger classes still need a project adapter.

## Desktop and mobile first-person input

When the exported game mode resolves to a Character with a Camera component, the viewer supplies a first-person controller using the Character Movement, capsule, camera, and Player Start defaults exported from Unreal. Desktop retains pointer-lock mouse look, keyboard movement, jump, and fire.

Touch-capable devices automatically receive a virtual movement stick, drag-to-look surface, Jump button, and Fire button. The controls respect Discord and browser safe-area insets, use Pointer Events so they work across current mobile browsers, and do not request pointer lock. Exported Blueprint calls to `ShouldUseTouchControls` use the same coarse-pointer/touch-capability decision as the generated controller.

The controller first dispatches the stock UE5 First Person events `Primary Thumbstick`, `Secondary Thumbstick`, `Touch Jump Start`, and `Touch Jump End` into the exported Blueprint VM, including `Axis`, `Axis_X`, and `Axis_Y` values. When a project implements one of those events, its Blueprint branch owns the behavior. When it does not, the controller uses its built-in portable fallback. This prevents the Blueprint and fallback paths from applying movement or look input twice.

This automatic layer makes the standard UE5 first-person template playable without authoring a second web UI. Project-specific gestures, remappable mobile layouts, controller-remapping UI, haptics, and complex Enhanced Input trigger semantics still require a project adapter.

## Discord display and mobile lifecycle

Blueprints implementing `UE5 HTML5 Discord Activity Listener` receive Discord's thermal-state, screen-orientation, and Activity-layout updates as ordinary interface events. The adapter normalizes each payload into the SDK integer plus a readable state name and broadcasts it to every exported Blueprint instance that implements the corresponding event.

The `Set Orientation Lock`, `Set Interactive PiP`, `Get Platform Behaviors`, and `Get Locale` Blueprint nodes call the Embedded App SDK after export and return safe unavailable values during native Unreal play. Optional SDK commands and event subscriptions emit a warning and remain non-fatal on older Discord clients.

## Discord multiplayer events

The same `UE5 HTML5 Discord Activity Listener` interface receives `Broadcast Received`, `Presence Changed`, `Participants Changed`, and `Verified Entitlements Changed`. Initial Presence, participants, and entitlements are emitted when the authenticated Activity attaches, followed by live updates. Broadcast includes the event name, JSON payload, and Supabase replay flag. Participant and entitlement events include JSON plus a count for simple Blueprint branches.

Broadcast uses the authenticated private Activity topic and is appropriate for game input, lobby state, and transient notifications. Presence uses an opaque random connection key with only `{ connected: true }` and is intended for slow online/offline state, not per-frame position updates. Entitlement events contain the Vercel API's reduced, server-verified SKU view rather than trusting Discord's client event as authority.

These event payloads are transient. The runtime does not write participant identity, Presence, Broadcast messages, or entitlements to local storage or Supabase. A project can explicitly save game-created state through the separate world/player save nodes.

## Discord lifecycle events

The listener interface emits `Connection State Changed`, `Ready`, `Unavailable`, `Error`, and `Warning` so a Blueprint can drive its loading, retry, offline, and optional-feature UI without polling JavaScript. The initial state is delivered after Blueprint `BeginPlay`; live transitions remain immediate. A transition to `Ready` also emits the initial Presence, participant, and verified-entitlement snapshots once per bridge attachment; this works even when the Blueprint runtime attached while authentication was still in progress.

Diagnostics follow a strict privacy boundary. The bridge forwards normalized state/reason/error/command codes and fixed messages only. Raw SDK error objects, response bodies, stack traces, access tokens, user identifiers, private Realtime topics, and Supabase details stay out of Blueprint event arguments and are never persisted by this adapter.

### Local Blueprint preview

**Tools → HTML5 Export → Export & Preview Discord Blueprint Logic** creates a disposable export under the Unreal project's `Saved` directory and launches it on `127.0.0.1` with `?ue5_discord_preview=1`. That flag is ignored on non-loopback hosts. The browser uses Discord's packaged `DiscordSDKMock`, a synthetic **Mock Player**, looped-back Broadcast events, mock purchase entitlements, and browser-local world/player state with the same optimistic revision checks as production. No Discord, Vercel, Supabase, OAuth, raw player identity, or billing system is contacted.

This preview shortens Blueprint iteration; it is not a Discord emulator or a release certificate. Real proxy URL mapping, authentication, Activity-instance membership, Supabase Realtime, mobile layouts, purchases, and two-client behavior must still pass the hosted workflow.

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
