# Call Center — LiveKit Deployment & Connectivity Guide

This guide covers the LiveKit-based media path used by the standalone
Call Center widget. It does NOT cover the legacy in-conversation chat
call (which uses the same LiveKit server but a different code path).

## 1. Server image / version compatibility

The standalone Call Center widget loads a self-hosted LiveKit JS SDK from:

```
/call-widget/vendor/livekit-client.umd.min.js
```

Modern LiveKit clients call `/rtc/v1/validate` on connect. The server
(and any reverse proxy in front of it) **MUST** answer that path. Older
LiveKit server tags (e.g. `v1.7.x`) only serve `/rtc/...` and return
**404** on `/rtc/v1/*` — the browser then reports:

> Initial connection failed: v1 RTC path not found. Consider upgrading
> your LiveKit server version

Pin the image tag via `LIVEKIT_IMAGE_TAG` in the LiveKit Coolify service:

```
LIVEKIT_IMAGE_TAG=v1.8.4
```

`docker-compose.livekit.yml` defaults to a tag that supports `/rtc/v1`.
If you must pin an older server, you must also pin a compatible client
SDK. Upgrading the server is preferred.

## 2. Network ports

Open on the LiveKit host firewall:

| Port            | Proto | Purpose                                |
|-----------------|-------|----------------------------------------|
| 7880            | TCP   | Signaling (HTTP / WebSocket Upgrade)   |
| 7881            | TCP   | ICE/TCP fallback for restrictive nets  |
| 50000-50100     | UDP   | WebRTC media — direct to host          |

UDP **does not** traverse Coolify's HTTP proxy. The UDP range MUST be
allowed all the way through the cloud provider firewall to the host.

## 3. Reverse proxy / Cloudflare

- The LiveKit subdomain (e.g. `livekit.example.com`) should be
  **DNS-only / grey cloud** in Cloudflare. Orange-cloud may pass the
  WebSocket upgrade but UDP media is never proxied.
- Coolify / Traefik must:
  - proxy WebSocket Upgrade headers
  - **not** rewrite `/rtc` or `/rtc/v1`
  - pass `/rtc/v1/validate` through unchanged

## 4. Public URL stored in admin

In Super Admin → Providers → Calls → LiveKit, set the public URL to the
**origin only**:

```
wss://livekit.example.com
```

Do NOT include a path. The bundled SDK appends `/rtc` and `/rtc/v1`
itself; including them in the configured URL produces broken paths like
`wss://livekit.example.com/rtc/rtc`.

## 5. Verifying connectivity

From any machine on the public internet:

```
curl -i https://livekit.example.com/rtc/v1/validate
```

Expected: anything **except** 404. A 400/401 (no token / invalid
token) is the normal response and confirms the path is routed.

If you get **404**, either the server tag is too old (upgrade) or the
reverse proxy strips `/rtc/v1` (fix proxy rules).

## 6. Built-in diagnostics

The Call Center exposes a safe, secrets-free diagnostics endpoint:

```
GET /api/call-center/diagnostics/livekit?workspaceId=...
```

Restricted to workspace `owner / admin / team_lead`. Returns the
normalized client URL, presence flags for each credential, and the HTTP
probe status for `/rtc/validate` and `/rtc/v1/validate`. Surfaced in
the Super Admin Call Center page under "LiveKit Connectivity".

Common warnings:

- `livekit_url_missing` — no `ws_url`/`rtc_url` configured
- `livekit_v1_rtc_path_not_supported` — server returns 404 on `/rtc/v1/validate`
- `livekit_server_unreachable` — neither path responded
- `recording_storage_credentials_missing` — egress storage incomplete

## 7. TURN

The bundled config does not provision TURN. If your visitors include
networks that block UDP entirely, configure a TURN server in the
admin RTC endpoints settings. Without TURN, those visitors will fail
to negotiate media even when signaling succeeds.
