import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { test } from 'node:test';

const plugin = new URL('../UE5HTML5Exporter/', import.meta.url);
const read = (path) => readFileSync(new URL(path, plugin), 'utf8');

test('plugin descriptor declares runtime Blueprint and editor exporter modules', () => {
  const descriptor = JSON.parse(read('UE5HTML5Exporter.uplugin'));
  assert.equal(descriptor.Modules.find((entry) => entry.Name === 'UE5HTML5ExporterRuntime')?.Type, 'Runtime');
  assert.equal(descriptor.Modules.find((entry) => entry.Name === 'UE5HTML5Exporter')?.Type, 'Editor');
  assert.equal(descriptor.Plugins.find((entry) => entry.Name === 'GLTFExporter')?.Enabled, true);
});

test('runtime module exposes Discord Activity operations as familiar Blueprint nodes', () => {
  const header = read('Source/UE5HTML5ExporterRuntime/Public/UE5HTML5DiscordBlueprintLibrary.h');
  const implementation = read('Source/UE5HTML5ExporterRuntime/Private/UE5HTML5DiscordBlueprintLibrary.cpp');
  for (const functionName of [
    'IsDiscordActivityReady', 'DiscordActivityBroadcast', 'DiscordActivityOpenInviteDialog',
    'DiscordActivityGetParticipants', 'DiscordActivityLoadWorldState', 'DiscordActivitySaveWorldState',
    'DiscordActivityLoadPlayerState', 'DiscordActivitySavePlayerState',
    'DiscordActivityGetSkus', 'DiscordActivityGetVerifiedEntitlements',
    'DiscordActivityHasEntitlement', 'DiscordActivityStartPurchase',
    'DiscordActivitySetRichPresence', 'DiscordActivityClearRichPresence',
    'DiscordActivityShareLink', 'DiscordActivityOpenExternalLink',
    'DiscordActivityChooseAndShareImage',
    'DiscordActivityGetLaunchContext', 'DiscordActivitySetOrientationLock',
    'DiscordActivitySetInteractivePip', 'DiscordActivityGetPlatformBehaviors',
    'DiscordActivityGetLocale',
  ]) {
    assert.match(header, new RegExp(functionName));
  }
  assert.match(header, /BlueprintCallable|BlueprintPure/);
  assert.match(implementation, /available after HTML5 export/);
  const listener = read('Source/UE5HTML5ExporterRuntime/Public/UE5HTML5DiscordActivityListener.h');
  for (const eventName of [
    'DiscordActivityConnectionStateChanged', 'DiscordActivityReady',
    'DiscordActivityUnavailable', 'DiscordActivityError', 'DiscordActivityWarning',
    'DiscordActivityThermalStateChanged', 'DiscordActivityOrientationChanged',
    'DiscordActivityLayoutModeChanged', 'DiscordActivityBroadcastReceived',
    'DiscordActivityPresenceChanged', 'DiscordActivityParticipantsChanged',
    'DiscordActivityVerifiedEntitlementsChanged',
  ]) assert.match(listener, new RegExp(eventName));
});

test('production web template is built and uses relative paths', () => {
  const indexUrl = new URL('Resources/WebTemplate/index.html', plugin);
  assert.ok(existsSync(indexUrl), 'run npm run build to create the bundled viewer');
  const html = readFileSync(indexUrl, 'utf8');
  assert.match(html, /\.\/runtime\/viewer-[A-Za-z0-9_-]+\.js/);
  assert.match(html, /name="ue5-activity-api" content="\/api\/activity"/);
  assert.doesNotMatch(html, /(?:src|href)="\//);
});

test('production template includes the Discord Activity API, Vercel adapter, and Supabase deployment surface', () => {
  for (const path of [
    'Resources/WebTemplate/api/activity.mjs',
    'Resources/WebTemplate/vercel.json',
    'Resources/WebTemplate/package.json',
    'Resources/WebTemplate/.env.example',
    'Resources/WebTemplate/.vercelignore',
    'Resources/WebTemplate/DISCORD_ACTIVITY_WORKFLOW.md',
    'Resources/WebTemplate/scripts/activity-preflight.mjs',
    'Resources/WebTemplate/scripts/activity-release.mjs',
    'Resources/WebTemplate/scripts/activity-release-assistant.mjs',
    'Resources/WebTemplate/serve.py',
    'Resources/WebTemplate/preview-discord-activity.cmd',
    'Resources/WebTemplate/preview-discord-activity.command',
    'Resources/WebTemplate/preview-discord-activity.sh',
    'Resources/WebTemplate/certify-browser.cmd',
    'Resources/WebTemplate/certify-browser.command',
    'Resources/WebTemplate/certify-browser.sh',
    'Resources/WebTemplate/release-discord-activity.cmd',
    'Resources/WebTemplate/release-discord-activity.command',
    'Resources/WebTemplate/release-discord-activity.sh',
    'Resources/WebTemplate/release-discord-activity-production.cmd',
    'Resources/WebTemplate/release-discord-activity-production.command',
    'Resources/WebTemplate/release-discord-activity-production.sh',
    'Resources/WebTemplate/verify-discord-activity-release.cmd',
    'Resources/WebTemplate/verify-discord-activity-release.command',
    'Resources/WebTemplate/verify-discord-activity-release.sh',
    'Resources/WebTemplate/scripts/activity-release-receipt.mjs',
    'Resources/WebTemplate/scripts/Start-DiscordActivityRelease.ps1',
  ]) assert.ok(existsSync(new URL(path, plugin)), `${path} is missing; run npm run build`);

  assert.match(read('Resources/WebTemplate/release-discord-activity.cmd'), /Start-DiscordActivityRelease\.ps1/);
  assert.match(read('Resources/WebTemplate/release-discord-activity.command'), /activity-release-assistant\.mjs --guided/);
  assert.match(read('Resources/WebTemplate/release-discord-activity.sh'), /activity-release-assistant\.mjs --guided/);
  assert.match(read('Resources/WebTemplate/release-discord-activity-production.cmd'), /--environment production --promote/);
  assert.match(read('Resources/WebTemplate/release-discord-activity-production.command'), /--environment production --promote/);
  assert.match(read('Resources/WebTemplate/release-discord-activity-production.sh'), /--environment production --promote/);
  assert.match(read('Resources/WebTemplate/verify-discord-activity-release.cmd'), /activity-release-receipt\.mjs activity-release-receipt\.json/);
  assert.match(read('Resources/WebTemplate/verify-discord-activity-release.command'), /activity-release-receipt\.mjs activity-release-receipt\.json/);
  assert.match(read('Resources/WebTemplate/verify-discord-activity-release.sh'), /activity-release-receipt\.mjs activity-release-receipt\.json/);
  assert.match(read('Resources/WebTemplate/.vercelignore'), /activity-release-receipt\.json/);
  assert.match(read('Resources/WebTemplate/.vercelignore'), /activity-release-verification\.json/);
  assert.match(read('Resources/WebTemplate/.vercelignore'), /browser-certification\.json/);
  const windowsReleaseBootstrap = read('Resources/WebTemplate/scripts/Start-DiscordActivityRelease.ps1');
  assert.match(windowsReleaseBootstrap, /\$PinnedNodeVersion = '22\.23\.2'/);
  assert.match(windowsReleaseBootstrap, /https:\/\/nodejs\.org\/dist\/v\$PinnedNodeVersion/);
  assert.match(windowsReleaseBootstrap, /Get-FileHash -LiteralPath \$archive -Algorithm SHA256/);
  assert.match(windowsReleaseBootstrap, /1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97/);
  assert.match(windowsReleaseBootstrap, /fec025a6da31757e3b6af84c5a1628e9d38442ca99a2161091d78f2fcfa35ef3/);
  assert.match(windowsReleaseBootstrap, /0d0f5e39f9f3d9587bc19f73eab3c2c9c4903fd02d6dbf9c853dd81b3d95fad4/);
  assert.match(windowsReleaseBootstrap, /97cce5301a815d2dce07ac5bfd1e6039eae88185ec1d10ae4f8cb712f1732878/);
  assert.match(windowsReleaseBootstrap, /LocalApplicationData/);
  assert.match(windowsReleaseBootstrap, /No administrator access or system PATH change is required/);
  assert.match(windowsReleaseBootstrap, /\[switch\]\$ForcePortableNode/);
  assert.match(windowsReleaseBootstrap, /\[string\]\$CacheRoot/);
  assert.match(windowsReleaseBootstrap, /\[string\]\$ReportFile/);
  assert.match(windowsReleaseBootstrap, /Get-VerifiedPortableNode/);
  assert.match(windowsReleaseBootstrap, /ue5-html5-node-runtime\/v1/);
  assert.match(windowsReleaseBootstrap, /executableSha256/);
  assert.match(windowsReleaseBootstrap, /ue5-html5-node-resolution\/v1/);
  assert.match(windowsReleaseBootstrap, /verified-portable-cache/);
  assert.match(windowsReleaseBootstrap, /Set-Content -LiteralPath \$resolvedPathFile -Value \$node/);
  assert.match(read('Resources/WebTemplate/release-discord-activity.cmd'), /activity-release-assistant\.mjs --guided %\*/);

  const migrationDirectory = new URL('Resources/WebTemplate/supabase/migrations/', plugin);
  assert.ok(existsSync(migrationDirectory));
  const coreMigration = read('Resources/WebTemplate/supabase/migrations/20260823011658_discord_activity_core.sql');
  const realtimeOptimization = read('Resources/WebTemplate/supabase/migrations/20260823011836_optimize_discord_activity_realtime_rls.sql');
  const privilegeRestriction = read('Resources/WebTemplate/supabase/migrations/20260823011940_restrict_discord_activity_service_role_privileges.sql');
  const liveCertification = read('Resources/WebTemplate/supabase/migrations/20260823104152_discord_activity_live_certification.sql');
  const liveCertificationCohorts = read('Resources/WebTemplate/supabase/migrations/20260823175001_bind_live_certification_cohorts.sql');
  assert.match(coreMigration, /revoke all on public\.discord_activity_world_state from service_role/);
  assert.match(coreMigration, /grant select, insert, update on public\.discord_activity_world_state to service_role/);
  assert.doesNotMatch(coreMigration, /grant select, insert, update, delete/);
  assert.match(realtimeOptimization, /\(select auth\.jwt\(\)\)/);
  assert.doesNotMatch(realtimeOptimization, /(?<!select )auth\.jwt\(\)/);
  assert.match(privilegeRestriction, /revoke all on public\.discord_activity_player_state from service_role/);
  assert.match(privilegeRestriction, /grant select, insert, update on public\.discord_activity_player_state to service_role/);
  assert.match(liveCertification, /alter table public\.discord_activity_live_certification_checkins enable row level security/);
  assert.match(liveCertification, /grant select, insert, update, delete on public\.discord_activity_live_certification_checkins to service_role/);
  assert.match(liveCertification, /count\(distinct active\.player_key\)/);
  assert.match(liveCertification, /interval '24 hours'/);
  assert.doesNotMatch(liveCertification, /(?:discord_user_id|username|email|billing|device_metadata)\s+(?:text|json|jsonb)/i);
  assert.match(liveCertificationCohorts, /check_in_discord_activity_certification_v2/);
  assert.match(liveCertificationCohorts, /checkin\.challenge_key = p_challenge_key/);
  assert.match(liveCertificationCohorts, /interval '10 seconds'/);
  assert.doesNotMatch(liveCertificationCohorts, /(?:discord_user_id|username|email|billing|device_metadata)\s+(?:text|json|jsonb)/i);
  const api = read('Resources/WebTemplate/api/activity.mjs');
  assert.match(api, /activity-instances/);
  assert.match(api, /SUPABASE_SECRET_KEY/);
  assert.match(api, /ue5-discord-live-certification\/v2/);
  assert.match(api, /check_in_discord_activity_certification_v2/);
  assert.doesNotMatch(api, /sb_secret_[A-Za-z0-9_-]{8,}/);
  const deploymentPackage = JSON.parse(read('Resources/WebTemplate/package.json'));
  assert.equal(deploymentPackage.scripts.preflight, 'node scripts/activity-preflight.mjs');
  assert.equal(deploymentPackage.scripts['preflight:package'], 'node scripts/activity-preflight.mjs --package-only');
  assert.equal(deploymentPackage.scripts['preflight:online'], 'node scripts/activity-preflight.mjs --online');
  assert.equal(deploymentPackage.scripts['release:activity'], 'node scripts/activity-release.mjs');
  assert.equal(deploymentPackage.scripts['release:assist'], 'node scripts/activity-release-assistant.mjs');
  assert.equal(deploymentPackage.overrides.tar, '7.5.22');
  const vercelConfig = JSON.parse(read('Resources/WebTemplate/vercel.json'));
  const cacheControl = (source) => vercelConfig.headers
    .find((entry) => entry.source === source)?.headers
    .find((entry) => entry.key === 'Cache-Control')?.value;
  for (const source of ['/runtime/(.*)', '/assets/(.*)', '/logic/(.*)']) {
    assert.equal(cacheControl(source), 'public, max-age=31536000, immutable');
  }
  for (const source of ['/api/(.*)', '/export-manifest.json', '/activity-handoff.json']) {
    assert.match(cacheControl(source), /no-store/);
  }
  const runtimeFiles = readdirSync(new URL('Resources/WebTemplate/runtime/', plugin));
  const viewerFile = runtimeFiles.find((name) => /^viewer-[A-Za-z0-9_-]+\.js$/.test(name));
  const activityFile = runtimeFiles.find((name) => /^discord-activity-[A-Za-z0-9_-]+\.js$/.test(name));
  assert.ok(viewerFile, 'content-hashed viewer bundle is missing');
  assert.ok(activityFile, 'content-hashed Discord Activity bundle is missing');
  assert.match(read('Resources/WebTemplate/index.html'), /Run two-client check/);
  assert.match(read('Resources/WebTemplate/index.html'), /Keep this game downloaded/);
  assert.match(read('Resources/WebTemplate/index.html'), /Protect cached assets/);
  assert.match(readFileSync(new URL(`Resources/WebTemplate/runtime/${activityFile}`, plugin), 'utf8'), /ue5-discord-live-certification\/v2/);
  const viewer = read(`Resources/WebTemplate/runtime/${viewerFile}`);
  const activity = read(`Resources/WebTemplate/runtime/${activityFile}`);
  assert.match(viewer, /discordactivitygetverifiedentitlements/);
  assert.match(viewer, /discordactivitystartpurchase/);
  assert.match(viewer, /discordactivitysetrichpresence/);
  assert.match(viewer, /discordactivitysharelink/);
  assert.match(viewer, /getGamepads/);
  assert.match(viewer, /gamepadfacebuttonbottom/);
  assert.match(viewer, /gamepadleft2d/);
  assert.match(activity, /startPurchase/);
  assert.match(activity, /setRichPresence/);
  assert.match(activity, /shareLink/);
  assert.match(activity, /DiscordSDKMock/);
  assert.match(activity, /preview-player/);
  assert.match(viewer, /ue5_discord_preview/);
  assert.match(viewer, /ue5-html5-browser-certification\/v3/);
  assert.match(viewer, /ue5html5_pack/);
  assert.match(viewer, /ue5_certify/);

  const serve = read('Resources/WebTemplate/serve.py');
  assert.match(serve, /127\.0\.0\.1/);
  assert.match(serve, /ue5_discord_preview=1/);
  assert.match(serve, /__ue5html5_certification__/);
  assert.match(serve, /--certify/);
  assert.match(serve, /X-UE5HTML5-Certification-Token/);
  assert.match(serve, /--check/);
  const windowsCertificationLauncher = read('Resources/WebTemplate/certify-browser.cmd');
  assert.match(windowsCertificationLauncher, /serve\.py" --certify/);
  assert.match(windowsCertificationLauncher, /setlocal EnableDelayedExpansion/);
  assert.match(windowsCertificationLauncher, /exit \/b !cert_status!/);
  assert.match(read('Resources/WebTemplate/certify-browser.command'), /serve\.py --certify/);
  assert.match(read('Resources/WebTemplate/certify-browser.sh'), /serve\.py --certify/);
  if (process.platform !== 'win32') {
    for (const path of [
      'Resources/WebTemplate/serve.py',
      'Resources/WebTemplate/preview-discord-activity.command',
      'Resources/WebTemplate/preview-discord-activity.sh',
      'Resources/WebTemplate/certify-browser.command',
      'Resources/WebTemplate/certify-browser.sh',
      'Resources/WebTemplate/release-discord-activity-production.command',
      'Resources/WebTemplate/release-discord-activity-production.sh',
    ]) assert.ok(statSync(new URL(path, plugin)).mode & 0o100, `${path} must be executable`);
  }
});

test('exporter writes the scene, manifest, and local server helper', () => {
  const source = read('Source/UE5HTML5Exporter/Private/UE5HTML5ExportLibrary.cpp');
  assert.match(source, /scene\.glb/);
  assert.match(source, /export-manifest\.json/);
  assert.match(source, /serve\.py/);
  assert.match(source, /UGLTFExporter::ExportToGLTF/);
  assert.match(source, /FUE5BlueprintGraphExporter::Export/);
  assert.match(source, /discord-activity/);
  assert.match(source, /DISCORD_ACTIVITY_WORKFLOW\.md/);
  assert.match(source, /activity-handoff\.json/);
  assert.match(source, /ue5-discord-activity-handoff\/v9/);
  assert.match(source, /projectTargets/);
  assert.match(source, /missingRequiredTargets/);
  assert.match(source, /blueprintCompatibility/);
  assert.match(source, /ue5-html5-export\/v8/);
  assert.match(source, /discordRequirements/);
  assert.match(source, /SetStringField\(TEXT\("exporterVersion"\)/);
  assert.match(source, /custom-adapters\.json/);
  assert.match(source, /custom-adapters\.js/);
  assert.match(source, /customAdapterNodeCount/);
  assert.match(source, /assetDelivery/);
  assert.match(source, /ue5-html5-asset-pack\/v3/);
  assert.match(source, /origin-scoped-content-addressed-cache/);
  assert.match(source, /unchanged-resources-across-exports/);
  assert.match(source, /pack-version-query/);
  assert.match(source, /versioned-module/);
  assert.match(source, /UE5HTML5::SHA256Hex/);
  assert.doesNotMatch(source, /GetSHA256Signature|FPlatformMisc/);
  const sha256 = read('Source/UE5HTML5Exporter/Private/UE5HTML5SHA256.cpp');
  assert.match(sha256, /class FSHA256State/);
  assert.match(sha256, /TotalBytes \* 8u/);
  assert.match(sha256, /0123456789abcdef/);
  assert.match(sha256, /e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855/);
  assert.match(sha256, /ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad/);
  assert.match(source, /VerifySHA256/);
  assert.match(source, /browserPayloadBytes/);
  assert.match(source, /not a Discord platform limit or a performance certification/);
  assert.match(source, /unreal-export-needs-blueprint-adapters/);
  for (const environmentName of [
    'DISCORD_BOT_TOKEN', 'SUPABASE_PUBLISHABLE_KEY',
    'SUPABASE_JWT_PRIVATE_KEY', 'ACTIVITY_STATE_SECRET',
  ]) assert.match(source, new RegExp(environmentName));
  assert.doesNotMatch(source, /ACTIVITY_SESSION_SECRET|SUPABASE_JWT_SECRET/);
});

test('Unreal Tools menu exposes a Discord Activity readiness check', () => {
  const module = read('Source/UE5HTML5Exporter/Private/UE5HTML5ExporterModule.cpp');
  const moduleHeader = read('Source/UE5HTML5Exporter/Public/UE5HTML5ExporterModule.h');
  const fpsSetup = read('Source/UE5HTML5Exporter/Private/UE5HTML5BrowserFPSSetup.cpp');
  const fpsSetupTest = read('Source/UE5HTML5Exporter/Private/Tests/UE5HTML5BrowserFPSSetupTests.cpp');
  const installUrlTest = read('Source/UE5HTML5Exporter/Private/Tests/UE5HTML5DiscordActivitySettingsTests.cpp');
  const receiptTest = read('Source/UE5HTML5Exporter/Private/Tests/UE5HTML5ReleaseReceiptTests.cpp');
  const library = read('Source/UE5HTML5Exporter/Private/UE5HTML5ExportLibrary.cpp');
  const commandlet = read('Source/UE5HTML5Exporter/Private/UE5HTML5ExportCommandlet.cpp');
  assert.match(module, /Check Discord Activity Readiness/);
  assert.match(module, /Export Discord Activity/);
  assert.match(module, /NEEDS BLUEPRINT ADAPTERS/);
  assert.match(module, /CheckDiscordActivityReadinessInteractive/);
  assert.match(module, /Open Discord Activity Install Page/);
  assert.match(module, /OpenDiscordActivityInstallPage/);
  assert.match(module, /FPlatformProcess::LaunchURL/);
  assert.match(module, /Verify Hosted Discord Activity Receipt/);
  assert.match(module, /VerifyDiscordActivityReleaseReceipt/);
  assert.match(module, /LaunchReleaseReceiptVerifier/);
  assert.match(module, /activity-release-verification\.json/);
  assert.match(module, /Check Blueprint Web Compatibility/);
  assert.match(module, /CheckBlueprintCompatibilityInteractive/);
  assert.match(module, /Open Custom Web Adapters Folder/);
  assert.match(module, /OpenCustomWebAdapters/);
  assert.match(module, /AnalyzeBlueprintCompatibility/);
  assert.match(module, /BLUEPRINT WEB COMPATIBILITY/);
  assert.match(module, /ProjectSavedDir/);
  assert.match(module, /BlueprintCompatibility/);
  assert.match(module, /LaunchDiscordActivityReleaseAssistant/);
  assert.match(module, /Export & Preview Discord Blueprint Logic/);
  assert.match(module, /ExportDiscordActivityPreviewInteractive/);
  assert.match(module, /LaunchDiscordActivityPreview/);
  assert.match(module, /Quick Start Discord FPS Preview/);
  assert.match(module, /QuickStartDiscordFPSPreviewInteractive/);
  assert.match(moduleHeader, /void QuickStartDiscordFPSPreviewInteractive\(\);/);
  assert.match(module, /FUE5HTML5BrowserFPSSetup::Apply\(World, false, true\)/);
  assert.match(module, /ConfirmQuickStartFPS/);
  assert.match(module, /target creation can be undone/);
  assert.match(module, /FUE5HTML5BrowserFPSSetup::Apply\(World, true, true\)/);
  assert.match(module, /ExportDiscordActivityPreviewInteractive\(\)/);
  assert.match(module, /Export & Certify Browser FPS/);
  assert.match(module, /ExportBrowserCertificationInteractive/);
  assert.match(module, /LaunchBrowserCertification/);
  assert.match(module, /SetupBrowserFPSTestLevelInteractive/);
  assert.match(module, /Set Up Browser FPS Test Level/);
  assert.match(module, /FUE5HTML5BrowserFPSSetup::Apply/);
  assert.match(module, /The first target is selected; no actor was created/);
  assert.match(fpsSetup, /FindComponentByClass<UUE5HTML5TargetComponent>/);
  assert.match(fpsSetup, /FindPreferredPlayerStart/);
  assert.match(fpsSetup, /HorizontalFacing\.Vector\(\) \* 600\.0f/);
  assert.match(fpsSetup, /FScopedTransaction/);
  assert.match(fpsSetup, /GEditor->AddActor/);
  assert.match(fpsSetup, /RF_Transactional/);
  assert.match(fpsSetup, /Transaction\.Cancel/);
  assert.match(fpsSetupTest, /UE5HTML5Exporter\.Editor\.BrowserFPSSetup/);
  assert.match(fpsSetupTest, /Preview does not create a target/);
  assert.match(fpsSetupTest, /Repeated setup creates no duplicate/);
  assert.match(fpsSetupTest, /Undo removes the created target/);
  assert.match(fpsSetupTest, /Redo restores exactly one target/);
  assert.match(installUrlTest, /UE5HTML5Exporter\.Editor\.DiscordInstallUrl/);
  assert.match(installUrlTest, /A non-digit Application ID is rejected/);
  assert.match(installUrlTest, /oauth2\/authorize\?client_id=1540833293098819795/);
  assert.match(receiptTest, /UE5HTML5Exporter\.Editor\.ReleaseReceiptWorkspace/);
  assert.match(receiptTest, /self-contained verification workspace/);
  assert.match(receiptTest, /oversized receipt is rejected/);
  assert.match(module, /browser-certification\.json/);
  assert.match(module, /certify-browser\.cmd/);
  assert.match(module, /certify-browser\.command/);
  assert.match(module, /certify-browser\.sh/);
  assert.match(module, /StopDiscordActivityPreview/);
  assert.match(module, /Binaries\/ThirdParty\/Python3\/Win64\/python\.exe/);
  assert.match(module, /Binaries\/ThirdParty\/Python3\/Mac\/bin\/python3/);
  assert.match(module, /Binaries\/ThirdParty\/Python3\/Linux\/bin\/python3/);
  assert.match(module, /ProjectSavedDir/);
  assert.match(module, /DiscordActivityPreview/);
  assert.match(module, /release-discord-activity\.cmd/);
  assert.match(module, /release-discord-activity\.command/);
  assert.match(module, /release-discord-activity\.sh/);
  assert.match(module, /non-mutating dry run/);
  assert.match(module, /Private credentials remain outside Unreal/);
  assert.match(library, /Discord features detected from Blueprints/);
  assert.match(library, /Required Discord authorization/);
  assert.match(library, /identify only/);
  assert.match(library, /rpc\.activities\.write/);
  assert.match(library, /PopulateDiscordRequirements/);
  assert.match(library, /RequiredDiscordOAuthScopes/);
  assert.match(library, /no client secret, bot token, email, billing information, or Discord player profile is written into the export/);
  assert.match(library, /DISCORD ACTIVITY ACCESS/);
  assert.match(library, /Summary\.UsedFunctions/);
  assert.match(module, /Report\.DiscordFeatures/);
  assert.match(module, /FormatDiscordAccessSummary/);
  assert.match(commandlet, /FormatDiscordAccessSummary/);
  assert.match(module, /open Project Settings and fill the missing public targets/);
  assert.match(library, /CheckDiscordActivityReadiness/);
  assert.match(library, /GLTFExporter/);
  assert.match(library, /does not certify gameplay/);
  assert.match(library, /credentials remain with the release operator/);
  assert.match(library, /scripts\/activity-release-assistant\.mjs/);
  assert.match(library, /scripts\/activity-release-receipt\.mjs/);
  assert.match(library, /PrepareReleaseReceiptVerification/);
  assert.match(library, /release-discord-activity\.cmd/);
  assert.match(library, /AnalyzeBlueprintCompatibility/);
  assert.match(library, /BLUEPRINT_COMPATIBILITY\.txt/);
  assert.match(library, /fast translator-coverage audit/);
});

test('Unreal Project Settings expose only non-secret Discord Activity targets', () => {
  const header = read('Source/UE5HTML5Exporter/Public/UE5HTML5DiscordActivitySettings.h');
  const implementation = read('Source/UE5HTML5Exporter/Private/UE5HTML5DiscordActivitySettings.cpp');
  const module = read('Source/UE5HTML5Exporter/Private/UE5HTML5ExporterModule.cpp');
  for (const field of [
    'DiscordApplicationId', 'DiscordPublicKey', 'VercelProjectName',
    'SupabaseProjectRef', 'ProductionUrl', 'BrowserPayloadBudgetMiB',
  ]) assert.match(header, new RegExp(field));
  for (const forbidden of [
    'DiscordClientSecret', 'DiscordBotToken', 'SupabaseSecretKey',
    'SupabaseJwtPrivateKey', 'ActivityStateSecret',
  ]) assert.doesNotMatch(header, new RegExp(forbidden));
  assert.match(header, /Config = Game, DefaultConfig/);
  assert.match(implementation, /ValidateTargets/);
  assert.match(implementation, /HasCompleteTargetSet/);
  assert.match(implementation, /GetMissingRequiredTargets/);
  assert.match(header, /TryGetDiscordInstallUrl/);
  assert.match(implementation, /https:\/\/discord\.com\/oauth2\/authorize\?client_id=%s/);
  assert.match(implementation, /IsValidDiscordApplicationId/);
  assert.match(header, /ImportPublicTargets/);
  assert.match(header, /ExportPublicTargets/);
  assert.match(implementation, /ue5-discord-activity-project-targets\/v1/);
  assert.match(implementation, /AllowedFields/);
  assert.match(implementation, /containsSecrets/);
  assert.match(implementation, /unsupported field/);
  assert.match(implementation, /TryUpdateDefaultConfigFile/);
  assert.match(implementation, /complete Discord, Vercel, and Supabase target set/);
  assert.match(module, /Discord Activity Project Settings/);
  assert.match(module, /Import Public Discord Activity Targets/);
  assert.match(module, /Export Public Discord Activity Targets/);
  assert.match(module, /ImportDiscordActivityProjectTargets/);
  assert.match(module, /ExportDiscordActivityProjectTargets/);
  assert.match(module, /JSON files \(\*\.json\)\|\*\.json/);
  assert.match(module, /Credential fields and player data are not part of this contract/);
});

test('Unreal commandlet exposes the same readiness policy for workstation automation', () => {
  const commandlet = read('Source/UE5HTML5Exporter/Private/UE5HTML5ExportCommandlet.cpp');
  const rootReadme = read('../README.md');
  const workflow = read('../docs/DISCORD_ACTIVITY_WORKFLOW.md');
  const bundledWorkflow = read('Resources/WebTemplate/DISCORD_ACTIVITY_WORKFLOW.md');
  assert.match(commandlet, /FParse::Param\(\*Params, TEXT\("CheckOnly"\)\)/);
  assert.match(commandlet, /FUE5HTML5ExportLibrary::CheckDiscordActivityReadiness\(World\)/);
  assert.match(commandlet, /Discord Activity readiness check passed/);
  assert.match(commandlet, /Readiness blocker/);
  assert.match(commandlet, /BlueprintCheckOnly/);
  assert.doesNotMatch(rootReadme, /CheckBlueprintsOnly/);
  assert.doesNotMatch(workflow, /CheckBlueprintsOnly/);
  assert.doesNotMatch(bundledWorkflow, /CheckBlueprintsOnly/);
  assert.match(commandlet, /FailOnUnsupported/);
  assert.match(commandlet, /AnalyzeBlueprintCompatibility/);
  assert.match(commandlet, /return 6/);
  assert.match(commandlet, /ProjectTargets=/);
  assert.match(commandlet, /ExportProjectTargets=/);
  assert.match(commandlet, /ImportPublicTargets/);
  assert.match(commandlet, /ExportPublicTargets/);
  assert.match(commandlet, /return 7/);
  assert.match(commandlet, /return 8/);
});

test('Blueprint exporter preserves graph pins and writes browser IR', () => {
  const source = read('Source/UE5HTML5Exporter/Private/UE5BlueprintGraphExporter.cpp');
  assert.match(source, /ue-blueprint-ir\/v1/);
  assert.match(source, /Pin->LinkedTo/);
  assert.match(source, /blueprints\.json/);
  assert.match(source, /unsupportedCount/);
  assert.match(source, /UnsupportedNodes/);
  assert.match(source, /project-adapter/);
  assert.match(source, /CustomAdapterNodeCount/);
  assert.match(source, /runtimeValidationRequired/);
  assert.match(source, /BlueprintName/);
  assert.match(source, /UInputMappingContext::StaticClass/);
  assert.match(source, /UBehaviorTree::StaticClass/);
  assert.match(source, /UWidgetBlueprint::StaticClass/);
  assert.match(source, /widgetBlueprints/);
  assert.match(source, /ResolveGameModeClass/);
  assert.match(source, /DefaultPawnClass/);
  assert.match(source, /playerStart/);
  assert.match(source, /firstPerson/);
  assert.match(source, /SimpleConstructionScript/);
  assert.match(source, /BlueprintFunctions/);
  assert.match(source, /switchString/);
  assert.match(source, /Function = GraphName/);
  assert.match(source, /discordactivity/);
  for (const eventName of ['primarythumbstick', 'secondarythumbstick', 'touchjumpstart', 'touchjumpend']) {
    assert.match(source, new RegExp(eventName));
  }
  assert.match(source, /browser-touch-controls/);
});

test('Enhanced Input metadata is read from enhanced mappings', () => {
  const source = read('Source/UE5HTML5Exporter/Private/UE5BlueprintGraphExporter.cpp');
  const legacyStart = source.indexOf('for (const FInputActionKeyMapping& Mapping');
  const enhancedStart = source.indexOf('for (const FEnhancedActionKeyMapping& Mapping');
  assert.ok(legacyStart >= 0 && enhancedStart > legacyStart);

  const legacyMappingBlock = source.slice(legacyStart, enhancedStart);
  assert.doesNotMatch(legacyMappingBlock, /Mapping\.Action->/);
  assert.doesNotMatch(legacyMappingBlock, /Mapping\.(?:Modifiers|Triggers)\b/);

  const enhancedMappingBlock = source.slice(enhancedStart, source.indexOf('Root->SetArrayField(TEXT("inputMappings")', enhancedStart));
  for (const member of ['Action', 'Modifiers', 'Triggers']) {
    assert.match(enhancedMappingBlock, new RegExp(`Mapping\\.${member}`));
  }
  assert.match(enhancedMappingBlock, /Mapping\.Action->ValueType/);
  assert.match(enhancedMappingBlock, /Mapping\.Action->Modifiers/);
  assert.match(enhancedMappingBlock, /Mapping\.Action->Triggers/);
  assert.match(enhancedMappingBlock, /triggerDetails/);
  for (const field of ['actuationThreshold', 'holdTimeThreshold', 'tapReleaseTimeThreshold', 'interval', 'triggerLimit', 'oneShot', 'triggerOnStart']) {
    assert.match(source, new RegExp(field));
  }
});

test('viewer exposes errors and animation selection', () => {
  const source = readFileSync(new URL('../web/src/main.js', import.meta.url), 'utf8');
  assert.match(source, /configureAnimations/);
  assert.match(source, /errorPanel\.hidden = false/);
  assert.match(source, /renderer\.setAnimationLoop/);
  assert.match(source, /BlueprintRuntime/);
  assert.match(source, /BrowserRuntimeAdapters/);
  assert.match(source, /loadExportManifest/);
  assert.match(source, /primary payload/);
  assert.match(source, /delivery review/);
});

test('browser adapters cover gameplay integration families', () => {
  const source = readFileSync(new URL('../web/src/runtime-adapters.js', import.meta.url), 'utf8');
  for (const symbol of ['ReplicationAdapter', 'EnhancedInputAdapter', 'CollisionAdapter', 'PhysicsAdapter', 'AbilitySystemAdapter', 'WidgetAdapter', 'ParticleAdapter', 'BehaviorTreeAdapter']) {
    assert.match(source, new RegExp(`class ${symbol}`));
  }
  assert.match(source, /registerFunction/);
  assert.match(source, /addmovementinput/);
  assert.match(source, /attachGameplayController/);
  assert.match(source, /callDiscordActivity/);
  assert.match(source, /shouldUseTouchControls/);
  assert.match(source, /DiscordActivityThermalStateChanged/);
  assert.match(source, /DiscordActivityBroadcastReceived/);
  assert.match(source, /DiscordActivityConnectionStateChanged/);
  assert.match(source, /playsound2d/);
  assert.match(source, /playsoundatlocation/);
  assert.match(source, /attachAudioListener/);
  const audio = readFileSync(new URL('../web/src/audio-adapter.js', import.meta.url), 'utf8');
  assert.match(audio, /unrealAudioLocationToWebAudio/);
  assert.match(audio, /panningModel = 'HRTF'/);
  assert.match(audio, /distanceModel = 'inverse'/);
  const exporter = readFileSync(new URL('../UE5HTML5Exporter/Source/UE5HTML5Exporter/Private/UE5BlueprintGraphExporter.cpp', import.meta.url), 'utf8');
  assert.match(exporter, /USoundExporterWAV/);
  assert.match(exporter, /ue5-html5-audio-assets\/v1/);
});

test('first-person controller converts Unreal coordinates and consumes exported movement defaults', async () => {
  const THREE = await import('three');
  const {
    FirstPersonController,
    shouldUseTouchControls,
    unrealVectorToThree,
  } = await import('../web/src/first-person-controller.js');
  const converted = unrealVectorToThree({ x: 100, y: 200, z: 300 });
  assert.deepEqual(converted.toArray(), [1, 3, -2]);

  const documentTarget = new EventTarget();
  documentTarget.pointerLockElement = null;
  const canvasTarget = new EventTarget();
  canvasTarget.ownerDocument = documentTarget;
  canvasTarget.requestPointerLock = () => { documentTarget.pointerLockElement = canvasTarget; };
  const controller = new FirstPersonController(
    new THREE.PerspectiveCamera(),
    canvasTarget,
    new THREE.Group(),
    {
      profile: 'firstPerson',
      playerStart: { location: { x: 100, y: 0, z: 200 } },
      movement: { maxWalkSpeed: 420, jumpVelocity: 510, gravityScale: 1.25, capsuleRadius: 40, capsuleHalfHeight: 90 },
    },
    {},
    new EventTarget(),
  );
  assert.equal(controller.enabled, true);
  assert.equal(controller.moveSpeed, 4.2);
  assert.equal(controller.jumpVelocity, 5.1);
  assert.equal(controller.gravity, 12.25);
  assert.equal(controller.radius, 0.4);
  controller.groundGrace = 0.1;
  assert.equal(controller.jump(), true);
  assert.equal(controller.velocity.y, 5.1);
  controller.dispose();

  assert.equal(shouldUseTouchControls({
    matchMedia: () => ({ matches: true }),
  }, { maxTouchPoints: 0 }), true);
  assert.equal(shouldUseTouchControls({
    matchMedia: () => ({ matches: false }),
  }, { maxTouchPoints: 2 }), true);
  assert.equal(shouldUseTouchControls({
    matchMedia: () => ({ matches: false }),
  }, { maxTouchPoints: 0 }), false);
  assert.equal(shouldUseTouchControls({
    matchMedia: (query) => ({ matches: query === '(pointer: fine)' }),
  }, { maxTouchPoints: 5 }), false);
});

test('Unreal target component exports a no-JavaScript target-practice contract', () => {
  const component = read('Source/UE5HTML5ExporterRuntime/Public/UE5HTML5TargetComponent.h');
  const implementation = read('Source/UE5HTML5ExporterRuntime/Private/UE5HTML5TargetComponent.cpp');
  const targetActor = read('Source/UE5HTML5ExporterRuntime/Public/UE5HTML5PracticeTargetActor.h');
  const targetActorImplementation = read('Source/UE5HTML5ExporterRuntime/Private/UE5HTML5PracticeTargetActor.cpp');
  const exporter = read('Source/UE5HTML5Exporter/Private/UE5BlueprintGraphExporter.cpp');
  const main = readFileSync(new URL('../web/src/main.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');

  assert.match(component, /BlueprintSpawnableComponent/);
  assert.match(component, /MaxHealth/);
  assert.match(component, /DamagePerShot/);
  assert.match(component, /ScoreValue/);
  assert.match(component, /RespawnDelaySeconds/);
  assert.match(component, /ApplyTargetPracticeDamage/);
  assert.match(component, /OnTargetDepleted/);
  assert.match(implementation, /SetActorHiddenInGame\(true\)/);
  assert.match(implementation, /SetTimer/);
  assert.match(targetActor, /UE5 HTML5 Practice Target/);
  assert.match(targetActor, /TargetRules/);
  assert.match(targetActorImplementation, /Engine\/BasicShapes\/Cube/);
  assert.match(targetActorImplementation, /CreateDefaultSubobject<UUE5HTML5TargetComponent>/);
  assert.match(exporter, /FindComponentByClass<UUE5HTML5TargetComponent>/);
  assert.match(exporter, /SetArrayField\(TEXT\("targets"\)/);
  assert.match(exporter, /hitFlashSeconds/);
  assert.match(main, /TargetPracticeRuntime/);
  assert.match(main, /targetPractice\?\.applyHit\(hit\)/);
  assert.match(html, /fps-target-score/);
  assert.match(html, /fps-target-count/);
});

test('mobile first-person controls provide move, look, jump, and fire without pointer lock', async () => {
  const THREE = await import('three');
  const { FirstPersonController } = await import('../web/src/first-person-controller.js');
  class TouchTarget extends EventTarget {
    constructor() {
      super();
      this.hidden = true;
      this.style = {};
      this.targets = new Map();
    }
    querySelector(selector) { return this.targets.get(selector) || null; }
    setPointerCapture() {}
  }
  const eventTarget = new TouchTarget();
  eventTarget.navigator = { maxTouchPoints: 5 };
  eventTarget.matchMedia = () => ({ matches: true });
  const documentTarget = new TouchTarget();
  documentTarget.pointerLockElement = null;
  const controls = new TouchTarget();
  const move = new TouchTarget();
  const knob = new TouchTarget();
  const look = new TouchTarget();
  const jump = new TouchTarget();
  const shoot = new TouchTarget();
  controls.targets.set('[data-touch-move]', move);
  controls.targets.set('[data-touch-move-knob]', knob);
  controls.targets.set('[data-touch-look]', look);
  controls.targets.set('[data-touch-jump]', jump);
  controls.targets.set('[data-touch-shoot]', shoot);
  documentTarget.targets.set('#touch-controls', controls);
  const canvas = new TouchTarget();
  canvas.ownerDocument = documentTarget;
  let requestedPointerLock = false;
  canvas.requestPointerLock = () => { requestedPointerLock = true; };
  let shots = 0;
  let jumps = 0;
  let blueprintTouchHandled = false;
  const touchEvents = [];
  const controller = new FirstPersonController(
    new THREE.PerspectiveCamera(),
    canvas,
    new THREE.Group(),
    { profile: 'firstPerson', movement: {} },
    {
      shoot: () => { shots += 1; },
      jump: ({ jumped }) => { if (jumped) jumps += 1; },
      primaryThumbstick: (args) => { touchEvents.push(['primary', args]); return blueprintTouchHandled; },
      secondaryThumbstick: (args) => { touchEvents.push(['secondary', args]); return blueprintTouchHandled; },
      touchJumpStart: () => { touchEvents.push(['jump-start']); return blueprintTouchHandled; },
      touchJumpEnd: () => { touchEvents.push(['jump-end']); return blueprintTouchHandled; },
    },
    eventTarget,
  );
  const pointer = (type, { pointerId = 1, clientX = 0, clientY = 0 } = {}) => {
    const event = new Event(type, { cancelable: true });
    Object.defineProperties(event, {
      pointerId: { value: pointerId },
      clientX: { value: clientX },
      clientY: { value: clientY },
    });
    return event;
  };

  assert.equal(controller.touchEnabled, true);
  assert.equal(controls.hidden, false);
  canvas.dispatchEvent(new Event('click'));
  assert.equal(requestedPointerLock, false);
  move.dispatchEvent(pointer('pointerdown', { clientX: 50, clientY: 100 }));
  move.dispatchEvent(pointer('pointermove', { clientX: 77, clientY: 73 }));
  assert.ok(controller.touchMovement.x > 0);
  assert.ok(controller.touchMovement.y > 0);
  controller.update(1 / 60);
  assert.equal(touchEvents.some(([name]) => name === 'primary'), true);
  const yawBefore = controller.yaw;
  look.dispatchEvent(pointer('pointerdown', { pointerId: 2, clientX: 200, clientY: 100 }));
  look.dispatchEvent(pointer('pointermove', { pointerId: 2, clientX: 230, clientY: 115 }));
  assert.ok(controller.yaw > yawBefore);
  assert.equal(touchEvents.some(([name]) => name === 'secondary'), true);
  look.dispatchEvent(pointer('pointerup', { pointerId: 2 }));
  controller.groundGrace = 0.1;
  jump.dispatchEvent(pointer('pointerdown', { pointerId: 3 }));
  jump.dispatchEvent(pointer('pointerup', { pointerId: 3 }));
  shoot.dispatchEvent(pointer('pointerdown', { pointerId: 4 }));
  assert.equal(jumps, 1);
  assert.equal(shots, 1);
  assert.equal(touchEvents.some(([name]) => name === 'jump-start'), true);
  assert.equal(touchEvents.some(([name]) => name === 'jump-end'), true);
  move.dispatchEvent(pointer('pointerup'));
  assert.deepEqual(controller.touchMovement.toArray(), [0, 0]);

  blueprintTouchHandled = true;
  move.dispatchEvent(pointer('pointerdown', { pointerId: 5, clientX: 50, clientY: 100 }));
  move.dispatchEvent(pointer('pointermove', { pointerId: 5, clientX: 77, clientY: 73 }));
  controller.velocity.set(0, 0, 0);
  controller.update(1 / 60);
  assert.equal(controller.velocity.x, 0);
  assert.equal(controller.velocity.z, 0);
  move.dispatchEvent(pointer('pointerup', { pointerId: 5 }));

  const blueprintYawBefore = controller.yaw;
  look.dispatchEvent(pointer('pointerdown', { pointerId: 6, clientX: 200, clientY: 100 }));
  look.dispatchEvent(pointer('pointermove', { pointerId: 6, clientX: 230, clientY: 115 }));
  assert.equal(controller.yaw, blueprintYawBefore);
  look.dispatchEvent(pointer('pointerup', { pointerId: 6 }));

  controller.velocity.y = 0;
  controller.groundGrace = 0.1;
  jump.dispatchEvent(pointer('pointerdown', { pointerId: 7 }));
  assert.equal(controller.velocity.y, 0);
  assert.equal(jumps, 1);
  jump.dispatchEvent(pointer('pointerup', { pointerId: 7 }));
  controller.dispose();
  assert.equal(controls.hidden, true);
});

test('exported ShouldUseTouchControls Blueprint calls share the controller capability decision', async () => {
  const THREE = await import('three');
  const { BrowserRuntimeAdapters } = await import('../web/src/runtime-adapters.js');
  const touchWindow = new EventTarget();
  touchWindow.navigator = { maxTouchPoints: 3 };
  touchWindow.matchMedia = () => ({ matches: true });
  const adapters = new BrowserRuntimeAdapters(new THREE.Group(), {
    inputMappings: [],
    widgetBlueprints: [],
    behaviorTrees: [],
  }, {}, touchWindow);

  assert.deepEqual(adapters.call('ShouldUseTouchControls', {}, {}), {
    handled: true,
    value: true,
  });
  adapters.dispose();
});

test('Unreal module declares editor dependencies for exported adapter assets', () => {
  const rules = read('Source/UE5HTML5Exporter/UE5HTML5Exporter.Build.cs');
  for (const module of ['EnhancedInput', 'EngineSettings', 'AIModule', 'UMG', 'UMGEditor']) assert.match(rules, new RegExp(`"${module}"`));
});

test('Windows teammates have native PowerShell install and packaging helpers', () => {
  const tools = readFileSync(new URL('../scripts/UE5HTML5Tools.psm1', import.meta.url), 'utf8');
  const launcher = readFileSync(new URL('../scripts/Install-UE5HTML5Exporter.cmd', import.meta.url), 'utf8');
  const certificationLauncher = readFileSync(new URL('../scripts/Certify-UE5HTML5Exporter.cmd', import.meta.url), 'utf8');
  const start = readFileSync(new URL('../scripts/Start-UE5HTML5Setup.ps1', import.meta.url), 'utf8');
  const startCertification = readFileSync(new URL('../scripts/Start-UE5HTML5Certification.ps1', import.meta.url), 'utf8');
  const setup = readFileSync(new URL('../scripts/Setup-UE5HTML5Exporter.ps1', import.meta.url), 'utf8');
  const install = readFileSync(new URL('../scripts/Install-UE5HTML5Exporter.ps1', import.meta.url), 'utf8');
  const pack = readFileSync(new URL('../scripts/Package-UE5HTML5Exporter.ps1', import.meta.url), 'utf8');
  const verify = readFileSync(new URL('../scripts/Verify-UE5HTML5Exporter.ps1', import.meta.url), 'utf8');
  const sourcePackager = readFileSync(new URL('../scripts/package-source-plugin.mjs', import.meta.url), 'utf8');
  const ciWorkflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const windowsWorkflow = readFileSync(new URL('../.github/workflows/package-unreal-windows.yml', import.meta.url), 'utf8');
  for (const script of [start, startCertification, setup, install, pack, verify]) {
    assert.doesNotMatch(script, /\[string\]\$Plugin\s*=\s*\(Join-Path \$PSScriptRoot/);
  }
  assert.match(tools, /LauncherInstalled\.dat/);
  assert.match(tools, /Microsoft\.VisualStudio\.Workload\.NativeGame/);
  assert.match(tools, /10\.0\.22621\.0/);
  assert.match(tools, /17\.14/);
  assert.match(tools, /18\.0/);
  assert.match(tools, /Get-UE5HTML5DirectoryInventory/);
  assert.match(tools, /Get-UE5HTML5NodeResolutionEvidence/);
  assert.match(tools, /ue5-html5-node-resolution-evidence\/v1/);
  assert.match(tools, /does not match its verified runtime manifest/);
  assert.match(tools, /ue5-html5-directory-inventory\/v1/);
  assert.match(tools, /Get-UE5HTML5EditorAutomationEvidence/);
  assert.match(tools, /ue5-html5-editor-automation-evidence\/v2/);
  assert.match(launcher, /Start-UE5HTML5Setup\.ps1/);
  assert.match(launcher, /--check/);
  assert.match(launcher, /ExecutionPolicy Bypass/);
  assert.match(certificationLauncher, /Start-UE5HTML5Certification\.ps1/);
  assert.match(certificationLauncher, /--check/);
  assert.match(certificationLauncher, /ExecutionPolicy Bypass/);
  assert.match(start, /System\.Windows\.Forms\.OpenFileDialog/);
  assert.match(start, /\.uproject/);
  assert.match(start, /Setup-UE5HTML5Exporter\.ps1/);
  assert.match(start, /LauncherCheck/);
  assert.match(start, /MessageBoxButtons\]::YesNo/);
  assert.match(start, /\$Replace = \$true/);
  assert.match(start, /arguments\.Launch = \$true/);
  assert.match(startCertification, /System\.Windows\.Forms\.OpenFileDialog/);
  assert.match(startCertification, /Microsoft\.VisualBasic\.Interaction/);
  assert.match(startCertification, /Verify-UE5HTML5Exporter\.ps1/);
  assert.match(startCertification, /Saved\\UE5HTML5Certification/);
  assert.match(startCertification, /workstation-certification\.json/);
  assert.match(startCertification, /CertifyBrowser = \$true/);
  assert.match(startCertification, /Keep the browser open until it reports PASS/);
  assert.match(startCertification, /checksum-verified portable copy/);
  assert.match(startCertification, /does not change system PATH/);
  assert.match(setup, /Get-UE5HTML5WorkstationReport/);
  assert.match(setup, /CheckOnly/);
  assert.match(setup, /Install-UE5HTML5Exporter\.ps1/);
  assert.match(install, /\.ue5html5-backups/);
  assert.match(install, /UE5HTML5Exporter\.uplugin/);
  assert.match(pack, /RunUAT\.bat/);
  assert.match(pack, /BuildPlugin/);
  assert.match(pack, /Win64/);
  assert.match(verify, /-CheckOnly/);
  assert.match(verify, /activity-preflight\.mjs/);
  assert.match(verify, /workstation-certification\.json/);
  assert.match(verify, /workstation-certification\.sha256/);
  assert.match(verify, /Start-DiscordActivityRelease\.ps1/);
  assert.match(verify, /Get-UE5HTML5NodeResolutionEvidence/);
  assert.match(tools, /verified-portable-cache/);
  assert.match(verify, /nodeRuntime = \[ordered\]@/);
  assert.match(verify, /ue5-html5-workstation-certification\/v8/);
  assert.match(tools, /runtimeReadyFromNavigationStartMs/);
  assert.match(tools, /averageFramesPerSecond/);
  assert.match(tools, /proxy-versioned cold\/warm coverage/);
  assert.match(tools, /deviceMetadataCollected = \$false/);
  assert.match(verify, /UE5HTML5Exporter\.Editor\.BrowserFPSSetup/);
  assert.match(verify, /UE5HTML5Exporter\.Editor\.DiscordInstallUrl/);
  assert.match(verify, /Automation RunTests \$editorAutomationFilter/);
  assert.match(verify, /Automation RunTests/);
  assert.match(verify, /Automation Test Queue Empty/);
  assert.match(verify, /Get-UE5HTML5EditorAutomationEvidence/);
  assert.match(verify, /editorSetupAutomation = \$editorSetupAutomation/);
  assert.match(verify, /Remove-Item -LiteralPath \$editorAutomationReportPath -Recurse -Force/);
  assert.match(verify, /\[switch\]\$CertifyBrowser/);
  assert.match(verify, /Get-UE5HTML5BrowserCertificationEvidence/);
  assert.match(verify, /ExpectedAssetPackSchema/);
  assert.match(verify, /browserCertification = \$browserCertification/);
  assert.match(verify, /ThirdParty\\Python3\\Win64\\python\.exe/);
  assert.match(verify, /Get-Command py/);
  assert.match(verify, /Get-Command python/);
  assert.match(verify, /--certify --certification-timeout/);
  assert.match(tools, /Resolve-UE5HTML5CertificationSource/);
  assert.match(tools, /SourceCommit -notmatch '\^\[0-9a-fA-F\]\{40\}\$'/);
  assert.match(verify, /Get-UE5HTML5DirectoryInventory/);
  assert.match(verify, /credentialsAccessed = \$false/);
  assert.match(verify, /personalPlayerDataCollected = \$false/);
  assert.match(verify, /Get-UE5HTML5WorkstationReport/);
  assert.match(verify, /visualStudioVersion/);
  assert.match(verify, /blueprintCompatibility/);
  assert.match(verify, /passed-with-blueprint-adapters-required/);
  assert.match(verify, /Package-UE5HTML5Exporter\.ps1/);
  assert.match(verify, /Install-UE5HTML5Exporter\.ps1/);
  assert.match(verify, /projectFile/);
  assert.doesNotMatch(verify, /project = \$projectPath|pluginPackage = \$packagePath|export = \$exportPath/);
  assert.match(sourcePackager, /ue5-html5-source-revision\/v1/);
  assert.match(sourcePackager, /source-revision\.json/);
  assert.match(sourcePackager, /checksum-verified portable runtime/);
  assert.match(windowsWorkflow, /Require commit-clean certification source/);
  assert.match(windowsWorkflow, /SourceCommit = \$env:GITHUB_SHA/);
  assert.match(windowsWorkflow, /certify_browser:/);
  assert.match(windowsWorkflow, /arguments\.CertifyBrowser = \$true/);
  assert.match(windowsWorkflow, /actions\/attest@v4/);
  assert.match(ciWorkflow, /verified-portable-download/);
  assert.match(ciWorkflow, /verified-portable-cache/);
  assert.match(ciWorkflow, /Portable Node cache repair evidence is invalid/);
  assert.match(ciWorkflow, /x64\.backup-\*/);
  assert.match(ciWorkflow, /executableSha256/);
  assert.match(windowsWorkflow, /UE5HTML5Exporter-Win64-Certification-\$\{\{ github\.sha \}\}/);
});
