# Deploying LiveKit on Coolify

This guide covers deploying the **LiveKit voice/video provider** for this project on Coolify, in a way that matches the existing provider-based call architecture (`server/services/calls/providers/livekitProvider.ts`).

> LiveKit runs as a **standalone Coolify service**, separate from the backend and frontend. The backend talks to it over its public domain (HTTPS for signaling, plus direct UDP/TCP for media) — exactly like the existing Centrifugo deployment.

---

## 1. Files in this repository

| Path | Purpose |
|---|---|
| `docker-compose.livekit.yml` | Coolify-compatible compose file for the LiveKit container |
| `deploy/livekit/livekit.yaml` | LiveKit server config (mounted read-only into the container) |
| `.env.livekit.example` | Reference env vars for the Coolify LiveKit service |
| `deploy/livekit/README.md` | This guide |

The backend integration already lives in the main app:

| Path | Purpose |
|---|---|
| `server/services/calls/providers/livekitProvider.ts` | LiveKit `CallProvider` implementation (rooms, tokens, recording) |
| `server/services/calls/livekitTwirp.ts` | Minimal Twirp REST + JWT signing (no extra SDK deps) |
| `server/services/calls/livekitConfig.ts` | DB-backed config store + `toPublicView()` for the admin UI |
| `server/services/calls/providerResolver.ts` | Picks LiveKit (or Agora/Janus/Jitsi) per workspace |
| `server/services/calls/rtcResolver.ts` | Resolves `rtc_url` / `ws_url` without hardcoded hosts |
| `server/routes/calls.ts` | `/api/calls/*` endpoints (create call, mint token) |
| `server/routes/livekitWebhook.ts` | Verifies LiveKit's signed webhook callbacks |
| `src/hooks/useLiveKitCall.ts` | Frontend hook around `livekit-client` |

You do **not** need to deploy any additional backend code for LiveKit — the provider plumbing is already wired in.

---

## 2. Coolify setup

### 2.1 Create the service
1. In Coolify → your project → **+ New Resource** → **Docker Compose**.
2. Connect this repository as the source.
3. Configure these fields **exactly** (Coolify is strict):

   | Field | Value |
   |---|---|
   | **Build Pack** | `Docker Compose` |
   | **Docker Compose Location** | `docker-compose.livekit.yml`  *(no leading slash, no `./`)* |
   | **Custom Build Command** | *(leave empty)* |
   | **Custom Start Command** | *(leave empty)* |
   | **Base Directory** | `/` |

### 2.2 Add a public domain (signaling)
1. Open the new resource → **Domains**.
2. Add a domain, e.g. `livekit.destekly.tr`.
3. Set the **target port** to `7880` (LiveKit's WebSocket signaling port).
4. Enable **HTTPS** (Coolify will issue a Let's Encrypt cert).
5. Enable **WebSocket support** (on by default in Coolify's proxy, but double-check).

After this, the signaling endpoint must be reachable:
- `wss://livekit.destekly.tr/` → WebSocket handshake (browser SDK transport)

### 2.3 Open media ports on the host firewall

> ⚠️ **This is the step people miss.** Coolify's reverse proxy only handles HTTP/HTTPS. WebRTC media uses UDP (and TCP fallback) directly to the host — it bypasses the proxy entirely.

On your cloud provider's firewall (and the host's `ufw`/`iptables` if any), allow:

| Port | Protocol | Purpose | Required? |
|---|---|---|---|
| `443` | TCP | Signaling (Coolify proxy → 7880) | ✅ always |
| `7882` | UDP | WebRTC media | ✅ always |
| `7881` | TCP | ICE/TCP fallback for restrictive networks | ✅ always |
| `3478` | UDP | TURN/UDP | only if TURN enabled |
| `5349` | TCP | TURN/TLS | only if TURN/TLS enabled |

The compose file already publishes 7882/udp and 7881/tcp from the container to the host — you only need to make sure your **cloud firewall** lets them through.

### 2.4 Set environment variables

| Variable | Required | Example | Notes |
|---|---|---|---|
| `LIVEKIT_KEYS` | ✅ | `APIabc123: <secret>` | Single-line `api_key: api_secret`. Generate with `openssl rand -hex 16` (key) and `openssl rand -hex 32` (secret). **Must match** the values entered in Super Admin → Providers → Calls → LiveKit. |
| `LIVEKIT_WEBHOOK_API_KEY` | ✅ | `APIabc123` | Same `api_key` as above. Used by LiveKit to sign webhook callbacks. |
| `LIVEKIT_NODE_IP` | ✅ | `203.0.113.10` | Public IP of the host. Find with `curl -s https://api.ipify.org`. **Without this, calls will appear to connect but no audio/video will flow.** |
| `LIVEKIT_REDIS_ADDRESS` | ❌ | `redis:6379` | Multi-node only. Leave empty for single-node. |
| `LIVEKIT_TURN_DOMAIN` | ❌ | `turn.destekly.tr` | Only if you enable TURN in `livekit.yaml`. |
| `LIVEKIT_LOG_LEVEL` | ❌ | `info` | `debug` / `info` / `warn` / `error`. |

See `.env.livekit.example` for the canonical list.

### 2.5 Configure webhooks (optional but recommended)

The backend already has `/api/webhooks/livekit` wired in (`server/routes/livekitWebhook.ts`). To receive room/participant/egress events:

1. Edit `deploy/livekit/livekit.yaml` and uncomment the `webhook.urls` entry, replacing the URL with your backend's public domain:
   ```yaml
   webhook:
     api_key: ${LIVEKIT_WEBHOOK_API_KEY}
     urls:
       - https://api.your-domain.tld/api/webhooks/livekit
   ```
2. Redeploy the LiveKit Coolify service.

The backend verifies signatures using the `api_secret` stored in `livekit_config` (the same one in `LIVEKIT_KEYS`).

---

## 3. Configure the main app to use this LiveKit

After the LiveKit service is up:

1. Open the main app → **Super Admin → Providers → Calls → LiveKit**.
2. Enter:
   - **API Key** — the `<api_key>` half of `LIVEKIT_KEYS`
   - **API Secret** — the `<api_secret>` half of `LIVEKIT_KEYS`
   - **RTC URL** — `wss://livekit.destekly.tr` (your public domain from §2.2)
   - **WS URL** — same as RTC URL (the LiveKit JS SDK uses this)
   - **Webhook Secret** — same as **API Secret** (LiveKit signs webhooks with the api_secret of the api_key it lists in the JWT header)
3. Toggle **Enabled** on and **Save**.
4. In **Super Admin → Providers → Calls** set the active provider to `livekit`.

The backend caches this config for 30s (`livekitConfig.ts` → `CACHE_TTL_MS`), so changes propagate within half a minute.

---

## 4. Verify the deployment

### 4.1 Signaling reachability
```bash
curl -i https://livekit.destekly.tr/
# Expect: HTTP/2 200 with body "OK"
```

### 4.2 Container logs
In Coolify → LiveKit service → **Logs**, look for:
```
starting LiveKit server   {"version": "1.7.x", "nodeID": "..."}
using config file         {"file": "/etc/livekit/livekit.yaml"}
listening on              {"port": 7880}
```
If you see `node_ip is not set` or `failed to determine external IP`, your `LIVEKIT_NODE_IP` is missing — calls will connect signaling but media will never flow.

### 4.3 End-to-end smoke test
Open two browser tabs in the operator UI, start a call between them, and confirm bidirectional audio. The signaling handshake going through `wss://livekit.destekly.tr/` is visible in DevTools → Network → WS. The media frames go peer↔server over UDP 7882 and are NOT visible in the WebSocket frames.

If signaling connects but no media flows, the cause is almost always one of:
- `LIVEKIT_NODE_IP` not set or wrong
- UDP 7882 blocked by the cloud firewall
- Both clients on networks that block UDP AND TCP 7881 → enable TURN/TLS

---

## 5. Operational notes

- **No persistent volume needed** for single-node setups. LiveKit holds room state in memory.
- **Egress / recording** is a separate LiveKit service (`livekit/egress`). When you add it later, point its S3 storage at the bucket configured in Super Admin → Providers → Calls → LiveKit → Recording Storage. The backend (`livekitConfig.ts`) already models this.
- **Scaling**: switch `LIVEKIT_REDIS_ADDRESS` on, add a Redis service to `docker-compose.livekit.yml`, and replicate the LiveKit service. All replicas must point at the same Redis.
- **Restart semantics**: a LiveKit restart drops all in-flight rooms. The backend treats `CallProviderNotReadyError` as "fall through to the next provider", so a brief outage during a deploy will surface as an error to clients but won't poison subsequent calls once the service is back.

---

## 6. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `wss://...` returns 502 from Coolify | LiveKit container not running or wrong target port | Check `expose: ["7880"]` and that Coolify domain points to 7880 |
| Signaling connects, no audio/video | `LIVEKIT_NODE_IP` missing/wrong, or UDP 7882 blocked | Set the env var, open the port on the cloud firewall |
| `unauthorized` from token mint | `LIVEKIT_KEYS` doesn't match the api_key/api_secret entered in Super Admin → Providers → Calls → LiveKit | Re-enter both sides so they match exactly |
| Webhooks never arrive at backend | `webhook.urls` not set in `livekit.yaml`, or backend domain not publicly reachable | Edit YAML, redeploy, verify `POST /api/webhooks/livekit` returns 200 to a manual `curl` |
| Calls work locally but break for some users | Their network blocks UDP and TCP 7881 fallback | Enable TURN/TLS (uncomment `turn:` block in `livekit.yaml`, open 5349/tcp) |