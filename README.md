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
- `export-manifest.json` plus per-Blueprint/node compatibility warnings and exact browser payload measurements
- Commandlet support for CI or batch export
- Output that works on any static host
- Discord Activity Blueprint nodes plus automatic connection/error, multiplayer, participant, entitlement, layout/orientation/thermal events, Rich Presence/share-link discovery, verified Discord identity, Supabase Realtime, cross-device saves, and a ready-to-deploy Activity API (Vercel adapter included)
- A dry-run-first cross-platform release command that links the explicitly selected Supabase/Vercel projects, migrates, verifies, and deploys without printing server secrets
- A one-click **Export & Preview Discord Blueprint Logic** command that runs Discord's official SDK mock locally with offline Broadcast, mock purchases, and revisioned game-state persistence—before any portal, credential, or deployment work
- A fast **Check Blueprint Web Compatibility…** command that scans the same placed/runtime Blueprint scope without exporting scene assets, lists exact adapter work in Unreal, and writes a readable report plus machine-readable IR
- Project Settings for shared non-secret Discord Application ID/public key, Vercel project, Supabase project ref, and production URL; Unreal blocks guided export until the required set is complete and release tooling refuses cross-project drift
- Strict **Import/Export Public Discord Activity Targets…** commands so a release operator can hand Unreal teammates one cross-platform JSON file instead of asking them to copy four service IDs; unknown fields, malformed values, and partial target sets are rejected before `DefaultGame.ini` changes
- Content-hashed web bundles, Discord mobile safe areas, bounded API rate-limit handling, and optional signed proxy-request enforcement for production
- Automatic mobile FPS movement/look/jump/fire controls that execute the stock `Primary Thumbstick`, `Secondary Thumbstick`, `Touch Jump Start`, and `Touch Jump End` Blueprint branches before using a browser fallback
- A readiness chain that rejects incomplete Unreal targets, missing Discord launch commands, Vercel authentication redirects, iframe-blocking headers, missing Unreal manifests, and disabled Activity APIs before printing the portal checklist and URL mappings
- A double-click Windows installer that selects a `.uproject`, checks the exact Unreal/compiler toolchain, installs the plugin, and launches the project without requiring command-line or web-development knowledge
- A commit-bound Win64 certification workflow with per-file SHA-256 inventories, a detached report checksum, and GitHub-signed SLSA provenance for downloadable Windows artifacts
- A configurable browser payload budget that reports exact runtime, scene/asset, and Blueprint-logic bytes in Unreal and rechecks them before release

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

   On Windows, teammates can double-click `Install-UE5HTML5Exporter.cmd` in the source bundle, choose the game's `.uproject`, and let it check, install, and launch automatically. The equivalent command-line path discovers the matching Epic Launcher engine and validates the compiler toolchain:

   ```powershell
   .\scripts\Setup-UE5HTML5Exporter.ps1 -Project "C:\Games\MyGame\MyGame.uproject"
   ```

3. Regenerate project files if your project uses C++.
4. Open the project. When prompted, enable/rebuild **UE5 to HTML5 Exporter** and **glTF Exporter**, then restart the Editor.
5. Open a level and use **Tools → HTML5 Export**.

The first compile must match your installed UE5 minor version. The plugin contains source, so Unreal Build Tool will build it for your engine.

For a redistributable native package, use `npm run package:plugin -- --engine "/path/to/UE_5.8" --platform Win64`. To make a portable source bundle that Unreal can compile for a teammate's installed engine, run `npm run package:source`. Source bundles include clean-commit provenance for later workstation certification. The self-hosted Windows workflow can bind a native build and real FPS export to that commit and sign the resulting ZIP provenance through GitHub. See [Team installation and Windows packaging](docs/TEAM_INSTALL.md).

## Preview an export

From the exported folder:

```bash
python3 serve.py
```

Then open [http://localhost:8000](http://localhost:8000). Do not double-click `index.html`; browser module and asset security rules require HTTP.

Deploy by uploading the entire output folder to S3/CloudFront, GitHub Pages, Netlify, Vercel, Cloudflare Pages, or any ordinary static web server.

For a Discord release, the export also contains a server-side Activity API, a default `vercel.json` deployment adapter, and the Supabase migration. Vercel is optional to Discord, but Supabase Storage is not used as the static HTML host. The frontend API URL can be changed with the `ue5-activity-api` meta tag in `index.html`. Double-click the exported `release-discord-activity.cmd` on Windows or `.command` on macOS (Linux uses the `.sh` launcher) for a pinned, self-installing, dry-run-first release assistant. Follow [Discord Activity release workflow](docs/DISCORD_ACTIVITY_WORKFLOW.md). Without server configuration, the same output stays in standalone website mode.

Inside an exported folder, the Windows, macOS, and Linux release launchers read public project identity directly from Unreal and print the complete release plan without an environment file. On Windows, the launcher uses a compatible installed Node.js or explicitly offers a pinned, SHA-256-verified portable copy under the user's Local AppData—no administrator access or system PATH change. After a successful dry run, the same terminal asks whether to configure and deploy that exact plan; answering No or closing the terminal makes no hosted changes. On confirmation, the authenticated Supabase CLI discovers the project’s publishable and secret API keys in memory; remaining secrets use hidden prompts and reach Vercel through stdin. Nothing is written into a local env file. The equivalent manual command is `npm run release:activity -- --vercel-only-secrets --supabase-cli-keys`. Older exports without targets can add `--supabase-project-ref YOUR_REF --vercel-project YOUR_PROJECT`.

For the lowest-friction path, the release operator configures one project and chooses **Tools → HTML5 Export → Export Public Discord Activity Targets…**. Teammates choose **Import Public Discord Activity Targets…** and select that JSON file; Unreal accepts only the versioned public Application ID/key, Vercel project, Supabase project ref, and optional production URL, validates the complete set atomically, and writes it to the project's `DefaultGame.ini`. Unknown fields and any partial or malformed set are rejected without changing current settings. The same values therefore follow the project across Windows, Linux, and macOS. They can also be entered manually under **Discord Activity Project Settings…**. Then choose **Export Discord Activity…**. The guided command reports exact supported/unsupported Blueprint-node counts and offers to start the operating system's release assistant directly from Unreal. The assistant opens in a terminal, runs the non-mutating plan, and asks a plain yes/no question before any apply step; secrets never enter Unreal Project Settings. Every export includes `activity-handoff.json`; it says `unreal-export-complete` only when every exported Blueprint node is covered, otherwise it says `unreal-export-needs-blueprint-adapters` and points to the exact nodes in `logic/blueprints.json`. The release command reads the public targets from that handoff and rejects conflicting CLI arguments or environment identities.

The exact teammate and release-operator click paths are in [Team installation and Windows packaging](docs/TEAM_INSTALL.md). The public target JSON schema, Supabase Pro role, privacy boundary, deployment steps, and final two-client checklist are in [Discord Activity release workflow](docs/DISCORD_ACTIVITY_WORKFLOW.md).

During gameplay development, choose **Tools → HTML5 Export → Export & Preview Discord Blueprint Logic**. Unreal exports to `Saved/UE5HTML5/DiscordActivityPreview`, starts its bundled Python on loopback, and opens the browser in explicit mock mode. Discord lifecycle, participant, Broadcast, Rich Presence/share, purchase, and world/player persistence Blueprint paths can run without a Discord application or backend. Preview saves remain in browser-local game storage and use the production revision-conflict contract. The mock cannot prove OAuth, Discord's proxy, Supabase Realtime, purchases, mobile clients, or deployment headers; the final guided release and two-client Discord test remain required.

For a faster logic-only iteration, choose **Tools → HTML5 Export → Check Blueprint Web Compatibility…**. It scans placed Blueprint actors plus the map's runtime GameMode, Pawn, PlayerController, HUD, GameState, PlayerState, and Spectator classes without running glTF or copying the web runtime. Unreal shows the first unsupported nodes immediately and writes the complete `Saved/UE5HTML5/BlueprintCompatibility/BLUEPRINT_COMPATIBILITY.txt` report beside `logic/blueprints.json`. This checks translator coverage only; it does not claim the browser behavior or Discord integration is correct.

### Asset delivery and performance budget

Every new export records the exact bytes for `index.html`, `runtime/**`, `assets/**`, and `logic/**` in both `export-manifest.json` and `activity-handoff.json`. The Unreal completion dialog and commandlet show the total, the configured budget, and the largest browser artifact. Package preflight recalculates the files instead of trusting the manifest, so a modified GLB or runtime bundle cannot retain stale size claims.

The default project advisory budget is 64 MiB. Change it under **Project Settings → Plugins → UE5 HTML5 Discord Activity → Browser Export** when the game has a deliberately different release target. Exceeding it produces a review warning rather than blocking export.

This budget is an exporter/team policy, not a Discord upload limit and not a performance certification. A small download can still perform poorly because of triangles, textures after GPU upload, shader/material cost, draw calls, Blueprint tick work, device memory, or thermal throttling. Test time-to-first-interaction, frame rate, memory, controls, and thermal behavior in real Discord desktop and mobile clients before release. Discord explicitly notes that an Activity shares CPU, RAM, and GPU with the Discord client and recommends prioritizing time-to-first-interaction and testing phones, tablets, and desktop machines.

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
  -ProjectTargets=/absolute/path/discord-activity-project-targets.json \
  -Output=/absolute/path/web-export \
  -unattended -nop4
```

`-ProjectTargets` is optional. When supplied, it runs the same strict public-target import used by the Unreal menu before readiness or export; invalid files return commandlet status `7` without applying a partial target set. Automation can create the same shareable contract with `-ExportProjectTargets=/absolute/path/targets.json`; this may be used without `-Map`, and export failures return status `8`.

On Windows, use `UnrealEditor-Cmd.exe`.

To run only the fast Blueprint compatibility audit, omit the scene export:

```bash
UnrealEditor-Cmd \
  /absolute/path/MyGame.uproject \
  -run=UE5HTML5Export \
  -Map=/Game/Maps/Main \
  -BlueprintCheckOnly \
  -Output=/absolute/path/compatibility-report \
  -unattended -nop4
```

Add `-FailOnUnsupported` when CI should exit with code `6` if any node still needs a web adapter. Without it, unsupported nodes are warnings and the audit exits successfully after writing the report.

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
| User C++ gameplay | Project-owned `Config/UE5HTML5/custom-adapters.json` + `custom-adapters.js`, copied into every export and registered through `UE5HTML5.registerFunction` before Blueprint startup |
| Discord Activity | Blueprint nodes/events backed by Embedded App SDK connection/auth lifecycle, privacy-safe diagnostics, inbound/outbound private Broadcast, opaque Presence, participant and verified-entitlement updates, layout/orientation/thermal updates, Rich Presence/share links, opaque HttpOnly Activity sessions, and atomic cross-device saves |
| Other Blueprint nodes/functions | Preserved in IR and reported as unsupported |
| UE post-processing/custom shaders | Not transferred or approximated by PBR conversion |

The exported page has a **Logic** button showing converted programs, actor instances, node totals, and unsupported nodes. Browser code can trigger events and exported Blueprint functions with `window.UE5HTML5.call(eventName, actorName, args)`.

For project C++ or a Blueprint function outside the built-in subset, choose **Tools → HTML5 Export → Open Custom Web Adapters Folder**. Declare the Unreal function name in `custom-adapters.json`, implement the same name in `custom-adapters.js`, and keep both files in source control. The fast compatibility audit then reports built-in, project-adapter-covered, and uncovered nodes separately. The exported browser refuses to start Blueprint logic if any declared implementation failed to register. Registration is a wiring check, not a behavior certification, so project-adapter coverage still requires local Discord preview and gameplay testing.

The footer also shows the measured primary browser payload from `export-manifest.json`. `delivery review` means the package exceeds its Unreal project advisory budget; it does not mean Discord rejected the package.

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
Epic GLTFExporter plugin       Blueprint graph serializer + adapter declarations
        │
        ├─────────────────────────────┐
        ▼                             ▼
assets/scene.glb          logic/blueprints.json + custom-adapters.{json,js}
        └──────────────┬──────────────┘
                       ▼
       Three.js renderer + Blueprint VM
```

## License

MIT. Three.js retains its own MIT license. Unreal Engine and Epic's glTF Exporter are governed by Epic's applicable license terms.
