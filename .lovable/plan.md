# Plugin Platform + Channels Runtime + Telegram

Scope is large enough that it must ship in phases. Each phase ends in a working,
type-checked, deployable state. Nothing below touches Auth, Widget runtime,
Call Center, AI Agent internals, billing core, or Smart Engagement.

Repo audit (current `main`, commit `c807183be`):
- Migrations run to `047_...`, so new files start at `048`.
- Workers already dispatch on `WORKER_KIND` in `worker/index.ts`
  (`intelligence`, `source-sync`, `file-ingest`, `regression-runner`, `all`).
- Core API is `server/` (Express), locales are `src/i18n/locales/{en,fa,tr}.ts`.

## Phase 1 — Data + plugin core (foundation)

Migrations `048`–`050`, service-role only, no browser-readable rows:
- `plugin_platform_state` — per-plugin Super Admin state (enabled,
  marketplace_visible, installable, maintenance_mode, featured, sort_order,
  rollout_status).
- `workspace_plugin_installations` — workspace_id, plugin_id, status,
  installed_by, timestamps; unique per (workspace, plugin, instance).
- `plugin_secrets` — authenticated-encryption envelope (key version, nonce,
  ciphertext, auth tag). Reuses whatever crypto helper the audit finds in
  `server/lib`; otherwise a new AES-256-GCM helper keyed by a server-only
  master key.
- `channel_jobs`, `channel_inbound_events`, `channel_delivery_attempts`,
  `channel_worker_heartbeats`.

Code: `server/plugins/registry.ts` (immutable `PluginDefinition` catalog:
Telegram available, the rest `coming_soon`), plugin state/installation
services, and `/api/plugins` + `/api/admin/plugins` routes.

## Phase 2 — Channels Gateway + Channels Worker

- New `channels/` service (`server.ts`, `config.ts`, `routes/`,
  `providers/telegram/`) with `Dockerfile.channels`, `GET /health`,
  `GET /ready`, and `POST /webhooks/telegram/:publicIntegrationId`.
  Verifies `X-Telegram-Bot-Api-Secret-Token` before any processing, writes a
  durable idempotent inbound event, enqueues a job, acks fast.
- New `worker/channels/` kind wired into the existing dispatcher
  (`WORKER_KIND=channels`, optional `CHANNEL_JOB_TYPES` filter). Default kind
  stays `intelligence`.
- Job claiming reuses the repo's existing atomic-claim pattern
  (`FOR UPDATE SKIP LOCKED` + lease), so replicas are safe.
- Core internal API: narrow endpoints only —
  `POST /internal/channels/inbound-message`, `.../inbound-media`,
  `.../outbound-result`, `GET /internal/channels/integrations/:id/runtime` —
  authenticated with a dedicated `CORE_INTERNAL_SECRET` via constant-time
  compare. No generic SQL/RPC proxy.

## Phase 3 — Telegram provider, end to end

- Shared server-only client `server/providers/telegram/client.ts`
  (getMe, setWebhook, deleteWebhook, getWebhookInfo, send*, getFile,
  setMy*, setChatMenuButton), used by Core, Gateway and Worker. No Telegram
  HTTP anywhere else.
- Connect flow in Core: session + workspace-role check → getMe → duplicate
  `bot_id` check → encrypt token → generate public integration id + webhook
  secret → setWebhook (with `secret_token`) → getWebhookInfo verify → only
  then mark connected. Webhook URL built solely from
  `PUBLIC_CHANNELS_BASE_URL` (must be HTTPS, else a clear "environment not
  ready" error).
- Inbound: Gateway → Core internal → existing contact/conversation/message
  services → existing Inbox and existing AI Agent routing. No new
  contact/conversation/inbox implementations.
- Outbound: Inbox reply → canonical message `pending` → `channel_jobs` →
  Channels Worker → Telegram → `outbound-result` → `sent`/`failed`.
  Retries with exponential backoff, `retry_after` respected on 429, capped
  attempts, failures stay visible.
- Media in/out handled only in the Worker through the existing storage and
  attachment pipeline, with size/MIME/filename validation.
- Disconnect, uninstall (history preserved), and staged token replacement.

## Phase 4 — UI

- Workspace: one new sidebar item **Plugins** → `/app/w/:slug/plugins` with
  Marketplace / Installed tabs, search, categories, skeletons, empty and
  error states, plus the Telegram install wizard and settings (branding,
  localized welcome/help/offline/handoff content, commands).
- Settings → Integrations keeps website/embed/CMS setup; its messaging cards
  are replaced by a localized "Manage messaging channels in Plugins" CTA.
- Super Admin: `/admin/plugins` with Overview / Catalog / Installations /
  Telegram / Policies / Health tabs, including the channel runtime health
  panel (gateway configured, public URL, HTTPS, internal connectivity,
  worker heartbeat, pending/retrying/failed jobs, oldest pending age) and
  force-disconnect. Never shows secrets — only Configured / Missing.
- Separate status model: provider connection, gateway, worker, core.
  "Connected + runtime degraded" instead of a single fake status.
- Full `en`/`fa`/`tr` strings, natural Persian/Turkish, logical-CSS RTL.

## Phase 5 — Tests, docs, audit

- Dispatcher tests (existing kinds unaffected, default preserved),
  gateway auth/secret/idempotency tests, atomic-claim and retry tests,
  mocked-Telegram tests, cross-workspace isolation, i18n parity,
  remote-deployment contract test (no in-process imports across the
  Core/Channels boundary), secret-leak static audit.
- `docs/CHANNELS_DEPLOYMENT.md` with the five-service Coolify layout and the
  env contract, plus `.env` examples. No hardcoded domains.

## Technical notes

- Telegram is the only implemented provider; everything else is catalog-only
  `coming_soon` — no fake OAuth, credentials, or connected states.
- Entitlements use the existing capability registry with one new module key
  following current naming; self-host unlimited billing behavior is preserved.
- No Edge Functions; all backend logic stays in the Express core, the new
  channels gateway, and the existing worker image.
