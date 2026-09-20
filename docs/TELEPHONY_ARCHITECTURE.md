# WEBYAR Telephony

Provider-neutral inbound PSTN telephony for the **existing** Call Center. There
is no second call product, no second call history and no softphone UI:
a phone call is a `call_sessions` row with `entry_source = 'telephony'` that
rings in the Call Center operators already use.

DaftareShoma is the first *adapter*. Every layer below it is generic
(`server/services/telephony/**`), so Generic SIP / Asterisk trunks / 3CX can be
added later without touching the Call Center.

## Topology

```text
  PSTN caller
      │  (call to the workspace's DaftareShoma number)
      ▼
  DaftareShoma  ──────────── SIP REGISTER (server-side, always on) ───────────┐
      │  INVITE                                                               │
      ▼                                                                       │
  Asterisk / PJSIP            ← registration adapter, multi-tenant ───────────┘
      │  1. identifies the registered tenant (endpoint → installation)
      │  2. captures a stable SIP Call-ID
      │  3. authenticated event ──► WEBYAR Core  (TELEPHONY_INTERNAL_SECRET)
      │                                 │  resolves workspace SERVER-SIDE
      │                                 │  telephony_calls + call_sessions (idempotent)
      │                                 │  returns room = tel_<call-session-id>_<rand>
      │  4. dials LiveKit SIP with that room name as the callee
      ▼
  LiveKit SIP  ← long-lived inbound trunk + reusable callee dispatch rule
      │  creates the SIP participant in that exact room
      ▼
  LiveKit room  ◄── operator browser joins the SAME room (existing media console)
```

**LiveKit SIP does not support SIP REGISTER.** Asterisk is therefore the
registration adapter and LiveKit SIP is only the SIP→LiveKit media bridge.
There is no WebRTC/WSS fallback leg: if `livekit-sip` is not deployed,
readiness reports `livekit_sip_ready: false` and deployment fails loudly
rather than silently switching to a second media architecture.

## Responsibility split inside Asterisk

| Layer | Owns |
| --- | --- |
| PJSIP | SIP transports, endpoints, auth, registrations |
| PJSIP Realtime (`asterisk.*` schema) | dynamic multi-tenant endpoint/registration rows |
| ARI | runtime channel/bridge events and call control **only** |

ARI is never a configuration store. Provisioning writes validated rows to
`asterisk.ps_endpoints / ps_auths / ps_aors / ps_registrations` and reloads the
affected endpoint — no whole-service restart when one workspace saves settings.
Those tables live in a restricted schema owned by the least-privilege role
`webyar_asterisk` and are never exposed through PostgREST or the browser.

## Data model (migration 199, forward-only)

- `public.telephony_calls` — technical mapping only, **not** user-facing history.
  `UNIQUE (installation_id, provider, sip_call_id)` plus a partial unique index
  on `call_session_id`. Every repeated provider event for one SIP dialog
  resolves to the same canonical call session.
- `public.telephony_registrations` — one row per installation: state,
  last success, last error code, last inbound call.
- `public.call_sessions` stays the product source of truth:
  `entry_source = 'telephony'`, `direction = 'inbound'`, `call_type = 'audio'`,
  `provider = 'livekit'` (media provider semantics unchanged — `daftareshoma`
  is **never** added to the media-provider enum), and
  `metadata.telephony = { provider, external_call_id, sip_call_id,
  caller_number, called_number, sip_extension, installation_id }`.
- `telephony_claim_call(p_workspace_id, p_call_session_id, p_agent_id)` —
  SECURITY DEFINER RPC performing the answer in ONE transaction: verifies
  workspace ownership, verifies the queue entry is still queued/offered and the
  call is unassigned, then sets queue `accepted` + `assigned_agent_id` +
  `accepted_at` and moves the call to `connecting`. Exactly one concurrent
  operator wins; losers get a stable `already_answered` (HTTP 409). Frontend
  race prevention is never relied upon.

## Entry-source generalization

`shared/callCenter/entrySources.ts` defines the canonical constants.

- **Group A — include `call_widget` + `telephony`:** operator queue visibility,
  routing (`server/services/callCenter/routing.ts`), overview counters, call
  lists, live queue, accept/reject/end lifecycle, platform admin counters.
- **Group B — `call_widget` ONLY, unchanged:** widget concurrency and
  entitlement counters (`server/services/billing/usageResolvers.ts`), widget
  routes (`server/routes/callWidget.ts`), widget recording control,
  cross-widget identity. Widget product limits must not change silently.

## Security

- The SIP password is stored through the existing encrypted plugin secret
  system (`plugin_secrets` + `PLUGIN_SECRETS_MASTER_KEY`, AES-256-GCM) under
  key `daftareshoma_sip_password`. No second encryption system exists.
- The password is **write-only**: the status endpoint returns
  `hasSipPassword: true` and never the value. Plaintext exists only in memory
  on the provisioning path, for one authenticated request to the control
  service.
- Passwords, decrypted credentials, auth headers and REGISTER authorization
  values are never logged; diagnostics are redacted and phone numbers masked
  (`maskNumberForLog`).
- Core ↔ control service authenticate in both directions with
  `TELEPHONY_INTERNAL_SECRET` (`x-telephony-internal-secret` + `Bearer`),
  constant-time compared, and validated at boot as distinct from
  `CORE_INTERNAL_SECRET`, `PLUGIN_SECRETS_MASTER_KEY`,
  `CHANNELS_WEBHOOK_SIGNING_KEY`, `AI_RUNTIME_INTERNAL_SECRET` and the service
  role key. With either value missing, every gateway call fails closed with
  `gateway_not_configured`.
- A `workspace_id` supplied by an untrusted SIP request is never trusted: the
  workspace is resolved from the registered account.
- Multi-tenant: one installation = one telephony account. Workspace A's
  credentials are never readable or usable by workspace B, and contact lookup
  is workspace-scoped, so caller identity never leaks across tenants.

## Readiness flags

The plugin reports four independent flags — a saved password alone can never
read as "connected":

| Flag | Meaning |
| --- | --- |
| `configured` | valid SIP settings + stored password |
| `gateway_healthy` | control service + Asterisk ARI/SIP stack reachable |
| `sip_registered` | DaftareShoma accepted the REGISTER |
| `livekit_sip_ready` | LiveKit + LiveKit SIP (and its Redis) healthy |

## Call lifecycle

`incoming → ringing → connected → ended`, with `rejected` / `missed` / `failed`
mapped onto the existing `call_state` enum (`pending → ringing → active →
ended`). Termination from the PSTN side, LiveKit, or the operator converges on
one idempotent `ended` transition.

## Plan gating

`isPluginAllowedByPlan()` gives `planChannelKey` precedence and returns before
checking `planModuleKey`, so the registry entry uses
`planModuleKey: 'call_center'`, `planChannelKey: null`. The existing `voice`
entitlement is enforced at the real call creation/answer boundary by the
canonical call entitlement composer, not in the registry — the plugin is never
permanently plan-locked by a key that does not exist.

## Deferred (designed for, not built)

Outbound calling, recording, call history/reconciliation via the DaftareShoma
Core API, missed-call follow-up, queues/departments/round-robin for telephony,
transfer/hold/mute/DTMF, voicemail, IVR, business hours, AI transcription and
analytics, additional telephony providers. The adapter boundary
(`server/services/telephony/providers/daftareshoma/`) reserves
`getCallHistory()`, `startOutgoingCall()`, `getRecording()`, `reconcileCall()`;
no undocumented REST endpoint is invented.
