# Coolify Deployment Guide — Multi-Domain Production

This project deploys as **two separate services** in Coolify.
The same codebase supports multiple domains via environment variables.

---

## Architecture

```
Browser → https://example.com (Frontend / Nginx)
Browser → https://api.example.com (Backend / Express)
```

- **Frontend**: Static SPA served by Nginx. Calls backend via `VITE_API_BASE_URL`.
- **Backend**: Express API. Accepts requests from frontend origin(s) via CORS.
- **No internal proxy.** Frontend and backend are fully independent services.

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
| `VITE_SUPABASE_URL` | `https://xxx.supabase.co` | ✅ |
| `VITE_SUPABASE_ANON_KEY` | `eyJ...` | ✅ |
| `VITE_API_BASE_URL` | `https://api.example.com` | ✅ |

> ⚠️ These are **build-time** variables. You must rebuild after changing them.

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
| `SUPABASE_URL` | `https://xxx.supabase.co` | ✅ |
| `SUPABASE_ANON_KEY` | `eyJ...` | ✅ |
| `SUPABASE_SERVICE_ROLE_KEY` | `eyJ...` | ✅ |
| `CORS_ORIGINS` | `https://example.com` | ✅ |
| `RATE_LIMIT_WINDOW_MS` | `60000` | ❌ |
| `RATE_LIMIT_MAX` | `100` | ❌ |
| `RESEND_API_KEY` | `re_xxx` | ❌ |
| `SENDGRID_API_KEY` | `SG.xxx` | ❌ |
| `SMTP_HOST` | `smtp.example.com` | ❌ |
| `SMTP_PORT` | `587` | ❌ |
| `SMTP_USER` | | ❌ |
| `SMTP_PASS` | | ❌ |

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

- Auth uses Supabase Auth (token-based via `supabase-js`)
- No cookie-based sessions between frontend/backend
- Frontend authenticates directly with Supabase
- Backend validates tokens via Supabase service role
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
# Edit .env.docker with your values
docker compose --env-file .env.docker up --build
```

This starts both services locally. **Not for production use.**
