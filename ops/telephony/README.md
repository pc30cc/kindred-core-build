# ops/telephony

Deployment assets for the WEBYAR Telephony control service (Asterisk/PJSIP
registration adapter + ARI-driven call control).

- `docker-compose.telephony.yml` — service definition, ports, health check.
- Full setup, environment variables, firewall rules and troubleshooting:
  `docs/DAFTARESHOMA_PLUGIN.md`.
- Architecture, security model and data model:
  `docs/TELEPHONY_ARCHITECTURE.md`.

## Before deploying

1. Migration 200 applied (hosted: done; self-host:
   `database/migrations/200_telephony_foundation.sql`).
2. A least-privilege database login in role `webyar_asterisk`, scoped to the
   `asterisk` schema only.
3. `livekit` and `livekit-sip` running on the same internal network —
   LiveKit SIP is required, there is no fallback media path.
4. `TELEPHONY_INTERNAL_SECRET` and `TELEPHONY_INTERNAL_BASE_URL` set on Core.

## Safety rules

- ARI (8088) and the control API (8089) are internal only — never publish them.
- Never log SIP passwords, decrypted credentials, auth headers or REGISTER
  authorization values.
- Never hardcode a production domain; every host is an environment variable.
