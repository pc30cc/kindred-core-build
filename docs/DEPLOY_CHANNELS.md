# Deploying the Channels runtime (Telegram)

`no available server` when opening the webhook URL is **not** an application
error — it is the reverse proxy (Traefik / Coolify) saying that the domain in
`PUBLIC_CHANNELS_BASE_URL` has no running container behind it. The Channels
Gateway is a **separate deployable**; connecting a bot in the UI does not
start it.

## The three processes

| Process | Image | Public? | Needs DB? |
|---|---|---|---|
| Core API (`backend`) | `Dockerfile.server` | yes (api domain) | yes |
| Channels Gateway | `Dockerfile.channels` | **yes** (channels domain) | no |
| Channels Worker | `Dockerfile.worker` (`WORKER_KIND=channels`) | no | yes |

Without the Gateway, Telegram cannot reach you at all.
Without the Worker, updates are accepted but never processed or delivered.

## Shared secrets

Generate once, reuse across services (each value must be distinct):

```bash
openssl rand -hex 32   # PLUGIN_SECRETS_MASTER_KEY
openssl rand -hex 32   # CHANNELS_WEBHOOK_SIGNING_KEY
openssl rand -hex 32   # CORE_INTERNAL_SECRET
```

| Env var | Core | Gateway | Worker |
|---|---|---|---|
| `PLUGIN_SECRETS_MASTER_KEY` | yes | **never** | yes |
| `CHANNELS_WEBHOOK_SIGNING_KEY` | yes | yes | no |
| `CORE_INTERNAL_SECRET` | yes | yes | yes |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | **never** | yes |
| `PUBLIC_CHANNELS_BASE_URL` | yes | no | no |
| `CORE_INTERNAL_BASE_URL` | no | yes | yes |

The Gateway **exits on boot** if `SUPABASE_SERVICE_ROLE_KEY` or
`PLUGIN_SECRETS_MASTER_KEY` are present — do not copy the full `.env` into it.

## Coolify

1. New service → Dockerfile `Dockerfile.channels`, port **3011**, domain e.g.
   `https://channels.example.com` (Coolify issues the certificate).
2. Env: `CHANNELS_WEBHOOK_SIGNING_KEY`, `CORE_INTERNAL_SECRET`,
   `CORE_INTERNAL_BASE_URL=http://<core-service>:3001`.
3. New service → Dockerfile `Dockerfile.worker`, no domain, env
   `WORKER_KIND=channels`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
   `CORE_INTERNAL_BASE_URL`, `CORE_INTERNAL_SECRET`,
   `PLUGIN_SECRETS_MASTER_KEY`.
4. On the Core service set `PUBLIC_CHANNELS_BASE_URL=https://channels.example.com`
   (no trailing slash, no path) and redeploy.
5. In the workspace UI: **disconnect and reconnect** the Telegram bot so
   `setWebhook` is re-registered against the now-reachable URL.

`CORE_INTERNAL_SECRET` is one shared value, not three independently generated
values. Copy the exact same value (with no quotes or trailing whitespace) into
Core, Gateway and Worker, then redeploy all three services. A Worker log such as
`process-inbound failed [401]` proves that the Worker's value differs from the
Core value. New Worker builds verify this boundary before claiming jobs, so a
bad secret pauses processing instead of exhausting job retries.

## Docker Compose (single host)

`docker-compose.yml` now contains `channels-gateway` and `channels-worker`.
Set the secrets in `.env`, put `PUBLIC_CHANNELS_BASE_URL` to the HTTPS origin
your proxy maps to port 3011, then `docker compose up -d --build`.

## Verify

```bash
curl -s https://channels.example.com/health   # {"ok":true,"service":"channels-gateway"}
curl -s https://channels.example.com/ready    # {"ready":true,"core":"reachable"}
```

- `no available server` / 502 → gateway container not running or wrong port.
- `{"ready":false,"reason":"core_unreachable"}` → fix `CORE_INTERNAL_BASE_URL`.
- `{"ready":false,"reason":"core_status_401"}` → `CORE_INTERNAL_SECRET` differs
  between Core and Gateway.
- Worker `paused before claiming jobs: CORE_INTERNAL_SECRET does not match Core`
  → copy Core's exact value to the Worker and redeploy it. Jobs already marked
  `failed` need to be requeued after authentication is repaired; merely
  restarting the Worker only resumes pending/retrying jobs.
- Opening the webhook path in a browser returns `404`/`401` — that is correct;
  it only accepts `POST` with Telegram's secret header.
