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

**Phase: Call Route Enforcement Rollout — Strict Minimal Pass.**
One route gated on the composer: `POST /api/call-invitations`
(operator-side invitation creation). Composition required:
`voice_video ∧ voice ∧ runtime.voice_enabled` for `channel='audio'`,
`voice_video ∧ video ∧ runtime.video_enabled` for `channel='video'`.
Denial returns `403 { error: 'plan_forbidden', capability,
upgrade_required: true }` and skips `createInvitation`. Cancel
(`POST /:id/cancel`), get (`GET /:id`), and list (`GET /`) are
intentionally NOT gated so in-flight invitations remain visible and
cancellable after a plan downgrade — the deny-on-create / allow-cleanup
policy holds.

### Route audit

| Route | Capability shape | Class |
| --- | --- | --- |
| `workspaceCalls.ts` (settings GET/PUT) | `voice_video` | DO NOT GATE — already returns `loadEffectiveCallChannels`; gating would block visibility of the very state operators need to manage. |
| `adminCalls.ts` | platform-admin | DO NOT GATE — admin surface, already role-protected. |
| `callCenter.ts` | very mixed: settings, queue, recording, callbacks, departments, presence, admin | AMBIGUOUS — needs per-handler classification before any sweep. Recording start/stop endpoints (`/calls/:id/recording/start|stop`) are the cleanest future candidates for `recording_enabled`. |
| `callQueue.ts` | `call_center` ∧ `call_queue` | AMBIGUOUS — admit/offer/accept must keep working for in-flight queue entries even if a plan downgrade lands mid-session. Defer until a "drain in-flight" policy is decided. |
| `callAvailability.ts` | `voice_video` | AMBIGUOUS — visibility of operator availability should arguably remain even when plans deny calls (operators may still toggle status during downgrade). |
| `callInvitations.ts` (operator) | `voice_video` ∧ (`voice`∨`video`) | FUTURE CANDIDATE — POST `/` is a clean enforcement point but cancel/get must remain. Not gated this phase. |
| `callInvitations.ts` POST `/` | composed via `loadEffectiveCallEntitlements` | **GATED** — channel-scoped: `eff.voice_enabled` for `audio`, `eff.video_enabled` for `video`. Cancel/get/list ungated. |
| `widgetCallInvitations.ts` | `voice_video` ∧ visitor channel | ALREADY EFFECTIVELY GUARDED — visitor-initiated paths gate on the runtime visitor toggles via the bootstrap snapshot. |
| `callbacks.ts` (operator) | `call_center` ∧ `call_callbacks` | FUTURE CANDIDATE — list/patch are stable, but list visibility should likely survive a plan downgrade for cleanup. |
| `widgetCallbacks.ts` | `call_center` ∧ `call_callbacks` (visitor) | AMBIGUOUS — already guarded by `callback_offer_after_timeout` runtime path; needs care to avoid double-blocking. |

### Why other routes are still deferred

Each remaining call route either (a) already consults
`loadEffectiveCallChannels`, (b) is admin-only and role-protected, or
(c) has in-flight semantics (active queue entries, offered calls,
pending callbacks) that a plan denial mid-session must not silently
break. The operator invitation POST is the one boundary where denial
only blocks a brand-new action and never breaks an in-flight one.

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