# Team installation and Windows packaging

## No-web-development teammate path

The Unreal developer only needs to install the plugin and open the project. During development, **Tools → HTML5 Export → Export & Preview Discord Blueprint Logic** creates a disposable local export and exercises Discord-facing Blueprint paths through Discord's official SDK mock; it needs no project IDs, credentials, or backend. For release, the operator can choose **Export Public Discord Activity Targets…** once and give teammates that JSON file. They choose **Import Public Discord Activity Targets…**; the plugin accepts only the versioned allowlist of public Discord/Vercel/Supabase identity, validates the whole set, and updates `DefaultGame.ini` only after every check passes. Unknown, malformed, or partial fields are rejected. Manual entry under **Discord Activity Project Settings…** remains available. Then choose **Export Discord Activity…**. The guided command will not call a partial target set ready: it names every missing Discord, Vercel, or Supabase field and offers to open the correct settings page. Once complete, it exports the level, reports exact Blueprint compatibility plus browser payload size, and offers to start the release assistant. `activity-handoff.json` carries the non-secret target identity and tells the release operator what remains. Uncovered nodes produce `unreal-export-needs-blueprint-adapters`; project-adapter-covered nodes produce `unreal-export-needs-runtime-validation`; only built-in-covered exports are marked `unreal-export-complete` without an additional project-adapter test obligation.

Project Settings may contain only the Discord Application ID/public key, Vercel project name, Supabase project ref, and public production URL. They are ordinary version-controlled project configuration. Never enter Discord client secrets/bot tokens, Supabase secret/signing keys, or the Activity state secret there. The guided launcher needs no environment file: it hydrates public identity from Unreal, discovers Supabase API keys through the authenticated CLI, requests remaining secrets with hidden input only at apply time, and sends their application copies directly to Vercel without saving them locally.

The same settings page exposes a non-secret **Browser Payload Budget MiB** value. Its 64 MiB default is an exporter/team advisory, not a Discord platform limit. Unreal reports the total and largest artifact, and package preflight independently recalculates the values. Treat it as an early asset-portability warning; real Discord desktop/mobile performance testing is still required.

Create that portable source bundle from the repository with:

```sh
npm run build
npm run package:source
```

Share the generated `dist/UE5HTML5Exporter-Source` folder or download the `UE5HTML5Exporter-Source` artifact from a successful GitHub Actions CI run. The bundle intentionally excludes `Binaries` and `Intermediate`, so Unreal compiles it against the teammate's exact engine installation. It also includes `source-revision.json`; a release-grade Windows certification accepts that provenance only when it contains an exact commit and says the source tree was clean.

The intended team workflow keeps Unreal developers inside Unreal. A release operator owns Discord, hosting, and Supabase configuration; level designers and Blueprint developers install the plugin and use familiar UE5 tools and nodes.

### Five-minute Unreal teammate checklist

1. Install the plugin into the game's `Plugins/UE5HTML5Exporter` folder and open the project.
2. For everyday Blueprint work, choose **Tools → HTML5 Export → Export & Preview Discord Blueprint Logic**. This needs no account, service ID, or credential.
3. For the baseline target-range gate, choose **Export & Certify Browser FPS**. Wait for the browser to report PASS and retain `Saved/UE5HTML5/BrowserCertification/browser-certification.json` with the export evidence.
4. When preparing a shared release, choose **Import Public Discord Activity Targets…** and select the JSON supplied by the release operator. If Unreal rejects it, send the exact error back; do not edit in a secret or guess a missing value.
5. Choose **Check Discord Activity Readiness…**, then **Export Discord Activity…**. Review the reported unsupported Blueprint nodes and browser payload warning.
6. Let the exporter open the release assistant. Its first pass is a dry run. Only the release operator should answer Yes to the apply prompt or enter Discord/Supabase credentials.

The Unreal teammate never needs the Discord client secret or bot token, a Supabase secret key or signing private key, the Activity state secret, a Vercel account, player email, or billing information. The shared target file is project configuration, not an authorization file.

### Release operator checklist

1. Create or select one Discord application, one Vercel project, and one Supabase project for the game.
2. Enter their public identifiers under **Discord Activity Project Settings…**, then choose **Export Public Discord Activity Targets…** and review the JSON before sharing it.
3. Receive the Unreal export and confirm its `activity-handoff.json` reports the expected project identities and Blueprint coverage.
4. Run the included release assistant. Review the dry-run plan, then approve apply only when the named projects are correct.
5. Complete Discord URL mappings and run the final Activity in at least two Discord clients. Confirm join, Broadcast/Presence, world save, player save, revision conflict, reconnect, and entitlement behavior as applicable.

Supabase Pro is fully suitable for this workflow and gives the production project paid capacity and operational features. It does not replace the HTTPS static host: Supabase remains the private persistence/Realtime layer, while Vercel or another iframe-compatible HTTPS host serves the exported game and Activity API.

The mock preview binds only to `127.0.0.1`, activates only with its explicit query flag, and stores only game-created preview state in that browser. It verifies Blueprint branching and adapter contracts, not Discord OAuth/proxy behavior, Supabase Realtime, real purchases, mobile behavior, or multi-client synchronization.

### Build a first target range entirely in Unreal

1. Choose **Tools → HTML5 Export → Set Up Browser FPS Test Level**. If the level already has a target component, Unreal selects it and changes nothing. Otherwise, after confirmation, the plugin adds one configured **UE5 HTML5 Practice Target** six meters in front of the selected—or first—Player Start, marks the level modified, and leaves the operation undoable. No web setting or Blueprint graph is required.
2. Save the level and inspect the selected target. Adjust its position if the level geometry blocks the Player Start's forward view. Every target needs a unique Actor Label; the label is the portable link between the Unreal actor and exported glTF mesh. You can still drag additional **UE5 HTML5 Practice Target** actors from **Place Actors**.
3. The selected target is already configured with **Max Health** `3`, **Damage Per Shot** `1`, **Score Value** `100`, and **Respawn** enabled. Change those values under **Target Rules** only when you want different gameplay; a shorter **Respawn Delay** such as `0.5` makes repeated certification quicker. Hit Flash may be tuned independently.
4. Choose **Tools → HTML5 Export → Export & Certify Browser FPS**. The generated browser runs cold and warm asset-pack loads automatically, records time-to-runtime-ready plus a 120-frame pacing sample, fires the same center ray used by mouse/touch gameplay, verifies **Score 100 · Targets 0/1**, waits for **Targets 1/1** to return, and writes `browser-certification.json`. Use **Export & Preview Discord Blueprint Logic** afterward for free-form movement, aiming, and Discord Blueprint mock testing.
5. If the HUD says **Targets 0/1** before any shot, the target definition exported but its visible mesh did not bind. Save the level, confirm the actor is visible/exportable and its Actor Label is unique, then export again. If shots hit the scenery behind it, move the target so its visible mesh intersects the camera-height crosshair before re-exporting.
6. To use custom art, add **UE5 HTML5 Target** to an existing Blueprint actor instead. Keep the component on the same placed actor whose visible mesh should receive hits.
7. In native Unreal play, connect the project's weapon trace/projectile to **Apply Target Practice Damage** and bind the component delegates for effects. Browser fallback shooting needs no additional graph.

This target component is intentionally local prototype gameplay. It is appropriate for a Discord target-range test and can save game-created scores/state through the supplied persistence nodes. It does not make client-side hits authoritative for a competitive multiplayer game.

The browser certificate is a local, machine-readable smoke test, not a synthetic claim that the whole Activity is certified. It proves the exported manifest, SHA-256 asset pack, pack-hash query on every managed request, Cache API cold/warm paths, versioned adapter-module loading, Blueprint runtime startup, first-person shot, target binding, score, and respawn in the launched browser. It also records advisory runtime-ready time and frame-pacing percentiles without collecting the browser, user agent, device model, credential, or player identity. Those numbers help compare builds on the same workstation; they do not prove Discord OAuth/proxy behavior, Supabase, Vercel headers, mobile performance, multiplayer authority, or two-client synchronization. The certification endpoint binds only to loopback and accepts one report carrying an ephemeral server token; hosted `discordsays.com` pages cannot activate it.

The release operator does not need to assemble hosting commands by hand. **Export Discord Activity…** can launch the operating system's release assistant directly from Unreal, and every export includes `scripts/activity-release.mjs`; `npm run release:activity -- --vercel-only-secrets --supabase-cli-keys` reads the public targets from Unreal and prints a zero-file dry-run plan plus the exact Discord portal checklist. The included launcher supplies both safe options automatically. Explicit `--supabase-project-ref` and `--vercel-project` overrides are still accepted only when they match Unreal's targets. An explicit `--apply` discovers modern Supabase API keys through the authenticated CLI, performs the selected Supabase/Vercel setup, and creates a Preview deployment. Package preflight rejects contradictory, stale, or secret-bearing handoff data, preserves an honest list of any missing public targets, and warns when Blueprint adapters remain; the release selection gate refuses to proceed until the required target set is complete. Online preflight verifies the embedded-app flag, both installation contexts, OAuth redirect setup, and a Discord-managed Primary Entry Point before checking the public host and Activity API. The same Node.js 22 command runs on Windows, macOS, and Linux; private values remain in process memory and reach Vercel through stdin rather than files or command arguments.

Unreal gameplay developers can run **Tools → HTML5 Export → Check Blueprint Web Compatibility…** at any time. It avoids the glTF scene-export cost, shows the first unsupported nodes in the Editor, and writes a complete human-readable report plus `logic/blueprints.json` under the project's `Saved/UE5HTML5/BlueprintCompatibility` folder. Workstation automation can run the same scope with `-BlueprintCheckOnly`; add `-FailOnUnsupported` only when unsupported nodes should fail CI.

When project C++ or an uncovered Blueprint function is intentional, choose **Open Custom Web Adapters Folder** from the same menu. Add the function name to `custom-adapters.json`, implement it in `custom-adapters.js`, and commit both files with the Unreal project. The exporter copies them automatically; no one edits generated export folders. A missing registration prevents Blueprint startup, while a valid registration is reported honestly as requiring preview and gameplay validation.

## Windows developer install

Requirements:

- Unreal Engine 5.3 or newer with the built-in **glTF Exporter** plugin
- For UE 5.8 source builds: Visual Studio 2022 17.14+ or Visual Studio 2026 18.0+, **Game development with C++**, Visual Studio Tools for Unreal Engine, and Windows SDK 10.0.22621+
- Node.js 22.12 or newer only when rebuilding/testing the browser runtime; ordinary plugin installation uses PowerShell, and the exported Windows release launcher can explicitly install a verified portable runtime under Local AppData

From the downloaded source bundle, double-click `Install-UE5HTML5Exporter.cmd`. Choose the game's `.uproject` file in the Windows file picker. The launcher runs the workstation doctor, installs the plugin, and opens the selected project; it does not ask for Discord, Vercel, Supabase, player, or billing information. You can also drag a `.uproject` file onto the launcher. When updating an existing installation, it asks before moving the current plugin into the project's recoverable `.ue5html5-backups` folder.

For automation or advanced options, the equivalent PowerShell command is:

```powershell
.\scripts\Setup-UE5HTML5Exporter.ps1 -Project "C:\Games\MyGame\MyGame.uproject"
```

The setup tool reads the project's `EngineAssociation`, discovers the matching Epic Launcher installation, checks the supported Visual Studio workload and Windows SDK when a source compile is needed, and installs the plugin. It refuses to select a newer engine minor version silently. The click launcher uses Windows PowerShell 5.1 in STA mode only for its native `.uproject` picker and the bundled source setup scripts; it makes no network request. Use `-CheckOnly` for a non-mutating workstation doctor or `-CheckOnly -Json` for automation:

```powershell
.\scripts\Setup-UE5HTML5Exporter.ps1 -Project "C:\Games\MyGame\MyGame.uproject" -CheckOnly
```

An explicit `-EngineRoot` remains available when intentionally upgrading an Unreal project. To install manually without the doctor:

```powershell
.\scripts\Install-UE5HTML5Exporter.ps1 -Project "C:\Games\MyGame\MyGame.uproject" -SourceOnly
```

Open the project and accept Unreal's rebuild prompt. Then use **Tools → HTML5 Export** and the **UE5 HTML5 → Discord Activity** Blueprint category.

The installer refuses to overwrite an existing plugin. To update it while preserving the current copy:

```powershell
.\scripts\Install-UE5HTML5Exporter.ps1 -Project "C:\Games\MyGame\MyGame.uproject" -SourceOnly -Replace
```

`-Replace` moves the existing folder to a timestamped `Project/.ue5html5-backups/` entry before copying. Backups stay recoverable without being rediscovered as duplicate Unreal plugins.

## Produce a prebuilt Win64 package

Build on Windows using the same UE minor version as the team. `-EngineRoot` is optional when Epic Launcher metadata is available:

```powershell
.\scripts\Package-UE5HTML5Exporter.ps1 -EngineRoot "C:\Program Files\Epic Games\UE_5.8" -Platform Win64 -Output "C:\UEPlugins\UE5HTML5Exporter-UE5.8-Win64"
```

Give that output folder to teammates. They can install it without `--source-only`:

```powershell
.\scripts\Install-UE5HTML5Exporter.ps1 -Project "C:\Games\MyGame\MyGame.uproject" -Plugin "C:\UEPlugins\UE5HTML5Exporter-UE5.8-Win64"
```

A prebuilt plugin is tied to its UE minor version and target operating system. Package UE 5.7 and UE 5.8 separately. macOS cannot prove a Win64 Unreal binary; the repository's manually triggered Windows workflow requires a self-hosted runner labeled `Windows` and `ue5` with Unreal already installed.

The workflow and local scripts use the same workstation report. The workflow may leave `engine_root` blank to discover the newest valid Epic Launcher installation; a real project certification instead follows that project's engine association.

## Certify the complete Windows handoff

On the Windows Unreal workstation, double-click `Certify-UE5HTML5Exporter.cmd`. Choose a `.uproject`, enter the map path when prompted, and confirm the operation. The launcher builds the Win64 plugin, backs up and installs it into the real project, runs the native Unreal automation test for target creation, selected/first Player Start placement, defaults, idempotency, Undo, and Redo, applies the same readiness policy used by the Unreal menu, exports the map, and opens the default browser. Keep that browser window open: it automatically proves the cold download, warm reusable cache, records advisory runtime-ready/frame-pacing evidence, and proves center-ray shooting, score, target depletion, and respawn before the package preflight and evidence folder complete. No command line or separate editor/browser test step is required.

For automation or an explicit command-line run, use:

```powershell
.\scripts\Verify-UE5HTML5Exporter.ps1 `
  -EngineRoot "C:\Program Files\Epic Games\UE_5.8" `
  -Project "C:\Games\MyGame\MyGame.uproject" `
  -Map "/Game/Maps/Main" `
  -CertifyBrowser
```

The verified export receives `workstation-certification.json` using the `ue5-html5-workstation-certification/v6` contract. It binds the record to the exact 40-character source commit, engine/compiler/SDK versions, the exact passing native editor test, Blueprint compatibility counts, the matching `browser-certification.json` result, normalized proxy-versioned cache/module evidence, local runtime-ready/frame-pacing evidence, and canonical SHA-256 inventories for every file in both the native plugin package and browser export. The raw Unreal Automation report contains workstation metadata, so the certifier validates it, keeps only a normalized pass/fail/test-path/duration record, and deletes the raw report instead of adding it to the shared artifact. Browser evidence is accepted only when its exporter version, manifest schema, asset-pack schema/hash/query, cold/warm resource sets, versioned adapter module, FPS results, performance shape, and privacy flags match the just-exported package. `workstation-certification.sha256` independently protects the combined report. Certification refuses a dirty checkout or a source bundle without usable revision metadata. The report distinguishes a directly verified clean Git checkout (`releaseGradeSourceProof: true`) from unsigned source-bundle metadata (`false`); use the self-hosted GitHub workflow for release-grade proof and GitHub-signed provenance.

No Discord, Vercel, or Supabase credential is read or written by this script. It does not collect personal player data; its scope is native compilation, native editor setup automation, plugin installation, readiness, map export, loopback browser FPS certification, and package preflight.

The manual GitHub workflow accepts the same optional project and map paths when a self-hosted runner labeled `Windows` and `ue5` has the matching Unreal installation and test project. Enable its **certify_browser** option only when the runner is attached to a logged-in interactive desktop with a default browser; Windows service sessions normally cannot complete browser UI. It produces one commit-named certification bundle containing ZIP archives, checksums, and the report. GitHub's first-party `actions/attest` action signs SLSA provenance for each ZIP. After downloading one of those ZIPs, verify its builder and digest with:

```powershell
gh attestation verify .\UE5HTML5Exporter-Win64-<commit>.zip --repo H-XX-D/ue5-html5-exporter
```

The package-only workflow path proves native compilation. Supply `project_path` for an end-to-end native export; enable `certify_browser` for the strongest workflow path that also proves the exported FPS in a real browser. A report that says `browserCertification.status: not-run` is an explicit native-only result, not browser evidence.

## Who needs to understand the web stack?

| Role | Unreal | Node/web tooling | Discord/Vercel/Supabase |
|---|---:|---:|---:|
| Level or asset designer | Yes | No | No |
| Blueprint gameplay developer | Yes | No | Only the supplied Discord Blueprint nodes |
| Plugin maintainer | Yes | Yes | Test configuration only |
| Release operator | Optional | Supplied automatically by the Windows launcher; required for manual/CI use | Yes |

The exported folder is static-host compatible. Vercel is the included deployment adapter because it serves both the game and confidential Activity API from one project. Supabase stores game-created state and provides private Realtime channels. Discord provides identity, purchases, Rich Presence, share links, and distribution. Unreal teammates access those features through supplied Blueprint nodes rather than writing Embedded App SDK code.

Production bundles use content-hashed runtime JavaScript/CSS filenames and a pack-hash query for scene, Blueprint, and project-adapter resources, so a Discord proxy or CDN cannot substitute an older export after an update. Discord mobile safe-area variables are applied automatically. Standard first-person exports also receive touch movement, look, Jump, and Fire controls automatically, while desktop keeps pointer-lock mouse and keyboard controls. These details are generated by the plugin; Unreal teammates do not need to manage them.

If the static game is hosted elsewhere, keep the API on a Discord-mapped same-origin prefix. For example, update this generated tag in `index.html`:

```html
<meta name="ue5-activity-api" content="/activity-api" />
```

Then map `/activity-api` to the backend's Activity endpoint in the Discord Developer Portal or configure an equivalent reverse proxy on the static host. Keeping the browser request same-origin preserves the host-only Activity cookie and avoids CORS becoming part of the security boundary. Discord must map `/` to the static game host. Map `/supabase` to the Supabase project hostname only when optional private Realtime is configured; the base save/load path does not need it. Never put Discord client secrets, bot tokens, Supabase secret keys, or signing private keys in `index.html` or the exported runtime.
