# Plugin Platform + Channels Runtime + Telegram

Scope is large enough that it must ship in phases. Each phase ends in a working,
type-checked, deployable state. Nothing below touches Auth, Widget runtime,
Call Center, AI Agent internals, billing core, or Smart Engagement.

Repo audit (planning pass, commit `c807183be`) — **stale by design**:
- Workers already dispatch on `WORKER_KIND` in `worker/index.ts`
  (`intelligence`, `source-sync`, `file-ingest`, `regression-runner`, `all`).
- Core API is `server/` (Express), locales are `src/i18n/locales/{en,fa,tr}.ts`.
- Migration numbering is **not** assumed; see Phase 0.

## Phase 0 — Re-audit before any code

1. Re-fetch current `main` and report `Implementation starting SHA`. The
   planning SHA is stale; nothing is implemented from it.
2. Re-audit **both** migration chains (self-host `database/migrations/` and the
   hosted chain) and derive the real next numbers/names. No number is assumed.
3. Audit `server/lib` and `server/services` for an existing
   authenticated-encryption helper before writing any new crypto.
4. Audit the existing atomic job-claim pattern (`ai_kb_jobs`,
   `ai_source_sync_jobs`, `entitlement_fanout_jobs`) and reuse it verbatim.

## Ownership boundaries (locked)

**Channels Gateway owns:** public provider webhook HTTP ingress; Telegram
webhook secret verification; basic envelope validation; authenticated
forwarding to the Core ingress endpoint; fast HTTP acknowledgement;
`/health` and `/ready`.
It does **not** own Contacts, Conversations, Messages, AI, Assignments,
workspace permissions, plugin credential storage, or general DB access. It has
no database client at all.

**Core Backend owns:** `gs_session` / workspace authorization; plugin
installation and configuration; encrypted credential lifecycle; canonical
plugin state; the durable inbound ingest transaction; channel job creation;
Contacts; Conversations; Messages; Inbox; AI routing; handoff; audit.

**Channels Worker owns:** async channel jobs; all Telegram provider API calls;
outbound send; provider media download/upload; retry/backoff; Telegram
rate-limit handling; provider profile synchronization; webhook repair jobs;
worker heartbeat. It reports business results back only through narrow
authenticated Core internal endpoints.

## Canonical inbound path (single, no alternatives)

```text
Telegram
  → Channels Gateway
      verify X-Telegram-Bot-Api-Secret-Token
      validate basic envelope
  → authenticated narrow Core internal ingress endpoint
  → Core: ONE transaction writes the durable idempotency record
           + the channel job
  → Core returns success quickly
  → Gateway acknowledges Telegram (200)
  → WORKER_KIND=channels claims the job
  → Worker performs provider/media work (getFile, download, upload)
  → Worker calls narrow authenticated Core internal processing endpoint
  → Core creates/reuses canonical Contact / Conversation / Message
  → existing AI routing and handoff logic runs
```

If Core is unavailable or the ingest transaction fails, the Gateway returns a
non-2xx so Telegram retries. It never acknowledges an event that was not
durably persisted. Duplicate `(integration_id, update_id)` re-deliveries hit the
unique constraint and are acknowledged as already-ingested — no second job.

## Phase 1 — Data + plugin core (foundation)

Migrations (numbers determined in Phase 0, applied to **both** chains):
- `plugin_platform_state` — per-plugin Super Admin state (enabled,
  marketplace_visible, installable, maintenance_mode, featured, sort_order,
  rollout_status).
- `workspace_plugin_installations` — workspace_id, plugin_id, status,
  installed_by, timestamps; unique per (workspace, plugin, instance) so
  multi-instance plugins are possible later.
- `plugin_secrets` — authenticated-encryption envelope (key version, nonce,
  ciphertext, auth tag). No plaintext column, ever.
- `channel_integrations` — Telegram integration metadata (public integration
  id, bot_id, bot username, webhook state, verification timestamps).
- `channel_jobs`, `channel_inbound_events`, `channel_delivery_attempts`,
  `channel_worker_heartbeats`.

All of these are backend/service-only: no `anon` grant, no
`authenticated`-browser raw grant, RLS enabled with service-role-only policies.
The browser reaches them exclusively through Core Express endpoints.

Code: `server/plugins/registry.ts` (immutable `PluginDefinition` catalog —
Telegram `available`, everything else `coming_soon`), plugin state and
installation services, `/api/plugins` and `/api/admin/plugins` routes.

### Plugin secret encryption boundary

- Dedicated env key `PLUGIN_SECRETS_MASTER_KEY` (or the existing repo
  convention if Phase 0 finds one). Never reuses
  `SUPABASE_SERVICE_ROLE_KEY`, `CORE_INTERNAL_SECRET`, the JWT/Auth secret, or
  a Telegram token.
- Present in: **Core Backend YES**, **Channels Worker YES** (it needs bot
  credentials for send/media), **Channels Gateway NO**, **Frontend NO**.
- Missing/invalid key fails **closed** for every secret-dependent plugin
  operation and surfaces a safe configuration error in Super Admin health.
  There is no plaintext fallback path.
- Key version column supports rotation without rewriting rows in place.

## Phase 2 — Channels Gateway + Channels Worker

- New `channels/` service (`server.ts`, `config.ts`, `routes/`,
  `providers/telegram/`) with `Dockerfile.channels`, `GET /health`,
  `GET /ready`, and `POST /webhooks/telegram/:publicIntegrationId`.
  Its only secrets are `CORE_INTERNAL_SECRET` and
  `CHANNELS_WEBHOOK_SIGNING_KEY`; the rest of its config is public runtime data
  (`CHANNELS_PORT`, `CORE_INTERNAL_BASE_URL`, `PUBLIC_CHANNELS_BASE_URL`).
  It holds no Supabase client, no database access of any kind, no plugin
  encryption master key, and no bot token.

### Derived per-integration Telegram webhook secret

The Gateway must verify `X-Telegram-Bot-Api-Secret-Token` without any DB
lookup, so the secret is **derived**, not stored:

```text
telegramWebhookSecret =
  base64url(HMAC-SHA256(CHANNELS_WEBHOOK_SIGNING_KEY,
                        `telegram:${publicIntegrationId}`))
```

- A dedicated env secret `CHANNELS_WEBHOOK_SIGNING_KEY` is introduced. It never
  reuses `CORE_INTERNAL_SECRET`, `PLUGIN_SECRETS_MASTER_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY`, Auth/JWT secrets, or a Telegram bot token — a
  startup check rejects a value equal to any of those.
- Deployment boundary: **Core YES**, **Gateway YES**, **Worker NO**,
  **Frontend NO**.
- Core derives the value when calling `setWebhook(..., secret_token)`. The
  Gateway independently derives the same value from the public integration id
  in the URL and compares in constant time. The derived secret is never stored
  in plaintext in the database.
- `publicIntegrationId` is public; without the signing key it yields nothing —
  HMAC-SHA256 makes the secret non-derivable from the id alone.
- Rotating `CHANNELS_WEBHOOK_SIGNING_KEY` invalidates every registered Telegram
  webhook and **requires re-registration**. This is documented, and the
  `telegram_webhook_repair` job re-registers affected integrations after a
  controlled rotation.
- The signing key, the derived secret and the raw webhook header value are
  never logged.

- New `worker/channels/` kind wired into the existing dispatcher
  (`WORKER_KIND=channels`, optional `CHANNEL_JOB_TYPES` filter that defaults to
  all supported types). Default kind stays `intelligence`; existing kinds are
  untouched.
- Job claiming reuses the repo's existing atomic-claim pattern
  (`FOR UPDATE SKIP LOCKED` + lease/`locked_by`/`locked_at`), so multiple
  replicas are safe and restarts resume pending work.
- Core internal API — narrow, typed, no generic SQL/RPC/table proxy:
  - `POST /internal/channels/ingress/telegram` (Gateway → Core durable ingest)
  - `POST /internal/channels/inbound-message` (Worker → Core canonical persist)
  - `POST /internal/channels/inbound-media`
  - `POST /internal/channels/outbound-result`
  - `GET  /internal/channels/integrations/:id/runtime`
  - `POST /internal/channels/worker-heartbeat`

  All authenticated with the dedicated `CORE_INTERNAL_SECRET` using
  constant-time comparison, on a segment-safe route prefix.

### Channel job model

One queue covers the whole channel lifecycle — inbound and outbound:

```
telegram_inbound_event     telegram_outbound_message
telegram_inbound_media     telegram_outbound_media
telegram_profile_sync      telegram_webhook_repair
```

Generic shape: `provider`, `job_type`, `workspace_id`, `integration_id`,
`payload`, `status`, `attempt_count`, `available_at`, `locked_by`, `locked_at`,
`last_error`, timestamps. Future `whatsapp_*`, `instagram_*`, `email_send`
types slot in without schema change. **No secrets in payloads** — the worker
resolves credentials by integration id. No second queue is introduced for this
lifecycle.

## Phase 3 — Telegram provider, end to end

- Shared server-only, pure client `server/providers/telegram/client.ts`
  (getMe, setWebhook, deleteWebhook, getWebhookInfo, send*, getFile, setMy*,
  setChatMenuButton), importable by Core and Worker (and, for envelope types
  only, the Gateway). No Telegram HTTP anywhere else, never bundled to the
  frontend. Contracts verified against the current Bot API before coding.
- Connect flow in Core: session + workspace-role check → getMe → duplicate
  `bot_id` check → encrypt token → generate public integration id + webhook
  secret → setWebhook with `secret_token` → getWebhookInfo verify → mark
  connected only after verification. Webhook URL is built solely from
  `PUBLIC_CHANNELS_BASE_URL`; absent or non-HTTPS produces an explicit
  "environment not ready for inbound webhooks" error. Never derived from
  `Host`/`X-Forwarded-Host`/`Origin`.
- Inbound follows the canonical path above and lands in the existing Inbox via
  existing contact/conversation/message services. No new Inbox, Contact or
  Conversation implementations.
- Outbound: Inbox reply → canonical message `pending` → `channel_jobs` →
  Channels Worker → Telegram → `outbound-result` → `sent`/`failed`.
  Exponential backoff, `retry_after` honored on 429, capped attempts, failures
  stay visibly failed.
- Media in and out handled only in the Worker, through the existing storage and
  attachment pipeline, with size/MIME/filename validation and existing storage
  limits. Token-bearing Telegram file URLs never reach the browser.
- Disconnect (webhook deleted, secret invalidated, credential retired),
  uninstall (history preserved), and staged token replacement (verify new
  before retiring old).
- Localized customer-facing content (welcome, help, offline, handoff, fallback)
  in en/fa/tr, resolved Telegram `language_code` → workspace locale → English.
  Commands: `/start`, `/help`, `/human`, `/new`.

## Phase 4 — UI

- Workspace: one new sidebar item **Plugins / افزونه‌ها / Eklentiler** →
  `/app/w/:slug/plugins` with Marketplace and Installed tabs, search,
  categories, skeletons, empty and error states, plus the Telegram install
  wizard and settings (branding apply-on-demand, localized content, commands).
  Telegram is not added to the sidebar.
- Settings → Integrations keeps website/embed/CMS setup; its messaging cards
  become a localized "Manage messaging channels in Plugins" CTA. Embed install
  is not touched.
- Super Admin: `/admin/plugins` (separate from Providers) with Overview /
  Catalog / Installations / Telegram / Policies / Health tabs, including the
  channel runtime panel (gateway configured, public URL, HTTPS valid, internal
  connectivity, worker heartbeat, pending/retrying/failed jobs, oldest pending
  age) and force-disconnect. Secrets are shown only as Configured / Missing.
- Four independent status axes — provider connection, gateway, worker, core —
  so "Connected, runtime degraded, 12 pending" is expressible instead of one
  misleading status. Differentiated, localized error messages per failure kind.
- Full `en`/`fa`/`tr` strings with natural Persian/Turkish and logical-CSS RTL.

## Phase 5 — Tests, docs, audit

- Dispatcher tests (existing kinds unaffected, unset `WORKER_KIND` still
  defaults to `intelligence`), gateway auth/secret/idempotency/malformed-payload
  tests, "Core down ⇒ no false ack" test, atomic-claim and two-replica tests,
  retry/backoff and max-attempt tests, mocked-Telegram suite, cross-workspace
  isolation, i18n parity, secret-leak static audit.
- Webhook-secret derivation tests: (1) same key + same integration id yields the
  same secret; (2) different integration ids yield different secrets;
  (3) a different signing key yields a different secret; (4) a wrong webhook
  header is rejected; (5) the correct header is accepted; (6) the Gateway
  verifies with no DB access at all; (7) the Gateway has neither
  `SUPABASE_SERVICE_ROLE_KEY` nor `PLUGIN_SECRETS_MASTER_KEY`; (8)
  `CORE_INTERNAL_SECRET` is rejected as the webhook signing key at startup.

- Remote-deployment contract test: no import path lets the Gateway call Core
  runtime functions or vice versa; no in-memory queues, same-process callbacks
  or localhost assumptions. Only pure shared modules/types are permitted across
  the boundary; deployed services talk via authenticated internal HTTP and the
  Postgres job queue.
- `docs/CHANNELS_DEPLOYMENT.md` with the five-service Coolify layout
  (Dockerfile, Dockerfile.server, Dockerfile.channels, Dockerfile.worker
  ×`intelligence`, Dockerfile.worker ×`channels`), the env contract, and both
  the one-machine and split-server topologies. No hardcoded domains.

## Technical notes

- Telegram is the only implemented provider; everything else is catalog-only
  `coming_soon` — no fake OAuth, credentials, or connected states.
- Entitlements use the existing capability registry with one new module key
  following current naming; self-host unlimited billing behavior is preserved.
- No Edge Functions; all backend logic stays in the Express core, the new
  channels gateway, and the existing worker image.

## Explicit commitments

```text
Canonical inbound path:
  Telegram → Gateway → Core durable ingest → channel_jobs
           → Channels Worker → Core canonical processing

Gateway has SUPABASE_SERVICE_ROLE_KEY:        MUST BE NO
Gateway has PLUGIN_SECRETS_MASTER_KEY:        MUST BE NO
Gateway has CHANNELS_WEBHOOK_SIGNING_KEY:     YES
Core has CHANNELS_WEBHOOK_SIGNING_KEY:        YES
Worker has CHANNELS_WEBHOOK_SIGNING_KEY:      NO
Gateway DB access:                            MUST BE NO
Webhook verification requires DB lookup:      MUST BE NO
Channels Worker has plugin decryption:        YES
Core owns canonical conversations:            YES
Hosted/self-host migration parity:            REQUIRED
Current main re-fetched before implementation: REQUIRED
```
