# DaftareShoma telephony plugin — setup and operations

Read `docs/TELEPHONY_ARCHITECTURE.md` first for the topology and security
model. This document covers installing, configuring, deploying and
troubleshooting.

## 1. Workspace setup (what the customer does)

1. Buy a phone number / SIP extension from DaftareShoma
   (<https://daftareshoma.com/help/docs/kb/portal-setting/SIPphone-setting/>).
2. In WEBYAR: **Plugins → DaftareShoma → Install**.
3. Enter the credentials from the DaftareShoma portal:

   | Field | Notes |
   | --- | --- |
   | SIP username | letters/digits/`._-+`, ≤ 64 chars |
   | Extension | digits (`*`/`#` allowed for short codes) |
   | SIP password | stored encrypted, never shown again |
   | SIP domain (UDP) | hostname, optional `:port`, no scheme/path |
   | SIP domain (TCP) | as above |
   | SIP domain (WebRTC) | as above |
   | Outgoing caller line | digits, optional leading `+` |
   | Transport | UDP / TCP / TLS |

4. **Save**, then **Test connection**. The test performs a real REGISTER
   through the telephony gateway — it is not field validation.
5. Status must show **Registered** plus all four readiness flags green before
   calls will ring.

Leaving the password field blank on a later save keeps the stored password;
it never erases it. The password is never returned to the browser.

## 2. Environment variables (Core)

| Variable | Purpose |
| --- | --- |
| `TELEPHONY_INTERNAL_SECRET` | shared secret between Core and the telephony control service. Must differ from `CORE_INTERNAL_SECRET`, `PLUGIN_SECRETS_MASTER_KEY`, `CHANNELS_WEBHOOK_SIGNING_KEY`, `AI_RUNTIME_INTERNAL_SECRET` and the service role key (validated at boot). |
| `TELEPHONY_INTERNAL_BASE_URL` | internal URL of the control service, e.g. `http://webyar-telephony:8089` |
| `PLUGIN_SECRETS_MASTER_KEY` | already required — encrypts the SIP password |

With either telephony variable unset, every gateway call fails closed with
`gateway_not_configured` and the plugin reports `gateway_healthy: false`.

## 3. Telephony service environment

| Variable | Purpose |
| --- | --- |
| `TELEPHONY_CORE_BASE_URL` | Core internal base URL (`/internal/telephony`) |
| `TELEPHONY_INTERNAL_SECRET` | same value as Core |
| `TELEPHONY_PUBLIC_SIP_HOST` | public hostname/IP advertised in SIP (never hardcode a production domain in the repo) |
| `TELEPHONY_RTP_PORT_MIN` / `_MAX` | RTP range, e.g. `16384` / `16584` |
| `ASTERISK_ARI_URL` / `_USER` / `_PASSWORD` | runtime call control |
| `ASTERISK_DB_URL` | least-privilege DSN for the `asterisk` schema (`webyar_asterisk`) |
| `LIVEKIT_SIP_URI` | internal SIP URI of `livekit-sip` |
| `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | existing LiveKit credentials |

## 4. Ports and firewall

| Port | Protocol | Exposure | Purpose |
| --- | --- | --- | --- |
| 5060 | UDP/TCP | public (restrict to DaftareShoma ranges where possible) | SIP signalling |
| 5061 | TCP | public, optional | SIP TLS |
| 16384–16584 | UDP | public | RTP media |
| 8088/8089 | TCP | **internal only** | Asterisk ARI + control service API |
| 5060 (livekit-sip) | UDP/TCP | internal only | Asterisk → LiveKit SIP |

Never expose ARI or the control service API publicly. NAT deployments must set
`TELEPHONY_PUBLIC_SIP_HOST` to the reachable address.

## 5. Deployment (Coolify / Docker Compose)

`ops/telephony/docker-compose.telephony.yml` defines `webyar-telephony`
(Asterisk + PJSIP + the control service) and expects an existing `livekit` and
`livekit-sip` service on the same internal network.

1. Apply migration 200 (already applied on hosted; self-host parity file is
   `database/migrations/200_telephony_foundation.sql`).
2. Create the Asterisk database login and grant it the `asterisk` schema only:

   ```sql
   CREATE ROLE webyar_asterisk_login LOGIN PASSWORD '…' IN ROLE webyar_asterisk;
   ```

3. Set the environment variables above in Coolify for both Core and the
   telephony service.
4. Deploy, then check `GET /internal/telephony/health` from inside the network
   and the four readiness flags in the plugin UI.

**LiveKit SIP is required.** If `livekit-sip` is not deployed, readiness
reports `livekit_sip_ready: false` and inbound calls are not bridged — there is
no fallback media path by design.

## 6. Test connection behaviour

`Test connection` → Core → authenticated control service → Asterisk attempts or
confirms the REGISTER → safe diagnostics come back: `configured`, gateway
health, registration state, extension, masked domain. Never a password.

Error codes surfaced to the UI: `invalid_credentials`, `dns_failure`,
`registration_timeout`, `provider_rejected`, `transport_unsupported`,
`gateway_unavailable`, `gateway_not_configured`, `livekit_sip_unavailable`,
`encryption_not_configured`.

## 7. Incoming call lifecycle

INVITE → Asterisk identifies the tenant → idempotent event to Core → one
`call_session` + `telephony_calls` row → Core returns `tel_<id>_<rand>` →
Asterisk dials LiveKit SIP with that room as the callee → the reusable dispatch
rule places the SIP participant in that room → the existing realtime ring
reaches every eligible operator → the first **Answer** wins atomically via
`telephony_claim_call` (others get `409 already_answered` and stop ringing) →
the winner joins the same room → two-way audio → either side hangs up → one
idempotent `ended` transition.

## 8. Troubleshooting

| Symptom | Check |
| --- | --- |
| `gateway_not_configured` | `TELEPHONY_INTERNAL_BASE_URL` / `TELEPHONY_INTERNAL_SECRET` on Core |
| Registered but no ring | Asterisk dialplan → LiveKit SIP; `livekit_sip_ready`; Redis behind livekit-sip |
| Ringing but no audio | RTP range not open, or `TELEPHONY_PUBLIC_SIP_HOST` wrong behind NAT |
| `invalid_credentials` | re-enter the password in the plugin; portal may have rotated it |
| `409 already_answered` | expected — another operator won the claim |

## 9. Secret rotation, disable, uninstall

- Rotate the SIP password in the DaftareShoma portal, then re-save it in the
  plugin; provisioning is idempotent and reloads only that endpoint.
- Rotate `TELEPHONY_INTERNAL_SECRET` on both Core and the control service
  together; calls fail closed in between, never open.
- **Disconnect** removes the registration and stops inbound calls, keeping
  settings. **Uninstall** additionally deprovisions the registration and
  deletes the encrypted password.

## 10. Known MVP limitations

Inbound only; no recording, transcription, IVR, voicemail, transfer, hold, DTMF
or telephony analytics; no DaftareShoma REST integration (call history /
reconciliation) — the adapter interface is reserved but unimplemented because
only documented endpoints will ever be called; ring-all only, no skill or
department routing for phone calls.
