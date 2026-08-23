# Discord Activity release workflow

This exporter can produce a Discord Activity-ready folder. The exported game remains playable as an ordinary website, while Discord launch, verified identity, and persistent saves turn on automatically inside Discord after the base configuration. Private Supabase Broadcast/Presence is an optional multiplayer layer.

Discord runs Activities on desktop, web, iOS, and Android. Standard first-person exports detect touch-capable clients and provide safe-area-aware movement, look, Jump, and Fire controls without changing the Unreal project. Desktop clients retain pointer-lock mouse and keyboard controls.

## Architecture

| Layer | Responsibility | Trusted for authority? |
|---|---|---|
| UE5 + exporter | Scene, Blueprint IR, browser runtime, Activity adapter | No; all browser code can be modified |
| Discord | Launch context, OAuth identity, Activity participants, Discovery, native purchases | SDK data is UI-only; HTTP API responses from the backend are authoritative |
| HTTPS host + Activity API | Static game hosting, confidential OAuth exchange, Activity Instance checks, entitlement verification, save/load API | Yes, while secrets stay server-side |
| Supabase | Game-created world/player state; optional private Broadcast/Presence | Yes through the server-only secret key and, when enabled, Realtime RLS |

The included deployment adapter uses Vercel, but Discord does not require Vercel. The player sees one Discord authorization flow. The OAuth access token exists in browser memory only long enough to complete Discord SDK authentication, then it is cleared. The Activity API issues a short-lived, signed, HttpOnly `Secure; SameSite=None; Partitioned` session cookie containing only opaque HMAC keys and an expiry. No Supabase Auth user or profile is created. The backend rechecks the Activity Instance through Discord before every privileged operation. Persistent player state is keyed by a one-way HMAC of the verified Discord user ID, so it survives switching Discord clients without storing that raw ID. When optional Realtime is configured, the backend also mints a short-lived Supabase JWT limited to one opaque private topic.

For production defense in depth, the API can also require Discord's signed proxy-authentication headers. This proves that a privileged POST passed through the configured Discord Activity proxy before the existing OAuth, instance-membership, session-cookie, and entitlement checks run. The signed proxy payload is verified in memory and is never written to Supabase.

Supabase is the persistence/Realtime layer, not the static game host: Supabase Storage returns HTML files as plain text. Host the exported files on Vercel or another HTTPS static host. If the Activity API is deployed separately, change the `ue5-activity-api` meta tag in `index.html` to a relative proxy prefix and add the corresponding Discord URL mapping. Keep API calls same-origin from the iframe so the host-only Activity cookie remains the authority boundary.

## 1. Supabase

Supabase Free and Pro use the same integration contract. A Pro account is a good production choice, but plan level does not change the privacy model or turn Supabase Storage into the game host. Store only game-created world/player state in the private tables below; Discord remains the system for player identity, authorization, and billing.

1. Create a Supabase project.
2. Optional Realtime only: in **Realtime Settings**, disable **Allow public access** so every channel must pass Realtime Authorization.
3. Optional Realtime only: generate an ES256 signing key, import it under **Authentication → Signing Keys**, then activate it. Keep the private JWK only in your password manager and Vercel; Supabase cannot reveal an imported private key later. Skip this step for Discord auth plus server-mediated save/load.

   ```bash
   supabase gen signing-key --algorithm ES256
   ```

4. Apply the SQL file in `supabase/migrations/` with the Supabase CLI:

   ```bash
   supabase link --project-ref YOUR_PROJECT_REF
   supabase db push
   ```

5. From the project **Connect** dialog or **Settings → API Keys**, copy a publishable key (`sb_publishable_...`) and create/copy a secret key (`sb_secret_...`). Do not use a secret key in browser code. The secret key is sufficient for the base persistence path.
6. Run the Security Advisor and verify RLS is enabled on both `discord_activity_*` tables.

The migration explicitly revokes browser access to both state tables and grants only the server-side secret role access to the atomic save functions. When optional Realtime is enabled, its authorization accepts short-lived `authenticated` JWTs only when their opaque `activity_topic` claim exactly matches the private channel being joined. Raw Discord IDs, names, avatars, email, OAuth tokens, entitlements, and billing data are not stored. Rotating `ACTIVITY_STATE_SECRET` invalidates all Activity session cookies and changes the opaque state keys, so plan a state migration before rotating it in production.

### Local Unreal development preview

Before creating or configuring any hosted service, choose **Tools → HTML5 Export → Export & Preview Discord Blueprint Logic**. The plugin exports the open level to `Saved/UE5HTML5/DiscordActivityPreview`, uses Unreal's bundled Python to serve it on loopback, and opens the browser with an explicit local-only preview flag. The runtime then uses Discord's official `DiscordSDKMock`, a synthetic participant, looped-back Broadcast, mock entitlements, and revisioned browser-local game state. It never calls Discord, Vercel, Supabase, OAuth, or billing.

The same export also includes `preview-discord-activity.cmd`, `.command`, and `.sh` launchers for reopening the preview outside Unreal. This is a fast Blueprint logic check, not proof of the iframe proxy, Activity-instance authentication, Supabase Realtime, mobile behavior, real purchases, or multiple Discord clients. Continue through the hosted checks below before release.

### Guided cross-platform release

Before exporting, configure this game's Discord Application ID/public key, Vercel project name, Supabase project ref, and optional production URL. A release operator can choose **Export Public Discord Activity Targets…** and teammates can import the resulting `ue5-discord-activity-project-targets/v1` JSON through **Import Public Discord Activity Targets…**. The importer has a closed field allowlist, requires `containsSecrets: false`, validates the complete set before changing anything, and rejects unknown fields. Manual entry under **Discord Activity Project Settings…** remains available. These are public identifiers stored in `DefaultGame.ini`; never enter a Discord secret/token, Supabase secret/signing key, or Activity state secret. The guided exporter requires all four non-optional values, names any missing fields, and offers to open the settings page instead of failing later in a terminal. The exporter copies only the allowlisted public fields and their completion status into `activity-handoff.json`.

The shareable file has exactly this shape:

```json
{
  "schema": "ue5-discord-activity-project-targets/v1",
  "containsSecrets": false,
  "discordApplicationId": "123456789012345678",
  "discordPublicKey": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "vercelProjectName": "my-discord-game",
  "supabaseProjectRef": "abcdefghijklmnopqrst",
  "productionUrl": "https://game.example.com"
}
```

Replace every example value with the actual public project value. `productionUrl` may be an empty string until a production domain exists. Do not add fields. In particular, never add `discordClientSecret`, `discordBotToken`, `supabaseSecretKey`, `supabaseJwtPrivateKey`, `activityStateSecret`, access tokens, emails, player identifiers, or billing records. `containsSecrets: false` is an explicit handoff declaration, not a substitute for reviewing the file before sharing it.

Commandlet automation can apply and verify the same contract before export:

```text
UnrealEditor-Cmd MyGame.uproject -run=UE5HTML5Export -ProjectTargets=/absolute/path/discord-activity-project-targets.json -Map=/Game/Maps/Main -CheckOnly -unattended -nop4
```

Use `-ExportProjectTargets=/absolute/path/discord-activity-project-targets.json` without `-Map` to write the current configured target set. Invalid imports return status `7`; export failures return status `8`.

After **Export Discord Activity…**, Unreal offers to start the correct one-command assistant immediately. You can also launch it later by double-clicking `release-discord-activity.cmd` on Windows or `release-discord-activity.command` on macOS; on Linux run `./release-discord-activity.sh`. The assistant reads public identity from `activity-handoff.json`, installs pinned Vercel and Supabase CLIs locally, and invokes the release workflow without creating an environment file. On Windows, a missing or outdated Node.js produces an explicit consent prompt for a pinned official portable ZIP; the launcher verifies its architecture-specific SHA-256 before placing it under Local AppData, without administrator access or a system PATH change. No global CLI installation or web-project command knowledge is required.

The platform launcher always runs the non-mutating plan first, then asks a plain yes/no question before it invokes `--apply` in the same terminal. Answering No, a failed plan, or non-interactive use performs no hosted changes. The underlying Node.js 22 command remains dry-run-only unless `--apply` is present. Both paths read public targets from `activity-handoff.json`, check that `DISCORD_CLIENT_ID`, `DISCORD_PUBLIC_KEY`, and `SUPABASE_URL` agree, and refuse to silently switch an existing Vercel link.

For manual or CI use, the same zero-file dry-run is:

```bash
npm install
npm run release:activity -- \
  --vercel-only-secrets \
  --supabase-cli-keys
```

That manual command remains useful for CI and custom automation. The workstation launchers perform the install, select both safe modes, and offer the apply step only after the dry-run plan succeeds. Advanced automation may pass `--apply` directly. `.env.example` remains available solely for optional CI/advanced overrides.

If an older export has no configured project targets, supply `--supabase-project-ref YOUR_PROJECT_REF --vercel-project YOUR_VERCEL_PROJECT`. When the handoff does contain targets, explicit arguments must match them exactly.

On Windows PowerShell, enter the same command on one line. Neither safe mode reads private values during dry-run. After `--apply` is added, `--supabase-cli-keys` retrieves modern `sb_publishable_...` and `sb_secret_...` keys through the authenticated CLI without printing them. `--vercel-only-secrets` requests Discord credentials and the deliberately imported Supabase private signing JWK through hidden input, derives its key ID, and generates `ACTIVITY_STATE_SECRET` in memory. The application-side values are sent directly to Vercel and never written locally. CI may instead inject existing values into the process environment.

After reviewing the dry-run, answer Yes in the workstation launcher or add `--apply` to the manual command. The tool then:

1. hydrates public identity from Unreal, discovers Supabase API keys in memory, completes the remaining private configuration, and verifies the exported package;
2. verifies both CLIs are installed;
3. links the exact Vercel and Supabase projects;
4. runs `supabase db push --dry-run` before applying pending migrations;
5. sends sensitive Vercel variables through process stdin rather than command arguments;
6. runs the read-only Discord/Supabase online identity and security preflight;
7. creates a Vercel Preview deployment;
8. probes the hosted root, export manifest, iframe headers, and Activity API as an unauthenticated player before printing the two Discord URL mappings.

For production, `--environment production --apply` creates a staged deployment with `--skip-domain`; the tool never promotes production automatically. Use `--no-migrate` or `--no-deploy` when an operator intentionally owns that step separately.

## 2. Vercel

From the UE5-exported folder:

```bash
node --version
npm run preflight:package
vercel
```

The guided `npm run release:activity` command above performs these checks and Vercel/Supabase steps together without pulling Vercel secrets onto the workstation. The manual commands in this section remain available for troubleshooting and custom hosts.

`preflight:package` verifies that Unreal produced every required scene, Blueprint, API, migration, and deployment artifact. It cross-checks Blueprint counts across `export-manifest.json`, `activity-handoff.json`, and `logic/blueprints.json`; a handoff cannot claim `unreal-export-complete` while unsupported nodes remain. Partial compatibility is reported as a warning because an unsupported node may be intentionally unused or replaced by a registered JavaScript function, but it must be reviewed before release. For manifest v3 and later it also recalculates every byte under `index.html`, `runtime/**`, `assets/**`, and `logic/**`, then rejects stale manifest/handoff measurements. Current manifest v6 exports additionally require a matching `ue5-html5-asset-pack/v2` contract: preflight re-hashes every reusable asset, Blueprint-data file, and project adapter module; checks each Cache API versus versioned-module delivery policy; derives the canonical pack version; and requires the `ue5html5_pack` query strategy that prevents Discord's proxy from serving a prior export under a stable path. Crossing the Unreal project's advisory payload budget emits a release warning without pretending that the budget is a Discord platform limit. Legacy exports remain accepted with an explicit request to re-export before performance review and proxy-safe caching. The preflight also scans browser-visible text for any server secret already present in process memory. The guided apply flow runs the full online check without pulling Vercel secrets onto disk. For CI systems that inject the complete environment through their native secret store, the equivalent standalone command is `npm run preflight:online`.

Configure the advisory budget under **Unreal Project Settings → Plugins → UE5 HTML5 Discord Activity → Browser Export**. The 64 MiB default is a conservative exporter policy, not an official Discord maximum. Package size is only one risk signal: test load time, frame rate, GPU memory, device thermal behavior, and Discord voice/video quality on representative desktop and mobile clients.

The online preflight performs read-only checks: the bot token must belong to `DISCORD_CLIENT_ID`; Discord must report the `EMBEDDED` Activity flag and a global Primary Entry Point using Discord's automatic launch handler; it also inspects Guild Install, User Install, and OAuth2 redirect setup; the Supabase JWKS public coordinates must match the configured private signing key; the publishable and secret keys must reach that project; the migration table must exist; and the publishable key must be denied direct table access. Publishable-key identity is checked through Supabase Auth health rather than the PostgREST OpenAPI root, which no longer permits public keys. Missing install contexts or a redirect URI are reported as actionable warnings, while a missing or custom-handler Entry Point blocks this exporter because it does not provide a separate interactions endpoint. The check does not create a Discord user, Supabase Auth user, profile, save, entitlement, or billing record.

The preflight prints setting names and failures only; it never prints secret values. The exported `.gitignore` excludes `.env*`, `.vercel`, and `node_modules` while retaining `.env.example`.

Vercel Deployment Protection must not intercept the hostname mapped in Discord. A Vercel authentication redirect or `X-Frame-Options: DENY` makes an otherwise successful deployment unusable as an Activity. Use an unprotected production/custom domain, or disable Vercel Authentication for a dedicated public Activity project. Automation bypass secrets are suitable for CI testing only; never put one in a Discord URL mapping. The release command tests this boundary without a bypass token and stops instead of printing a misleading mapping.

Set these in the Vercel project for Preview and Production. Mark every value under **Sensitive server configuration** as sensitive in Vercel.

```text
DISCORD_CLIENT_ID
SUPABASE_URL
SUPABASE_PUBLISHABLE_KEY
DISCORD_ENABLE_RICH_PRESENCE
DISCORD_REQUIRE_PROXY_AUTH
DISCORD_PUBLIC_KEY

# Sensitive server configuration
DISCORD_CLIENT_SECRET
DISCORD_BOT_TOKEN
SUPABASE_SECRET_KEY
ACTIVITY_STATE_SECRET

# Optional private Realtime configuration
SUPABASE_JWT_PRIVATE_KEY
SUPABASE_JWT_KEY_ID
```

Set `DISCORD_REQUIRE_PROXY_AUTH=false` for ordinary browser previews. Before a public release, enable proxy authentication for the Discord application, copy its 64-character Ed25519 public key into `DISCORD_PUBLIC_KEY`, set `DISCORD_REQUIRE_PROXY_AUTH=true`, redeploy, and run the online preflight. The preflight then verifies that the key matches Discord's application record. Do not turn the requirement on before Discord is sending the three proxy headers or every privileged request will correctly fail with HTTP 401.

Set `DISCORD_ENABLE_RICH_PRESENCE=true` when the game uses the Rich Presence Blueprint nodes. The public configuration then requests Discord's `rpc.activities.write` scope in addition to `identify`; the scope is not requested when the feature is disabled.

The export pins Node.js 22 or later and includes:

- `api/activity.mjs`: signed proxy-request validation, bounded Discord rate-limit retries, OAuth exchange, Activity Instance verification, entitlement checks, opaque topic tokens, and save/load.
- `vercel.json`: no-cache API/manifest responses, content-hashed runtime files, immutable pack-versioned assets/logic, and iframe-safe headers.
- `assetPack` manifest/handoff fields: a SHA-256 resource index and delivery policy used by the viewer's origin-scoped Cache API and versioned module loader. Every managed non-HTML request carries the pack hash, so an updated export cannot be confused with an older Discord-proxy entry. Browser eviction or unavailable storage falls back to network loading; no native client install or service worker is required.
- `certify-browser.*` plus **Export & Certify Browser FPS**: a loopback-only, token-bound proxy-versioned cold-load/warm-cache/adapter-module/runtime-ready/frame-pacing/center-shot/score/respawn gate that writes `browser-certification.json`. Performance values are advisory and collect no device metadata, service credential, or player data; they do not replace hosted Discord, mobile, or two-client validation.
- `package.json`: the server dependency needed by the Vercel Function.
- `scripts/activity-preflight.mjs`: package, configuration, optional Realtime signing-key, accidental-secret, and optional online identity/access checks.
- `scripts/activity-release.mjs`: dry-run/apply orchestration plus a post-deployment public, iframe, manifest, and API readiness probe.

Use a Preview deployment for Discord testing. For a controlled release, stage production without assigning the domain, test that exact deployment, then promote it:

```bash
vercel --prod --skip-domain
vercel promote DEPLOYMENT_URL
```

## 3. Discord Developer Portal

1. Select the verified Discord application whose Application ID matches `DISCORD_CLIENT_ID`.
2. Enable **Activities**, then enable both **Guild Install** and **User Install** so the Activity can launch in servers, DMs, and group DMs.
3. Add the required root URL mapping:

   ```text
   /  -> YOUR_VERCEL_PRODUCTION_HOST
   ```

   Enter the hostname without a path. If optional private Realtime is configured, also map `/supabase` to `YOUR_PROJECT_REF.supabase.co`; the bundled adapter patches that prefix for the Realtime WebSocket. Basic Discord auth and save/load do not need the `/supabase` mapping.
4. Add an OAuth redirect URI. `https://127.0.0.1` is sufficient when authorization is handled only by the Embedded App SDK; the confidential exchange occurs only in `api/activity.mjs`.
5. Leave **Public Client** disabled. This exporter has a Vercel backend that can protect `DISCORD_CLIENT_SECRET`, so it uses Discord's recommended confidential-client design. Enable Public Client only for a different, backend-free native desktop/mobile Social SDK integration that uses PKCE; the toggle does not publish or list an Activity.
6. Confirm the global **Launch** command is a Primary Entry Point with Discord's automatic `DISCORD_LAUNCH_ACTIVITY` handler. The online preflight verifies this through the Discord API.
7. Enable Discord proxy authentication when the option is available for the app, then configure the matching `DISCORD_PUBLIC_KEY` and `DISCORD_REQUIRE_PROXY_AUTH=true` values in Vercel.
8. Launch the Activity in a private test server and verify:

   - The HUD changes from **Discord · connecting** to **Discord · your display name**.
   - If optional Realtime is enabled, a second Discord client joining the same Activity receives Broadcast and Presence events on `window.UE5HTML5.activity`.
   - `await window.UE5HTML5.activity.savePlayerState({ checkpoint: 1 }, 0)` succeeds.
   - `await window.UE5HTML5.activity.loadPlayerState()` returns that state on another Discord client signed into the same Discord user.
   - Opening the Vercel URL directly still loads the standalone viewer but does not establish an Activity session.

## Blueprint and JavaScript bridge

In UE5, search the Blueprint palette for **UE5 HTML5 → Discord Activity**. Available nodes include:

- `Is Discord Activity Ready`
- `Discord Activity Broadcast`
- `Discord Activity Open Invite Dialog`
- `Discord Activity Encourage Hardware Acceleration`
- `Discord Activity Set Orientation Lock`
- `Discord Activity Set Interactive PiP`
- `Discord Activity Get Platform Behaviors`
- `Discord Activity Get Locale`
- `Discord Activity Set/Clear Rich Presence`
- `Discord Activity Share Link`
- `Discord Activity Open External Link`
- `Discord Activity Get Launch Context`
- `Discord Activity Get Participants`
- `Discord Activity Get Skus`
- `Discord Activity Get Verified Entitlements`
- `Discord Activity Has Entitlement`
- `Discord Activity Start Purchase`
- `Discord Activity Load/Save World State`
- `Discord Activity Load/Save Player State`

The nodes return safe unavailable/default values during native Unreal play. After export, async operations pause that Blueprint execution path until the Discord/Supabase operation completes. JSON payload pins accept JSON strings. Save nodes default `Expected Revision` to `-1` for an unconditional write; pass a prior revision to enable stale-write rejection.

For automatic client display events, open **Class Settings → Implemented Interfaces**, add **UE5 HTML5 Discord Activity Listener**, and implement any of these interface events:

- `Discord Activity Connection State Changed` — `Idle`, `Checking`, `Connecting`, `Ready`, `Unavailable`, `Error`, or `Disposed`
- `Discord Activity Ready` — authorization and authentication are ready; save/load is available, and private Realtime is connected when configured
- `Discord Activity Unavailable` — safe reason code such as `ConfigurationDisabled`, `ConfigurationUnavailable`, or `OutsideDiscord`
- `Discord Activity Error` — normalized error code plus a fixed privacy-safe operator message
- `Discord Activity Warning` — recoverable unsupported-command/event code plus a privacy-safe message
- `Discord Activity Broadcast Received` — authenticated game event name, JSON payload, and replay flag
- `Discord Activity Presence Changed` — complete opaque connection-state JSON
- `Discord Activity Participants Changed` — current Discord participant JSON and count
- `Discord Activity Verified Entitlements Changed` — server-rechecked entitlement JSON and count
- `Discord Activity Thermal State Changed` — `Nominal`, `Fair`, `Serious`, or `Critical`
- `Discord Activity Orientation Changed` — `Portrait` or `Landscape`
- `Discord Activity Layout Mode Changed` — `Focused`, `PictureInPicture`, or `Grid`

The lifecycle events remove readiness polling from normal Blueprint flow. Use `Ready` to enable multiplayer/menu actions, `Unavailable` for the ordinary browser or disabled-backend fallback, `Error` for a retry screen, and `Warning` for optional features that an older Discord client does not support. Error objects, stack traces, tokens, user IDs, topics, and server payloads are never forwarded to Blueprint diagnostics; only normalized codes and fixed/bounded messages cross the bridge.

The multiplayer events remove the need to register JavaScript callbacks for normal lobby and storefront UI. Initial Presence, participants, and verified entitlements are delivered whenever the runtime reaches `Ready`, including when Blueprints attached earlier during `Connecting`, then updated automatically. Presence contains the exporter's random per-connection key and `{ connected: true }`; it does not contain a game-owned user profile. Participant data comes transiently from Discord's Embedded App SDK and is not stored by the exporter. Do not copy raw participant identifiers into saved game state unless the game has a separately documented need and privacy policy.

Display events expose both the exact Discord SDK integer and a readable name. Use thermal state to reduce particles, shadows, or tick frequency; use layout mode to simplify the HUD in picture-in-picture or grid; and use orientation to rearrange mobile controls. `Set Orientation Lock` accepts friendly enum values and optional picture-in-picture/grid overrides. These subscriptions and newer commands fail softly when an older Discord client does not expose them.

`Get Launch Context` returns campaign `custom_id` and a Boolean saying whether a referrer exists. It deliberately does not expose the raw referrer's Discord user ID to Blueprint. `link_id` remains an optional input when sharing a Developer Portal custom link. Newer social commands return a safe unsupported result when an older Discord client reports `INVALID_COMMAND`; other errors remain visible instead of being silently swallowed.

The same bridge is available to custom browser code at `window.UE5HTML5.activity`:

```js
const activity = await window.UE5HTML5.activityReady;

activity.addEventListener('broadcast', ({ detail }) => {
  window.UE5HTML5.call('OnNetworkMessage', null, detail);
});

await activity.broadcast('player-input', { x: 1, y: 0 });
const { participants } = await activity.getParticipants();
await activity.openInviteDialog();
await activity.setOrientationLock(3); // Discord landscape orientation
await activity.setInteractivePip(true);
const platform = await activity.getPlatformBehaviors();
const locale = await activity.getLocale();
await activity.setRichPresence({
  details: 'Round 3',
  state: 'In match',
  currentPartySize: 2,
  maximumPartySize: 4,
});
await activity.shareLink('Join my match', 'campaign-summer');
const launch = activity.getLaunchContext();

const { skus } = await activity.getSkus();
const purchase = await activity.startPurchase(skus[0].id);
const verifiedEntitlements = await activity.verifyEntitlements();

const loaded = await activity.loadPlayerState();
const saved = await activity.savePlayerState(
  { level: 4, inventory: ['key'] },
  loaded.revision,
);
```

When optional Realtime is enabled, use Broadcast/Presence for input, lobby state, and other short-lived messages. Without it, Broadcast reports that Realtime is unavailable while Discord identity, participants, purchases, and save/load continue to work. Do not send authoritative rewards, purchases, or anti-cheat decisions through Realtime. Each world or player state document can contain at most 512 KiB. Passing the revision returned by a load/save enables atomic compare-and-swap; a stale write returns HTTP 409 and the current revision.

Supabase Broadcast is the fast event path; Presence is for slow-changing connection state and should not be updated every frame. The Blueprint bridge accepts JSON Broadcast payloads. Supabase binary Broadcast payloads remain available to custom JavaScript but are intentionally outside the Blueprint JSON contract.

## Discovery and monetization release gates

Because the app is already verified, complete **Discovery → Discovery Status**, upload the required Discovery metadata/assets, and opt in. Discord says listing propagation can take up to 24 hours.

Use Rich Presence and `Share Link` for Discord-native discovery without making Unreal developers learn the Embedded App SDK. Use non-personal `custom_id` values for campaign or deep-link routing. The bridge exposes only whether a referrer is present; it does not expose or store the raw referrer ID.

For monetization, use Discord-native SKUs and `startPurchase()`. `Get Skus` is intended for storefront display. `Get Verified Entitlements` and `Has Entitlement` call the Vercel backend, which rechecks both Activity membership and Discord's Entitlements HTTP API; use those nodes before granting premium value. Client entitlement events remain immediate UI signals, not authority.

Before public release, also verify:

- Privacy policy clearly states that raw Discord identity and billing data are processed by Discord or transiently verified but not stored by the game; document deletion of opaque game-created state.
- No Vercel deployment output or browser response contains the Discord client secret, Bot token, or Supabase secret key.
- Network inspection confirms the Discord OAuth token appears only in the initial SDK authentication response and never in later save, load, refresh, or entitlement request bodies.
- The Activity session cookie is `HttpOnly`, `Secure`, `SameSite=None`, `Partitioned`, host-only, and rejected after tampering or when replayed against another Activity instance.
- With proxy authentication required, direct privileged POSTs without Discord's signed proxy headers return HTTP 401 while a real Discord launch succeeds.
- A controlled Discord API `429` test or mock honors `retry_after` and remains bounded rather than looping indefinitely.
- If optional Realtime is enabled, Supabase Realtime Inspector rejects a token joining any `activity:*` topic other than its one opaque claim.
- Two real Discord accounts cannot read each other's save through the API.
- Refresh/reconnect works after at least one hour and no expired token remains connected.
- Mobile Discord, desktop Discord, and web Discord fit the exported UI and memory budget.

## Official references

- [Discord: Building Your First Activity](https://docs.discord.com/developers/activities/building-an-activity)
- [Discord: Local Activity development and Developer Activity Shelf](https://docs.discord.com/developers/activities/development-guides/local-development)
- [Discord: Embedded App SDK reference](https://docs.discord.com/developers/developer-tools/embedded-app-sdk)
- [Discord: Application commands and Primary Entry Points](https://docs.discord.com/developers/interactions/application-commands)
- [Discord: OAuth2 client types for games](https://docs.discord.com/developers/discord-social-sdk/core-concepts/oauth2-scopes)
- [Discord: Application installation contexts](https://docs.discord.com/developers/resources/application)
- [Discord: Activity networking, cookies, and proxy security](https://docs.discord.com/developers/activities/development-guides/networking)
- [Discord: Multiplayer Experience and Activity Instance API](https://docs.discord.com/developers/activities/development-guides/multiplayer-experience)
- [Discord: Production readiness](https://docs.discord.com/developers/activities/development-guides/production-readiness)
- [Discord: Activity design patterns and performance guidance](https://docs.discord.com/developers/activities/design-patterns)
- [Discord: Mobile safe areas](https://docs.discord.com/developers/activities/development-guides/mobile)
- [Discord: Rich Presence for Activities](https://docs.discord.com/developers/rich-presence/using-with-the-embedded-app-sdk)
- [Discord: Growth and referrals](https://docs.discord.com/developers/activities/development-guides/growth-and-referrals)
- [Discord: Enabling Discovery](https://docs.discord.com/developers/discovery/enabling-discovery)
- [Discord: In-app purchases for Activities](https://docs.discord.com/developers/monetization/implementing-iap-for-activities)
- [Supabase: JWT Signing Keys](https://supabase.com/docs/guides/auth/signing-keys)
- [Supabase: Realtime Authorization](https://supabase.com/docs/guides/realtime/authorization)
- [Supabase: Broadcast](https://supabase.com/docs/guides/realtime/broadcast)
- [Supabase: Presence](https://supabase.com/docs/guides/realtime/presence)
- [Supabase: API keys](https://supabase.com/docs/guides/getting-started/api-keys)
- [Vercel: Functions](https://vercel.com/docs/functions)
- [Vercel: Deploying from the CLI](https://vercel.com/docs/cli/deploying-from-cli)
