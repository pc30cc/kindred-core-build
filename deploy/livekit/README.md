# Deploying LiveKit on Coolify

This guide covers deploying the **self-hosted LiveKit voice/video provider** for this project on Coolify.

LiveKit runs as a **standalone Coolify service**, separate from the backend and frontend, and is consumed by the existing provider-based call architecture (`server/services/calls/providers/livekitProvider.ts`).

> **Why env-driven config?** LiveKit accepts its full server configuration as a single YAML blob via the `LIVEKIT_CONFIG` environment variable. We use that exclusively — there is **no bind-mounted `livekit.yaml`**. The compose file is the single source of truth, which avoids a class of Coolify build-pack issues (file-vs-directory mount races, repo-relative path resolution, stale staged files).

---

## 1. Files in this repository

| Path | Purpose |
|---|---|
| `docker-compose.livekit.yml` | Coolify-deployable compose file. Embeds the full LiveKit config in `LIVEKIT_CONFIG`. |
| `.env.livekit.example` | Reference env vars for the Coolify LiveKit service. |
| `deploy/livekit/README.md` | This guide. |

> The previous `deploy/livekit/livekit.yaml` file has been **removed**. All config now lives inside `LIVEKIT_CONFIG` in the compose file.

The backend integration is unchanged and already wired in:

| Path | Purpose |
|---|---|
| `server/services/calls/providers/livekitProvider.ts` | LiveKit `CallProvider` implementation |
| `server/services/calls/livekitTwirp.ts` | Twirp REST + JWT signing |
| `server/services/calls/livekitConfig.ts` | DB-backed config + `toPublicView()` |
| `server/services/calls/providerResolver.ts` | Picks LiveKit per workspace |
| `server/services/calls/rtcResolver.ts` | Resolves `rtc_url` / `ws_url` |
| `server/routes/calls.ts` | `/api/calls/*` endpoints |
| `server/routes/livekitWebhook.ts` | Verifies LiveKit's signed webhooks |
| `src/hooks/useLiveKitCall.ts` | Frontend hook around `livekit-client` |

You do **not** need to deploy any additional backend code for LiveKit.

---

## 2. Coolify setup

### 2.1 Create the service
1. In Coolify → your project → **+ New Resource** → **Docker Compose**.
2. Connect this repository as the source.
3. Configure these fields **exactly**:

   | Field | Value |
   |---|---|
   | **Build Pack** | `Docker Compose` |
   | **Docker Compose Location** | `docker-compose.livekit.yml`  *(no leading slash, no `./`)* |
   | **Custom Build Command** | *(empty)* |
   | **Custom Start Command** | *(empty)* |
   | **Base Directory** | `/` |

### 2.2 Add a public domain (signaling)
1. Open the new resource → **Domains**.
2. Add a domain, e.g. `livekit.your-domain.tld`.
3. Set the **target port** to `7880`.
4. Enable **HTTPS** (Coolify issues a Let's Encrypt cert).
5. Confirm **WebSocket support** is on (default).

After this, signaling must be reachable at `wss://livekit.your-domain.tld/`.

### 2.3 Open media ports on the host firewall

> ⚠️ **Don't skip this.** Coolify's reverse proxy only handles HTTP/HTTPS. WebRTC media goes directly to the host.

| Port | Protocol | Purpose | Required? |
|---|---|---|---|
| `443` | TCP | Signaling (Coolify proxy → 7880) | ✅ always |
| `7881` | TCP | ICE/TCP fallback | ✅ always |
| `50000-50100` | UDP | WebRTC media (RTC port range) | ✅ always |

The compose file publishes these ports from the container — you only need to make sure your **cloud firewall** lets them through.

### 2.4 Set environment variables

| Variable | Required | Example | Notes |
|---|---|---|---|
| `LIVEKIT_API_KEY` | ✅ | `APIabc123` | LiveKit API key (identifier). Generate with `openssl rand -hex 16`. **Must match** the API Key in Super Admin → Providers → Calls → LiveKit. |
| `LIVEKIT_API_SECRET` | ✅ | `secretvalue...` | LiveKit API secret (signing secret). Generate with `openssl rand -hex 32`. **Must match** the API Secret in Super Admin → Providers → Calls → LiveKit. |
| `LIVEKIT_NODE_IP` | ✅ | `203.0.113.10` | Public IP of the host. Find with `curl -s https://api.ipify.org`. **Without this, calls connect but no audio/video flows.** |
| `LIVEKIT_LOG_LEVEL` | ❌ | `info` | `debug` / `info` / `warn` / `error` |
| `LIVEKIT_WEBHOOK_API_KEY` | ❌ | `APIabc123` | Same value as `LIVEKIT_API_KEY`. Only if you enable webhooks (§2.5). |
| `LIVEKIT_REDIS_ADDRESS` | ❌ | `redis:6379` | Multi-node only. |
| `LIVEKIT_TURN_DOMAIN` | ❌ | `turn.your-domain.tld` | Reserved for a future TURN/TLS rollout. |

See `.env.livekit.example` for the canonical list.

### 2.5 Webhooks (optional)

Webhooks are not enabled in the current `LIVEKIT_CONFIG` to keep the first deploy lean. To enable them later, add a `webhook:` block to the YAML inside `LIVEKIT_CONFIG` in the compose file and set `LIVEKIT_WEBHOOK_API_KEY`. The backend already accepts `/api/webhooks/livekit`.

---

## 3. Configure the main app to use this LiveKit

After the LiveKit service is up:

1. Open the main app → **Super Admin → Providers → Calls → LiveKit**.
2. Enter:
   - **API Key** — the value of `LIVEKIT_API_KEY`
   - **API Secret** — the value of `LIVEKIT_API_SECRET`
   - **RTC URL** — `wss://livekit.your-domain.tld`
   - **WS URL** — same as RTC URL
3. Toggle **Enabled** on and **Save**.
4. In **Super Admin → Providers → Calls** set the active provider to `livekit`.

The backend caches this for 30s (`livekitConfig.ts → CACHE_TTL_MS`).

---

## 4. Verify the deployment

### 4.1 Signaling reachability
```bash
curl -i https://livekit.your-domain.tld/
# Expect: HTTP/2 200 with body "OK"
```

### 4.2 Container logs
In Coolify → LiveKit service → **Logs**, look for:
```
starting LiveKit server   {"version": "1.7.x"}
listening on              {"port": 7880}
```
If you see `node_ip is not set` or `failed to determine external IP`, your `LIVEKIT_NODE_IP` is missing — calls will signal but media will never flow.

### 4.3 End-to-end smoke test
Open two operator UI tabs, start a call between them, and confirm bidirectional audio. Signaling is visible in DevTools → Network → WS. Media frames go peer↔server over UDP 50000–50100 and are NOT visible in WS frames.

If signaling works but no media:
- `LIVEKIT_NODE_IP` not set or wrong
- UDP `50000-50100` blocked on the cloud firewall
- Both clients on networks blocking UDP **and** TCP 7881 → enable TURN/TLS later

---

## 5. Operational notes

- **No persistent volume needed** for single-node setups.
- **Egress / recording** is a separate LiveKit service. Add later when needed.
- **Scaling**: set `LIVEKIT_REDIS_ADDRESS`, add a Redis service, replicate this compose service.
- **TURN/TLS**: deferred. Add a `turn:` block inside `LIVEKIT_CONFIG` and open UDP 3478 / TCP 5349 when you need it.
- **Restart semantics**: a LiveKit restart drops in-flight rooms. The backend treats `CallProviderNotReadyError` as "fall through", so a brief outage during deploy surfaces as an error to clients but does not poison subsequent calls.

---

## 6. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `wss://...` returns 502 | Container down, or Coolify domain points to wrong port | Confirm `expose: ["7880"]` and Coolify domain target = 7880 |
| Signaling connects, no audio/video | `LIVEKIT_NODE_IP` missing or UDP `50000-50100` blocked | Set the env var; open the range on the cloud firewall |
| `unauthorized` on token mint | `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` don't match Super Admin → Providers → Calls → LiveKit | Re-enter both sides so they match exactly |
| Container restart loop with `cannot unmarshal !!str ... into map[string]string` | Old `LIVEKIT_KEYS` env var still set, or `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` empty | Remove `LIVEKIT_KEYS`; set `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` |
| Calls work locally but break for some users | Their network blocks UDP and TCP 7881 fallback | Plan a TURN/TLS rollout |
