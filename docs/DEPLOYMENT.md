# Deployment Guide — Services, Workers & Plugins

Single entry point for installing and deploying the whole platform. Covers every
runnable service, the secrets that bind them together, the migration chain, and
the plugin/channel activation flow.

Related, narrower docs:

- [`../SELF_HOST_GUIDE.md`](../SELF_HOST_GUIDE.md) — first-time self-host setup
- [`../COOLIFY_DEPLOY.md`](../COOLIFY_DEPLOY.md) — Coolify-specific service wiring
- [`DEPLOY_CHANNELS.md`](DEPLOY_CHANNELS.md) — Channels gateway/worker detail
- [`WORKERS_DEPLOYMENT.md`](WORKERS_DEPLOYMENT.md) — background worker kinds
- [`AI_KB_WORKER_DEPLOYMENT.md`](AI_KB_WORKER_DEPLOYMENT.md) — KB builder worker

---

## 1. Topology

```text
        RESTRICTED NETWORK (e.g. Iran)              EXTERNAL NETWORK
 ┌───────────────────────────────────────┐   ┌──────────────────────────────┐
 │ frontend (nginx)                      │   │ ai-runtime  ──▶ AI providers │
 │ backend  (Core API, Express)          │──▶│                              │
 │ postgres / Supabase                   │   │ channels-gateway ──▶ Telegram│
 │ centrifugo (realtime)                 │   │ channels-worker              │
 │ workers (intelligence, source-sync)   │   └──────────────────────────────┘
 └───────────────────────────────────────┘
```

Hard rule enforced in code and tests: **Core never opens a socket to an AI or
channel provider.** All provider egress originates from `ai-runtime` and the
channels services. Breaking this fails `src/test/security/restrictedNetwork*`.

| Service | Image / Dockerfile | Port | Needs DB | Talks to providers |
|---|---|---|---|---|
| frontend | `Dockerfile.frontend` | 80 | no | no |
| backend (Core) | `Dockerfile.server` | 3001 | yes (service role) | **no** |
| centrifugo | `centrifugo/centrifugo:v5` | 8000 | no | no |
| channels-gateway | `Dockerfile.channels` | 3011 | no | inbound webhooks only |
| channels-worker | `Dockerfile.worker` (`WORKER_KIND=channels`) | — | yes | yes (Telegram) |
| ai-runtime | `Dockerfile.ai` | 3021 | **no** | yes (OpenAI/Anthropic/Gemini/…) |
| worker: intelligence | `Dockerfile.worker` (`WORKER_KIND=intelligence`) | — | yes | via AI Runtime |
| worker: source-sync | `Dockerfile.worker` (`WORKER_KIND=source-sync`) | — | yes | crawling only |

---

## 2. Prerequisites

- Docker 24+ / Coolify, or any container host
- A Supabase-shaped PostgreSQL database (hosted Supabase, or `supabase/postgres`
  self-hosted — stock `postgres:16` lacks the `auth` schema the RLS policies need)
- One public HTTPS hostname per publicly reachable service:
  app (frontend), api (backend), channels gateway, ai-runtime
- **Node 22.15 or newer** for the backend and worker images

### Node runtime requirement

`Dockerfile.server` and `Dockerfile.worker` are pinned to `node:22-alpine`,
and both assert the version at build time so a base-image downgrade fails the
build instead of surfacing in production. The requirement is also declared in
`package.json` and `server/package.json` (`engines.node: ">=22.15"`).

The reason is Web Analytics object storage: its Parquet writer compresses with
ZSTD through `node:zlib`, which landed in Node 22.15. On an older runtime that
feature reports an incompatible runtime and stops — it does **not** stop the
backend from booting, so a Node 20 deployment that never enables Web Analytics
storage still runs. Everything else in the stack is unaffected.

The frontend image (`Dockerfile`/`Dockerfile.frontend`), the channels gateway
and the AI runtime do not run this code and stay on their own pins.

### Analytics durability volume (only for S3-only writes)

`docker-compose.yml` mounts a named volume at `/app/data` on the backend. When
Web Analytics storage is switched to S3-only writes — a later phase, currently
locked — accepted events are written to a crash-safe log under
`/app/data/analytics-spool` before they are buffered, and replayed on the next
start if they never reached object storage. Override the location with
`ANALYTICS_SPOOL_DIR`.

That spool is **local to each backend instance**. Running more than one backend
requires a durable volume per instance: a node that loses its disk loses only
its own un-flushed rows, and no other instance can recover them. While writes
stay dual-write (the default), PostgreSQL remains the backstop and the spool is
an optimisation rather than a requirement.

The backend counts itself: every instance stamps its hostname into the analytics
instance census (the flush ticker runs on all of them, by design). Super Admin →
Analytics Storage reports how many instances are live, and on a multi-instance
deployment the cutover readiness check is **blocked** until an operator confirms
that each instance has its own durable volume. That confirmation is recorded
against the exact hostnames it was made for, so scaling out afterwards
invalidates it rather than silently carrying over.

Sizing the spool. The ceiling defaults to 2 GiB and is configurable:

| Variable | Default | Meaning |
|---|---|---|
| `ANALYTICS_SPOOL_DIR` | `/app/data/analytics-spool` | Where segments are written |
| `ANALYTICS_SPOOL_MAX_BYTES` | `2147483648` | Total ceiling; past it the oldest segment is dropped and the loss is logged |
| `ANALYTICS_SPOOL_SEGMENT_BYTES` | `67108864` | Rotation size |
| `ANALYTICS_SPOOL_FSYNC_MS` | `1000` | Upper bound on what a host power loss can cost |
| `ANALYTICS_SPOOL_ENABLED` | unset | `1` spools under dual-write too, so the mechanism can be exercised before cutover |

Size it from the outage you intend to survive, using the **measured** frame size
(Super Admin reports it; it depends on your URL and UTM lengths):

```
required_bytes = events_per_second x average_frame_bytes x outage_seconds x safety_factor
```

A safety factor of 2 or more is the recommendation.

Measured on a 4-core Ubuntu 24.04 VPS running the real ingest path, a realistic
page-view event (full URL with UTM parameters, denormalized session dimensions)
frames to **780 bytes**. At that size the 2 GiB default buys, at 2x safety:

| Ingest rate | Outage covered by the 2 GiB default | For a 24h outage |
|---|---|---|
| 100 events/sec | 3.8 hours | 12.6 GiB |
| 500 events/sec | 46 minutes | 62.8 GiB |
| 1,000 events/sec | 23 minutes | 125.6 GiB |

So the default is comfortable for a low-traffic install and **too small for a
busy one**. Set `ANALYTICS_SPOOL_MAX_BYTES` from the outage you actually intend
to survive, and give `/app/data` a volume that can hold it — if the ceiling is
reached it starts dropping the oldest segments, which makes it the thing that
loses the data the spool exists to protect.

Same measurement run, for reference: enqueue latency stayed at p99 < 1.3 ms up
to 1,000 events/sec, and a 90-day range (90 sealed objects, 658 KB) answered
all six main reports in 1.63 s total, with partition pruning reading exactly as
many objects as the window has days.

## 3. Database migrations

Run `database/migrations/*.sql` **in numeric order**, starting with
`000_selfhost_roles_bootstrap.sql` on self-hosted Postgres (no-op on hosted
Supabase). Details and the per-file rationale: [`../database/README.md`](../database/README.md).

Every migration is forward-only. Never edit a shipped file — add a new one.

**Migration authority (AI Billing included).** There are two authoritative
chains and every production deployment runs exactly one of them:

| Deployment | Authoritative chain | AI Billing migrations |
|---|---|---|
| Self-hosted Postgres (this guide) | `database/migrations/*.sql`, numeric order | `073_ai_usage_billing.sql`, `074_ai_billing_pricing_append_only.sql`, `075_ai_billing_recovery_lease.sql` |
| Hosted Supabase | `supabase/migrations/*.sql`, timestamp order | `20260901094824_*`, `20260901103902_*`, `20260901105630_*` |

The two AI Billing sets are byte-equivalent mirrors (comments/whitespace aside)
and CI enforces that: `src/test/integration/migrationMirrorParity.test.ts`
fails on any functional drift, and the `selfhost-chain` job applies the whole
`database/migrations` chain — including 073–075 — against a real database.
Financial invariants themselves are gated by the mandatory `ai-billing-db` CI
job (`REQUIRE_BILLING_DB=1`, which fails rather than skips without a database).

Verification helpers:

```bash
psql "$DATABASE_URL" -f scripts/ci/verify-selfhost-chain.sql
psql "$DATABASE_URL" -f scripts/ci/verify-hosted-chain.sql
```

## 4. Secrets

Generate each with `openssl rand -hex 32`. They are **distinct values** — Core
refuses to start if the AI secret is reused for channels.

| Secret | Held by | Purpose |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | backend, workers | DB access. **Never** in frontend or ai-runtime |
| `CORE_INTERNAL_SECRET` | backend, channels-gateway, channels-worker | bearer for `/internal/channels/*` |
| `CHANNELS_WEBHOOK_SIGNING_KEY` | backend, channels-gateway | signs/validates provider webhook URLs |
| `PLUGIN_SECRETS_MASTER_KEY` | backend, channels-worker | envelope encryption of plugin credentials (bot tokens) |
| `AI_RUNTIME_INTERNAL_SECRET` | backend, ai-runtime | bearer for the AI Runtime internal API |
| `CENTRIFUGO_TOKEN_HMAC_SECRET`, `CENTRIFUGO_API_KEY` | backend, centrifugo | realtime auth |
| `SESSION_SECRET` | backend | first-party auth sessions |

Rotation: change on both sides of a pair, then restart both services. Losing
`PLUGIN_SECRETS_MASTER_KEY` means stored bot tokens can no longer be decrypted —
each channel must be reconnected.

## 5. Local / single-host deployment

```bash
cp .env.docker.example .env.docker
# fill Supabase creds + the secrets from section 4
docker compose --env-file .env.docker up -d --build
docker compose ps          # every service should be healthy
```

Health endpoints:

```bash
curl -fsS http://localhost:3001/api/health   # backend
curl -fsS http://localhost:3011/health       # channels-gateway
curl -fsS http://localhost:3021/health       # ai-runtime
curl -fsS http://localhost:8000/health       # centrifugo
```

## 6. Split / production deployment

Deploy each service separately (Coolify: one resource per service, same repo,
different Dockerfile).

### frontend — `Dockerfile.frontend`

Build args (baked at build time, so rebuild after changing):
`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_API_BASE_URL`.
Runtime: `BACKEND_URL` (bare origin, no `/api` suffix) for the same-origin nginx proxy.

### backend (Core) — `Dockerfile.server`, port 3001

```env
PORT=3001
SUPABASE_URL= / SUPABASE_ANON_KEY= / SUPABASE_SERVICE_ROLE_KEY=
SESSION_SECRET=
APP_BASE_URL=https://app.example.com          # links inside auth emails
CORS_ORIGINS=https://app.example.com          # never leave "*" in production
TRUSTED_PROXY_IPS=
PLUGIN_SECRETS_MASTER_KEY= / CHANNELS_WEBHOOK_SIGNING_KEY= / CORE_INTERNAL_SECRET=
PUBLIC_CHANNELS_BASE_URL=https://channels.example.com   # what Telegram calls
CHANNELS_INTERNAL_BASE_URL=https://channels.example.com
AI_RUNTIME_URL=https://ai-runtime.example.com
AI_RUNTIME_INTERNAL_SECRET=
CENTRIFUGO_WS_URL= / CENTRIFUGO_API_URL= / CENTRIFUGO_API_KEY= / CENTRIFUGO_TOKEN_HMAC_SECRET=
APP_VERSION=<git sha>                          # stamped into /internal/channels/ready
```

Persist a volume at `/app/data` for the GeoIP `.mmdb` database.

### ai-runtime — `Dockerfile.ai`, port 3021 (external network)

```env
AI_RUNTIME_PORT=3021
AI_RUNTIME_INTERNAL_SECRET=          # must equal Core's, must differ from CORE_INTERNAL_SECRET
AI_HTTP_TIMEOUT_MS= / AI_RETRY_ATTEMPTS= / AI_TOTAL_BUDGET_MS=   # optional
```

Stateless by contract: no database, no stored provider keys — provider config
travels inline per request from Core. The process **refuses to boot** if
`SUPABASE_SERVICE_ROLE_KEY`, `PLUGIN_SECRETS_MASTER_KEY` or `SESSION_SECRET`
are present. Restrict ingress to Core's egress IP.

### channels-gateway — `Dockerfile.channels`, port 3011

```env
CHANNELS_PORT=3011
CHANNELS_WEBHOOK_SIGNING_KEY=
CORE_INTERNAL_SECRET=
CORE_INTERNAL_BASE_URL=https://api.example.com
```

Must be publicly reachable over HTTPS at `PUBLIC_CHANNELS_BASE_URL`. Holds no
database access and no provider credentials by design.

### channels-worker — `Dockerfile.worker`, `WORKER_KIND=channels`

```env
WORKER_KIND=channels
SUPABASE_URL= / SUPABASE_SERVICE_ROLE_KEY=
CORE_INTERNAL_BASE_URL=https://api.example.com
CORE_INTERNAL_SECRET=
PLUGIN_SECRETS_MASTER_KEY=
```

Drains `channel_jobs` (inbound + outbound). Without it messages queue but are
never delivered.

### background workers — `Dockerfile.worker`

| `WORKER_KIND` | Queue | Purpose |
|---|---|---|
| `intelligence` | `ai_kb_jobs` | AI KB Builder generation |
| `source-sync` | `ai_source_sync_jobs` | Data Hub source sync / crawling |
| `all` | both | dev and small deployments only |

`intelligence` additionally requires `AI_RUNTIME_URL` and
`AI_RUNTIME_INTERNAL_SECRET` — it reaches models only through the AI Runtime.
Optional: `WORKER_ID`, `WORKER_INTERVAL_MS`, `WORKER_LOCK_TTL_SECONDS`,
`CRAWLER_TIMEOUT_MS`, `CRAWLER_MAX_BYTES`, `CRAWLER_USER_AGENT`.

---

## 7. Plugins & channels

Plugins are **first-party trusted modules shipped in this repository**
(`server/plugins/registry.ts`). Users never upload code, SQL or modules;
"install" means enabling and configuring a catalog entry.

Two layers of state:

1. **Immutable capabilities** — in source (`registry.ts`): category, version,
   whether it supports inbox/AI/media/webhooks, plan keys.
2. **Operational platform state** — in `public.plugin_platform_state`:
   `enabled`, `marketplace_visible`, `installable`, `maintenance_mode`,
   `featured`, `sort_order`, `rollout_status`.

### Activation order

1. **Super Admin → Plugins** — enable the plugin globally and make it
   installable/visible. A globally disabled plugin is invisible to workspaces.
2. **Super Admin → Plans** — grant the entitlement. Channel plugins are sold as
   plan *channels* (`planChannelKey`, e.g. `telegram`), other plugins as
   *modules* (`planModuleKey`). Without the grant the workspace sees a
   plan-locked state, even when the plugin is globally enabled.
3. **Workspace → Plugins** — the workspace owner connects it (e.g. pastes the
   Telegram bot token). Credentials are encrypted with
   `PLUGIN_SECRETS_MASTER_KEY` and stored; they are never returned to the client.
4. Core registers the provider webhook at
   `PUBLIC_CHANNELS_BASE_URL/<signed path>` and channels-worker starts draining
   jobs.

### Telegram checklist

- `channels-gateway` publicly reachable over HTTPS (Telegram rejects plain HTTP)
- `PUBLIC_CHANNELS_BASE_URL` on Core equals that public origin
- `CORE_INTERNAL_SECRET` and `CHANNELS_WEBHOOK_SIGNING_KEY` identical across
  backend, gateway and worker
- `channels-worker` running with `PLUGIN_SECRETS_MASTER_KEY`
- AI replies additionally require: Super Admin AI toggle on for the plugin,
  the AI module granted to the workspace plan, and a reachable `AI_RUNTIME_URL`

---

## 8. Post-deploy verification

```bash
# 1. Core is up and knows its build
curl -fsS https://api.example.com/api/health

# 2. Gateway ↔ Core internal handshake
curl -fsS https://channels.example.com/health

# 3. AI Runtime reachable from Core's network only
curl -fsS https://ai-runtime.example.com/health

# 4. Provider-isolation and full suite
bunx vitest run src/test/security/
```

Then, in the app: send a widget message (AI replies), send a Telegram message
(appears in Inbox with the channel badge), and run an AI Playground question.

## 9. Troubleshooting

| Symptom | Likely cause |
|---|---|
| `AI runtime is not configured` | `AI_RUNTIME_URL` / `AI_RUNTIME_INTERNAL_SECRET` missing on backend **or** on the intelligence worker |
| `runtime_unauthorized` | secret mismatch between Core and ai-runtime |
| Telegram "no available server" | `PUBLIC_CHANNELS_BASE_URL` not HTTPS-reachable, or gateway down |
| Worker logs `Unauthorized` / `Not found` | `CORE_INTERNAL_SECRET` mismatch or stale Core image (check `APP_VERSION` at `/internal/channels/ready`) |
| Messages queue but never deliver | `channels-worker` not running |
| Credentialed cross-origin requests rejected | `CORS_ORIGINS` still `*` — set real origins |
| Broken links in auth emails | `APP_BASE_URL` unset (or set it in Super Admin → Domains) |
| Plugin hidden for a workspace | globally disabled, or plan channel/module not granted |
