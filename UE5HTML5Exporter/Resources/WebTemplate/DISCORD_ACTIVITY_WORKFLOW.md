# Discord Activity release workflow

This exporter can produce a Discord Activity-ready folder. The exported game remains playable as an ordinary website, while Discord launch, verified identity, Realtime multiplayer, and persistent saves turn on automatically inside Discord after configuration.

## Architecture

| Layer | Responsibility | Trusted for authority? |
|---|---|---|
| UE5 + exporter | Scene, Blueprint IR, browser runtime, Activity adapter | No; all browser code can be modified |
| Discord | Launch context, OAuth identity, Activity participants, Discovery, native purchases | SDK data is UI-only; HTTP API responses from the backend are authoritative |
| HTTPS host + Activity API | Static game hosting, confidential OAuth exchange, Activity Instance checks, entitlement verification, save/load API | Yes, while secrets stay server-side |
| Supabase | Private Broadcast/Presence and game-created world/player state | Yes through Realtime RLS and the server-only secret key |

The included deployment adapter uses Vercel, but Discord does not require Vercel. The player sees one Discord authorization flow. The OAuth access token exists in browser memory only long enough to complete Discord SDK authentication, then it is cleared. The Activity API issues a short-lived, signed, HttpOnly `Secure; SameSite=None; Partitioned` session cookie containing only opaque HMAC keys and an expiry. No Supabase Auth user or profile is created. The backend rechecks the Activity Instance through Discord before every privileged operation, and mints a short-lived Supabase JWT limited to one opaque private Realtime topic. Persistent player state is keyed by a one-way HMAC of the verified Discord user ID, so it survives switching Discord clients without storing that raw ID.

For production defense in depth, the API can also require Discord's signed proxy-authentication headers. This proves that a privileged POST passed through the configured Discord Activity proxy before the existing OAuth, instance-membership, session-cookie, and entitlement checks run. The signed proxy payload is verified in memory and is never written to Supabase.

Supabase is the persistence/Realtime layer, not the static game host: Supabase Storage returns HTML files as plain text. Host the exported files on Vercel or another HTTPS static host. If the Activity API is deployed separately, change the `ue5-activity-api` meta tag in `index.html` to a relative proxy prefix and add the corresponding Discord URL mapping. Keep API calls same-origin from the iframe so the host-only Activity cookie remains the authority boundary.

## 1. Supabase

1. Create a Supabase project.
2. In **Realtime Settings**, disable **Allow public access** so every channel must pass Realtime Authorization.
3. Generate an ES256 signing key, import it under **Authentication → Signing Keys**, then activate it. Keep the private JWK only in your password manager and Vercel; Supabase cannot reveal an imported private key later.

   ```bash
   supabase gen signing-key --algorithm ES256
   ```

4. Apply the SQL file in `supabase/migrations/` with the Supabase CLI:

   ```bash
   supabase link --project-ref YOUR_PROJECT_REF
   supabase db push
   ```

5. From the project **Connect** dialog or **Settings → API Keys**, copy a publishable key (`sb_publishable_...`) and create/copy a secret key (`sb_secret_...`). Do not use a secret key in browser code.
6. Run the Security Advisor and verify RLS is enabled on both `discord_activity_*` tables.

The migration explicitly revokes browser access to both state tables and grants only the server-side secret role access to the atomic save functions. Realtime authorization accepts short-lived `authenticated` JWTs only when their opaque `activity_topic` claim exactly matches the private channel being joined. Raw Discord IDs, names, avatars, email, OAuth tokens, entitlements, and billing data are not stored. Rotating `ACTIVITY_STATE_SECRET` invalidates all Activity session cookies and changes the opaque state keys, so plan a state migration before rotating it in production.

### Guided cross-platform release

The exported folder includes one Node.js 22 release command that runs unchanged in PowerShell, Terminal, or a Linux shell. It is dry-run-only unless `--apply` is present, checks that `SUPABASE_URL` matches the explicitly selected project ref, and refuses to silently switch an existing Vercel link.

Create a gitignored environment file from `.env.example`, then review the exact project plan:

```bash
npm install
npm run release:activity -- \
  --env-file .env.activity.local \
  --supabase-project-ref YOUR_PROJECT_REF \
  --vercel-project YOUR_VERCEL_PROJECT
```

On Windows PowerShell, enter the same command on one line. `--generate-state-secret` generates `ACTIVITY_STATE_SECRET` in memory when the file omits it. The generated value is sent directly to Vercel as sensitive input and is never printed or written back to the file.

After reviewing the dry-run, add `--apply`. The tool then:

1. verifies the exported package and complete private configuration;
2. verifies both CLIs are installed;
3. links the exact Vercel and Supabase projects;
4. runs `supabase db push --dry-run` before applying pending migrations;
5. sends sensitive Vercel variables through process stdin rather than command arguments;
6. runs the read-only Discord/Supabase online identity and security preflight;
7. creates a Vercel Preview deployment and prints the two Discord URL mappings.

For production, `--environment production --apply` creates a staged deployment with `--skip-domain`; the tool never promotes production automatically. Use `--no-migrate` or `--no-deploy` when an operator intentionally owns that step separately.

## 2. Vercel

From the UE5-exported folder:

```bash
node --version
npm run preflight:package
vercel
```

The guided `npm run release:activity` command above performs these checks and Vercel/Supabase steps together. The manual commands in this section remain available for troubleshooting and custom hosts.

`preflight:package` verifies that Unreal produced every required scene, Blueprint, API, migration, and deployment artifact. It also scans browser-visible text for any server secret already present in the shell environment. Run the full environment check before deploying by exposing the Vercel values to that one command (or by using a temporary, gitignored environment file):

```bash
vercel env pull .env.activity.local
node --env-file=.env.activity.local scripts/activity-preflight.mjs --online
rm .env.activity.local
```

If the variables are already loaded in the shell or CI environment, the equivalent shortcut is `npm run preflight:online`.

The online preflight performs read-only checks: the bot token must belong to `DISCORD_CLIENT_ID`, Discord must report the `EMBEDDED` Activity flag, the Supabase JWKS public coordinates must match the configured private signing key, the publishable and secret keys must reach that project, the migration table must exist, and the publishable key must be denied direct table access. It does not create a Discord user, Supabase Auth user, profile, save, entitlement, or billing record.

The preflight prints setting names and failures only; it never prints secret values. The exported `.gitignore` excludes `.env*`, `.vercel`, and `node_modules` while retaining `.env.example`.

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
SUPABASE_JWT_PRIVATE_KEY
ACTIVITY_STATE_SECRET

# Server configuration; optional when the JWK contains kid
SUPABASE_JWT_KEY_ID
```

Set `DISCORD_REQUIRE_PROXY_AUTH=false` for ordinary browser previews. Before a public release, enable proxy authentication for the Discord application, copy its 64-character Ed25519 public key into `DISCORD_PUBLIC_KEY`, set `DISCORD_REQUIRE_PROXY_AUTH=true`, redeploy, and run the online preflight. The preflight then verifies that the key matches Discord's application record. Do not turn the requirement on before Discord is sending the three proxy headers or every privileged request will correctly fail with HTTP 401.

Set `DISCORD_ENABLE_RICH_PRESENCE=true` when the game uses the Rich Presence Blueprint nodes. The public configuration then requests Discord's `rpc.activities.write` scope in addition to `identify`; the scope is not requested when the feature is disabled.

The export pins Node.js 22 or later and includes:

- `api/activity.mjs`: signed proxy-request validation, bounded Discord rate-limit retries, OAuth exchange, Activity Instance verification, entitlement checks, opaque topic tokens, and save/load.
- `vercel.json`: no-cache API responses, content-hashed immutable runtime assets, and iframe-safe headers.
- `package.json`: the server dependency needed by the Vercel Function.
- `scripts/activity-preflight.mjs`: package, configuration, signing-key, accidental-secret, and optional online identity/access checks.

Use a Preview deployment for Discord testing. For a controlled release, stage production without assigning the domain, test that exact deployment, then promote it:

```bash
vercel --prod --skip-domain
vercel promote DEPLOYMENT_URL
```

## 3. Discord Developer Portal

1. Select the verified Discord application whose Application ID matches `DISCORD_CLIENT_ID`.
2. Enable **Activities** and configure the app for the install contexts your game needs. A typical public Activity supports both user and guild installation.
3. Add URL mappings:

   ```text
   /          -> YOUR_VERCEL_PRODUCTION_HOST
   /supabase  -> YOUR_PROJECT_REF.supabase.co
   ```

   Enter hostnames without a path. The bundled adapter calls Discord's `patchUrlMappings` for `/supabase`, covering Supabase Auth HTTP requests and the Realtime WebSocket.
4. Add the OAuth redirect placeholder required by the Activity setup screen. The Embedded App SDK performs the authorization-code flow within Discord; the confidential exchange occurs only in `api/activity.mjs`.
5. Enable Discord proxy authentication when the option is available for the app, then configure the matching `DISCORD_PUBLIC_KEY` and `DISCORD_REQUIRE_PROXY_AUTH=true` values in Vercel.
6. Launch the Activity in a private test server and verify:

   - The HUD changes from **Discord · connecting** to **Discord · your display name**.
   - A second Discord client joining the same Activity receives Broadcast and Presence events on `window.UE5HTML5.activity`.
   - `await window.UE5HTML5.activity.savePlayerState({ checkpoint: 1 }, 0)` succeeds.
   - `await window.UE5HTML5.activity.loadPlayerState()` returns that state on another Discord client signed into the same Discord user.
   - Opening the Vercel URL directly still loads the standalone viewer but does not establish an Activity session.

## Blueprint and JavaScript bridge

In UE5, search the Blueprint palette for **UE5 HTML5 → Discord Activity**. Available nodes include:

- `Is Discord Activity Ready`
- `Discord Activity Broadcast`
- `Discord Activity Open Invite Dialog`
- `Discord Activity Encourage Hardware Acceleration`
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

Use Broadcast/Presence for input, lobby state, and other short-lived messages. Do not send authoritative rewards, purchases, or anti-cheat decisions through Realtime. Each world or player state document can contain at most 512 KiB. Passing the revision returned by a load/save enables atomic compare-and-swap; a stale write returns HTTP 409 and the current revision.

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
- Supabase Realtime Inspector rejects a token joining any `activity:*` topic other than its one opaque claim.
- Two real Discord accounts cannot read each other's save through the API.
- Refresh/reconnect works after at least one hour and no expired token remains connected.
- Mobile Discord, desktop Discord, and web Discord fit the exported UI and memory budget.

## Official references

- [Discord: Building Your First Activity](https://docs.discord.com/developers/activities/building-an-activity)
- [Discord: Activity networking, cookies, and proxy security](https://docs.discord.com/developers/activities/development-guides/networking)
- [Discord: Multiplayer Experience and Activity Instance API](https://docs.discord.com/developers/activities/development-guides/multiplayer-experience)
- [Discord: Production readiness](https://docs.discord.com/developers/activities/development-guides/production-readiness)
- [Discord: Mobile safe areas](https://docs.discord.com/developers/activities/development-guides/mobile)
- [Discord: Rich Presence for Activities](https://docs.discord.com/developers/rich-presence/using-with-the-embedded-app-sdk)
- [Discord: Growth and referrals](https://docs.discord.com/developers/activities/development-guides/growth-and-referrals)
- [Discord: Enabling Discovery](https://docs.discord.com/developers/discovery/enabling-discovery)
- [Discord: In-app purchases for Activities](https://docs.discord.com/developers/monetization/implementing-iap-for-activities)
- [Supabase: JWT Signing Keys](https://supabase.com/docs/guides/auth/signing-keys)
- [Supabase: Realtime Authorization](https://supabase.com/docs/guides/realtime/authorization)
- [Supabase: API keys](https://supabase.com/docs/guides/getting-started/api-keys)
- [Vercel: Functions](https://vercel.com/docs/functions)
- [Vercel: Deploying from the CLI](https://vercel.com/docs/cli/deploying-from-cli)
