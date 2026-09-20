# ops/telephony

Runtime for the **WEBYAR Telephony Control Service**: a real Asterisk
(PJSIP + ARI + PostgreSQL realtime) installation that holds the provider SIP
registrations, plus a small Node service that Core calls at
`TELEPHONY_INTERNAL_BASE_URL`.

SIP registration is never simulated in Node — PJSIP performs the real REGISTER.

## Contents

```
ops/telephony/
  Dockerfile                    Asterisk + control service image
  entrypoint.sh                 renders configs from env, starts Asterisk, then the service
  docker-compose.telephony.yml  webyar-telephony, livekit-sip, one-shot bootstrap
  telephony.env.example         every environment variable
  package.json tsconfig.json
  src/
    index.ts        entrypoint: config → realtime store → ARI → LiveKit bootstrap → HTTP
    config.ts       environment parsing (no defaults for secrets)
    auth.ts         TELEPHONY_INTERNAL_SECRET, constant-time, both transports
    app.ts          PUT/DELETE /registrations/:id, POST /registrations/:id/test,
                    POST /calls/control, GET /health
    database.ts     PJSIP Realtime store (asterisk.ps_* upserts, tenant lookup)
    registrations.ts strict validation, idempotent provisioning, per-endpoint reload
    asteriskAri.ts  ARI + `asterisk -rx` runtime control and registration state
    incomingCalls.ts Stasis orchestration: tenant resolution → Core → LiveKit bridge
    livekitSip.ts   token signing + idempotent trunk/dispatch bootstrap
    coreClient.ts   authenticated calls back into Core
    health.ts       ARI / SIP stack / realtime DB / LiveKit SIP readiness
    bootstrapCli.ts standalone idempotent LiveKit SIP bootstrap
  asterisk/
    asterisk.conf http.conf logger.conf ari.conf modules.conf
    pjsip.conf extconfig.conf sorcery.conf res_pgsql.conf rtp.conf extensions.conf
  livekit-sip/config.yaml       reference LiveKit SIP configuration
```

All `asterisk/*.conf` are templates: `entrypoint.sh` renders them with
`envsubst` at start, so no credential and no production host is baked into the
image.

## Responsibility split

| Layer | Owns |
| --- | --- |
| PJSIP | transports, endpoints, auth, AORs, outbound registrations |
| PJSIP Realtime (`asterisk` schema) | dynamic multi-tenant provisioning |
| ARI | runtime channel/bridge events and control **only** |
| LiveKit SIP | the single media bridge into the operator's LiveKit room |

## Before deploying

1. Telephony migration applied. The committed file is
   `database/migrations/200_telephony_foundation.sql` — number 199 was already
   taken by `199_commerce_sync_sweep.sql`, so the telephony migration landed as
   200 and is **not** renamed. Documentation matches the committed file.
2. A least-privilege database login in role `webyar_asterisk`, scoped to the
   `asterisk` schema only. Never give Asterisk the application role.
3. `livekit` and `livekit-sip` running on the same internal network — LiveKit
   SIP is required, there is no fallback media path. If it is unreachable the
   service reports `livekit_sip_ready: false` and stays unhealthy rather than
   switching to another media architecture.
4. `TELEPHONY_INTERNAL_SECRET` and `TELEPHONY_INTERNAL_BASE_URL` set on Core.

## Deploy

```bash
cp telephony.env.example .env      # fill in real values, never commit
docker compose -f docker-compose.telephony.yml config    # validate
docker compose -f docker-compose.telephony.yml build
docker compose -f docker-compose.telephony.yml up -d webyar-telephony livekit-sip
# one-shot, safe to repeat: creates the long-lived trunk + callee dispatch rule
docker compose -f docker-compose.telephony.yml run --rm webyar-telephony-bootstrap
```

Health (internal network only):

```bash
curl -H "x-telephony-internal-secret: $TELEPHONY_INTERNAL_SECRET" \
  http://webyar-telephony:8089/internal/telephony/health
```

## Ports / firewall

| Port | Proto | Exposure |
| --- | --- | --- |
| 5060 | UDP/TCP | public SIP signalling — restrict to the provider where possible |
| 5061 | TCP | SIP TLS (optional) |
| 16384–16584 | UDP | RTP media (must match `TELEPHONY_RTP_PORT_MIN/MAX`) |
| 5080 | UDP/TCP | Asterisk → LiveKit SIP, internal only |
| 20000–20100 | UDP | LiveKit SIP RTP, internal unless split across hosts |
| 8088 | TCP | ARI — **internal only, never publish** |
| 8089 | TCP | control API — **internal only, never publish** |

## Safety rules

- ARI (8088) and the control API (8089) are internal only.
- Never log SIP passwords, decrypted credentials, auth headers or REGISTER
  authorization values; caller numbers are masked in logs.
- Never hardcode a production domain; every host is an environment variable.
- Do not run PJSIP debug logging in production.
