# Coolify Deployment Guide — Multi-Domain Production

This project deploys as **two separate services** in Coolify.
The same codebase supports multiple domains via environment variables.

The database is any PostgreSQL 15+ the backend can reach: a PostgreSQL
service in Coolify (image `pgvector/pgvector:pg17`), an external server, or
a Supabase project used only as a database. Setup, migrations and moving
between them: [`docs/DATABASE.md`](docs/DATABASE.md).

---

## Architecture

```
Browser → https://example.com (Frontend / Nginx)
        → /api/* same-origin proxy → https://api.example.com (Backend / Express)
Browser → https://api.example.com (Backend / Express, optional direct API calls)
```

- **Frontend**: Static SPA served by Nginx. Its `/api/` location proxies to Express.
- **Backend**: Express API. Accepts requests from frontend origin(s) via CORS.
- **Canonical runtime contract**: `BACKEND_URL` is a bare backend origin. Never append `/api`.

---

## 1. Frontend Deployment

| Setting | Value |
|---|---|
| **Deploy type** | Dockerfile |
| **Dockerfile path** | `Dockerfile.frontend` |
| **Internal port** | `80` |
| **Domain** | `example.com` (your domain) |

### Build Arguments (set in Coolify)

| Variable | Example | Required |
|---|---|---|
| `VITE_API_BASE_URL` | `https://api.example.com` | ✅ |

> ⚠️ These are **build-time** variables. You must rebuild after changing them.

### Runtime Environment Variable (set on the frontend service)

| Variable | Example | Required |
|---|---|---|
| `BACKEND_URL` | `https://api.example.com` | ✅ |

`BACKEND_URL` must be a bare origin. The frontend nginx template appends
`/api/` itself. The container entrypoint defensively normalizes an accidental
trailing `/api`, so neither accepted input can generate `/api/api/`:

```text
https://api.example.com     → https://api.example.com/api/...
https://api.example.com/api → https://api.example.com/api/...
```

---

## 2. Backend Deployment

| Setting | Value |
|---|---|
| **Deploy type** | Dockerfile |
| **Dockerfile path** | `Dockerfile.server` |
| **Internal port** | `3001` |
| **Domain** | `api.example.com` (your API domain) |
| **Health check path** | `/api/health` |

### Environment Variables (set in Coolify)

| Variable | Example | Required |
|---|---|---|
| `PORT` | `3001` | ✅ |
| `DATABASE_URL` | `postgresql://webyar_app:…@postgres:5432/webyar` | ✅ |
| `PLATFORM_SIGNING_SECRET` | `openssl rand -hex 32` (moving from Supabase: the old service-role key) | ✅ |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | | ❌ (only for the optional Supabase Realtime transport) |
| `CORS_ORIGINS` | `https://example.com` | ✅ |
| `WIDGET_ASSET_BASE_URL` | `https://example.com` | ✅ (split deploy) |
| `RATE_LIMIT_WINDOW_MS` | `60000` | ❌ (no effect — limits are fixed per route) |
| `RATE_LIMIT_MAX` | `100` | ❌ (no effect — limits are fixed per route) |
| `RESEND_API_KEY` | `re_xxx` | ❌ |
| `SENDGRID_API_KEY` | `SG.xxx` | ❌ |
| `SMTP_HOST` | `smtp.example.com` | ❌ |
| `SMTP_PORT` | `587` | ❌ |
| `SMTP_USER` | | ❌ |
| `SMTP_PASS` | | ❌ |
| `PHONE_VERIFICATION_PEPPER` | `openssl rand -hex 32` | ✅ (phone OTP) |
| `GENERIC_VERIFICATION_PEPPER` | `openssl rand -hex 32` | ✅ (email OTP / guest order lookup) |

> ⚠️ **Verification peppers (fail closed, no fallback).**
> Unlike `INVITATION_LINK_SECRET` / `INVITATION_OTP_PEPPER` — which
> self-bootstrap from the database when unset (see
> `server/services/invitations/secretBootstrap.ts`) — these two have **no
> fallback**. Leave `PHONE_VERIFICATION_PEPPER` unset and every phone OTP,
> including Super Admin → user → *resend code*, answers
> `phone_verification_unavailable` (HTTP 503) **before any SMS is
> attempted**. From the UI that is indistinguishable from a broken SMS
> provider, so check this first. Minimum 16 characters
> (`GENERIC_VERIFICATION_PEPPER`: 32). Use two different values, and never
> change one afterwards — codes already in flight are HMAC'd with it.

> ⚠️ **Widget asset consistency (critical).**
> In a split deploy the backend Express container cannot read the frontend
> nginx container's filesystem, so it cannot find `widget-manifest.json`.
> You **must** set `WIDGET_ASSET_BASE_URL` (or `WIDGET_MANIFEST_URL`) to
> the frontend's public URL. Otherwise `/api/widget/config` returns
> `runtime.js?v=unresolved` and customer browsers load stale/cached
> runtime assets that mismatch the loader contract.
>
> Verify after deploy: `curl https://api.example.com/api/health/widget`
> should show `manifest.source` starting with `remote:` or `fs:`, and
> `manifest.loaderVersion` should NOT be `unresolved` or `dev`.

---

## 3. DNS Setup

| Record | Name | Value |
|---|---|---|
| A | `@` | Your Coolify server IP |
| A | `api` | Your Coolify server IP |

Both `example.com` and `api.example.com` should point to the same Coolify server.
Coolify's reverse proxy routes traffic to the correct container by domain.

---

## 4. Multi-Domain Deployment

To deploy the **same codebase** for a second domain (e.g. `site2.com`):

1. Create a **new Frontend service** in Coolify from the same repo
   - Set `VITE_API_BASE_URL=https://api.site2.com`
   - Set domain to `site2.com`

2. Create a **new Backend service** in Coolify from the same repo
   - Set `CORS_ORIGINS=https://site2.com`
   - Set domain to `api.site2.com`

3. Set DNS for `site2.com` and `api.site2.com`

Each deployment is fully independent. No code changes needed.

---

## 5. CORS Configuration

Set `CORS_ORIGINS` on the backend to your frontend domain(s).

- Single domain: `https://example.com`
- Multiple: `https://example.com,https://www.example.com`
- Development: `*` (not recommended for production)

---

## 6. Auth & Session Notes

- Auth is first-party: the backend checks `profiles` + `user_credentials` in
  your own database and issues an HttpOnly `gs_session` cookie. Supabase Auth
  is not used, and the browser never talks to Supabase.
- Email verification and password reset use **fully self-hosted** custom token system
- Verification/reset links point to the **frontend domain** (not Supabase)
- No `supabase.co/auth/v1/verify` links are used

> ⚠️ **After any auth-related backend changes**, you must **redeploy the backend** AND **rebuild the frontend** for changes to take effect.

---

## 7. Widget Deployment

The widget loader (`/widget/loader.js`) is served from the frontend.
It auto-detects the API base URL from the script's `src` attribute.

For cross-domain widget usage, the backend's CORS must allow the customer's domain.

---

## Local Development

Use `docker-compose.yaml` for local dev only:

```bash
cp .env.docker.example .env.docker
# Edit .env.docker with your values (DATABASE_URL, PLATFORM_SIGNING_SECRET, …)
docker compose --env-file .env.docker up --build
```

For the full stack with a bundled PostgreSQL, see `docker-compose.postgres.yml`.

This starts both services locally. **Not for production use.**
