# DaftareShoma Telephony Plugin — MVP (revised after your corrections)

## 1. Canonical media topology (no alternatives)
```text
PSTN caller
  → DaftareShoma (SIP provider, registration-based account)
  → Asterisk / PJSIP            [registration adapter: REGISTER outbound, receives INVITE]
  → LiveKit SIP (self-hosted)   [SIP → LiveKit media bridge, creates the SIP participant]
  → unique LiveKit room per call
  → existing WEBYAR operator media console (unchanged token/join flow)
```
- LiveKit SIP never registers to DaftareShoma (REGISTER is unsupported there). Asterisk owns
  registration; LiveKit SIP owns the bridge.
- **No WSS/WebRTC fallback.** If self-hosted `livekit-sip` is absent, deployment readiness fails
  loudly (`livekit_sip_ready: false`) and telephony stays unavailable. No silent second media path.
- One LiveKit room per PSTN call, keyed off the WEBYAR call id + random suffix. Trunk and dispatch
  rules in LiveKit SIP are created once as long-lived objects, not per call.

## 2. Asterisk responsibility split
- **PJSIP**: transports, endpoints, auths, outbound registrations.
- **PJSIP Realtime (database-backed provisioning)**: the multi-tenant endpoint/auth/registration
  rows. Written only by the WEBYAR Telephony Control Service from validated, escaped values —
  idempotent per installation, tenant-scoped, reloaded per-endpoint without restarting Asterisk.
- **ARI**: runtime channel/bridge events and call control only. ARI is never a configuration store.
- Many workspaces register concurrently, each with its own username/password/domain/extension.
  Credentials stay encrypted in WEBYAR and are delivered to the trusted telephony service only when
  a registration is provisioned or refreshed.

## 3. Plugin definition (no new taxonomy, no fake capability key)
Audit result: `capabilityRegistry` already ships module `call_center` and channel `voice`; there is
no `telephony` key anywhere in plan JSON, Plans UI, overrides, resolver or tests.
- `category: 'channels'` (no new PluginCategory).
- `planModuleKey: 'call_center'`, `planChannelKey: 'voice'` — real, sellable, already gated.
- `supportsMedia: true`; `supportsInbox/supportsAI/supportsWebhook: false`.
- Service layer is named generically: **WEBYAR Telephony**, with a `daftareshoma` provider adapter.

## 4. Telephony number normalization (new, separate from SMS)
`shared/telephony/phoneNumber.ts` — accepts Iranian mobiles, Iranian landlines (021…, 0xxx),
E.164, `00` international prefixes, Persian/Arabic digits, and falls back to a safe sanitized
display form for unknown foreign caller IDs (never throws away the call).
`server/services/phoneVerification/phone.ts` is untouched; SMS keeps its stricter mobile-only rules.

## 5. `entry_source` audit — exact surfaces
Telephone calls use `entry_source = 'telephony'` with `metadata.telephony.provider = 'daftareshoma'`.
New shared constants + helper (`CALL_CENTER_ENTRY_SOURCES = ['call_widget','telephony']`,
`WIDGET_ONLY_ENTRY_SOURCE = 'call_widget'`) so future providers need no scattered string checks.

**Group A — generalize to the Call Center surface set (`call_widget` + `telephony`)**
| File | Lines | Surface |
|---|---|---|
| `server/services/callCenter/routing.ts` | 116 | routing session lookup |
| `server/routes/callCenter.ts` | 548, 550, 552, 554 | workspace overview counters |
| `server/routes/callCenter.ts` | 583 | call list |
| `server/routes/callCenter.ts` | 639 | live queue |
| `server/routes/callCenter.ts` | 756, 888, 946 | accept / reject / end lifecycle lookups |
| `server/routes/callCenter.ts` | 1758, 1759 | platform admin live activity counters |

**Group B — must stay `call_widget` only (unchanged semantics)**
| File | Lines | Why |
|---|---|---|
| `server/routes/callWidget.ts` | 195, 224, 256, 472, 487, 509, 931, 933, 972, 1042, 1204, 1447 | widget-owned endpoints, widget concurrency and session creation |
| `server/services/billing/usageResolvers.ts` | ~301–305 | widget concurrency/entitlement counting |
| `server/services/callCenter/recordingControl.ts` | 4, 81 | recording is widget-only and out of MVP scope |
| `server/routes/callCenter.ts` | 2139, 2182, 2225 | recording control guards |
| `server/services/widget/crossWidgetIdentity.ts` | 50 | widget identity source enum |

## 6. Call session model (one lifecycle)
`provider` keeps its media-provider meaning (`livekit`); `daftareshoma` never enters that enum.
```text
entry_source = 'telephony'      direction = 'inbound'      call_type = 'audio'
metadata.telephony = { provider, external_call_id, sip_call_id, caller_number,
                       called_number, sip_extension, installation_id }
```
States reuse the existing enum: pending → ringing → active → ended (plus missed/failed/cancelled).

## 7. Deterministic, idempotent incoming flow
INVITE → Asterisk identifies the registered tenant → stable SIP Call-ID captured → authenticated
event to Core → **Core resolves workspace from the registration/installation, never from a value in
the SIP request** → exactly one `call_session` (unique on provider + sip_call_id; duplicates are
no-ops) → queue entry → Asterisk bridges to LiveKit SIP → SIP participant enters the unique room →
existing realtime ring event → operator claims → joins the same room → audio → any termination
(SIP, LiveKit, operator) converges on one idempotent `ended` transition.

## 8. Ring-all + atomic claim (explicit design)
The realtime ring event is fanned out to every eligible/available agent, so all of them see and hear
the incoming call. Answering performs a single conditional server-side claim
(`UPDATE … WHERE state IN ('queued','offered') AND accepted_by IS NULL` returning the row); the
winner is whoever the database accepts. Losers get a stable `already_answered` conflict and their UI
stops ringing on the broadcast `call_answered` event. No frontend race prevention.

## 9. Internal boundary
Dedicated `TELEPHONY_INTERNAL_SECRET` following the `server/lib/internalAuth.ts` pattern
(constant-time compare, `Authorization` + `X-…-Secret` transports, machine-readable failure reason,
fingerprint logging only). Both directions authenticate; provider events carry a timestamp + dialog
id for replay rejection. SIP password never leaves the server; API returns only `hasSipPassword`.

## 10. Readiness / status model
The plugin reports four independent flags — a saved password alone can never read as connected:
`configured`, `gateway_healthy`, `sip_registered`, `livekit_sip_ready`.
Startup/readiness checks cover Core, Telephony Control Service, Asterisk ARI, Asterisk SIP stack,
DaftareShoma registration state, LiveKit, LiveKit SIP, its Redis dependency, and RTP/SIP reachability.

## 11. Phases
- **B** Plugin: registry entry, settings storage, `daftareshoma_sip_password` in `plugin_secrets`
  (blank on save keeps the existing secret), install/uninstall hooks that provision/deprovision the
  registration.
- **C** `telephony/` service: Asterisk + PJSIP realtime provisioning + control API (`/registrations`,
  `/registrations/:id` delete, `/test`, `/health`) behind the internal secret.
- **D** Incoming-call bridge and Core event endpoint; number normalization; workspace-scoped contact
  match; realtime ring.
- **E** LiveKit SIP deployment (compose service, trunk/dispatch bootstrap) + room-per-call.
- **F** Answer / reject / hangup / disconnect / uninstall cleanup, all idempotent.
- **G** Tests (mock gateway, no live credentials): catalog/install/plan gates, secret never returned
  and never erased, tenant isolation (A cannot read/update/answer B), registration
  success/bad-credentials/timeout/reconnect, incoming event → session + normalization + contact
  match + realtime + first-claim-wins + duplicate idempotent + hangup ends session, internal endpoint
  rejects missing/wrong secret, redaction in diagnostics, and regression tests proving Group B
  widget counters did not change.
- **H** Docs (`docs/TELEPHONY_ARCHITECTURE.md`, `docs/DAFTARESHOMA_PLUGIN.md`) + Docker/Coolify,
  ports/firewall, secret rotation, troubleshooting, MVP limits, roadmap.

## 12. Database
Forward-only `199_telephony_registrations.sql` for the telephony integration/registration state and
the PJSIP realtime tables. Migrations 169–198 untouched; self-host and hosted chains kept in parity.

## 13. Frontend
`DaftareShomaConfigPanel` in the existing plugin-panel style: credential form (password rendered as
`••••••••`, only replaced when a new value is typed), four-flag status block, Save · Test Connection ·
Disconnect, external "Get a number from DaftareShoma" link. Full FA/TR/EN. The Call Center rings
phone calls in its existing UI, labelled **Phone · DaftareShoma**, showing the contact name when a
workspace contact matches, otherwise the normalized number.

## 14. Preserved behavior
LiveKit widget calls, widget queue, video calls, callbacks, plan limits, recording, operator presence
and all existing plugins keep their current behavior; workspaces that do not install the plugin need
no new configuration.

## 15. Manual steps only you can do
Deploy `webyar-telephony` and `livekit-sip`, open SIP/RTP ports, set `TELEPHONY_INTERNAL_SECRET` and
`TELEPHONY_INTERNAL_BASE_URL`, and run the real DaftareShoma registration + inbound PSTN test; CI
uses a mock gateway. DaftareShoma REST endpoints are only used if confirmable in their live docs —
otherwise the adapter stays a documented stub, never invented.
