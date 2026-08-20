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
- A Supabase project (or any Postgres with auth)
- A VPS / Docker host / Coolify instance

## Quick Start (Development)

### 1. Database Setup

Run migrations in order against your Supabase project:

```bash
# Via Supabase SQL Editor or psql
psql $DATABASE_URL -f database/migrations/001_core_tables.sql
psql $DATABASE_URL -f database/migrations/002_workspace_features.sql
psql $DATABASE_URL -f database/migrations/003_visitors_kb_config.sql
psql $DATABASE_URL -f database/migrations/004_seed_defaults.sql
```

**Migration order is critical.** 001 creates core tables + helper functions. 002 adds workspace features. 003 adds visitors + KB. 004 seeds default feature flags.

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

## Frontend Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `VITE_SUPABASE_URL` | Yes | Your Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Yes | Supabase anon key (safe for frontend) |
| `VITE_API_BASE_URL` | Yes | Your backend server URL (e.g. http://localhost:3001) |

## Production Deployment

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
3. Set environment variables in Coolify dashboard
4. Configure reverse proxy to route `/api/*` to backend
5. Serve `/widget/loader.js` from frontend static build

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

- ✅ Auth — uses your Supabase project directly
- ✅ Email verification — fully self-hosted custom token system (no Supabase GoTrue links)
- ✅ Password reset — fully self-hosted custom token system
- ✅ Database — your Supabase Postgres
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
