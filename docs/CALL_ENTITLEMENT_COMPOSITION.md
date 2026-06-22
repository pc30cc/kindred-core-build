# Call Entitlement Composition

Authoritative reference for how plan-level call capabilities compose
with the runtime/global/workspace call control plane.

## Two layers, one logical AND

- **Plan layer** (`server/services/billing/capabilityRegistry.ts`)
  - module: `voice_video`
  - channels: `voice`, `video`
  - module: `call_center`
  - features: `call_recording`, `call_queue`, `call_callbacks`
- **Runtime layer** (`server/services/calls/controlPlane.ts`)
  - global gates on `app_runtime_config.call_control_plane`
  - workspace overrides on `workspace_provider_settings(provider_type='call')`
  - resolved as `EffectiveCallChannels` via `loadEffectiveCallChannels`

`Effective = Plan AND Runtime`. Either layer can deny; neither can
override the other. Plan denies are commercial; runtime denies are
operational (kill switches, provider availability, SLA timing).

## Canonical composer

`server/services/calls/entitlementComposer.ts` is the single place
that performs this AND. Two entry points:

- `composeCallEntitlements(plan, runtime)` — pure function, unit-tested.
- `loadEffectiveCallEntitlements(config, workspaceId)` — async wrapper
  that reads plan flags via the existing RPC layer
  (`check_module_access`, `check_channel_access`,
  `check_workspace_entitlement`) and the runtime layer via
  `loadEffectiveCallChannels`. Fail-closed on RPC errors.

Output (`EffectiveCallEntitlements`):

| Field | Plan inputs | Runtime inputs |
| --- | --- | --- |
| `voice_enabled` | `voice_video` ∧ `voice` | `voice_enabled` |
| `video_enabled` | `voice_video` ∧ `video` | `video_enabled` |
| `visitor_voice_enabled` | `voice_video` ∧ `voice` | `visitor_initiated_audio` |
| `visitor_video_enabled` | `voice_video` ∧ `video` | `visitor_initiated_video` |
| `recording_enabled` | `voice_video` ∧ `call_recording` | `recording_enabled` |
| `queue_enabled` | `call_center` ∧ `call_queue` | `queue_enabled` |
| `callbacks_enabled` | `call_center` ∧ `call_callbacks` | `queue_enabled` |

The composer never replaces `loadEffectiveCallChannels` — it consumes
it. Existing handlers that already call `loadEffectiveCallChannels`
(notably `workspaceCalls.ts`) continue to work unchanged.

## Rollout status

**Phase: Call Route Enforcement Expansion — Strict Drain-Policy Pass.**
Three operator-side create boundaries are now gated on the canonical
composer. All three deny with
`403 { error: 'plan_forbidden', capability, upgrade_required: true }`
before mutating any state. No cleanup, cancel, status, or read path
was gated.

| Route | Composed entitlement | Capability label |
| --- | --- | --- |
| `POST /api/call-invitations` | channel-scoped: `eff.voice_enabled` (audio) or `eff.video_enabled` (video) | `voice` / `video` |
| `POST /api/calls/:id/recording/start` | `eff.recording_enabled` | `call_recording` |
| `POST /api/call-center/calls/:id/recording/start` | `eff.recording_enabled` | `call_recording` |

### Drain policy (locked)

- CREATE / START / ADMIT / REQUEST may be denied by the composer.
- READ / STATUS / CANCEL / CLEAR / CLEANUP / FINALIZE must remain
  reachable for already-existing objects after a plan downgrade.

Concretely, the matching `recording/stop`, invitation `cancel`/`get`/
`list`, queue cancel, callback list/patch, and call `end`/`hangup`
routes are intentionally NOT gated. The composer is consulted only at
the moment a brand-new action is requested.

### Route audit

| Route | Class | Reason |
| --- | --- | --- |
| `POST /api/call-invitations` | **GATED** | Pure operator create boundary; channel-scoped composer. |
| `POST /:id/cancel`, `GET /:id`, `GET /` (invitations) | DO NOT GATE | Cleanup / read paths must survive downgrade. |
| `POST /api/calls/:id/recording/start` | **GATED** | Pure create; composer's `recording_enabled`. |
| `POST /api/calls/:id/recording/stop` | DO NOT GATE | Cleanup / finalize for in-flight recordings. |
| `POST /api/call-center/calls/:id/recording/start` | **GATED** | Pure create; same `recording_enabled` mapping. |
| `POST /api/call-center/calls/:id/recording/stop` (+ status) | DO NOT GATE | Cleanup / finalize. |
| `POST /api/call-queue/:workspaceId/:entryId/offer` / `accept` | DEFERRED | Acts on already-existing queue entries — denial would strand in-flight queue work. Needs a drain plan before gating. |
| `POST /api/call-queue/:workspaceId/:entryId/cancel` | DO NOT GATE | Cleanup — must always succeed. |
| `POST /api/widget/call-queue/enqueue` | DEFERRED | Visitor-public; denial UX (queue full vs plan-denied) is undefined. |
| `POST /api/widget/call-queue/:entryId/cancel` | DO NOT GATE | Visitor cleanup. |
| `POST /api/call-widget/calls/request` | **GATED** | Visitor-initiated new call request. Mapped to `eff.visitor_voice_enabled` / `eff.visitor_video_enabled`. Stable denial: `{ error: "plan_forbidden", capability: "voice" \| "video", upgrade_required: true }`. Runs before any DB insert / provider resolution so no half-created call objects are stranded. |
| `POST /api/call-widget/callbacks/request` | **GATED** | Visitor-initiated new callback request. Mapped to `eff.callbacks_enabled`. Stable denial: `{ error: "plan_forbidden", capability: "call_callbacks", upgrade_required: true }`. |
| `POST /api/widget-callbacks/request` | **GATED** | Same surface mounted under the unified widget router. Mapped to `eff.callbacks_enabled` with the same denial shape. |
| `GET /api/widget-callbacks/status` | DO NOT GATE | Visitor read of own existing callback — required for cleanup / cooldown UI after a downgrade. |
| `GET / PATCH /api/callbacks/:workspaceId(/...)` | DO NOT GATE | List + status patch (includes 'cancelled' / 'completed') — cleanup. |
| `POST /api/call-center/callbacks/:id/{assign,complete,cancel}` | DO NOT GATE | All three operate on existing callback rows — cleanup / finalize. |
| `POST /api/calls/create` | **GATED** (Phase: Operator Call Route Split + Selective Gating) | Pure new-action boundary. Mixed by `call_type`; split branch-by-branch via the canonical composer — `audio` → `eff.voice_enabled` (`capability: voice_video.voice`), `video` → `eff.video_enabled` (`capability: voice_video.video`). Composer runs before `resolveEffectiveCallProvider` and the `call_sessions` insert, so no half-created sessions are stranded. Stable denial: `{ error: "plan_forbidden", capability, upgrade_required: true }` (403). |
| `POST /api/calls/:id/{accept,reject,hangup,end,token}` and `GET /api/calls/:id/state` | DO NOT GATE | Cleanup / lifecycle / read — must always remain reachable so in-flight calls can be drained after a plan downgrade. |
| `POST /api/calls/:id/invite` | DEFERRED | Acts on an already-existing `call_sessions` row and may be re-issued mid-call to add additional participants; gating would strand in-flight calls needing additional invitees. Held until a participant-class drain decision is made. |
| `POST /api/call-center/calls/:id/{accept,reject,end}` | DO NOT GATE | Cleanup / control surfaces. |
| `POST /api/call-center/calls/:id/{assign,transfer}` | DEFERRED | Operates on already-active calls; routing-level decision, not a new entitlement boundary. |
| `widgetCallInvitations.ts` `POST /:id/{join,decline,end}` | ALREADY GUARDED | Already consults `loadCallControlPlane` + `loadWorkspaceCallOverrides` per channel. |
| `callAvailability.ts`, `callCenter` settings/presence/departments | DO NOT GATE | Visibility/configuration surfaces — denial would block the very screens needed to manage a downgrade. |
| `adminCalls.ts`, `callCenter` `/admin/*` | DO NOT GATE | Platform-admin only; already role-protected. |

### Why the deferred routes stay deferred

Every deferred row above either (a) operates on an already-created
queue entry / call / callback (denial would strand in-flight work),
(b) is a public/widget surface where denial UX is still undefined, or
(c) is a mixed handler whose cleanup branches cannot be cleanly
separated from create branches. The composer is intentionally not
invoked there until each surface gets its own drain decision.

### Visitor / drain policy (locked)

- **Deny-on-create**: visitor `POST /api/call-widget/calls/request`,
  `POST /api/call-widget/callbacks/request`, and
  `POST /api/widget-callbacks/request` may be denied via the
  composer. Denial happens **before** provider resolution, queue
  inserts, and any DB mutation — so no half-created call objects or
  reserved queue rows are stranded.
- **Allow-on-cleanup / status / cancel / read**:
  `GET /api/widget-callbacks/status`, queue cancel paths, operator
  callback list / counts / PATCH, and all `accept` / `reject` /
  `hangup` / `end` / `cancel` surfaces remain reachable regardless of
  plan state so visitors and operators can finish or abort in-flight
  work.
- **Stable denial shape**: every newly gated visitor surface returns
  `{ error: "plan_forbidden", capability: <key>, upgrade_required: true }`
  with HTTP 403 — never a generic 500. The widget UI can branch on
  `error === "plan_forbidden"` without parsing prose.

## Numeric limits — still deferred

No `max_concurrent_calls` / `max_call_minutes_per_month` /
`recording_retention_days` plan limits are added in this phase. None
have a workspace-scoped counter or usage resolver yet
(`server/services/billing/usageResolvers.ts`), and adding limits
without a counter would be speculative.

## Backward compatibility

- No registry key was renamed.
- No route behavior changed.
- `loadEffectiveCallChannels` is unchanged and remains the runtime
  authority.
- The composer is additive; nothing imports it from a route handler.