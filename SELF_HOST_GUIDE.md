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

## 1. Database Setup

Run the migrations against your Supabase project:

```bash
# Via Supabase SQL Editor or psql
psql $DATABASE_URL -f database/migrations/001_core_tables.sql
psql $DATABASE_URL -f database/migrations/002_workspace_features.sql
psql $DATABASE_URL -f database/migrations/003_visitors_kb_config.sql
```

## 2. Backend Server

```bash
cd server
cp .env.example .env
# Edit .env with your Supabase credentials
npm install
npm run dev        # Development
npm run build      # Production build
npm start          # Production start
```

### Server Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | Yes | Your Supabase project URL |
| `SUPABASE_ANON_KEY` | Yes | Supabase anon/public key |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase service role key (server-only!) |
| `PORT` | No | Server port (default: 3001) |
| `CORS_ORIGINS` | No | Comma-separated allowed origins |

## 3. Frontend

```bash
# Root directory
npm install
npm run build
```

### Frontend Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `VITE_SUPABASE_URL` | Yes | Your Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Yes | Supabase anon key (safe for frontend) |
| `VITE_API_BASE_URL` | Yes | Your backend server URL |

## 4. Docker Deployment

```dockerfile
# Dockerfile.frontend
FROM node:18-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80

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

## 5. Coolify / VPS

1. Push to GitHub
2. In Coolify, create two services:
   - **Frontend**: Static site from `Dockerfile.frontend`
   - **Backend**: Node app from `Dockerfile.server`
3. Set environment variables in Coolify dashboard
4. Configure reverse proxy to route `/api/*` to backend

## What Is NOT Dependent on Lovable Cloud

- ✅ Auth — uses your Supabase project directly
- ✅ Database — your Supabase Postgres
- ✅ Realtime — your Supabase Realtime
- ✅ Widget bootstrap — your own Express server (`/api/widget/config`)
- ✅ Visitor tracking — your own Express server (`/api/visitors/track`)
- ✅ All CRUD — direct Supabase client from frontend
- ✅ All admin config — persisted in your Supabase database
- ✅ All branding — stored in `workspace_branding` table, fully editable
- ✅ Widget loader — static file in `public/widget/loader.js`

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
