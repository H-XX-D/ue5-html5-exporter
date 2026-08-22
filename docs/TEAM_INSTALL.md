# Team installation and Windows packaging

## No-web-development teammate path

The Unreal developer only needs to install the plugin and open the project. During development, **Tools → HTML5 Export → Export & Preview Discord Blueprint Logic** creates a disposable local export and exercises Discord-facing Blueprint paths through Discord's official SDK mock; it needs no project IDs, credentials, or backend. For release, set the public target identity once under **Discord Activity Project Settings…** and choose **Export Discord Activity…**. The guided command will not call a partial target set ready: it names every missing Discord, Vercel, or Supabase field and offers to open the correct settings page. Once complete, it exports the level, reports exact Blueprint compatibility, and offers to start the release assistant. `activity-handoff.json` carries the non-secret target identity and tells the release operator what remains. It marks the Unreal work complete only when every exported Blueprint node is covered; otherwise it names the handoff `unreal-export-needs-blueprint-adapters` and points to `logic/blueprints.json`.

Project Settings may contain only the Discord Application ID/public key, Vercel project name, Supabase project ref, and public production URL. They are ordinary version-controlled project configuration. Never enter Discord client secrets/bot tokens, Supabase secret/signing keys, or the Activity state secret there. The guided launcher needs no environment file: it hydrates public identity from Unreal, discovers Supabase API keys through the authenticated CLI, requests remaining secrets with hidden input only at apply time, and sends their application copies directly to Vercel without saving them locally.

Create that portable source bundle from the repository with:

```sh
npm run build
npm run package:source
```

Share the generated `dist/UE5HTML5Exporter-Source` folder or download the `UE5HTML5Exporter-Source` artifact from a successful GitHub Actions CI run. The bundle intentionally excludes `Binaries` and `Intermediate`, so Unreal compiles it against the teammate's exact engine installation.

The intended team workflow keeps Unreal developers inside Unreal. A release operator owns Discord, hosting, and Supabase configuration; level designers and Blueprint developers install the plugin and use familiar UE5 tools and nodes.

The mock preview binds only to `127.0.0.1`, activates only with its explicit query flag, and stores only game-created preview state in that browser. It verifies Blueprint branching and adapter contracts, not Discord OAuth/proxy behavior, Supabase Realtime, real purchases, mobile behavior, or multi-client synchronization.

The release operator does not need to assemble hosting commands by hand. **Export Discord Activity…** can launch the operating system's release assistant directly from Unreal, and every export includes `scripts/activity-release.mjs`; `npm run release:activity -- --vercel-only-secrets --supabase-cli-keys` reads the public targets from Unreal and prints a zero-file dry-run plan plus the exact Discord portal checklist. The included launcher supplies both safe options automatically. Explicit `--supabase-project-ref` and `--vercel-project` overrides are still accepted only when they match Unreal's targets. An explicit `--apply` discovers modern Supabase API keys through the authenticated CLI, performs the selected Supabase/Vercel setup, and creates a Preview deployment. Package preflight rejects contradictory, stale, or secret-bearing handoff data, preserves an honest list of any missing public targets, and warns when Blueprint adapters remain; the release selection gate refuses to proceed until the required target set is complete. Online preflight verifies the embedded-app flag, both installation contexts, OAuth redirect setup, and a Discord-managed Primary Entry Point before checking the public host and Activity API. The same Node.js 22 command runs on Windows, macOS, and Linux; private values remain in process memory and reach Vercel through stdin rather than files or command arguments.

## Windows developer install

Requirements:

- Unreal Engine 5.3 or newer with the built-in **glTF Exporter** plugin
- For UE 5.8 source builds: Visual Studio 2022 17.14+ or Visual Studio 2026 18.0+, **Game development with C++**, Visual Studio Tools for Unreal Engine, and Windows SDK 10.0.22621+
- Node.js 22.12 or newer only when rebuilding/testing the browser runtime; ordinary source or prebuilt plugin installation uses PowerShell

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

On the Windows Unreal workstation, one command can build the Win64 plugin, back up and install it into a real project, run the same readiness policy used by the Unreal menu, export a real map, and run the Discord Activity package preflight:

```powershell
.\scripts\Verify-UE5HTML5Exporter.ps1 `
  -EngineRoot "C:\Program Files\Epic Games\UE_5.8" `
  -Project "C:\Games\MyGame\MyGame.uproject" `
  -Map "/Game/Maps/Main"
```

The verified export receives `workstation-certification.json`, including the Blueprint compatibility counts and either `passed` or `passed-with-blueprint-adapters-required` for the Unreal export. No Discord, Vercel, or Supabase credential is read or written by this script. The manual GitHub workflow accepts the same optional project and map paths when the self-hosted Windows runner has a test project available.

## Who needs to understand the web stack?

| Role | Unreal | Node/web tooling | Discord/Vercel/Supabase |
|---|---:|---:|---:|
| Level or asset designer | Yes | No | No |
| Blueprint gameplay developer | Yes | No | Only the supplied Discord Blueprint nodes |
| Plugin maintainer | Yes | Yes | Test configuration only |
| Release operator | Optional | Yes | Yes |

The exported folder is static-host compatible. Vercel is the included deployment adapter because it serves both the game and confidential Activity API from one project. Supabase stores game-created state and provides private Realtime channels. Discord provides identity, purchases, Rich Presence, share links, and distribution. Unreal teammates access those features through supplied Blueprint nodes rather than writing Embedded App SDK code.

Production bundles use content-hashed JavaScript and CSS filenames so a Discord proxy or CDN cannot keep an older runtime after an update. Discord mobile safe-area variables are applied automatically. Standard first-person exports also receive touch movement, look, Jump, and Fire controls automatically, while desktop keeps pointer-lock mouse and keyboard controls. These details are generated by the plugin; Unreal teammates do not need to manage them.

If the static game is hosted elsewhere, keep the API on a Discord-mapped same-origin prefix. For example, update this generated tag in `index.html`:

```html
<meta name="ue5-activity-api" content="/activity-api" />
```

Then map `/activity-api` to the backend's Activity endpoint in the Discord Developer Portal or configure an equivalent reverse proxy on the static host. Keeping the browser request same-origin preserves the host-only Activity cookie and avoids CORS becoming part of the security boundary. Discord must also map `/` to the static game host and `/supabase` to the Supabase project hostname. Never put Discord client secrets, bot tokens, Supabase secret keys, or signing private keys in `index.html` or the exported runtime.
