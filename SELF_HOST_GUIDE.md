# Growth Suite — Self-Host Deployment Guide

## Architecture Overview

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Frontend SPA  │────▶│  Backend Server   │────▶│    Supabase     │
│   (Vite/React)  │     │  (Express/Node)   │     │   (Postgres)    │
│   Port 5173     │     │   Port 3001       │     │   Auth/DB/RT    │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                              │
                        ┌─────┴─────┐
                        │  Widget   │
                        │  Loader   │
                        │ (public/) │
                        └───────────┘
```

## Prerequisites

- Node.js 18+
- A Supabase project (or any Postgres instance) — used as the application database only; dashboard authentication is first-party and does not require Supabase Auth/GoTrue
- A VPS / Docker host / Coolify instance

## Quick Start (Development)

### 1. Database Setup

Apply the **complete** `database/migrations/` chain, in numeric order, against your Supabase/Postgres project — not just the first few files:

```bash
# Via Supabase SQL Editor or psql
for f in database/migrations/*.sql; do
  psql "$DATABASE_URL" -f "$f" || break
done
```

**Migration order is critical, and the chain must be run through its current head, not truncated.** Early migrations create core tables, workspace features, visitors/KB, and default feature flags; later migrations build the entire first-party authentication system (`profiles` as the identity root, `user_credentials`, session/token RPCs) and the account/workspace provisioning schema (`accounts`, `account_members`, `create_workspace_atomic`, `provision_account_on_signup`) that the dashboard's signup, login, and workspace-bootstrap flows depend on. Stopping partway through the chain leaves the dashboard unable to complete signup or provision a first workspace.

### 2. Backend Server

```bash
cd server
cp .env.example .env
# Edit .env with your Supabase credentials:
#   SUPABASE_URL=https://your-project.supabase.co
#   SUPABASE_ANON_KEY=your-anon-key
#   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

npm install
npm run dev        # Development (ts-node with watch)
```

Backend runs on `http://localhost:3001` by default.

### 3. Frontend

```bash
# From project root
cp .env.example .env
# Edit .env:
#   VITE_SUPABASE_URL=https://your-project.supabase.co
#   VITE_SUPABASE_ANON_KEY=your-anon-key
#   VITE_API_BASE_URL=http://localhost:3001

npm install
npm run dev        # Vite dev server on http://localhost:5173
```

### 4. First Run

1. Open `http://localhost:5173`
2. Sign up for an account
3. Create a workspace on the onboarding page
4. Configure branding in Settings → Branding
5. Enable the widget in the Widget page
6. Copy the embed code and paste it into your test site

## Server Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | Yes | Your Supabase project URL |
| `SUPABASE_ANON_KEY` | Yes | Supabase anon/public key |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase service role key (server-only!) |
| `PORT` | No | Server port (default: 3001) |
| `CORS_ORIGINS` | No | Comma-separated allowed origins for cross-origin dashboard requests. Unset/`*` fails closed (rejects cross-origin credentialed requests) rather than allowing every origin — only needed if the frontend is served from a different origin than the API; a same-origin reverse-proxy deployment doesn't need it. |
| `RATE_LIMIT_WINDOW_MS` | No | Rate limit window in ms (default: 60000) |
| `RATE_LIMIT_MAX` | No | Max requests per window (default: 100) |
| `APP_BASE_URL` | No* | The dashboard's public https URL, used to build links in verification/password-reset emails. Prefer configuring `app_base_url` via the admin UI (Super Admin → Domains) instead — that takes priority. *Effectively required in production if neither is set and `CORS_ORIGINS` isn't a real URL: auth emails fail loudly rather than going out with a broken link. |
| `INVITATION_LINK_SECRET` | Yes | 32-byte minimum link-derivation secret (`openssl rand -hex 32`). Must differ from the OTP pepper. |
| `INVITATION_OTP_PEPPER` | Yes | Dedicated 32-byte minimum OTP pepper. Never reuse another secret. |
| `INVITATION_LINK_SECRET_RING` | During rotation | `version:secret` entries retaining old link keys until their invitations expire. |
| `INVITATION_LINK_KEY_VERSION` | Yes | Active invitation derivation-key version. |
| `PHONE_VERIFICATION_PEPPER` | For phone OTP | Minimum **16** characters (`openssl rand -hex 32`). Peppers the hashed 6-digit phone codes. **Fails closed:** unset, every phone OTP — including Super Admin → user → *resend code* — answers `phone_verification_unavailable` (HTTP 503) and **no SMS is attempted at all**. That is indistinguishable from a broken SMS provider from the UI, so check this before suspecting SMS.ir/Kavenegar. The Super Admin resend action names the cause (`detail: "pepper_missing"`). |
| `GENERIC_VERIFICATION_PEPPER` | For email OTP / guest order lookup | Minimum **32** characters. Peppers the Generic Verification Core's codes (signup email OTP, WooCommerce guest order lookup). Fails closed the same way. Super Admin → Verification shows it as *pepper not configured*. |
| `SELF_HOST_SEAT_LIMIT` | Yes* | Authoritative seat limit unless billing mode is explicitly unlimited; missing value fails acceptance closed. |
| `INVITATION_WORKER_INPROC` | No | Development fallback only. Production uses a dedicated `WORKER_KIND=invitations` service. |
| `OBSERVABILITY_REPORTING_TICKERS` | No | **Risk: safe.** Set to exactly `off` to skip the six observe-and-report tickers at boot (alerting, perf/process collectors, reliability+business rollup, auto-actions ticker, auto-actions cache, SLO+enforcement) and the database churn they generate. Safe on an install with no users. Cost: alert incidents and webhooks stop, the reliability/business/process-trend charts stop filling, and automatic SLO throttling stops — a real incident then needs a manual admin auto-action. Nothing refuses work and no visitor sees a change: auto-actions only ever remove capability and the runtime check fails open, so visitors keep full transport, typing, video and no throttling. Realtime failover, call queue, billing and deletions are unaffected. |
| `REALTIME_FAILOVER_TICKER` | No | **Risk: caution.** Set to exactly `off` to skip the 30s realtime provider health probe and the failover/failback engine — the largest periodic writer left once the flag above is off. Realtime keeps working: `/connect` reads the persisted state directly, so the effective provider freezes at its last value (on a healthy install, the default). Cost: if that provider later dies, nothing moves the platform to the polling fallback and nothing ever fails back; recovery means setting the realtime provider lock by hand in the admin panel. |
| `PRODUCT_ANALYTICS_LOGGING` | No | **Risk: safe.** Set to exactly `off` to no-op the charts-only telemetry writes (`visitor_page_views`, `web_analytics_events`, `widget_smart_events`, `ai_agent_debug_events`, `ai_usage_logs`). Saves nothing at zero traffic — these are request-path writes — but keeps the cost at zero once visitors arrive. Cost: visitor-journey/page-path reports, the Inbox page history, the custom-events report, smart-rule and AI-nudge conversion analytics, the AI debug trail and the AI provider/model charts go blank. No billing, legal, routing or visitor-facing impact; AI billing reads `ai_usage_events`, which this does not touch. |
| `DELIVERY_DIAGNOSTICS_LOGGING` | No | **Risk: caution.** Set to exactly `off` to no-op `email_logs`, `channel_delivery_attempts` and `ai_source_sync_logs`. Sending, retry and ingestion are unaffected — retry state lives on `channel_jobs`. Cost: no evidence that an invitation/password-reset/invoice email was actually sent, no per-attempt error code or latency for a failed WhatsApp/Telegram send, an empty email section in the GDPR export, and the Data Hub can no longer show whether the last knowledge-source sync succeeded. |
| `COMPLIANCE_AUDIT_LOGGING` | No | **Risk: do not disable in production.** Set to exactly `off` to no-op `audit_logs`, `security_events`, `login_attempts`, `admin_gate_bypass_log`, `plan_change_log`, `commerce_tool_audit` and `realtime_provider_audit`. Saves nothing on an idle install (all request-path-only). Cost: the legal record of admin and privacy actions, the GDPR export's required audit section, the only forensic trail if this install is probed or compromised, account-takeover evidence and the user-visible login history, any trace of an admin gate bypass, and billing-dispute evidence of plan changes. Brute-force throttling is in-memory and keeps working. |
| `CHANNELS_WORKER_HEARTBEAT` | No | **Risk: caution.** Set to exactly `off` — on **both** Core and the channels worker — to stop the 45s `channel_worker_heartbeats` upsert (~1,920 writes/day on one row). Core relaxes its staleness gate under the same flag, so no request path starts refusing work. Cost: the Super Admin channels-health panel reports the worker offline forever even while it drains the queue, and Telegram diagnostics/webhook repair no longer fail fast with a clean 503 when the worker really is dead (the operator waits out the 12-15s timeout instead). Channel messaging is unaffected. Cheaper lever first: raise `CHANNELS_HEARTBEAT_MS`, up to ~100s (the staleness windows are 120s and 150s). |

## Frontend Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `VITE_SUPABASE_URL` | Yes | Your Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Yes | Supabase anon key (safe for frontend) |
| `VITE_API_BASE_URL` | Yes | Your backend server URL (e.g. http://localhost:3001) |

## Production Deployment

Run one durable worker container from `Dockerfile.worker` with
`WORKER_KIND=invitations`. It requires the Supabase service key, invitation
secrets, seat entitlement configuration and email/SMS provider credentials.
Do not enable `INVITATION_WORKER_INPROC` on production API replicas.

For link-key rotation, add the old and new versions to
`INVITATION_LINK_SECRET_RING`, set `INVITATION_LINK_KEY_VERSION` to the new
version, deploy API and worker together, and retain the old key until all
previously generated invitation links have expired.

### Docker

```dockerfile
# Dockerfile.frontend
FROM node:18-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ARG VITE_API_BASE_URL
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

```dockerfile
# Dockerfile.server
FROM node:18-alpine
WORKDIR /app
COPY server/package*.json ./
RUN npm ci --production
COPY server/ .
RUN npm run build
EXPOSE 3001
CMD ["npm", "start"]
```

### Coolify / VPS

1. Push to GitHub
2. In Coolify, create two services:
   - **Frontend**: Static site from `Dockerfile.frontend`
   - **Backend**: Node app from `Dockerfile.server`
3. Set environment variables in Coolify dashboard **on the Backend service**
   (not the Frontend one — these are all server-side secrets read via
   `process.env`, never bundled into the frontend build). If you instead
   deploy via `docker-compose.yml` as a Coolify "Docker Compose" resource,
   the project-level env vars you set there only reach a container if that
   compose file's `environment:` block forwards them with `${VAR}` — this
   repo's `docker-compose.yml` already does that for every var below.
4. Configure reverse proxy to route `/api/*` to backend
5. Serve `/widget/loader.js` from frontend static build

#### Optional: SEO → GSC Insights (Google Search Console)

Only needed if you want the SEO suite's Google Search Console integration
to work — without it, that module shows the user "not configured" instead
of erroring. On the **Backend** service, set:

- `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` — from a Google
  Cloud OAuth Client (type **Web application**) with the Search Console API
  enabled and the `.../auth/webmasters.readonly` scope added to the consent
  screen.
- `GOOGLE_OAUTH_REDIRECT_URI` — must be byte-for-byte identical to an
  Authorised redirect URI on that same OAuth client, and must resolve to
  this **Backend** service's own public origin — e.g.
  `https://api.yourdomain.com/api/seo/gsc/oauth/callback`. In a split
  Coolify deployment this is your `api.*` subdomain, not the frontend's
  `app.*` one. The client's "Authorised JavaScript origins" field is not
  used by this flow (the OAuth exchange happens server-side) and can be
  left empty.
- `PLUGIN_SECRETS_MASTER_KEY` (see above) must also be set — Search
  Console refresh tokens are encrypted with it before being stored.

See `server/.env.example` for the full step-by-step.

#### Optional: Gmail channel plugin (Email Inbox)

Only needed if you want to offer the Gmail plugin / the dedicated Email
Inbox — without it, Gmail shows as unavailable in the plugin marketplace.
Reuses the SAME Google Cloud OAuth Client as GSC above (`GOOGLE_OAUTH_
CLIENT_ID`/`GOOGLE_OAUTH_CLIENT_SECRET`) — Google allows several redirect
URIs on one Client, so this is additive, not a second project.

On the **Backend** service:

- Enable the **Gmail API** on the same Google Cloud project used for GSC.
- Add scopes `.../auth/gmail.modify` and `.../auth/gmail.send` to the same
  OAuth consent screen as GSC.
- On that same OAuth Client, add another Authorised redirect URI — e.g.
  `https://api.yourdomain.com/api/plugins/gmail/oauth/callback` — and set
  `GOOGLE_GMAIL_OAUTH_REDIRECT_URI` to that exact value.
- In **Cloud Pub/Sub**, create a topic (e.g. `gmail-inbox-push`), then grant
  **Publish** rights on it to `gmail-api-push@system.gserviceaccount.com`
  (Google's own fixed service account for this — not one you create). Set
  `GMAIL_PUBSUB_TOPIC` to the topic's fully-qualified name
  (`projects/<project>/topics/<topic>`).
- On that topic, create a **push subscription** whose endpoint is
  `https://api.yourdomain.com/webhooks/gmail/push` — this is a Core route,
  not the Channels Gateway. Configure the subscription's push authentication
  with an OIDC token and set its audience to that same URL; set
  `GMAIL_PUBSUB_PUSH_AUDIENCE` to match.
- `PLUGIN_SECRETS_MASTER_KEY` must also be set (shared with every other
  channel's encrypted credential storage).

On the **Channels Worker** service (`Dockerfile.worker`), also set
`GOOGLE_OAUTH_CLIENT_ID`/`GOOGLE_OAUTH_CLIENT_SECRET` — the Worker refreshes
Gmail access tokens itself for the sync/send jobs, independent of Core.

See `server/.env.example` for the full inline documentation of each var.

#### Optional: Yahoo Mail channel plugin (Email Inbox)

Only needed if you want to offer the Yahoo Mail plugin — feeds the SAME
Email Inbox as Gmail once connected. Unlike Gmail, Yahoo has no existing
platform OAuth Client to reuse: this is its own Yahoo Developer Network app.

On the **Backend** service:

- Create an app at developer.yahoo.com/apps with API Permissions: **Mail**
  (Read/Write). That single permission is what grants IMAP/SMTP XOAUTH2
  access — there is no separate "enable an API" step the way Google
  requires for Gmail.
- Add a Redirect URI — e.g.
  `https://api.yourdomain.com/api/plugins/yahoo/oauth/callback` — and set
  `YAHOO_OAUTH_REDIRECT_URI` to that exact value.
- Set `YAHOO_OAUTH_CLIENT_ID`/`YAHOO_OAUTH_CLIENT_SECRET` from that app.
- `PLUGIN_SECRETS_MASTER_KEY` must also be set (shared with every other
  channel's encrypted credential storage).

On the **Channels Worker** service, also set `YAHOO_OAUTH_CLIENT_ID`/
`YAHOO_OAUTH_CLIENT_SECRET`/`YAHOO_OAUTH_REDIRECT_URI` — unlike Gmail's
Worker-side token refresh, Yahoo's token endpoint requires `redirect_uri` on
every refresh call too, not just the initial code exchange, so the Worker
needs the same three values Core does. There is no Pub/Sub-equivalent setup:
Yahoo exposes no push webhook for third-party apps, so the Worker polls
IMAP on a fixed interval instead (`CHANNELS_YAHOO_POLL_INTERVAL_MS`,
default 75s).

See `server/.env.example` for the full inline documentation of each var.

### Reverse Proxy (nginx example)

```nginx
server {
    listen 80;
    server_name app.yourdomain.com;

    location /api/ {
        proxy_pass http://backend:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location / {
        root /usr/share/nginx/html;
        try_files $uri $uri/ /index.html;
    }
}
```

## What Is NOT Dependent on Lovable Cloud

- ✅ Auth — first-party: the dashboard authenticates against `profiles` + `user_credentials` in your own Postgres schema, not Supabase Auth/GoTrue. Login/signup issue an HttpOnly `gs_session` cookie from your own Express server; Supabase GoTrue is not used as application auth at all.
- ✅ Email verification — fully self-hosted custom token system (no Supabase GoTrue links)
- ✅ Password reset — fully self-hosted custom token system
- ✅ Database — your Supabase Postgres (used purely as a Postgres database — GoTrue/`auth.users` is not part of the application's identity model)
- ✅ Realtime — your Supabase Realtime
- ✅ Widget bootstrap — your own Express server (`/api/widget/config`)
- ✅ Visitor tracking — your own Express server (`/api/visitors/track`)
- ✅ All CRUD — direct Supabase client from frontend
- ✅ All admin config — persisted in your Supabase database
- ✅ All branding — stored in `workspace_branding` table, fully editable
- ✅ Widget loader — static file in `public/widget/loader.js`
- ✅ Browser title, favicon, meta — driven from `workspace_branding`
- ✅ Widget embed code — generated from branding settings

## Important: Rebuild & Redeploy

After making changes to auth logic, email templates, or environment variables:

- **Backend**: Redeploy the backend service (Coolify / Docker restart)
- **Frontend**: Rebuild the frontend (`npm run build`) — Vite env vars are baked in at build time
- Both steps are required for changes to take full effect

## Widget Installation

The widget uses a Crisp-style embed model:

```html
<script type="text/javascript">
  window.__gs = [];
  window.__gs_id = "YOUR_WORKSPACE_ID";
  (function(){
    var d = document;
    var s = d.createElement("script");
    s.src = "https://your-widget-domain.com/widget/loader.js";
    s.async = 1;
    d.getElementsByTagName("head")[0].appendChild(s);
  })();
</script>
```

The loader:
1. Reads `window.__gs_id` for workspace identification
2. Derives API base from its own script src URL
3. Fetches widget config from `/api/widget/config` (server-validated)
4. Starts visitor tracking via `/api/visitors/track`
5. Sends heartbeats every 30s via `/api/visitors/heartbeat`
6. Loads widget runtime script if configured

## Provider Swapping

All business logic uses provider interfaces. To swap providers:

1. Implement the interface (e.g., `CustomAuthProvider implements AuthProvider`)
2. Pass it to the context provider (e.g., `<AuthContextProvider provider={customAuth}>`)
3. No business logic changes needed

Interfaces defined in `src/types/providers.ts`:
- AuthProvider, DatabaseProvider, RealtimeProvider
- EmailProvider, StorageProvider, AIProvider
- SearchProvider, NotificationProvider, CacheProvider
- FeatureFlagProvider, WidgetDeliveryProvider
