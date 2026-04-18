# Deploying Centrifugo on Coolify

This guide covers deploying the **Centrifugo realtime provider** for this project on Coolify, in a way that matches the existing Phase 3 realtime implementation (`server/services/realtime/centrifugo.ts`).

> Centrifugo runs as a **standalone Coolify service**, separate from the backend and frontend. The backend talks to it over the **public domain** (HTTPS), because the three services do not share a Docker network in this deployment model.

---

## 1. Files in this repository

| Path | Purpose |
|---|---|
| `docker-compose.centrifugo.yml` | Coolify-compatible compose file for the Centrifugo container |
| `deploy/centrifugo/config.json` | Centrifugo runtime config (matches this project's channel/namespace model) |
| `DEPLOY_CENTRIFUGO_COOLIFY.md` | This guide |

---

## 2. Coolify setup

### 2.1 Create the service
1. In Coolify → your project → **+ New Resource** → **Docker Compose**.
2. Connect this repository (or paste the content of `docker-compose.centrifugo.yml`).
3. Set the **Compose file path** to: `docker-compose.centrifugo.yml`.
4. Make sure `deploy/centrifugo/config.json` is included in the build context (it will be, because Coolify mounts the repo).

> Use **Docker Compose** (not "Service" templates) so the volume mount for `config.json` works as written.

### 2.2 Add a public domain
1. Open the new resource → **Domains**.
2. Add a domain, e.g. `rt.destekly.tr`.
3. Set the **target port** to `8000`.
4. Enable **HTTPS** (Coolify will issue a Let's Encrypt cert).
5. Enable **WebSocket support** (it is on by default in Coolify's proxy, but double-check).

After this, both of the following must work over HTTPS:
- `https://rt.destekly.tr/health` → `{"status":"ok"}`
- `https://rt.destekly.tr/api` (POST with `X-API-Key`) → JSON response
- `wss://rt.destekly.tr/connection/websocket` → WebSocket handshake

### 2.3 Set environment variables (on the Centrifugo service)

| Variable | Required | Example | Notes |
|---|---|---|---|
| `CENTRIFUGO_TOKEN_HMAC_SECRET` | ✅ | `64-char random hex` | HS256 secret. Generate with `openssl rand -hex 32`. **Must match** the value entered in Super Admin → Providers → Realtime. |
| `CENTRIFUGO_API_KEY` | ✅ | `64-char random hex` | Server-to-server admin API key. **Must match** the value entered in Super Admin → Providers → Realtime. |
| `CENTRIFUGO_ALLOWED_ORIGINS` | ✅ | `https://destekly.tr,https://app.destekly.tr` | Comma-separated list of every origin where the widget loader/runtime runs. Include all customer-facing domains that embed the widget. |
| `CENTRIFUGO_ADMIN_PASSWORD` | optional | — | Only needed if you flip `admin: true` in `config.json` |
| `CENTRIFUGO_ADMIN_SECRET` | optional | — | Same as above |

Click **Deploy**. Wait for the healthcheck to go green.

---

## 3. Backend service (Express) — environment variables to update

The backend already implements the Centrifugo driver. You do **not** need to set Centrifugo URLs as backend env vars — they are stored in the database via the admin panel (`realtime_provider` config). The backend reads them through `loadRealtimeConfig()`.

The only backend env you may want to ensure is in place (used by the manifest resolver from the previous fix):

```
WIDGET_ASSET_BASE_URL=https://app.destekly.tr   # frontend public URL
```

That's it for backend env. Everything Centrifugo-related is configured **at runtime through the admin UI**, so you can rotate keys without redeploying.

---

## 4. Super Admin → Providers → Realtime — exact values to enter

After Centrifugo is running on `https://rt.destekly.tr`, log into the platform as a super admin and go to **Super Admin → Providers → Realtime**. Set:

| Field | Value |
|---|---|
| **Vendor** | `Centrifugo` |
| **Enabled** | ✅ on |
| **Fallback policy** | `lenient` (recommended) — falls back to polling if Centrifugo is unreachable |
| **WebSocket URL** (`ws_url`) | `wss://rt.destekly.tr/connection/websocket` |
| **HTTP API URL** (`api_url`) | `https://rt.destekly.tr/api` |
| **API Key** (`api_key`) | the same value as `CENTRIFUGO_API_KEY` |
| **HMAC Token Secret** (`token_hmac_secret`) | the same value as `CENTRIFUGO_TOKEN_HMAC_SECRET` |
| **Allowed origins** | same list as `CENTRIFUGO_ALLOWED_ORIGINS` |
| **Connect timeout (ms)** | `10000` |
| **Subscribe timeout (ms)** | `10000` |
| **Presence enabled** | ✅ |
| **Typing enabled** | ✅ |
| **Token TTL (seconds)** | `300` |

Click **Save**, then click **Test connection**. You should see `status: healthy`.

---

## 5. Verification checklist

Run these in order. All must pass before considering the deploy done.

### 5.1 Centrifugo container
```bash
curl https://rt.destekly.tr/health
# → {"status":"ok"}
```

### 5.2 Server-to-server API
```bash
curl -X POST https://rt.destekly.tr/api \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $CENTRIFUGO_API_KEY" \
  -d '{"method":"info","params":{}}'
# → {"result":{...}}
```

### 5.3 Backend resolver
Hit the admin "Test connection" button. It calls `CentrifugoDriver.health()` which performs the same `info` call above with the API key from the database.

### 5.4 Widget end-to-end
1. Open a page that embeds the widget on one of the `allowed_origins`.
2. In DevTools → Network, look for `POST /api/realtime/connect`. Response should contain:
   ```json
   { "vendor": "centrifugo", "ws_url": "wss://rt.destekly.tr/connection/websocket", "token": "...", ... }
   ```
3. Then a WebSocket connection to `wss://rt.destekly.tr/connection/websocket` should open and stay open (status `101 Switching Protocols`).
4. Send a message from the widget; in the operator inbox it should appear without polling delay.

### 5.5 Audit log
Super Admin → Providers → Realtime → **Audit** should show your `configure` and `test` actions with `result: success`.

---

## 6. Common pitfalls

- **`Origin not allowed` on WebSocket connect** → the page's `Origin` header is not in `CENTRIFUGO_ALLOWED_ORIGINS`. Add it (full scheme + host, no path), redeploy Centrifugo.
- **`unauthorized` on connect** → the HMAC secret in the admin panel does not match `CENTRIFUGO_TOKEN_HMAC_SECRET`. Re-enter both, save, redeploy.
- **`HTTP 401` on `Test connection`** → the API key does not match. Same fix as above for `CENTRIFUGO_API_KEY`.
- **WebSocket immediately closes** → Coolify domain not configured for WebSocket. Re-check the domain settings.
- **Backend log: `Centrifugo configuration incomplete`** → one of `ws_url`, `api_url`, `api_key`, `token_hmac_secret` is empty in the admin form. Fill all four.
- **Widget falls back to polling silently** → check `GET /api/realtime/admin/resolved` (admin-only). `effective_vendor` will tell you why (e.g. `polling_builtin` because health failed).

---

## 7. Rotating secrets

1. Generate new values (`openssl rand -hex 32`).
2. Update the env vars on the Centrifugo Coolify service → redeploy.
3. Update the same values in **Super Admin → Providers → Realtime** → Save.
4. Click **Refresh cache** (admin endpoint `/api/realtime/admin/refresh`) so the backend picks up the new config immediately.
5. Existing widget tokens (issued before rotation) keep working until their TTL expires (5 min default). New connections use the new secret.

No downtime is required.
