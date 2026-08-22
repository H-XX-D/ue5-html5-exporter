# UE5 to HTML5 Exporter

A UE5 Editor plugin that turns a level—or selected actors—into a ready-to-host WebGL game. It uses Epic's glTF 2.0 exporter for scene conversion, exports Blueprint graphs to a typed JSON IR, and runs supported gameplay logic in a bundled browser VM.

> This is an incremental Blueprint converter, not an Unreal Engine runtime compiled to WebAssembly. Supported nodes execute in the browser; every unsupported graph node is retained in the IR and listed in the compatibility report so missing behavior is explicit.

## What you get

- **Tools → Export Level to HTML5…** in the Level Editor
- **Tools → Export Selection to HTML5…** for a smaller scene
- A self-contained `scene.glb`
- `logic/blueprints.json` containing event graphs, typed pins, links, variables, and actor bindings
- A browser Blueprint VM for gameplay flow plus adapters for Enhanced Input, replicated state/RPC transport, delegates/interfaces, latent tasks, physics events, GAS-style state, Behavior Trees, UMG, and particles
- Responsive WebGL viewer with orbit controls, animation playback, drag-and-drop GLB loading, progress, and errors
- `export-manifest.json` plus per-Blueprint/node compatibility warnings
- Commandlet support for CI or batch export
- Output that works on any static host
- Discord Activity Blueprint nodes plus automatic connection/error, multiplayer, participant, entitlement, layout/orientation/thermal events, Rich Presence/share-link discovery, verified Discord identity, Supabase Realtime, cross-device saves, and a ready-to-deploy Activity API (Vercel adapter included)
- A dry-run-first cross-platform release command that links the explicitly selected Supabase/Vercel projects, migrates, verifies, and deploys without printing server secrets
- Project Settings for shared non-secret Discord Application ID/public key, Vercel project, Supabase project ref, and production URL; Unreal blocks guided export until the required set is complete and release tooling refuses cross-project drift
- Content-hashed web bundles, Discord mobile safe areas, bounded API rate-limit handling, and optional signed proxy-request enforcement for production
- Automatic mobile FPS movement/look/jump/fire controls that execute the stock `Primary Thumbstick`, `Secondary Thumbstick`, `Touch Jump Start`, and `Touch Jump End` Blueprint branches before using a browser fallback
- A readiness chain that rejects incomplete Unreal targets, missing Discord launch commands, Vercel authentication redirects, iframe-blocking headers, missing Unreal manifests, and disabled Activity APIs before printing the portal checklist and URL mappings

## Build the plugin

Requirements: Node.js 22.12+, npm, and Unreal Engine 5.3 or newer with the built-in **glTF Exporter** plugin available.

```bash
npm install
npm run build
```

The web build is written into `UE5HTML5Exporter/Resources/WebTemplate`, where the Editor plugin packages it.

## Install in a UE5 project

1. Build the web template as shown above.
2. Install it without manually copying folders:

   ```bash
   npm run install:plugin -- --project "/path/to/YourGame.uproject" --source-only
   ```

   On Windows, teammates can instead use the source bundle's one-command doctor and installer. It discovers the matching Epic Launcher engine for the project and validates the compiler toolchain:

   ```powershell
   .\scripts\Setup-UE5HTML5Exporter.ps1 -Project "C:\Games\MyGame\MyGame.uproject"
   ```

3. Regenerate project files if your project uses C++.
4. Open the project. When prompted, enable/rebuild **UE5 to HTML5 Exporter** and **glTF Exporter**, then restart the Editor.
5. Open a level and use **Tools → HTML5 Export**.

The first compile must match your installed UE5 minor version. The plugin contains source, so Unreal Build Tool will build it for your engine.

For a redistributable native package, use `npm run package:plugin -- --engine "/path/to/UE_5.8" --platform Win64`. To make a portable source bundle that Unreal can compile for a teammate's installed engine, run `npm run package:source`. See [Team installation and Windows packaging](docs/TEAM_INSTALL.md).

## Preview an export

From the exported folder:

```bash
python3 serve.py
```

Then open [http://localhost:8000](http://localhost:8000). Do not double-click `index.html`; browser module and asset security rules require HTTP.

Deploy by uploading the entire output folder to S3/CloudFront, GitHub Pages, Netlify, Vercel, Cloudflare Pages, or any ordinary static web server.

For a Discord release, the export also contains a server-side Activity API, a default `vercel.json` deployment adapter, and the Supabase migration. Vercel is optional to Discord, but Supabase Storage is not used as the static HTML host. The frontend API URL can be changed with the `ue5-activity-api` meta tag in `index.html`. Double-click the exported `release-discord-activity.cmd` on Windows or `.command` on macOS (Linux uses the `.sh` launcher) for a pinned, self-installing, dry-run-first release assistant. Follow [Discord Activity release workflow](docs/DISCORD_ACTIVITY_WORKFLOW.md). Without server configuration, the same output stays in standalone website mode.

Inside an exported folder, the Windows, macOS, and Linux release launchers read public project identity directly from Unreal and print the complete release plan without an environment file. On `--apply`, the authenticated Supabase CLI discovers the project’s publishable and secret API keys in memory; remaining secrets use hidden prompts and reach Vercel through stdin. Nothing is written into a local env file. The equivalent manual command is `npm run release:activity -- --vercel-only-secrets --supabase-cli-keys`. Older exports without targets can add `--supabase-project-ref YOUR_REF --vercel-project YOUR_PROJECT`.

For the lowest-friction path, first choose **Tools → HTML5 Export → Discord Activity Project Settings…** and enter this game's public target identity. These values are saved in the Unreal project's `DefaultGame.ini`, so the same Discord/Vercel/Supabase targets follow the project across Windows, Linux, and macOS. Then choose **Export Discord Activity…**. Unreal now treats the target set as configured only when all four required public values are present; an incomplete set opens the same Project Settings page and names every missing field before export. The guided command reports exact supported/unsupported Blueprint-node counts and offers to start the operating system's release assistant directly from Unreal. The assistant opens in a terminal and remains dry-run-only until the release operator explicitly adds `--apply`; secrets never enter Unreal Project Settings. Every export includes `activity-handoff.json`; it says `unreal-export-complete` only when every exported Blueprint node is covered, otherwise it says `unreal-export-needs-blueprint-adapters` and points to the exact nodes in `logic/blueprints.json`. The release command reads the public targets from that handoff and rejects conflicting CLI arguments or environment identities.

Only public target identity belongs in Unreal Project Settings: Discord Application ID, Discord Public Key, Vercel Project Name, Supabase Project Ref, and an optional public production URL. The guided launcher retrieves Supabase API keys through the authenticated CLI, prompts without echo for Discord credentials and the intentionally imported Supabase signing JWK, and generates the Activity state secret in memory. Their application copies remain Vercel-only. Deployment and two-client checks also remain owned by the release operator.

## Discord nodes in Blueprint

Search the Blueprint palette for **UE5 HTML5 → Discord Activity**. The runtime module supplies nodes for readiness, Broadcast, the native invite dialog, display/orientation control, interactive picture-in-picture, locale/platform behavior, Rich Presence, Discord share links, HTTPS external links, non-personal launch campaign context, hardware acceleration, connected participants, Discord SKUs/purchases, server-verified entitlements, and atomic world/player load/save. They return safe unavailable/default values during native Unreal play and become asynchronous Discord SDK operations after HTML5 export.

Add the **UE5 HTML5 Discord Activity Listener** interface to a Blueprint to receive connection readiness, safe unavailable/error/warning diagnostics, multiplayer Broadcast messages, opaque Presence state, connected-participant changes, server-verified entitlement changes, and Discord display/mobile events without SDK code. Incoming data exists only in browser memory unless game logic explicitly saves it; the exporter does not create player profiles or persist participant identity.

State and Broadcast payloads are JSON strings. Save nodes accept an optional expected revision: leave it at `-1` for unconditional save, or pass the revision from the previous load/save to reject stale concurrent writes.

## Automated export

Use the Editor commandlet executable for your platform. Example on macOS:

```bash
UnrealEditor-Cmd \
  /absolute/path/MyGame.uproject \
  -run=UE5HTML5Export \
  -Map=/Game/Maps/Main \
  -Output=/absolute/path/web-export \
  -unattended -nop4
```

On Windows, use `UnrealEditor-Cmd.exe`.

## Compatibility

| UE content | Result |
|---|---|
| Static meshes and transforms | Exported |
| Skeletal meshes and current animation sequences | Exported when supported by Epic's glTF exporter |
| Standard PBR materials and textures | Converted/baked by Epic's exporter |
| Directional, point, and spot lights | Exported through glTF extensions |
| Cameras | Exported in the GLB; viewer initially frames the whole scene |
| Landscapes | Converted to scene geometry; large landscapes can be expensive |
| BeginPlay, Tick, custom Blueprint events | Converted |
| Branch, Sequence, Do Once, FlipFlop | Converted |
| Blueprint variables, literals, structs, common math/comparisons | Converted |
| Keyboard input nodes | Converted |
| Delay and Print String/Text | Converted |
| Actor location, offset, rotation, scale, visibility, destroy | Converted |
| Enhanced Input actions/mapping contexts | Exported; keyboard, standard browser gamepad, context activation, Input Action plus mapping-level triggers, common Pressed/Released/Hold/Hold-and-Release/Tap/Pulse timing, and stock First Person touch/thumbstick events run in-browser |
| Replicated properties and RPC-style calls | Browser transport adapter using BroadcastChannel or a configured WebSocket |
| Interfaces and delegates | Routed through the browser runtime/event bus |
| Timers, async asset/JSON fetch, Move Component To | Converted to browser async operations |
| Physics/collision | Lightweight force/impulse/gravity integration plus mesh-bounds overlap/hit events |
| Gameplay Ability System | Gameplay tags, numeric attributes, effects, cooldowns, and ability activation adapter |
| AI/Behavior Trees | Tree assets exported; Wait and Blueprint task events run in a lightweight scheduler |
| UMG | Widget trees exported to DOM; common containers, text, buttons, viewport, visibility, and text calls supported |
| Niagara/Cascade | Spawn/activate/deactivate calls use a portable Three.js particle fallback |
| User C++ gameplay | Explicit JavaScript replacement registry through `UE5HTML5.registerFunction` |
| Discord Activity | Blueprint nodes/events backed by Embedded App SDK connection/auth lifecycle, privacy-safe diagnostics, inbound/outbound private Broadcast, opaque Presence, participant and verified-entitlement updates, layout/orientation/thermal updates, Rich Presence/share links, opaque HttpOnly Activity sessions, and atomic cross-device saves |
| Other Blueprint nodes/functions | Preserved in IR and reported as unsupported |
| UE post-processing/custom shaders | Not transferred or approximated by PBR conversion |

The exported page has a **Logic** button showing converted programs, actor instances, node totals, and unsupported nodes. Browser code can trigger events and exported Blueprint functions with `window.UE5HTML5.call(eventName, actorName, args)`.

These adapters intentionally reproduce portable gameplay behavior, not Unreal's engine internals. Chaos rigid-body determinism, authoritative Unreal replication, full GAS prediction, Behavior Tree decorators/services, exact Slate layout, Niagara scripts, and compiled C++ still need project-specific web implementations. See [Runtime adapters](docs/RUNTIME_ADAPTERS.md) for the API and exact boundary.

## Development

```bash
npm run dev   # viewer development server
npm test      # repository structure and packaging tests
npm run build # production viewer bundle
npm run install:plugin -- --help
npm run package:plugin -- --help
```

## Architecture

```text
UE5 World / selected actors
        │
        ▼
Epic GLTFExporter plugin       Blueprint graph serializer
        │
        ├─────────────────────────────┐
        ▼                             ▼
assets/scene.glb          logic/blueprints.json
        └──────────────┬──────────────┘
                       ▼
       Three.js renderer + Blueprint VM
```

## License

MIT. Three.js retains its own MIT license. Unreal Engine and Epic's glTF Exporter are governed by Epic's applicable license terms.
