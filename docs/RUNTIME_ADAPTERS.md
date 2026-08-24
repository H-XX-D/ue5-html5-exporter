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

## Discord social sharing

`Choose And Share Image` is a single user-initiated Blueprint operation. Discord opens its own file picker, uploads the selected image to an ephemeral Discord CDN URL, and opens the share-moment dialog. The exporter never receives the image bytes, never returns the URL to Blueprint, and does not persist either one. The operation needs no additional OAuth scope and returns `false` with a recoverable warning when the connected Discord client does not support either SDK command.

## First-person target practice

`UE5 HTML5 Practice Target` is a ready-to-place cube actor, while `UE5 HTML5 Target` is a Blueprint-spawnable component for existing actors. The graph exporter writes the placed actor identity plus health, per-shot damage, score, hit-flash time, and respawn policy under `gameplay.targets`. The browser binds each definition to the matching glTF actor label/name, applies the existing center-screen raycast, and owns only the local target-range state and HUD.

The component exposes `Apply Target Practice Damage`, `On Target Hit`, `On Target Depleted`, and `On Target Respawned` so the same values can drive native Unreal play. Browser fallback fire automatically drives the exported target contract and also continues to raise the normal `IA_Shoot` Blueprint input event. Only bound targets contribute to the active/depleted counts. If the HUD begins at `Targets 0/1`, the metadata exported but its visible glTF actor did not bind; save the level, confirm a unique Actor Label on the mesh-owning actor, and export again. Ordinary scene geometry never becomes a scoring target.

This is a convenience adapter for prototypes, training ranges, and cooperative Activity games. Browser hit results are client-controlled and must not be treated as authoritative competitive combat without a project-owned server validation adapter.

### Local Blueprint preview

**Tools → HTML5 Export → Export & Preview Discord Blueprint Logic** creates a disposable export under the Unreal project's `Saved` directory and launches it on `127.0.0.1` with `?ue5_discord_preview=1`. That flag is ignored on non-loopback hosts. The browser uses Discord's packaged `DiscordSDKMock`, a synthetic **Mock Player**, looped-back Broadcast events, mock purchase entitlements, and browser-local world/player state with the same optimistic revision checks as production. No Discord, Vercel, Supabase, OAuth, raw player identity, or billing system is contacted.

Generated games expose **Logic → Keep this game downloaded**. Its button calls the standard browser persistent-storage request only after a player click. A grant protects the Activity origin's verified asset cache and game-created local saves from automatic eviction; denial, unsupported browsers, and API errors retain normal Cache API plus network fallback behavior. Cache API resources are keyed by their verified SHA-256 identity, so unchanged scene, Blueprint, and audio bytes can be reused after a later Unreal export even though the full pack version changed. The adapter does not inspect quota, enumerate unrelated storage, or treat a grant as a native Discord installation.

This preview shortens Blueprint iteration; it is not a Discord emulator or a release certificate. Real proxy URL mapping, authentication, Activity-instance membership, Supabase Realtime, mobile layouts, purchases, and two-client behavior must still pass the hosted workflow.

## Replication and RPCs

Blueprint properties carrying `CPF_Net` are marked replicated. Function calls whose names begin with `Server`, `Client`, or `Multicast` are transported as RPC-style calls. Inside a configured Discord Activity, both automatically use the authenticated private Supabase Broadcast topic that the Activity bridge has already joined. Unreal developers do not need to add separate Discord Broadcast nodes for those portable replication frames.

The same messages also use `BroadcastChannel` for same-origin tabs and can use an explicit WebSocket fallback. Add this optional field to the exported IR for a project-owned server transport:

```json
{
  "network": { "websocketUrl": "wss://game.example/ws" }
}
```

Activity replication uses the reserved `__ue5html5_replication_v1` event and `ue5-html5-replication/v1` JSON envelope. Frames are limited to 64 KiB, must contain bounded program/actor/member identifiers, reject cyclic or non-JSON arguments, deduplicate across simultaneous Activity/BroadcastChannel/WebSocket delivery, and never enter the public `Discord Activity Broadcast Received` Blueprint event. The exporter adds no Discord identity, email, billing, profile, or device fields. Frames are transient and are not written to local storage or Supabase tables.

Private Realtime must be configured for cross-device delivery. The exporter detects any replicated property or invoked `Server*`, `Client*`, or `Multicast*` call, declares `SUPABASE_JWT_PRIVATE_KEY` in the handoff, and makes the guided release print the required `/supabase` mapping. Package preflight derives the same rule from `logic/blueprints.json` and rejects a stale declaration. Without Realtime the runtime can still use local-tab and optional WebSocket delivery, but the Discord release workflow will not certify that configuration when Unreal-authored replication requires it. This is a client-authored compatibility transport, not Unreal server authority. A production competitive game must authenticate clients, enforce actor ownership, validate RPC arguments and state changes, and decide routing in a trusted project adapter. This layer does not reproduce Unreal's replication graph, relevancy, prediction, rollback, dormancy, conditions, or serialization protocol.

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

## Audio

Direct mono/stereo `SoundWave` assets referenced by exported Blueprint pin defaults or Blueprint object variables are written to `assets/audio/*.wav` and indexed under `audioAssets` in `logic/blueprints.json`. The files enter the same SHA-256 asset-pack manifest as the scene and logic data, so playback consumes verified cached bytes when available and retains the normal network fallback.

Blueprint **Play Sound 2D** and **Play Sound at Location** calls use one shared browser Web Audio context. Volume multiplier, pitch multiplier, and start time are retained. The Blueprint execution wire continues immediately, matching the fire-and-forget UE nodes; audio download and decoding finish asynchronously. Browser autoplay policy can suspend sound until the first pointer, keyboard, or touch action, and the runtime resumes the context from that user gesture. Failure to unlock, download, decode, or play audio produces a warning without stopping gameplay.

This first portable contract deliberately excludes Sound Cues, MetaSounds, procedural sources, sound classes/mixes, attenuation assets, concurrency rules, submix/DSP graphs, capture, and exact Unreal spatialization. **Play Sound at Location** converts the authored Unreal location from centimeters into the exported Three.js coordinate system, uses a Web Audio HRTF panner, and updates the listener from the active camera. It falls back to 2D playback when the browser has no panner. The portable inverse-distance curve is not Unreal attenuation-asset parity, so use a project adapter when exact falloff, occlusion, cones, or spatialization settings are gameplay-significant. Test voice-call coexistence, levels, and mobile autoplay behavior in real Discord clients before release.

## User C++ replacements

Native C++ cannot be translated safely from compiled Unreal modules. For an impure synchronous C++ call, including one with connected data output pins, first use the Blueprint-only fallback convention:

1. Keep the existing C++ call, for example `NativeApplyDamage`, in the graph.
2. Choose **Tools → HTML5 Export → Create Blueprint Web Fallback Drafts…**. The plugin creates `Web_NativeApplyDamage` in the same Blueprint and copies the native call's input and output pin names and types.
3. Rebuild the portable behavior with ordinary supported Blueprint nodes and set every required output on the generated Function Result. The large orange `UE5HTML5 DRAFT FALLBACK` comment deliberately keeps the original call uncovered during this work.
4. Test the Blueprint, delete that comment, and run **Check Blueprint Web Compatibility…**. The call should now be reported as Blueprint-fallback-covered rather than unsupported.

Draft creation is explicit, transactional, undoable, and does not save Blueprint assets automatically. Repeated runs do not duplicate an existing draft. The compatibility IR labels eligible uncovered calls with `repairKind: "blueprint-fallback-draft"` and `suggestedBlueprintFunction`; package preflight independently checks the candidate count carried by the manifest and handoff. The exporter writes `webFallbackFunction: "Web_NativeApplyDamage"` only after the marker is removed and adds `webFallbackReturnsValue` when the original execution-flow call consumes an output. The browser passes the original inputs into the exported fallback, captures its Function Result values, caches them on the original call node, and only then follows the caller's execution wire. A missing synchronous Function Result is a runtime error rather than a silent default. No generated web file or JavaScript is edited. Pure functions, exact C++ semantics, native libraries, operating-system APIs, and behavior that cannot complete synchronously still need a JavaScript project adapter.

For those remaining cases, choose **Tools → HTML5 Export → Open Custom Web Adapters Folder**. The plugin creates two source-controlled project files:

- `Config/UE5HTML5/custom-adapters.json` declares the exact Unreal function names covered by project code.
- `Config/UE5HTML5/custom-adapters.js` registers their browser implementations.

For example, declare the functions:

```json
{
  "schema": "ue5-html5-custom-adapters/v1",
  "functions": ["NativeApplyDamage", "NativeLoadProfile"]
}
```

Then implement the same names:

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

Every audit and full export copies both files to `logic/`. Declared calls are labeled `supportSource: "project-adapter"`; built-in calls and uncovered calls remain distinct. The browser imports the module before constructing the Blueprint VM and stops with a visible error if a declaration did not register. Static coverage and successful registration prove only that the bridge is connected—not that its gameplay semantics are correct—so the handoff records `unreal-export-needs-runtime-validation` for the release operator to resolve with preview and gameplay testing.

## Extension point

The main browser API is:

```js
window.UE5HTML5.call('OpenDoor', 'BP_Door_C_0', { speed: 2 });
window.UE5HTML5.registerFunction('ProjectSpecificNode', implementation);
window.UE5HTML5.runtime;
window.UE5HTML5.adapters;
window.UE5HTML5.projectAdapters;
window.UE5HTML5.projectAdaptersReady;
```

Unsupported nodes remain in the IR with their original class, title, GUID, graph coordinates, typed pins, defaults, and links. That makes project adapters additive: the Unreal project does not need to be exported through a lossy intermediate representation again.
