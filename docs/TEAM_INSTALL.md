# Team installation and Windows packaging

## No-web-development teammate path

The Unreal developer only needs to install the plugin, open the project, and choose **Tools → HTML5 Export → Export Discord Activity…**. That guided command runs the readiness gate, exports the level, reports exact Blueprint compatibility, and offers to open the finished folder. `activity-handoff.json` tells the release operator what remains. It marks the Unreal work complete only when every exported Blueprint node is covered; otherwise it names the handoff `unreal-export-needs-blueprint-adapters` and points to `logic/blueprints.json`. The developer can stay focused on the level and Blueprint gameplay instead of learning the web stack.

Create that portable source bundle from the repository with:

```sh
npm run build
npm run package:source
```

Share the generated `dist/UE5HTML5Exporter-Source` folder or download the `UE5HTML5Exporter-Source` artifact from a successful GitHub Actions CI run. The bundle intentionally excludes `Binaries` and `Intermediate`, so Unreal compiles it against the teammate's exact engine installation.

The intended team workflow keeps Unreal developers inside Unreal. A release operator owns Discord, hosting, and Supabase configuration; level designers and Blueprint developers install the plugin and use familiar UE5 tools and nodes.

The release operator does not need to assemble hosting commands by hand. Every export includes `scripts/activity-release.mjs`; `npm run release:activity` prints a dry-run plan, and an explicit `--apply` performs the selected Supabase/Vercel setup and creates a Preview deployment. Package preflight rejects contradictory or stale handoff data and warns when Blueprint adapters remain. It then verifies that an unauthenticated Discord player can reach the host, that iframe headers permit embedding, that the Unreal manifest is present, and that the Activity API is enabled. The same Node.js 22 command runs on Windows, macOS, and Linux, and secret values are sent to Vercel through stdin rather than command arguments.

## Windows developer install

Requirements:

- Unreal Engine 5.3 or newer with the built-in **glTF Exporter** plugin
- For UE 5.8 source builds: Visual Studio 2022 17.14+ or Visual Studio 2026 18.0+, **Game development with C++**, Visual Studio Tools for Unreal Engine, and Windows SDK 10.0.22621+
- Node.js 22.12 or newer only when rebuilding/testing the browser runtime; ordinary source or prebuilt plugin installation uses PowerShell

From PowerShell in this repository or source bundle, the recommended one-command setup is:

```powershell
.\scripts\Setup-UE5HTML5Exporter.ps1 -Project "C:\Games\MyGame\MyGame.uproject"
```

The setup tool reads the project's `EngineAssociation`, discovers the matching Epic Launcher installation, checks the supported Visual Studio workload and Windows SDK when a source compile is needed, and installs the plugin. It refuses to select a newer engine minor version silently. Use `-CheckOnly` for a non-mutating workstation doctor or `-CheckOnly -Json` for automation:

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
