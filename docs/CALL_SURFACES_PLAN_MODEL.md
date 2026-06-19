# Call Surfaces — Plan Model

This document records which call concepts are represented in the
plan capability registry, which remain runtime-only, and how the
two layers compose.

## Registry coverage (plan-level)

| Key | Type | Group | Purpose |
| --- | --- | --- | --- |
| `voice_video` | module | modules | Top-level access to voice/video. Pre-existing. |
| `voice` | channel | channels | Voice call channel availability. Pre-existing. |
| `video` | channel | channels | Video call channel availability. Pre-existing. |
| `call_center` | module | modules | Call queue + routing + invitations + callbacks suite. Added. |
| `call_recording` | feature | calls | Plan-level recording allowance. Added. |
| `call_queue` | feature | calls | Plan-level queue surface allowance. Added. |
| `call_callbacks` | feature | calls | Plan-level visitor callback allowance. Added. |

No new numeric limits were introduced in this phase. The runtime
control plane already owns the per-call defaults (max participants,
bitrates, retention) and those are not yet modelled per-workspace.

## Runtime-only (intentionally not in plans)

These remain on `app_runtime_config.call_control_plane` /
`workspace_provider_settings(provider_type='call')` and stay as
platform/workspace operational toggles, not plan capabilities:

- `enabled` (master kill switch)
- `primary_provider` / `secondary_provider` / `fallback_policy`
- `max_participants`, bitrates, video profile (per-call defaults)
- `retention_default_days` (recording retention default)
- `verification_required_for_visitor_calls`
- `voice_calls_enabled_global`, `video_calls_enabled_global`
- `call_recording_enabled_global`, `call_queue_enabled_global`
- `visitor_initiated_audio_enabled_global`, `visitor_initiated_video_enabled_global`
- `queue_offer_timeout_seconds`, `queue_max_wait_seconds`,
  `auto_expire_queue_after_seconds`
- `audio_queue_enabled`, `video_queue_enabled`
- workspace overrides: `allow_voice/video/recording`, `provider_override`,
  `verification_policy`, `default_video_quality`

These are platform-operational controls (provider routing, SLA timing,
kill switches) — they are NOT plan-shaped and must not be modelled as
plan keys.

## Composition rule

`effective(call surface) = plan(call_center / voice_video / voice|video / call_recording / call_queue / call_callbacks)`
`AND control_plane.enabled`
`AND control_plane.<feature>_enabled_global`
`AND workspace_overrides.<feature>_enabled`

Plan keys are an upper bound on what the control plane will let
through. The control plane stays authoritative for per-call defaults
and provider selection.

## Future enforcement readiness

The following routes are the natural attachment points for a future
enforcement rollout — none are gated on the new keys yet and this
phase intentionally avoids a broad gating sweep:

- `server/routes/workspaceCalls.ts` → `voice_video` / `voice` / `video`
- `server/routes/callQueue.ts` → `call_center` + `call_queue`
- `server/routes/callAvailability.ts` → `call_center`
- `server/routes/callInvitations.ts` → `voice_video` + (`voice`|`video`)
- `server/routes/widgetCallInvitations.ts` → `voice_video` + (`voice`|`video`)
- `server/routes/callbacks.ts` / `widgetCallbacks.ts` → `call_callbacks`
- recording endpoints (when added) → `call_recording`

Enforcement must compose with the existing control-plane gates
(`loadEffectiveCallChannels`) — never replace them.

## Considered but not added

- `max_concurrent_calls` — no per-workspace concurrency counter exists
  yet; would be speculative.
- `max_call_minutes_per_month` — no usage resolver in
  `usageResolvers.ts`; deferred until a counter exists.
- `recording_retention_days` (plan-level) — currently a per-call
  default on the control plane. Promoting it to a plan limit would
  require a workspace-scoped enforcement path that does not exist yet.
- `max_call_participants` (plan-level) — already enforced as a
  per-call ceiling in the control plane; per-plan override has no
  current consumer.

These are documented here so a future phase can revisit them with
grounded semantics rather than re-deriving the audit.