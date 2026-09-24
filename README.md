# BroBot

BroBot is a multi-tenant Twitch bot that runs entirely on Cloudflare Workers.
One deployment serves any number of channels; a channel becomes active by
adding a row to the `channels` table, not by changing configuration.

- **Worker**: [Hono](https://hono.dev) routes HTTP, Twitch EventSub webhooks
  and a WebSocket upgrade.
- **Storage**: [D1](https://developers.cloudflare.com/d1/) holds
  configuration, sessions and per-channel data; one
  [Durable Object](https://developers.cloudflare.com/durable-objects/)
  (`ChannelObject`, SQLite-backed) per channel handles the realtime
  WebSocket connection to the dashboard.
- **Dashboard**: React 19 + [Mantine](https://mantine.dev), built with Vite,
  served as static assets by the same Worker.
- **Overlay**: a small, transparent, lazily-loaded React view for OBS or
  StreamElements browser sources.

Everything channel-specific keys off `channelId`, which is the Twitch
broadcaster's numeric user ID. There is no separate operator secret that
identifies a channel; access is granted only through rows in `channels` and
`channel_members`, never through a Twitch role such as moderator. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (German) for the full
runtime and data-flow picture, including the module and tenancy decisions
this rests on.

## What's included

**Modules** (`src/modules/registry.ts` is the single place that lists them):

- **`text_commands`** — chat-triggered `!commands`, configured entirely in
  the panel. Each command has a kind: `text` (fixed reply), `list` (replies
  with enabled command names in alphabetical order), `uptime`, `followage`,
  `game` (current category/title), or `shoutout`. Commands support aliases, a
  minimum tier (`everyone`/`subscriber`/`vip`/`moderator`/`broadcaster`), a
  per-channel and
  optional per-user cooldown, and an "online only"/"offline only" condition.
- **`raid`** — reacts to `channel.raid`: an automatic shoutout at or above a
  viewer-count threshold, plus a separate threshold selecting a short or long
  chat message. Also contributes the Stream Manager's manual-shoutout
  immediate action. The dashboard shows this module as "Shoutout", not "Raid".
- **`ads`** — reacts to `stream.online` and `channel.ad_break.begin`: an
  optional lead-time pre-warning message and a message for the ad break
  itself. Also contributes a "start commercial now" immediate action.
- **`clips`** — no settings, enabled by default for every channel
  (`defaultEnabled`). Contributes a "clip now" immediate action that creates
  a Twitch clip via Helix and links back to it for editing.
- **`channel_events`** (mandatory, always enabled) — turns raid, shoutout,
  chat-notification, moderation, AutoMod-hold, suspicious-user and
  stream online/offline events into entries in the channel's event log,
  without a chat reply.

A module's settings can be a generated settings editor alone (`raid`:
template texts, thresholds, toggles), a generated editor combined with a
custom panel (`ads`: schedule, snooze and recent breaks), or a hand-written
panel with its own persisted rows (`text_commands`: full CRUD for commands).

**Host features** (not modules, built into the Worker/dashboard):

- **Stream Manager**: renders each enabled module's immediate-action card
  (`raid`'s manual shoutout, `clips`'s "clip now", `ads`'s "start
  commercial") — the host contributes no actions of its own here. A card is
  only clickable once its module's declared availability requirement holds
  (today: the stream being live); otherwise it disables itself and shows
  why.
- **Mute / pause**: a channel can be muted or paused for a duration or until
  the current stream ends, independent of any module.
- **Event log**: diagnostics a module emits — including *why* it took no
  action, when it reports a reason — are recorded with a machine-readable
  `code` and small detail fields, filterable by module, origin, tone and
  actor; a module that emits no diagnostics for an event leaves no row.
- **Audit log**: every administrative change (member roles, module
  enable/disable, channel controls, platform-level actions) is written in the
  same D1 batch as the change itself.
- **Roles**: `broadcaster`, `manager`, `operator` per channel
  (`channel_members`). `broadcaster` and `manager` can manage the channel;
  only a `broadcaster` can grant the `broadcaster` role. `operator` is
  read-only on modules. Platform admins (`PLATFORM_USER_IDS`) sit above all
  channels: they release channels, see a global audit log, and manage
  channel membership without themselves being a channel member.

## Operating an installation

Full detail, including the exact secret-rotation and OBS overlay setup
steps, lives in [`docs/OPERATIONS.md`](docs/OPERATIONS.md) (German). This
section is the short path.

### Prerequisites

- A Cloudflare account with Workers and D1 available.
- A Twitch application, created in the
  [Twitch Developer Console](https://dev.twitch.tv/console/apps), with its
  OAuth redirect URL set to `<PUBLIC_ORIGIN>/auth/twitch/callback` for each
  environment you deploy.
- A dedicated Twitch account for the bot itself, separate from any personal
  or broadcaster account. Set `vars.TWITCH_BOT_LOGIN` in each Wrangler
  environment (`wrangler.jsonc`) to that account's Twitch login before
  connecting it. The bot connects once, globally — not per channel.

### Environments

`wrangler.jsonc` defines three environments, each with its own Worker name,
D1 database and (in staging/production) a custom domain:

| Environment | Worker name | Notes |
|---|---|---|
| (default/local) | `brobot-local` | used by `pnpm run dev` and local D1 |
| `staging` | `brobot-staging` | deployed automatically after CI on `main` |
| `production` | `brobot` | deployed manually via `workflow_dispatch`, gated by a GitHub environment approval |

Replace the `custom_domain` routes in `wrangler.jsonc` with your own domains
(e.g. `brobot-staging.example.com`, `brobot.example.com`) before deploying.

### Secrets and bindings

Required secrets (`REQUIRED_SECRET_NAMES` in `src/worker/config.ts`, mirrored
in `secrets.required` per environment in `wrangler.jsonc`; `pnpm run
config:verify` checks the two lists stay in sync):

| Secret | Purpose |
|---|---|
| `TWITCH_CLIENT_ID` | Twitch application client ID |
| `TWITCH_CLIENT_SECRET` | Twitch application client secret, used in the OAuth token exchange |
| `TWITCH_EVENTSUB_SECRET` | key ring that verifies the HMAC signature of incoming EventSub webhooks |
| `PUBLIC_ORIGIN` | this environment's absolute public origin (no trailing slash); drives OAuth redirects and overlay URLs |
| `SESSION_COOKIE_KEYS` | key ring that signs the session cookie |
| `TOKEN_ENCRYPTION_KEYS` | key ring that encrypts stored Twitch access/refresh tokens |
| `OVERLAY_TOKEN_PEPPER` | single value (not a key ring) used to hash revocable overlay tokens |
| `PLATFORM_USER_IDS` | JSON array of Twitch numeric user IDs granted platform-admin access |

`TWITCH_EVENTSUB_SECRET`, `SESSION_COOKIE_KEYS` and `TOKEN_ENCRYPTION_KEYS`
use the same key-ring shape: `{"active":{"id":"...","key":"..."},"retired":[...]}`.
Generate a 32-byte base64url key with:

```bash
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

Cloudflare resource bindings (also from `wrangler.jsonc`, not secrets):

| Binding | Resource |
|---|---|
| `DB` | the environment's D1 database |
| `CHANNEL` | the `ChannelObject` Durable Object namespace |
| `ASSETS` | static dashboard/overlay files from `dist/client` |
| `CF_VERSION_METADATA` | deployment version metadata, shown by overlay diagnostics with `debug=1` |

### D1 setup

```bash
pnpm exec wrangler d1 create brobot-local
pnpm exec wrangler d1 create brobot-staging
pnpm exec wrangler d1 create brobot-production
```

Put each returned `database_id` into the matching environment in
`wrangler.jsonc`, then apply migrations (the argument accepts either the
binding name `DB` or the database name; `--env` selects the environment):

```bash
pnpm exec wrangler d1 migrations apply DB                                # local
pnpm exec wrangler d1 migrations apply DB --env staging --remote
pnpm exec wrangler d1 migrations apply DB --env production --remote
```

Staging migrates automatically as part of the deploy workflow: if a
migration fails, the job stops before the code deploy and the previous
Worker stays up, but migrations that already succeeded in that run stay
applied — Wrangler only rolls back the failing migration itself. Production
migrates by hand, on purpose — the same applies there with several pending
migrations, so an unattended run could still leave the schema between two
states with nobody having looked. `/healthz` runs after production's code
deploy and fails the CI job if the latest migration isn't recorded or a
sentinel table is missing; it doesn't check the whole schema and doesn't
roll the deploy back.

### Deploying

```bash
pnpm install --frozen-lockfile
pnpm run check
pnpm run deploy:staging:ci-code-only        # code-only, no secrets file
pnpm run deploy:production:ci-code-only
```

These are the code-only scripts CI itself runs; in normal operation GitHub
Actions deploys staging automatically after a green CI run on `main`, and
production only via a manually triggered `workflow_dispatch` against the
`production` GitHub environment. Before either deploy job can run, configure
repository variable `CLOUDFLARE_ACCOUNT_ID` and repository secret
`CLOUDFLARE_API_TOKEN`, and configure required reviewers on the `production`
environment — the workflow only names that environment, GitHub enforces the
review. For first-time secret provisioning or an emergency deploy outside CI,
`pnpm run deploy:staging:local-with-secrets` /
`...production:local-with-secrets` read a local `.env.staging` /
`.env.production` file and pass all secrets via `wrangler deploy
--secrets-file`; never commit those files.

Set secrets once per environment with `wrangler secret put <NAME> --env
<environment>` (interactive prompt — never pass values on the command line).

After any deploy, `GET /healthz` checks required binding and secret names
and formats, the latest recorded migration, and a schema sentinel table; it
returns `200` when all are present, or `503` listing every missing name (or
`DB_SCHEMA` for a schema mismatch), never a secret value.

### First-time setup flow

1. Sign in to the dashboard with a Twitch account listed in
   `PLATFORM_USER_IDS` — that account becomes a platform admin and sees the
   `/platform` page.
2. Connect the bot once, globally: `/auth/bot/login` checks the *dashboard
   session's* own Twitch login, not just the account you sign in with next —
   use a separate browser session, or visit `/auth/login?switch=1` to sign
   into the dashboard as the bot's account, then visit `GET /auth/bot/login`
   and approve the consent screen.
3. On `/platform`, release a channel by searching its broadcaster's Twitch
   login. That adds the row to `channels` that makes it active; the bot must
   also be modded in that channel's Twitch chat.
4. Give the broadcaster the invitation link shown on that channel's platform
   page (`<PUBLIC_ORIGIN>/auth/login?channel=<login>`) — opening it starts
   their own Twitch consent for the channel.
5. Optionally enable "full consent" for a channel (also on `/platform`) for
   modules that need broadcaster scopes, such as `ads`'s `channel:read:ads`
   for automatic ad-break detection.

### Maintenance and free tier

A scheduled handler (`triggers.crons` in `wrangler.jsonc`, hourly in every
environment) refreshes Twitch tokens, checks the bot's moderator status per
channel, prunes the event log after 14 days, and backfills missing
live/offline states and refreshes stale ones via Helix, up to 50 channels per
tick (the same Helix lookup also runs on demand when a channel's overview
page opens). Cloudflare Workers, D1 and Durable Objects all have free tiers;
nothing here requires a paid plan.
Watch Twitch's own limits instead — EventSub quota and Helix rate limits
apply per Client ID, not per channel, which is why maintenance throttles
itself.

## Development

Requirements (`package.json`): Node.js `>=24.0.0`, pnpm `>=12.0.0` (the repo
pins `pnpm@12.1.0` via `packageManager`).

```bash
pnpm install
cp .dev.vars.example .dev.vars   # replace the placeholder values, set PLATFORM_USER_IDS to your numeric Twitch user ID
pnpm exec wrangler d1 migrations apply DB   # creates local D1 under .wrangler/ and applies migrations
pnpm run dev
```

`pnpm run dev` starts Vite with the Cloudflare plugin, simulating Worker
bindings locally. The dashboard is at `http://localhost:5173/`, the overlay
at `http://localhost:5173/overlay.html`; sign in with the Twitch account
listed in `PLATFORM_USER_IDS` to reach the `/platform` admin pages.
`/healthz` reports `503` until migrations have been applied.

Twitch EventSub delivers webhooks to `PUBLIC_ORIGIN/api/twitch/eventsub`,
which must be a real, publicly reachable HTTPS URL — Twitch cannot call
`localhost`. There is no bundled tunnel setup; to exercise real EventSub
deliveries against your machine, expose your local port with a tunnel of
your choice and point `PUBLIC_ORIGIN` (and the Twitch application's redirect
URL) at it for the duration of the session. Day-to-day module development
normally does not need this — `handleEvent` is unit-tested directly, and the
Worker test suite exercises the webhook route with signed fixture payloads.

### Checks

```bash
pnpm run check
```

Runs, in order: `config:verify` (secret-list consistency between
`config.ts`, `wrangler.jsonc` and the verify script), `types:check`
(`wrangler types --check`), `typecheck` (`tsc --noEmit`), `lint` (`eslint .`),
`test` (Vitest, jsdom), `test:worker` (Vitest against the real Worker via
`@cloudflare/vitest-plugin`, after a build) and `test:e2e` (Playwright,
headless Chromium, after a build). Run it before every push.

Individual scripts, if you only need one: `pnpm run typecheck`,
`pnpm run lint`, `pnpm run test` (or `test:watch`), `pnpm run test:worker`,
`pnpm run test:e2e`, `pnpm run build`.

### CI

`.github/workflows/ci.yml` runs the same four jobs (`static`, `unit`,
`worker`, `e2e`) on every pull request and on push to `main`, plus a
`quality` job that gates on all four. `main`'s branch protection — configured
on GitHub, not by these workflow files — requires a green `quality` check, an
up-to-date branch, and no unresolved review comments before merging, and
rejects direct pushes even for admins. See
[`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md) (German) for the full branch
and review rules.

## Writing a module

Full detail lives in [`src/modules/README.md`](src/modules/README.md)
(German); this is the contract-level summary, checked against
[`src/modules/contract.ts`](src/modules/contract.ts).

### Layout

```text
src/modules/<id>/
├── contracts/     # public types and the module's I/O contracts
├── domain/        # pure rules and values, no Worker/UI/I-O dependency
├── service.ts     # use cases; wires domain to the repository
├── repository.ts  # small interface for persistence
├── adapters/      # concrete D1 / Durable Object / external adapters
├── overlay/       # minimal overlay view, strict bundle boundaries
└── panel/         # panel view: forms and controls
```

Only add what the module needs — `channel_events` has neither `overlay/` nor
`panel/`, `raid` has no `overlay/`.

### The `BotModule` contract

A module is one `BotModule` value, added to the `MODULES` array in
`src/modules/registry.ts` — the only place that knows every module.

Fields that exist today (`src/modules/contract.ts`):

- `id: string` — stable module identifier.
- `mandatory?: boolean` — always enabled, cannot be turned off (`channel_events`).
- `defaultEnabled?: boolean` — create an enabled settings row when a channel
  is released; existing channels need a backfill migration.
- `settingsSchema` (a Zod schema) and `defaultSettings` — `defaultSettings` is
  written into `channel_modules.settings` on enable; the host exposes
  GET/PATCH settings routes that validate reads and writes against
  `settingsSchema`.
- `templateFields?` — which template variables are valid per settings field,
  used by both panel validation and worker rendering.
- `broadcasterScopes?: readonly string[]` — broadcaster OAuth scopes the host
  verifies before subscribing (e.g. `ads` requires `channel:read:ads`).
- `eventSubTypes?: readonly string[]` — the EventSub types this module
  receives.
- `routes?: Hono<ModuleRouteEnvironment>` — mounted under
  `/api/channels/:channelId/modules/<id>`.
- `handleEvent?(event, context)` — the business entry point. May be async and
  use the provided context for module state; it returns
  `{ actions, diagnostics }` and executes nothing itself — the host executes
  the actions. A throw becomes a diagnostic in the event log; it never blocks
  the Worker or other modules.
- `onEnable?(context, channelId)` — may asynchronously prepare statements for
  initial data when the module is enabled; the panel route calls it on every
  enable request, not only the first, so it must be idempotent.
- `overlay?` / `panel?: () => Promise<{ default: ComponentType<...> }>` —
  must stay lazy `import()` promises, so a disabled module's panel or overlay
  view chunk never loads. Never turn these into direct imports.
- `settingsEditor?: () => Promise<{ default: SettingsEditorDefinition<Settings> }>`
  — for settings fully expressible as the built-in field kinds (`number`,
  `text`, `template`, `segment`, `choice`, `switchCard`; see
  `src/dashboard/ui/SettingsEditor.tsx`). The host renders load/save,
  server hints, 409-conflict handling and the read-only view once, for every
  module. If `settingsSchema` has any key, a guard test
  (`tests/unit/module-settings-editor-guard.test.ts`) requires this — a
  hand-written `panel` does not satisfy it, even when the module also has
  one (e.g. `ads`).
- `immediateActions?: { requires: readonly ImmediateActionRequirement[]; load: () =>
  Promise<{ default: ComponentType<ModuleImmediateActionProperties> }> }` — a
  lazily loaded card in the Stream Manager's immediate-action row, shown
  only while the module is enabled. `requires` lists the conditions the host
  must satisfy before the card is clickable (today only `"streamLive"`, from
  `IMMEDIATE_ACTION_REQUIREMENTS` in `src/contracts/values.ts`); the host
  evaluates it against the channel's current stream state and passes a
  localized `availabilityReason` string to the card when it doesn't hold.
  For example, `raid`:

  ```ts
  immediateActions: {
    requires: ["streamLive"],
    load: () => import("./panel/immediate-actions"),
  },
  ```

### What `handleEvent` gets and returns

`ModuleEvent` carries `channelId`, `subscriptionType`, `triggerId` (Twitch's
message ID, correlating all event-log rows from one trigger), the verified
`payload`, the module's own `settings`, `actor` (resolved from
`channel_members`; `actor.role: null` means the user is not a channel member,
while `actor: null` means the event has no resolved chatter at all), and —
for chat events only — `chatStatus` (badge-derived
tiers; `founder` counts as `subscriber`, `moderator`/`broadcaster` also
satisfy lower tiers).

`ModuleExecutionContext` (only for modules with their own D1 access) gives a
module `DB`, a host-issued `authorizeMutation`, and lazy host lookups:
`streamState()` (`"online" | "offline" | "unknown"`), `channelInfo()`
(title/game/start time), `followedAt(userId)`, `channelLanguage()`. A module
never queries `channel_members` or Twitch directly for these.

A module returns `ModuleResult`: an ordered `actions` list (`chat`,
`announcement`, `shoutout`, `overlay`) and `diagnostics` — a stable,
machine-readable `code` plus small `detail` values, reported even when no
action was taken, so the event log can answer "why didn't it fire". The host
executes `chat`, `announcement` and `shoutout`; `overlay` actions are
currently logged as not executed (`host.overlay.not_executed`) — the
realtime path for them doesn't exist yet.

### Where a feature belongs

> A chat command whose complete configuration is name, minimum tier,
> cooldown, template and exactly one host action is a `text_commands` kind.
> A feature with its own state or its own events belongs in its own module.

### Rules the linter enforces (`eslint.config.js`)

- A module cannot import another module (only `src/modules/contract.ts` is
  shared).
- `overlay/` cannot import Worker, service, repository or adapter code, or
  Zod.
- `panel/` cannot import Worker, repository, adapter or overlay code; Zod
  and the module's own `service.ts` are allowed.
- `@mantine/*`, `@tabler/icons-react` and `rich-textarea` may only be
  imported from `src/dashboard/ui/`.
- The Worker cannot import React or `react-dom`.

### Minimal skeleton

```ts
// src/modules/example/contracts/index.ts
import { z } from "zod";
export const exampleSettingsSchema = z.object({ greeting: z.string() });
export type ExampleSettings = z.output<typeof exampleSettingsSchema>;

// src/modules/example/service.ts (domain/index.ts would hold pure helpers)
import type { ModuleEvent, ModuleResult } from "../contract";
import type { ExampleSettings } from "./contracts";

export const processExampleEvent = (event: ModuleEvent<ExampleSettings>): ModuleResult => ({
  actions: [{ kind: "chat", text: event.settings.greeting }],
  diagnostics: [{ code: "example.greeted" }],
});

// src/modules/example/index.ts
import type { BotModule } from "../contract";
import { exampleSettingsSchema } from "./contracts";
import { processExampleEvent } from "./service";

export const exampleModule: BotModule<typeof exampleSettingsSchema> = {
  id: "example",
  settingsSchema: exampleSettingsSchema,
  defaultSettings: { greeting: "Hello!" },
  eventSubTypes: ["channel.chat.message"],
  handleEvent: (event) => processExampleEvent(event),
};

// src/modules/registry.ts — add `exampleModule` to the MODULES array
```

Then run `pnpm run check`. Follow existing modules' test files (e.g.
`tests/unit/ads-module.test.ts`, `tests/unit/channel_events-module.test.ts`)
for the expected coverage: `handleEvent` decisions, EventSub type
registration, and — for a SQL schema change — a numbered migration under
`migrations/` plus updated `tests/unit/sql-contract.test.ts` coverage against
the schema produced by all migrations together, with a data backfill plan
when persisted settings need one.

## Contributing

See [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md) (German) for issue
labels/claiming, branch and PR rules, and the full commit-message format.
In short: branch off `main`, keep `pnpm run check` green, open a PR against
`main`. Merges require the `quality` CI check to pass and the branch to be
up to date; no self-approval is required, but open review comments block a
merge. SonarCloud runs and is visible but is not a required check — its
duplication findings are largely intentional test structure, while its
security findings are treated as real and fixed.

Commit subjects follow `<icon> <type>(<module>): summary`, for example
`🐛 fix(text_commands): reject alias collisions on rename` — see
`docs/CONTRIBUTING.md` for the full icon legend and body format.

## License

[MIT](LICENSE) © The BroBot contributors.
