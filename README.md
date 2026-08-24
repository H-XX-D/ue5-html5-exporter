# UE5 to HTML5 Exporter

A UE5 Editor plugin that turns a level—or selected actors—into a ready-to-host WebGL game. It uses Epic's glTF 2.0 exporter for scene conversion, exports Blueprint graphs to a typed JSON IR, and runs supported gameplay logic in a bundled browser VM.

> This is an incremental Blueprint converter, not an Unreal Engine runtime compiled to WebAssembly. Supported nodes execute in the browser; every unsupported graph node is retained in the IR and listed in the compatibility report so missing behavior is explicit.

## What you get

- **Tools → Export Level to HTML5…** in the Level Editor
- **Tools → Export Selection to HTML5…** for a smaller scene
- A self-contained `scene.glb`
- `logic/blueprints.json` containing event graphs, typed pins, links, variables, and actor bindings
- A browser Blueprint VM for gameplay flow plus adapters for Enhanced Input, replicated state/RPC transport—including automatic private Activity Broadcast when configured—delegates/interfaces, latent tasks, physics events, GAS-style state, Behavior Trees, UMG, and particles
- Responsive WebGL viewer with orbit controls, animation playback, drag-and-drop GLB loading, progress, and errors
- `export-manifest.json` plus per-Blueprint/node compatibility warnings and exact browser payload measurements
- Commandlet support for CI or batch export
- Output that works on any static host
- Discord Activity Blueprint nodes plus automatic connection/error, multiplayer, participant, entitlement, layout/orientation/thermal events, Rich Presence/share-link discovery, verified Discord identity, cross-device saves, optional private Supabase Realtime, and a ready-to-deploy Activity API (Vercel adapter included)
- A dry-run-first cross-platform release command that links the explicitly selected Supabase/Vercel projects, migrates, verifies, and deploys without printing server secrets
- A one-click **Export & Preview Discord Blueprint Logic** command that runs Discord's official SDK mock locally with offline Broadcast, mock purchases, and revisioned game-state persistence—before any portal, credential, or deployment work
- A **Quick Start Discord FPS Preview** command that finds an existing browser target or, after confirmation, adds an undoable practice target and launches the local Discord mock preview in one Unreal action
- A fast **Check Blueprint Web Compatibility…** command that scans the same placed/runtime Blueprint scope without exporting scene assets, lists exact adapter work in Unreal, and writes a readable report plus machine-readable IR
- Project Settings for shared non-secret Discord Application ID/public key, Vercel project, Supabase project ref, and production URL; Unreal blocks guided export until the required set is complete and release tooling refuses cross-project drift
- A plain-language Discord access report in Unreal's export and preview dialogs, plus the commandlet log, showing the features inferred from the actual Blueprint graph, the exact authorization requested, and the privacy boundary before release
- Strict **Import/Export Public Discord Activity Targets…** commands so a release operator can hand Unreal teammates one cross-platform JSON file instead of asking them to copy four service IDs; unknown fields, malformed values, and partial target sets are rejected before `DefaultGame.ini` changes
- Content-hashed web bundles, Discord mobile safe areas, bounded API rate-limit handling, and optional signed proxy-request enforcement for production
- Automatic mobile FPS movement/look/jump/fire controls that execute the stock `Primary Thumbstick`, `Secondary Thumbstick`, `Touch Jump Start`, and `Touch Jump End` Blueprint branches before using a browser fallback
- A one-click **Set Up Browser FPS Test Level** command plus drag-and-drop **UE5 HTML5 Practice Target** actor and Blueprint-spawnable target component; health, damage per shot, score, hit reaction, depletion, and respawn are configured in Unreal and run in the browser without JavaScript
- A readiness chain that rejects incomplete Unreal targets, missing Discord launch commands, Vercel authentication redirects, iframe-blocking headers, missing Unreal manifests, and disabled Activity APIs before printing the portal checklist and URL mappings
- A double-click Windows installer that selects a `.uproject`, checks the exact Unreal/compiler toolchain, installs the plugin, and launches the project without requiring command-line or web-development knowledge
- A one-click Win64 plus browser-FPS certification workflow that first runs the native Unreal target-creation/idempotency/Undo test, then records privacy-safe local runtime-ready/frame-pacing evidence, per-file SHA-256 inventories, a detached report checksum, and optional GitHub-signed SLSA provenance for downloadable Windows artifacts
- A double-click Win64 certification launcher that selects a real Unreal project and produces the same native build/export evidence without requiring PowerShell knowledge
- A configurable browser payload budget that reports exact runtime, scene/asset, and Blueprint-logic bytes in Unreal and rechecks them before release
- A proxy-safe, origin-scoped content-addressed asset pack: exported scene and Blueprint data are SHA-256 verified and Cache API-backed, unchanged resources survive later exports, and project adapter code uses the full pack-hash query with immutable HTTP caching; storage failure falls back to the network
- An explicit **Keep this game downloaded** control in the generated Logic panel that can request persistent origin storage without collecting quota/device data; denial leaves the verified cache and network fallback working normally
- Direct mono/stereo `SoundWave` export to WAV plus browser playback for Blueprint **Play Sound 2D** and camera-relative HRTF playback for **Play Sound at Location**; audio uses the same verified reusable asset pack and remains non-fatal when browser audio is unavailable
- A Blueprint-only `Web_<Function>` fallback convention for synchronous user C++ calls—including pure calls with connected results and impure calls with or without results—so Unreal teams can rebuild portable behavior in familiar Blueprint graphs before reaching for JavaScript
- An undoable **Create Blueprint Web Fallback Drafts…** command that finds eligible uncovered calls, creates the correctly named `Web_` functions with matching input and output pins, and keeps each draft unsupported behind a visible marker until the developer finishes it

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

For a redistributable native package, use `npm run package:plugin -- --engine "/path/to/UE_5.8" --platform Win64`. To make a portable source bundle that Unreal can compile for a teammate's installed engine, run `npm run package:source`. Source bundles include clean-commit provenance for later workstation certification. Double-click certification does not require a global Node.js installation: it reuses a compatible system runtime or offers the same pinned portable runtime as the release assistant under the Windows user cache, with no administrator access or PATH change. Each reuse re-hashes the executable against the architecture-specific value pinned from the verified official archive, rather than trusting cache-owned metadata alone. The self-hosted Windows workflow can bind a native build and real FPS export to that commit and sign the resulting ZIP provenance through GitHub. See [Team installation and Windows packaging](docs/TEAM_INSTALL.md).

## Preview an export

From the exported folder:

```bash
python3 serve.py
```

Then open [http://localhost:8000](http://localhost:8000). Do not double-click `index.html`; browser module and asset security rules require HTTP.

Deploy by uploading the entire output folder to S3/CloudFront, GitHub Pages, Netlify, Vercel, Cloudflare Pages, or any ordinary static web server.

For a Discord release, the export also contains a server-side Activity API, a default `vercel.json` deployment adapter, and the Supabase migration. Vercel is optional to Discord, but Supabase Storage is not used as the static HTML host. The frontend API URL can be changed with the `ue5-activity-api` meta tag in `index.html`. Double-click the exported `release-discord-activity.cmd` on Windows or `.command` on macOS (Linux uses the `.sh` launcher) for a pinned, self-installing, dry-run-first Preview assistant. When that build is ready to replace the live game, use the separate `release-discord-activity-production` launcher. It stages a production build, verifies the exact hosted output, asks for explicit confirmation, and only then promotes it. Follow [Discord Activity release workflow](docs/DISCORD_ACTIVITY_WORKFLOW.md). Without server configuration, the same output stays in standalone website mode.

Inside an exported folder, the Windows, macOS, and Linux release launchers read public project identity directly from Unreal and print the complete release plan without an environment file. On Windows, the launcher uses a compatible installed Node.js or explicitly offers a pinned, SHA-256-verified portable copy under the user's Local AppData—no administrator access or system PATH change. After a successful dry run, the same terminal asks whether to apply that exact plan; answering No or closing the terminal makes no hosted changes. The ordinary launcher creates a Preview. The separate production launcher clearly names the live promotion in both its plan and confirmation, deploys with `--prod --skip-domain`, blocks on hosted verification plus separate SHA-256 identities for the complete export manifest and reusable asset pack, then invokes Vercel promotion for that exact URL. When Unreal has a stable Production URL configured, the workflow probes it after promotion and requires both identities to match. Every successful deployment writes `activity-release-receipt.json`, a secret-free team handoff recording the public URLs, exact identities, environment, promotion state, and completed verification gates; `.vercelignore` prevents an old local receipt, its verification, or a browser certificate from entering a later deployment. The Unreal teammate chooses **Verify Hosted Discord Activity Receipt…**, selects that file, and the plugin creates a disposable workspace that independently probes both URLs, compares the exact identities/version/schema, and writes `activity-release-verification.json` without credentials or player/billing data. On confirmation, the authenticated Supabase CLI discovers the project’s publishable and secret API keys in memory; remaining secrets use hidden prompts and reach Vercel through stdin. Nothing is written into a local env file. The equivalent manual Preview command is `npm run release:activity -- --vercel-only-secrets --supabase-cli-keys`; add `--environment production --promote` for the guarded live path. Older exports without targets can add `--supabase-project-ref YOUR_REF --vercel-project YOUR_PROJECT`.

For the lowest-friction path, the release operator configures one project and chooses **Tools → HTML5 Export → Export Public Discord Activity Targets…**. Teammates choose **Import Public Discord Activity Targets…** and select that JSON file; Unreal accepts only the versioned public Application ID/key, Vercel project, Supabase project ref, and optional production URL, validates the complete set atomically, and writes it to the project's `DefaultGame.ini`. Unknown fields and any partial or malformed set are rejected without changing current settings. The same values therefore follow the project across Windows, Linux, and macOS. They can also be entered manually under **Discord Activity Project Settings…**. **Open Discord Activity Install Page…** opens Discord's official **Add to My Apps / Add to Server** flow for that configured public Application ID; Unreal never receives the resulting Discord authorization. Then choose **Export Discord Activity…**. The guided command reports exact supported/unsupported Blueprint-node counts and offers to start the operating system's release assistant directly from Unreal. The assistant opens in a terminal, runs the non-mutating plan, and asks a plain yes/no question before any apply step; secrets never enter Unreal Project Settings. Every export includes `activity-handoff.json`; it says `unreal-export-complete` only when every exported Blueprint node is covered, otherwise it says `unreal-export-needs-blueprint-adapters` and points to the exact nodes in `logic/blueprints.json`. It also derives Discord features and OAuth scopes from the Blueprint functions actually used. Rich Presence nodes therefore enable `DISCORD_ENABLE_RICH_PRESENCE` and `rpc.activities.write` automatically, while image sharing and other no-scope commands do not broaden authorization. Package preflight recalculates this contract from `logic/blueprints.json` so a stale or edited handoff cannot forge it. The release command reads the public targets from that handoff and rejects conflicting CLI arguments or environment identities.

The exporter also derives transport requirements from the graph. A replicated property, an invoked function whose name begins with `Server`, `Client`, or `Multicast`, or a `Discord Activity Broadcast` call marks private Realtime as required. The guided apply then requests the imported ES256 private JWK through hidden input and prints the required `/supabase` Discord mapping. Auth/save-only exports keep Realtime optional, and package preflight recalculates the same rule from `logic/blueprints.json` so a stale handoff cannot silently downgrade multiplayer to local-tab behavior.

The completion dialog now shows the Discord features inferred from the exported Blueprint graph and the authorization they require. A game with no optional Discord feature nodes reports `identify only`; Rich Presence reports `identify + rpc.activities.write` and tells the developer that the release assistant will enable its server configuration automatically. Replication/RPC/Broadcast usage reports private Realtime as required without adding an OAuth scope. The same lines appear in commandlet output for workstation automation. This report is generated from the same result serialized into the manifest and handoff—not a separate checklist—and explicitly confirms that client secrets, bot tokens, email, billing information, and Discord player profiles are not written into the export.

The exact teammate and release-operator click paths are in [Team installation and Windows packaging](docs/TEAM_INSTALL.md). The public target JSON schema, Supabase Pro role, privacy boundary, deployment steps, and final two-client checklist are in [Discord Activity release workflow](docs/DISCORD_ACTIVITY_WORKFLOW.md).

In a real hosted Activity, open **Logic → Run two-client check** on two Discord clients signed into different accounts in the same Activity instance. The backend rechecks both memberships through Discord, counts distinct opaque HMAC player keys in Supabase, and enables a downloadable `discord-live-certification.json` report only when both clients poll during the same server-bound ten-second cohort. A recent check-in from an earlier run cannot satisfy the v2 certificate. The report contains counts, booleans, timestamps, and export/asset-pack versions—not Discord IDs, names, email, billing data, OAuth tokens, or device metadata. Repeating the check from one account remains one authenticated client. This certificate proves the two-client identity/instance boundary only; gameplay synchronization, mobile UX, reconnect behavior, and native Win64 Unreal compilation remain separate checks.

Migration filenames use the authoritative versions recorded by the reference Supabase project. This keeps `supabase db push --linked --dry-run` and the one-click release assistant deterministic after the first deployment instead of presenting already-applied schema under different timestamps.

For a stock First Person-style level, choose **Tools → HTML5 Export → Quick Start Discord FPS Preview**. If a browser target already exists, Unreal selects it and immediately exports the level. If not, Unreal asks before adding one configured target six meters in front of the selected or first Player Start; the level change is undoable. It then writes `Saved/UE5HTML5/DiscordActivityPreview`, starts its bundled Python on loopback, and opens the browser in explicit mock mode. Use **Export & Preview Discord Blueprint Logic** when the level does not need the FPS target setup step. Discord lifecycle, participant, Broadcast, Rich Presence/share, purchase, and world/player persistence Blueprint paths can run without a Discord application or backend. Preview saves remain in browser-local game storage and use the production revision-conflict contract. The mock cannot prove OAuth, Discord's proxy, Supabase Realtime, purchases, mobile clients, or deployment headers; the final guided release and two-client Discord test remain required.

For the baseline FPS, choose **Tools → HTML5 Export → Export & Certify Browser FPS**. Unreal creates a disposable export under `Saved/UE5HTML5/BrowserCertification` and opens a loopback-only certification run. It empties only the exporter-owned content cache for that loopback origin, proves a proxy-versioned cold download, explicitly exercises deferred assets such as weapon audio without changing normal lazy-loading behavior, reloads and proves every Cache API resource is a verified hit plus every adapter module retains the exact pack-version query, records time from navigation start to runtime-ready plus a 120-frame pacing sample, then fires the real center-ray controller until the placed practice target depletes, checks the exact score, and waits for respawn. The result is written as `browser-certification.json` using the `ue5-html5-browser-certification/v3` contract. Timing values are advisory local-browser evidence: no pass threshold is used, and no browser, device, user-agent, Discord, Vercel, Supabase, credential, or player data is collected. The certificate does not prove hosted Discord, mobile, or multi-client performance.

For a faster logic-only iteration, choose **Tools → HTML5 Export → Check Blueprint Web Compatibility…**. It scans placed Blueprint actors plus the map's runtime GameMode, Pawn, PlayerController, HUD, GameState, PlayerState, and Spectator classes without running glTF or copying the web runtime. Unreal shows the first unsupported nodes immediately, reports the Discord features and authorization inferred from the same scanned graph, and writes the complete `Saved/UE5HTML5/BlueprintCompatibility/BLUEPRINT_COMPATIBILITY.txt` report beside `logic/blueprints.json`. The commandlet prints that same access summary during `-BlueprintCheckOnly` automation. This checks translator coverage and declared Discord access only; it does not claim the browser behavior or live Discord integration is correct.

### Asset delivery and performance budget

Every new export records the exact bytes for `index.html`, `runtime/**`, `assets/**`, and `logic/**` in both `export-manifest.json` and `activity-handoff.json`. The Unreal completion dialog and commandlet show the total, the configured budget, and the largest browser artifact. Package preflight recalculates the files instead of trusting the manifest, so a modified GLB or runtime bundle cannot retain stale size claims.

The default project advisory budget is 64 MiB. Change it under **Project Settings → Plugins → UE5 HTML5 Discord Activity → Browser Export** when the game has a deliberately different release target. Exceeding it produces a review warning rather than blocking export.

### Reusable client asset cache

Current exports include an `assetPack` contract in both `export-manifest.json` and `activity-handoff.json`. Unreal hashes every file under `assets/**` plus `logic/blueprints.json`, `logic/custom-adapters.json`, and `logic/custom-adapters.js`, then derives one version hash from the sorted resource index and delivery policies. Every managed network URL receives `?ue5html5_pack=<hash>`, satisfying Discord's requirement to cache-bust non-HTML resources even when a proxy retains an earlier response. Scene, Blueprint, and audio responses are verified and stored under their individual SHA-256 identities in one exporter-owned Cache API store. A later export therefore reuses each unchanged resource without a network request and downloads only resources whose bytes changed. Adapter code continues to use the full pack version through immutable HTTP caching because JavaScript modules are loaded by the browser module loader. Migration cleanup removes only the exporter's obsolete whole-pack cache names; unrelated browser caches and the content-addressed store are retained.

This is browser-managed storage for one Activity origin, not a native Discord installation and not a promise that data will remain forever. The browser can evict it, private browsing may disable it, and separately hosted origins cannot share it. Gameplay therefore keeps a network path; if Cache API or Web Crypto support is unavailable, the game loads normally without Cache API storage. Content-hashed runtime JavaScript/CSS and pack-versioned adapter modules use ordinary immutable HTTP caching rather than being duplicated in the Cache API. Players can open **Logic → Keep this game downloaded → Protect cached assets** to request persistent storage for that Activity origin. The request happens only after that click, records no quota or device data, and may be denied; denial leaves ordinary caching and redownload working. Approval protects the origin bucket from automatic browser eviction but is still not a native installation guarantee, and players can clear it through their browser or Discord storage controls.

Every exported folder also includes `certify-browser.cmd`, `certify-browser.command`, and `certify-browser.sh`. Double-click the launcher for the current operating system to produce the same cold/warm/gameplay report outside Unreal. Certification is deliberately accepted only on `localhost`/`127.0.0.1`; adding its query string to a hosted Activity cannot clear storage or trigger automated shots.

This budget is an exporter/team policy, not a Discord upload limit. The local certificate now records runtime-ready time and frame pacing, but it deliberately applies no universal pass threshold: a fast workstation is not proof of Discord mobile performance. A small download can still perform poorly because of triangles, textures after GPU upload, shader/material cost, draw calls, Blueprint tick work, device memory, or thermal throttling. Test time-to-first-interaction, frame rate, memory, controls, and thermal behavior in real Discord desktop and mobile clients before release. Discord explicitly notes that an Activity shares CPU, RAM, and GPU with the Discord client and recommends prioritizing time-to-first-interaction and testing phones, tablets, and desktop machines.

Only public target identity belongs in Unreal Project Settings: Discord Application ID, Discord Public Key, Vercel Project Name, Supabase Project Ref, and an optional public production URL. The guided launcher retrieves Supabase API keys through the authenticated CLI, prompts without echo for Discord credentials, and generates the Activity state secret in memory. When the graph requires private Realtime, it also prompts for the intentionally imported Supabase ES256 signing JWK and derives its `kid`. Their application copies remain Vercel-only. Deployment and two-client checks also remain owned by the release operator.

## Discord nodes in Blueprint

Search the Blueprint palette for **UE5 HTML5 → Discord Activity**. The runtime module supplies nodes for readiness, Broadcast, the native invite dialog, display/orientation control, interactive picture-in-picture, locale/platform behavior, Rich Presence, Discord share links, user-initiated image sharing through Discord, HTTPS external links, non-personal launch campaign context, hardware acceleration, connected participants, Discord SKUs/purchases, server-verified entitlements, and atomic world/player load/save. They return safe unavailable/default values during native Unreal play and become asynchronous Discord SDK operations after HTML5 export.

Add the **UE5 HTML5 Discord Activity Listener** interface to a Blueprint to receive connection readiness, safe unavailable/error/warning diagnostics, multiplayer Broadcast messages, opaque Presence state, connected-participant changes, server-verified entitlement changes, and Discord display/mobile events without SDK code. Incoming data exists only in browser memory unless game logic explicitly saves it; the exporter does not create player profiles or persist participant identity.

State and Broadcast payloads are JSON strings. Save nodes accept an optional expected revision: leave it at `-1` for unconditional save, or pass the revision from the previous load/save to reject stale concurrent writes.

## Zero-code FPS targets

For a target-range prototype, drag **UE5 HTML5 Practice Target** into the level from the Unreal actor palette and place it directly ahead at the player's crosshair height. Select its **Target Rules** component and set **Max Health**, **Damage Per Shot**, **Score Value**, **Respawn**, **Respawn Delay**, and **Hit Flash** in Details. You can instead add **UE5 HTML5 Target** to an existing Blueprint actor. Keep Actor Labels unique: the exporter uses the label/name to bind each definition to its glTF object. The generated FPS runtime then applies center-screen raycast hits, hides depleted targets, updates the score/remaining-target HUD, and respawns them when configured. **Reset view** also resets the range. See [Team installation and Windows packaging](docs/TEAM_INSTALL.md#build-a-first-target-range-entirely-in-unreal) for the exact three-shot smoke test and binding troubleshooting.

For native Unreal play, call **Apply Target Practice Damage** on the same component from the project's weapon trace/projectile and use **On Target Hit**, **On Target Depleted**, and **On Target Respawned** for game-specific effects. The exported first-person fallback supplies the browser shot automatically. This component is deliberately a prototype loop, not an authoritative competitive damage system; multiplayer combat should validate hits on a trusted server adapter.

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
| Replicated properties and RPC-style calls | Versioned 64 KiB JSON envelopes over authenticated private Activity Broadcast when configured, with BroadcastChannel and optional WebSocket fallbacks |
| Interfaces and delegates | Routed through the browser runtime/event bus |
| Timers, async asset/JSON fetch, Move Component To | Converted to browser async operations |
| Physics/collision | Lightweight force/impulse/gravity integration plus mesh-bounds overlap/hit events |
| Gameplay Ability System | Gameplay tags, numeric attributes, effects, cooldowns, and ability activation adapter |
| AI/Behavior Trees | Tree assets exported; Wait and Blueprint task events run in a lightweight scheduler |
| UMG | Widget trees exported to DOM; common containers, text, buttons, viewport, visibility, and text calls supported |
| Niagara/Cascade | Spawn/activate/deactivate calls use a portable Three.js particle fallback |
| Audio | Direct mono/stereo `SoundWave` literals and Blueprint variables export as WAV; `Play Sound 2D` uses ordinary Web Audio and `Play Sound at Location` uses camera-relative HRTF panning with a 2D fallback |
| User C++ gameplay | Synchronous calls can redirect to an exported `Web_<Function>` Blueprint function: impure calls return values before execution continues, while pure calls with connected results evaluate a pure side-effect-free fallback on demand; native-only behavior uses project-owned JavaScript adapters |
| Discord Activity | Blueprint nodes/events backed by Embedded App SDK connection/auth lifecycle, privacy-safe diagnostics, inbound/outbound private Broadcast, opaque Presence, participant and verified-entitlement updates, layout/orientation/thermal updates, Rich Presence/share links, opaque HttpOnly Activity sessions, and atomic cross-device saves |
| Other Blueprint nodes/functions | Preserved in IR and reported as unsupported |
| UE post-processing/custom shaders | Not transferred or approximated by PBR conversion |

The exported page has a **Logic** button showing converted programs, actor instances, node totals, and unsupported nodes. Browser code can trigger events and exported Blueprint functions with `window.UE5HTML5.call(eventName, actorName, args)`.

For a synchronous project C++ call, run **Tools → HTML5 Export → Create Blueprint Web Fallback Drafts…**. Unreal audits the same export scope, creates `Web_<Function>` in the owning Blueprint, and copies the original visible input and output pin names and types. Rebuild the portable behavior with supported Blueprint nodes, set every required output on the generated Function Result, test it, then delete the large orange `UE5HTML5 DRAFT FALLBACK` comment. Pure originals create pure fallbacks: keep those graphs deterministic and side-effect-free. A manually created fallback for a pure original must also have **Pure** enabled or the compatibility audit leaves the call uncovered and names the correction. The exporter deliberately leaves the original call unsupported while the marker exists; after deletion it passes the inputs into the function, captures returned values synchronously, and reports the call as Blueprint-fallback-covered. The operation supports Undo and never saves Blueprint assets automatically. Behavior that genuinely needs browser APIs, native libraries, or asynchronous work still uses **Open Custom Web Adapters Folder**. Declare the Unreal function name in `custom-adapters.json`, implement it in `custom-adapters.js`, and keep both files in source control. The fast audit and handoff distinguish built-in, completed Blueprint-fallback, Blueprint-draft-candidate, project-adapter, and uncovered nodes. The browser refuses to start Blueprint logic if any declared JavaScript implementation failed to register. Registration is a wiring check, not behavior certification, so project-adapter coverage still requires local Discord preview and gameplay testing.

The footer also shows the measured primary browser payload from `export-manifest.json`. `delivery review` means the package exceeds its Unreal project advisory budget; it does not mean Discord rejected the package.

These adapters intentionally reproduce portable gameplay behavior, not Unreal's engine internals. Chaos rigid-body determinism, authoritative Unreal replication/ownership/validation, full GAS prediction, Behavior Tree decorators/services, exact Slate layout, Niagara scripts, Sound Cues/procedural audio graphs, and exact compiled-C++ behavior still need project-specific portable replacements. Eligible synchronous C++ calls can keep that replacement in Blueprint through `Web_<Function>`, including pure value calculations and impure synchronous outputs; native-only or asynchronous behavior still needs a web adapter. See [Runtime adapters](docs/RUNTIME_ADAPTERS.md) for the API and exact boundary.

## Development

```bash
npm run dev   # viewer development server
npm test      # repository structure and packaging tests
npm run build # production viewer bundle
npm run install:plugin -- --help
npm run package:plugin -- --help
```

After installing a packaged plugin into a test project, its native editor setup contract can be run headlessly with Unreal's Automation framework:

```text
UnrealEditor-Cmd YourGame.uproject -ExecCmds="Automation RunTests UE5HTML5Exporter.Editor" -TestExit="Automation Test Queue Empty" -ReportExportPath="path/to/report" -unattended -nop4 -NullRHI -NoSound
```

That suite creates an isolated editor map and proves missing-Player-Start refusal, selected/first Player Start resolution, six-meter placement, target defaults, idempotency, Undo, and Redo. It also proves that missing, malformed, and valid Discord Application IDs produce the safe install-handoff result, and that a bounded operator receipt produces the complete disposable hosted-verification workspace. The Windows double-click certifier requires all three tests automatically.

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
