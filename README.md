# Kindred Core

> **Canonical internal platform name:** Kindred Core (documentation only).
> Customer-facing brand strings are not hardcoded — they are resolved at
> runtime from `platform_branding` / `workspace_branding`. Existing legacy
> identifiers in code (`growth-suite-server`, `__gs_runtime`, `gs-widget`,
> `[Widget Runtime]`, etc.) are intentionally preserved for compatibility.
> See [`NAMING.md`](./NAMING.md).

---

## What this is

Kindred Core is a self-hosted, provider-driven customer engagement platform.
It bundles, in a single codebase:

- A multi-tenant operator/admin web application (React SPA).
- An embeddable visitor chat widget (Shadow-DOM, content-hashed runtime).
- An independent embeddable voice/video **call widget**.
- An Express backend that brokers Supabase, LiveKit, Centrifugo, email
  providers, MaxMind GeoIP, and AI services.
- A multi-kind worker process (AI knowledge-base builder, data-source
  sync, regression runner).
- A platform admin layer (super-admin), a workspace admin layer, an
  operator inbox, a public help center, and per-workspace branding.

The deployment model is **self-host first**. There is no required
dependency on managed Lovable Cloud or Supabase Edge Functions —
all server-side logic runs in the project's own Express server.

---

## Core product surfaces

| Surface | Route prefix | Purpose |
|---|---|---|
| Public help center | `/help/:locale/...` | Knowledge-base articles, search |
| Auth | `/auth/...` | Login, signup, invite, password reset, email verification |
| Workspace app | `/app/w/:slug/...` | Operator inbox, contacts, visitors, KB, widget config, call center (the `:slug` param resolves to a workspace) |
| Platform admin | `/admin/...` | Super-admin dashboard: users, workspaces, providers, billing, plans, observability, branding, domains, audit logs, security, voice/video, AI agent control, widget settings, feature flags |
| Embeddable chat widget | `/widget/loader.js` + hashed runtime | Customer-site visitor widget |
| Embeddable call widget | `/call-widget/l.js` + runtime | Standalone voice/video widget |

The full route table lives in `src/App.tsx`.

---

## Frontend stack

- React 18 + TypeScript 5
- Vite 5
- Tailwind CSS v3 + shadcn/ui (Radix primitives)
- TanStack Query
- React Router (BrowserRouter)
- i18n: `fa` (RTL), `en` (LTR), `tr` (LTR)
- Maps: Leaflet + react-leaflet + markercluster
- LiveKit JS SDK (self-hosted vendor bundle)
- Supabase JS client (auth + DB read paths only — privileged work goes
  through the Express backend)

The root `package.json` `name` field is `vite_react_shadcn_ts` (the
default Lovable Vite template name). It has not been renamed in order
to avoid breaking deploy scripts and image caches. See `NAMING.md`.

---

## Backend stack

- Node + Express 4 (`server/index.ts`)
- TypeScript (compiled by `tsc -p tsconfig.server.json`, output to `dist/server/`)
- Helmet, CORS, cookie-parser, express-rate-limit
- Supabase service-role client (server-only)
- JWT (`jsonwebtoken`), `crypto-js`
- Email providers: Resend, SendGrid, SMTP (configured via env or DB)
- MaxMind GeoIP (`maxmind`) for visitor geolocation
- PDF parsing (`pdf-parse`) for AI ingestion

The server package is named `growth-suite-server` (legacy). This is an
internal identifier only and is not surfaced to end users.

### Server boot responsibilities (`server/index.ts`)

The Express app mounts ~30 routers (widget, visitors, conversations,
calls, KB, AI agent, billing, plans, admin, observability, privacy,
notifications, etc.) and starts in-process tickers/workers:

- Source worker (AI sources — small/dev deploys)
- Call queue ticker, invitation expiry sweeper
- Attachment janitor
- Privacy worker + privacy expiry sweep
- Metrics rollup, alerting ticker, perf collectors
- Auto-actions ticker + cache
- Realtime failover ticker
- Reliability rollup, enforcement ticker

`trust proxy` is set to `loopback, linklocal, uniquelocal` so that
`x-forwarded-for` / `cf-connecting-ip` are only honored from private
upstream hops.

---

## Worker / process model

Workers ship as **one** image (`Dockerfile.worker`) with multiple kinds
selected via `WORKER_KIND`:

| `WORKER_KIND` | Source | Purpose |
|---|---|---|
| `intelligence` (default) | `worker/intelligence/` | AI knowledge-base builder (`public.ai_kb_jobs`) |
| `source-sync` | `worker/source-sync/` | Data Hub source sync (`public.ai_source_sync_jobs`) |
| `file-ingest` | `worker/source-sync/` | Alias of `source-sync` (production isolation) |
| `regression-runner` | `worker/regression-runner/` | AI agent regression batches/schedules |
| `all` | all of the above | Dev / small deploys only |

Operators run one Coolify service per kind for isolation. The legacy
entry `worker/intelligence/index.ts` is preserved and exposed as
`worker:intelligence:legacy` in `package.json` scripts.

See `docs/WORKERS_DEPLOYMENT.md` and `docs/AI_KB_WORKER_DEPLOYMENT.md`.

---

## Routing overview

- SPA routing via React Router (`BrowserRouter`). Lovable / nginx
  hosting falls back unknown paths to `index.html` automatically — no
  `_redirects` file is needed.
- Auth-gated layouts: `RequireAuth`, `RequireAdmin`, `AppLayout`,
  `AdminLayout`, `CallCenterLayout`, `AiAgentLayout`, `AuthLayout`,
  `PublicLayout`, `SettingsLayout`.
- Public surfaces: `/`, `/help/...`, marketing pages under
  `src/pages/public/`, and `/auth/...`.
- API surface: every backend route is mounted under `/api/...` from
  `server/index.ts`.

---

## Environment variables

### Frontend (`.env` at repo root, see `.env.example`)

| Variable | Required | Notes |
|---|---|---|
| `VITE_SUPABASE_URL` | yes | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | yes | Supabase anon (publishable) key |
| `VITE_API_BASE_URL` | yes | URL of the Express backend |
| `VITE_WIDGET_LOADER_BASE_URL` | no | Used **only** for the in-panel preview snippet shown on the login page when widget assets are served from a different origin |
| `VITE_WIDGET_ASSET_BASE_URL` | no | Same as above for hashed runtime URLs |

Vite env vars are **build-time** — the frontend image must be rebuilt
after changing them.

### Backend (`server/.env`, see `server/.env.example`)

Required:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (server-only — never sent to the browser)

Optional / common:

- `PORT` (default `3001`)
- `CORS_ORIGINS` (comma-separated list of frontend origins)
- `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`
- Email: `RESEND_API_KEY`, `SENDGRID_API_KEY`, `SMTP_HOST`, `SMTP_PORT`,
  `SMTP_USER`, `SMTP_PASS`, `SMTP_TLS_REJECT_UNAUTHORIZED`
- Widget asset resolution (split deploy):
  - `WIDGET_MANIFEST_URL` — explicit URL to `widget-manifest.json`
  - `WIDGET_ASSET_BASE_URL` — base URL where the frontend serves `/widget/`

Realtime (Centrifugo) connection details (`ws_url`, `api_url`,
`api_key`, `token_hmac_secret`) are **not** in `.env` — they are
configured at runtime via *Super Admin → Providers → Realtime* and
stored in the database. Do not duplicate them in env files.

Worker-only env: `WORKER_KIND` (see Worker section).

---

## Local development

Prereqs: Node 18+, a Supabase project (or compatible Postgres), Docker
(optional, for compose-based dev).

1. Database. Apply `database/migrations/001_*.sql` through
   `006_*.sql` in order against your Supabase / Postgres. Migration
   order is significant.
2. Backend:
   ```sh
   cd server
   cp .env.example .env   # fill SUPABASE_URL / ANON / SERVICE_ROLE
   npm install
   npm run dev            # tsx watch on :3001
   ```
3. Frontend (from repo root):
   ```sh
   cp .env.example .env   # fill VITE_SUPABASE_* and VITE_API_BASE_URL
   npm install
   npm run dev            # vite on :5173 (or 8080)
   ```
4. Workers (optional during dev):
   ```sh
   npm run worker:all     # both AI loops in one process
   # or:
   npm run worker:intelligence
   npm run worker:source-sync
   ```

Compose-based local dev (frontend + backend, no workers, no Centrifugo):

```sh
docker compose -f docker-compose.yaml up --build
```

Centrifugo and LiveKit are deployed as separate services — see
`docker-compose.centrifugo.yml`, `docker-compose.livekit.yml`,
`DEPLOY_CENTRIFUGO_COOLIFY.md`, and `deploy/livekit/README.md`.

---

## Build and run

- `npm run build` — runs `vite build` **and** `node scripts/widget-hash.js`.
  The widget-hash step copies `public/widget/*` into `dist/widget/` with
  content-hashed filenames and writes `dist/widget/widget-manifest.json`.
  This script is **mandatory** — production widgets break without it.
- `npm run typecheck:all` — frontend + server typecheck.
- `npm run lint` — ESLint.
- `npm test` — Vitest.
- Server build: `cd server && npm run build && npm start`.

---

## Deployment overview

The production model is **two independent services** — frontend (nginx)
and backend (Express) — plus optional worker, Centrifugo, and LiveKit
services. Detailed runbooks:

- `COOLIFY_DEPLOY.md` — multi-domain Coolify deployment.
- `SELF_HOST_GUIDE.md` — self-hosting overview (legacy title: "Growth
  Suite — Self-Host Deployment Guide"; preserved for compatibility).
- `DEPLOY_CENTRIFUGO_COOLIFY.md` — Centrifugo as its own Coolify service.
- `docs/WORKERS_DEPLOYMENT.md`, `docs/AI_KB_WORKER_DEPLOYMENT.md`.
- `docs/CALLS_ARCHITECTURE.md`, `docs/call-center-livekit.md`.
- [`DEPLOYMENT.md`](./DEPLOYMENT.md) — manifest / hashed-asset / cache
  invalidation operational notes (this audit).

Critical operational rule for split deploys: the Express backend cannot
read the nginx container's filesystem and therefore cannot find
`widget-manifest.json` locally. **Set `WIDGET_ASSET_BASE_URL` (or
`WIDGET_MANIFEST_URL`) on the backend** so it can fetch the manifest
over HTTP. Otherwise the widget config endpoint serves
`runtime.js?v=unresolved` with stale cache risk.

Verify after every deploy:

```sh
curl https://api.example.com/api/health/widget
# manifest.source must start with "remote:" or "fs:"
# loaderVersion must NOT be "unresolved"
```

---

## Widget / call-widget notes

There are **two separate** embeddable widgets, each with its own loader
and runtime bundle. They do not share runtime code at the bundle level.

### Chat widget (`public/widget/`)

- Entry: `loader.js` (stable filename, never hashed). Embeds via:
  ```html
  <script async src="https://YOUR_DOMAIN/widget/loader.js" workspace-id="..."></script>
  ```
- Runtime files (`runtime.js`, `runtime.css`, `runtime-chat.js`,
  `runtime-kb.js`, `runtime-call.js`, `runtime-rt-*.js`, plus
  `vendor/livekit-client.umd.min.js`) are **content-hashed** by
  `scripts/widget-hash.js` into `dist/widget/runtime.<hash>.js` etc.
- Hashed URLs are resolved by the backend at request time (see
  `server/services/widget/manifest.ts`) and returned to the loader via
  `/api/widget/config` (and the call-widget bootstrap). The loader
  refuses to fall back to unhashed URLs in production — failing loud
  is the documented preference over silently serving stale assets for
  a year (CDN cache).
- Shadow-DOM scoped: all widget CSS lives under `.shell ...` selectors
  inside `runtime.css`.
- **Single canonical design**: the chat widget has exactly one visual
  implementation and one runtime path. There is no template registry,
  no template selector, and no per-template branching — the legacy
  multi-template system was removed. `src/test/widget/noTemplateSystem.test.ts`
  guards against reintroducing it. The legacy `widget_templates` table and
  `widget_settings.template_slug` column are no longer read by any code.
- **Internal identifiers** (legacy, intentionally preserved):
  `__gs_runtime`, `<gs-widget>`, `.gs-launcher`, runtime log prefix
  `[Widget Runtime]`, loader log prefix `[Widget]` with constant
  `LOADER_VERSION` (e.g. `"2026-04-22-token-bus-v1"`).
  See `NAMING.md` and the migration-readiness package under `docs/`
  (`ADR-001`, `ADR-002`, `LEGACY_IDENTIFIER_INVENTORY.md`,
  `LEGACY_MIGRATION_PLAN.md`, `LEGACY_NAMING_DECISION_MATRIX.md`) for
  the full classification and migration policy.

### Call widget (`public/call-widget/`)

- Entry: `l.js`, runtime: `runtime.js`, styles: `runtime.css`. Vendor
  bundle: `vendor/livekit-client.umd.min.js`.
- These are **not** included in the widget-hash manifest. They are
  served as static files. A cache-bust query string is appended at
  fetch time (see `public/call-widget/l.js`).
- Bootstrap endpoint: `GET /api/call-widget/bootstrap`. Logs use the
  prefix `[call-widget]`.

---

## Operational sensitivities visible in the current implementation

1. **Widget asset consistency.** A mismatch between the loader's
   expected hash and the runtime present on the CDN produces silent
   "old style sometimes appears" bugs. The build script and the
   manifest reader fail loudly on purpose; deploys must rebuild
   *both* frontend and (if dependent on a remote manifest) the backend
   manifest cache.
2. **Service-role key isolation.** `SUPABASE_SERVICE_ROLE_KEY` must
   never reach the browser. The frontend uses the publishable / anon
   key only; privileged work crosses through `/api/...`.
3. **Edge Functions are forbidden by project policy.** All backend
   logic runs in the Express server.
4. **White-label.** No customer-facing brand string is hardcoded in
   user-visible UI. Defaults are intentionally generic
   (`platformName: 'Platform'`, index.html title `Platform`). Branding
   comes from `platform_branding` and `workspace_branding`.
5. **Multilingual / RTL.** `fa` is RTL with full fallback chains; do
   not hardcode left/right CSS — use logical properties.
6. **Realtime configuration lives in the database**, not env files.
   Centrifugo credentials are managed at runtime via Super Admin →
   Providers → Realtime.
7. **Migrations live in two places.** `database/migrations/00X_*.sql`
   are the canonical numbered migrations for self-host bring-up;
   `supabase/migrations/<timestamp>_*.sql` are produced by the
   Supabase migration tooling for incremental schema changes against
   the connected project. Both are applied to production.
8. **Trust proxy is private-only.** Public IPs in the
   `x-forwarded-for` chain are not trusted — operators terminating
   TLS in custom topologies should verify this matches their setup.

---

## Repository layout (high level)

```text
.
├── src/                    # React SPA
│   ├── pages/              # Route-level pages (admin, app, auth, public)
│   ├── components/         # UI + feature components
│   ├── features/           # Auth, branding, calls, providers, workspace
│   ├── hooks/              # TanStack Query hooks + domain hooks
│   ├── lib/                # API clients, helpers
│   ├── providers/          # Provider-driven architecture (Supabase, stubs, registry)
│   ├── realtime/           # Realtime resolver + drivers
│   ├── i18n/               # fa / en / tr
│   └── integrations/       # supabase/client, generated types
├── server/                 # Express backend (package: growth-suite-server)
│   ├── routes/             # ~50 route modules
│   ├── services/           # Domain services (widget manifest, calls, AI, etc.)
│   ├── middleware/         # Security, CORS, gating
│   └── index.ts            # Boot
├── worker/                 # Multi-kind worker dispatcher
├── public/
│   ├── widget/             # Chat widget loader + runtime sources
│   └── call-widget/        # Call widget loader + runtime sources
├── scripts/
│   └── widget-hash.js      # Hashes widget runtime + writes widget-manifest.json
├── database/migrations/    # Numbered self-host migrations (001-006)
├── supabase/migrations/    # Timestamped migrations from Supabase tooling
├── docs/                   # Architecture and ops runbooks
├── deploy/                 # Centrifugo / LiveKit / MaxMind config templates
├── Dockerfile.frontend     # nginx static SPA
├── Dockerfile.server       # Express backend
├── Dockerfile.worker       # Worker container (WORKER_KIND-driven)
├── Dockerfile              # Combined image (legacy / single-host)
├── docker-compose.yaml     # Local dev (frontend + backend)
├── COOLIFY_DEPLOY.md
├── SELF_HOST_GUIDE.md
├── DEPLOY_CENTRIFUGO_COOLIFY.md
├── NAMING.md               # ← naming audit (this audit)
└── DEPLOYMENT.md           # ← deployment / manifest audit (this audit)
```

---

## License / status

Internal project. Production-style codebase under active development.
