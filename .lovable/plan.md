# DaftareShoma Telephony Plugin — MVP (incoming PSTN call into the existing Call Center)

## Goal
Install plugin → enter SIP credentials → Test Connection (real SIP REGISTER) → a real phone
call rings the existing Call Center → an operator answers in the browser → two-way audio →
hang up. Nothing else (no IVR, recording, outbound, AI) in this phase.

## Audit result (what already exists and will be reused)
- **Plugin platform**: `server/plugins/registry.ts` (frozen catalog, categories channels/crm/…),
  `plugin_platform_state`, `workspace_plugin_installations.settings`, `plugin_secrets` with
  AES-256-GCM in `server/lib/pluginCrypto.ts`. Install/uninstall/settings routes already exist in
  `server/routes/plugins.ts`. → reuse all of it; no new crypto, no new install flow.
- **Call model**: `call_sessions` already has `provider`, `direction`, `entry_source`,
  `metadata jsonb`, `visitor_*`, `department_id`, `assigned_agent_id`, plus a full state enum
  (`pending/ringing/connecting/active/ended/failed/cancelled/missed`). `call_queue_entries` already
  implements queued → offered → accepted with atomic claim and realtime fan-out
  (`server/services/calls/queue.ts`, `server/services/callCenter/realtime.ts`). → phone calls become
  ordinary call sessions + queue entries; **no new call tables, no new lifecycle**.
- **Media**: self-hosted LiveKit, token issuing in `server/services/calls/livekitConfig.ts`,
  provider registry in `server/services/calls/providerResolver.ts` (livekit/jitsi/janus/agora).
  DaftareShoma will **not** be added to that media-provider enum.
- **Internal service auth**: `server/lib/internalAuth.ts` pattern (constant-time secret, two header
  transports, fingerprints). A dedicated `TELEPHONY_INTERNAL_SECRET` follows the same pattern.
- **Phone normalization**: `server/services/phoneVerification/phone.ts` (`normalizePhoneToE164`,
  Persian/Arabic digits, IR/TR/…). → reused as-is for caller identity and contact matching.

## Architecture
```text
PSTN caller → DaftareShoma → (SIP REGISTER/INVITE)
   → WEBYAR Telephony Gateway  (new service: Asterisk + PJSIP realtime + small Node control API)
        ├── notifies Core over authenticated internal HTTP (shared secret, replay-protected)
        └── dials the call into LiveKit via livekit-sip (SIP trunk/participant)
   → Core creates a call_session (provider_type=telephony) + call_queue_entry
   → existing realtime ring → existing Call Center UI → operator answers → LiveKit room audio
```
Provider-neutral naming: `telephony` layer with a `daftareshoma` adapter under
`server/services/telephony/providers/daftareshoma/`. No provider name leaks into Call Center code.

## Work phases
**B — Plugin.** Add `daftareshoma` to the registry (new `telephony` category, `supportsMedia: true`,
`supportsInbox/AI/Webhook: false`, plan channel key `telephony`). Settings (non-secret) in the
installation record; SIP password only in `plugin_secrets` under `daftareshoma_sip_password`.
API never returns it — only `hasSipPassword: true`. Blank password on save keeps the existing secret.

**C — Telephony Gateway service.** New `telephony/` service (Dockerfile + compose + Coolify docs):
Asterisk with PJSIP **realtime/ARI config generated from Core**, never from the browser. Strict
validation/escaping of usernames, extensions and domains. Endpoints (internal-secret protected):
`POST /internal/telephony/registrations` (upsert tenant), `DELETE` (remove), `POST /test` (verify
real registration), `GET /health`. Registration stays alive with no browser open.

**D — Incoming call bridge.** Gateway → Core `POST /internal/telephony/events` (invite / ringing /
answered / ended, idempotent on provider dialog id). Core normalizes caller number, matches a
workspace contact (workspace-scoped only), creates the session + queue entry, publishes the existing
realtime ring event.

**E — Media.** Add self-hosted `livekit-sip` to the LiveKit deployment; the gateway bridges the SIP
leg into the same LiveKit room the operator joins with the existing token flow. If the deployment
cannot host livekit-sip, fallback documented: Asterisk ↔ WebRTC (WSS) leg into the same room.

**F — Lifecycle.** Answer (atomic single-winner via existing queue claim), reject, hangup from either
side, gateway disconnect/cleanup on uninstall.

**G — Tests (vitest, mock gateway — no live credentials).** Catalog/install/gates, secret never
returned & not erased by blank save, tenant isolation (A cannot read/answer B), registration
success/bad-credentials/timeout/reconnect, incoming event → session + normalization + contact match +
realtime + first-claim-wins + duplicate event idempotent + hangup ends session, internal endpoint
rejects missing/wrong secret, redaction in diagnostics.

**H — Docs & deploy.** `docs/TELEPHONY_ARCHITECTURE.md` + `docs/DAFTARESHOMA_PLUGIN.md`: diagram,
setup, SIP values, ports (5060 UDP/TCP, 5061 TLS, RTP range, livekit-sip ports), firewall, secret
rotation, troubleshooting, uninstall, MVP limits, roadmap.

## Database
Forward-only migration `199_telephony_integrations.sql` only if the audit of `channel_integrations`
shows it cannot carry telephony registration state; preference is to reuse `channel_integrations`
(provider `daftareshoma`) plus `call_sessions.metadata`. Self-host + hosted parity kept; migrations
169–198 untouched.

## Frontend
`src/components/plugins/DaftareShomaConfigPanel.tsx` in the existing plugin-panel style: credential
form (password shown as `••••••••`), status block (installed / configured / gateway / registration),
Save · Test Connection · Disconnect, external "Get a number from DaftareShoma" link. Full FA/TR/EN
strings. Call Center shows phone calls in the existing ring UI labelled **Phone · DaftareShoma** with
contact name or normalized number.

## What I cannot verify from here (manual steps for you)
- Real SIP registration against DaftareShoma and a real inbound PSTN call need the deployed gateway
  plus your account credentials; CI uses a mock gateway.
- Deploying the new `webyar-telephony` container and `livekit-sip` on your server, opening SIP/RTP
  ports, and setting `TELEPHONY_INTERNAL_SECRET` / `TELEPHONY_INTERNAL_BASE_URL`.
- DaftareShoma REST/Core API: only endpoints confirmed in their live docs will be used; anything not
  confirmable will be left as a documented adapter stub, never invented.
