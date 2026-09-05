# Deploying Centrifugo on Coolify

This guide covers deploying the **Centrifugo realtime provider** for this project on Coolify, in a way that matches the existing Phase 3 realtime implementation (`server/services/realtime/centrifugo.ts`).

> Centrifugo runs as a **standalone Coolify service**, separate from the backend and frontend. The backend talks to it over the **public domain** (HTTPS), because the three services do not share a Docker network in this deployment model.

> **Deployment Mode 1 (`single_memory`).** This is the default and stays fully supported. For multi-node deployments with a shared Redis engine — Mode 2 (`app_routed_redis`) and Mode 3 (`load_balanced_redis`) — see [`DEPLOY_REALTIME_MULTI_NODE_COOLIFY.md`](./DEPLOY_REALTIME_MULTI_NODE_COOLIFY.md). Upgrading from Mode 1 needs no migration: a configuration without a deployment mode is treated as `single_memory`.


---

## 1. Files in this repository

| Path | Purpose |
|---|---|
| `docker-compose.centrifugo.yml` | Coolify-compatible, **fully env-driven** compose file for the Centrifugo container |
| `deploy/centrifugo/config.json` | Reference-only config (NOT mounted in production — kept in repo as documentation of the intended namespace/channel model) |
| `DEPLOY_CENTRIFUGO_COOLIFY.md` | This guide |

> ⚠️ **No bind mount in production.** Earlier versions mounted `./deploy/centrifugo/config.json` into the container. In Coolify's Docker Compose build pack the working directory at runtime is not guaranteed, so the mount silently failed (`config file not found` in the container logs) and Centrifugo started with an empty config. The current compose file is **100% env-driven** — every setting (auth, namespaces, transport, engine) is supplied via `CENTRIFUGO_*` environment variables. The JSON file in `deploy/centrifugo/` is kept only as human-readable reference for what those env vars produce.

---

## 2. Coolify setup

### 2.1 Create the service
1. In Coolify → your project → **+ New Resource** → **Docker Compose**.
2. Connect this repository as the source.
3. Configure these fields **exactly** (Coolify is strict):

   | Field | Value |
   |---|---|
   | **Build Pack** | `Docker Compose` |
   | **Docker Compose Location** | `docker-compose.centrifugo.yml`  *(no leading slash, no `./`)* |
   | **Custom Build Command** | *(leave empty)* |
   | **Custom Start Command** | *(leave empty)* |
   | **Base Directory** | `/` |

> Use **Docker Compose** (not "Service" templates). Coolify manages the lifecycle itself; do **not** add custom build/start commands or it will conflict with compose.

> ℹ️ **No Docker healthcheck.** The official `centrifugo/centrifugo:v5.4.5` image is built `FROM scratch` and ships **no shell, no `wget`, no `curl`**, and — verified at runtime — has **no `centrifugo healthcheck` subcommand** (`unknown command "healthcheck"`). Any healthcheck we could write would always fail and Coolify would mark the service `unhealthy` even when it is serving traffic correctly. The current compose file therefore declares **no `healthcheck:` block**. Coolify's proxy-level probe on the public domain is sufficient — verify health using §5 below.

### 2.2 Add a public domain
1. Open the new resource → **Domains**.
2. Add a domain, e.g. `rt.destekly.tr`.
3. Set the **target port** to `8000` (this is the container's internal port — Coolify reaches it over the internal Docker network, the port is **not** published to the host).
4. Enable **HTTPS** (Coolify will issue a Let's Encrypt cert).
5. Enable **WebSocket support** (on by default in Coolify's proxy, but double-check).

> ⚠️ The compose file uses `expose: ["8000"]` instead of `ports: ["8000:8000"]` on purpose. Publishing the port to the host would fail with `Bind for 0.0.0.0:8000 failed: port is already allocated` on hosts where port 8000 is already in use. Coolify does not need a published port — it routes traffic through its internal proxy.

After this, the following endpoints must be reachable over HTTPS (these are the **only** public endpoints this deployment relies on):
- `https://rt.destekly.tr/api` (POST with `X-API-Key` header) → JSON response (server-to-server admin API)
- `wss://rt.destekly.tr/connection/websocket` → WebSocket handshake (browser client transport)

> ℹ️ **About `/health`**: a public `/health` endpoint is **not** part of this deployment's contract. Coolify has no Docker healthcheck wired in (see §2.1), and we deliberately do not advertise `/health` publicly. If `curl https://rt.destekly.tr/health` returns `404` or `503`, that is **not an error** — verify health via the steps in §5 instead.

### 2.3 Set environment variables (on the Centrifugo service)

| Variable | Required | Example | Notes |
|---|---|---|---|
| `CENTRIFUGO_TOKEN_HMAC_SECRET_KEY` | ✅ | `64-char random hex` | HS256 secret. Generate with `openssl rand -hex 32`. **This is Centrifugo's own runtime variable name** — do NOT use the older `CENTRIFUGO_TOKEN_HMAC_SECRET` (Centrifugo logs `unknown key found in the environment` and ignores it). **Must match** the value entered in Super Admin → Providers → Realtime → "HMAC Token Secret". |
| `CENTRIFUGO_API_KEY` | ✅ | `64-char random hex` | Server-to-server admin API key. **Must match** Super Admin → Providers → Realtime → "API Key". |
| `CENTRIFUGO_ALLOWED_ORIGINS` | optional | `*` | **Multi-tenant note**: in this SaaS, real origin authorization is enforced by the backend (`/api/realtime/connect` + `/subscribe`) against each workspace's dynamic allow-list (`workspace_domains` + `widget_settings.allowed_domains`). Centrifugo is the transport layer only. **Default to `*`** so any customer domain can connect without a redeploy — the backend is the gatekeeper. Only set a static comma-separated list if you want an extra belt-and-suspenders cap at the transport layer (rarely needed). |
| `CENTRIFUGO_ADMIN` | optional | `true` | Enables the admin UI. Off by default. |
| `CENTRIFUGO_ADMIN_PASSWORD` | optional | — | Required if `CENTRIFUGO_ADMIN=true`. |
| `CENTRIFUGO_ADMIN_SECRET` | optional | — | Required if `CENTRIFUGO_ADMIN=true`. |

Click **Deploy**. The container should reach `Running` state within a few seconds. Because there is no Docker healthcheck, Coolify will simply show `Running` (not `Running (healthy)`) — that is correct.

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
| **HMAC Token Secret** (`token_hmac_secret`) | the same value as `CENTRIFUGO_TOKEN_HMAC_SECRET_KEY` |
| **Allowed origins** | leave empty (or `*`) — backend enforces per-workspace allow-list dynamically |
| **Connect timeout (ms)** | `10000` |
| **Subscribe timeout (ms)** | `10000` |
| **Presence enabled** | ✅ |
| **Typing enabled** | ✅ |
| **Token TTL (seconds)** | `300` |

Click **Save**, then click **Test connection**. You should see `status: healthy`.

---

## 5. Verification checklist

Run these in order. All must pass before considering the deploy done.

> ⚠️ **Do not test `https://rt.destekly.tr/health`.** It is intentionally not exposed publicly (see §2.2). A `404`/`503` there does not mean Centrifugo is down — use the tests below instead.

### 5.1 Container is running (Coolify)
In the Coolify UI for this service, the status badge must read **`Running`** (without `(healthy)` — there is no Docker healthcheck on purpose; see §2.1). Open the container logs and confirm Centrifugo printed its startup banner with `serving websocket` and `serving HTTP`. If the container is restarting, the most common causes are:

- Missing `CENTRIFUGO_TOKEN_HMAC_SECRET_KEY` or `CENTRIFUGO_API_KEY` → Centrifugo refuses to start.
- Using the **old** name `CENTRIFUGO_TOKEN_HMAC_SECRET` instead of `CENTRIFUGO_TOKEN_HMAC_SECRET_KEY` → log line `unknown key found in the environment`. Rename in Coolify env, redeploy.
- `CENTRIFUGO_ALLOWED_ORIGINS` should normally be `*` (or unset) — the backend handles per-workspace origin enforcement dynamically. Setting a static list here means new customer domains will be rejected at the transport layer until you redeploy Centrifugo.

### 5.2 Server-to-server API is reachable (backend → Centrifugo)
This is the call the Express backend makes for `Test connection` and for optional broadcasts.
```bash
curl -i -X POST https://rt.destekly.tr/api \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $CENTRIFUGO_API_KEY" \
  -d '{"method":"info","params":{}}'
```
Expected:
- HTTP `200 OK`
- JSON body containing `"result": { "nodes": [ ... ] }`

Failure modes:
- `401 Unauthorized` → `X-API-Key` does not match `CENTRIFUGO_API_KEY` env on the container. Re-enter both, redeploy.
- `405 Method Not Allowed` on a `GET` → expected; the API only accepts `POST`. Re-run with `-X POST`.
- `404` → Coolify domain is pointing at the wrong target port. It must be `8000`.
- `502`/`no available server` → container is crash-looping. Check logs (§5.1).

### 5.3 WebSocket transport is reachable (browser → Centrifugo)
A plain HTTP `GET` to the WS endpoint must respond with `400 Bad Request` and the body `Bad Request` — that's Centrifugo refusing the connection because the request is missing the WebSocket upgrade headers, which proves the endpoint is wired up correctly:
```bash
curl -i https://rt.destekly.tr/connection/websocket
# HTTP/1.1 400 Bad Request
# ...
# Bad Request
```
For a real WebSocket handshake test (requires `websocat` or similar):
```bash
websocat -v wss://rt.destekly.tr/connection/websocket
# expected: WebSocket handshake (101 Switching Protocols) succeeds, then closes after a few seconds because no auth token was sent — that's fine; we only care that the upgrade succeeds.
```

### 5.4 Backend resolver / admin "Test connection"
In Super Admin → Providers → Realtime, click **Test connection**. The backend's `CentrifugoDriver.health()` performs the same `info` call as §5.2 using the API key stored in the database. Expected: `status: healthy`.

If §5.2 passes but §5.4 fails, the API key in the admin form does not match the env var on the container — re-enter it in the admin UI and click **Save**, then click **Refresh cache** (or hit `POST /api/realtime/admin/refresh`).

### 5.5 Widget end-to-end
1. Open a page that embeds the widget on one of the `allowed_origins`.
2. In DevTools → Network, look for `POST /api/realtime/connect`. Response should contain:
   ```json
   { "vendor": "centrifugo", "ws_url": "wss://rt.destekly.tr/connection/websocket", "token": "...", ... }
   ```
3. Then a WebSocket connection to `wss://rt.destekly.tr/connection/websocket` should open with status `101 Switching Protocols` and stay open.
4. Send a message from the widget; in the operator inbox it should appear without polling delay.

### 5.6 Audit log
Super Admin → Providers → Realtime → **Audit** should show your `configure` and `test` actions with `result: success`.

---

## 6. Common pitfalls

- **Container logs `unknown key found in the environment` → `CENTRIFUGO_TOKEN_HMAC_SECRET`** → you set the variable under the old name. Centrifugo's runtime expects `CENTRIFUGO_TOKEN_HMAC_SECRET_KEY` (note the trailing `_KEY`). Rename in Coolify env, redeploy.
- **Container logs `using config file` → `config file not found`** → an older compose file mounted `./deploy/centrifugo/config.json`. The current compose is env-driven and does NOT mount any config. Pull the latest `docker-compose.centrifugo.yml` and redeploy.
- **`exec format error` / `unknown command "healthcheck"`** → you (or an older compose) added a `healthcheck:` block calling `centrifugo healthcheck`. That subcommand does not exist in v5.4.5. The current compose has no healthcheck on purpose — remove any local override.
- **Coolify shows `Running (unhealthy)`** → only happens if a healthcheck is defined and failing. With the current compose there is no healthcheck and the badge will simply read `Running`. If you see `unhealthy`, you have a stale compose — redeploy with the latest file.
- **`Origin not allowed for this workspace` (HTTP 403 from `/api/realtime/connect`)** → the customer domain is not in that workspace's `workspace_domains` (verified) or `widget_settings.allowed_domains`. Add the domain in the workspace settings (no Centrifugo redeploy needed). If you instead see `Origin not allowed` from Centrifugo (rare), `CENTRIFUGO_ALLOWED_ORIGINS` was set to a static list — change it to `*` and redeploy.
- **`unauthorized` on connect** → the HMAC secret in the admin panel does not match `CENTRIFUGO_TOKEN_HMAC_SECRET_KEY`. Re-enter both, save, redeploy.
- **`HTTP 401` on `Test connection`** → the API key does not match. Same fix as above for `CENTRIFUGO_API_KEY`.
- **WebSocket immediately closes** → Coolify domain not configured for WebSocket. Re-check the domain settings.
- **Backend log: `Centrifugo configuration incomplete`** → one of `ws_url`, `api_url`, `api_key`, `token_hmac_secret` is empty in the admin form. Fill all four.
- **Widget falls back to polling silently** → check `GET /api/realtime/admin/resolved` (admin-only). `effective_vendor` will tell you why (e.g. `polling_builtin` because health failed).
- **Coolify deploy fails with `port is already allocated`** → you (or a previous attempt) added a `ports:` mapping. The current compose uses `expose:` only — do not add `ports:`.
- **`curl https://rt.destekly.tr/health` returns `404`/`503`** → expected, not a bug. The public domain only routes the two endpoints we actually need (`/api` and `/connection/websocket`). Verify health using §5.1, §5.2, and §5.4 instead.

---

## 7. Rotating secrets

1. Generate new values (`openssl rand -hex 32`).
2. Update the env vars on the Centrifugo Coolify service (`CENTRIFUGO_TOKEN_HMAC_SECRET_KEY`, `CENTRIFUGO_API_KEY`) → redeploy.
3. Update the same values in **Super Admin → Providers → Realtime** → Save.
4. Click **Refresh cache** (admin endpoint `/api/realtime/admin/refresh`) so the backend picks up the new config immediately.
5. Existing widget tokens (issued before rotation) keep working until their TTL expires (5 min default). New connections use the new secret.

No downtime is required.
