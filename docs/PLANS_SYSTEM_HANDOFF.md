# Plans System — Handoff

_Last updated: 2026-06-22 (Post-Activation Cleanup phase). Status:
**CORE COMPLETE; `max_agents` LIVE.**_

This is the "start here" document for the next maintainer of the plans
subsystem. The plans system is a finished subsystem: capability modeling,
admin controls, workspace overrides, usage-backed limits, customer-facing
visibility, and live enforcement on the major plan-bounded surfaces are
all in place and tested.

Anything not listed under **Core complete** is either intentionally
deferred or optional polish — not unfinished work.

---

## 1. Canonical sources of truth

| Concern | File / Surface |
|---|---|
| Capability catalog (every key, type, default, visibility) | `server/services/billing/capabilityRegistry.ts` |
| Plan JSON values (per-plan entitlements + limits) | `billing_plans.entitlements`, `billing_plans.limits` |
| Module / channel boolean overrides | `workspace_module_overrides`, `workspace_channel_overrides` |
| Numeric limit overrides | `workspace_limit_overrides` |
| Effective entitlement resolver (RPC) | `public.check_workspace_entitlement` |
| TypeScript enforcement entry points | `server/middleware/featureGating.ts` (`requireFeature` / `requireModule` / `requireChannel` / `requireLimit` / `requireAICredits`) |
| Usage resolvers per limit key | `server/services/billing/usageResolvers.ts` |
| Admin + diagnostics API | `server/routes/plans.ts` (`/api/plans/...`) |
| Super Admin UI | `src/pages/admin/PlansPage.tsx` |
| Customer-facing visibility | `src/components/billing/PlanUsagePanel.tsx` (mounted by `src/pages/app/BillingPage.tsx`) |

The registry never decides runtime access. The middleware in
`featureGating.ts` is the only runtime authority and always reaches the
canonical resolver — same payload that the admin and customer UIs read.

---

## 2. Where things happen

- **Effective entitlements** are resolved in `check_workspace_entitlement`
  (SQL, security definer). All TS enforcement consumers reach it via
  `checkEntitlementFromDB`. Aggregated read for UIs:
  `GET /api/plans/workspace/:id/effective` — every limit carries
  `source: 'override' | 'plan' | 'default'`.
- **Module / channel / feature overrides** are managed by the Workspace
  Console in `PlansPage.tsx` via the existing
  `/api/plans/admin/overrides/*` endpoints.
- **Numeric limit overrides** use the same console and the additive
  `POST /api/plans/admin/overrides/limit` /
  `DELETE /api/plans/admin/overrides/limit/:id` endpoints. Precedence is
  `workspace_limit_overrides → billing_plans.limits → registry.default`,
  and `-1` means unlimited.
- **Usage-backed limit enforcement** runs through `requireLimit('<key>',
  usageFnForLimit('<key>'))` against the canonical counters. The current
  rolled-out keys are `max_conversations`, `max_visitors`, `storage_gb`,
  `ai_kb_jobs_per_month`, `ai_credits_per_month`, `max_contacts`
  (TS-first chokepoint at `POST /api/contacts` and
  `POST /api/contacts/bulk`), and `max_agents` (TS-first chokepoint at
  `POST /api/workspace-members/accept-invitation` — service-role
  companion RPC `accept_workspace_invitation_as`; see
  `docs/MAX_AGENTS_POLICY.md`).
- **Counter writes** are single-writer per metric (DB trigger or atomic
  RPC). Application code must not write `workspace_usage_counters.*`
  outside the Super Admin "usage adjust" route. Enforced by the CI
  invariant test `src/test/billing/singleWriterInvariants.test.ts`.
- **Customer-facing visibility** is read-only. The Plan & Usage tab in
  `/app/billing` consumes the same effective-state payload as enforcement
  and renders only `userVisible` capabilities. No mutation controls.
- **Call surfaces** are plan-modeled (`voice_video`, `voice`, `video`,
  `call_center`, `call_recording`, `call_queue`, `call_callbacks`). The
  composer `server/services/calls/entitlementComposer.ts` is canonical
  for plan ∧ control-plane ∧ override composition. The first call route
  enforced is `POST /api/callInvitations` (channel-scoped). All other
  call routes are intentionally deferred — see
  `docs/ENFORCEMENT_COVERAGE_AUDIT.md`.

---

## 3. Final scope (what is done)

### Core complete

- Central capability registry with `feature` / `module` / `channel` /
  `limit` types, visibility flags, and stable keys.
- Registry-driven Super Admin Plans UI (`PlansPage.tsx`), including the
  Workspace Console and limit-override controls.
- Workspace effective entitlements resolved by a single SQL RPC consumed
  by all enforcement paths and both UIs.
- Module, channel, feature, and numeric-limit overrides — all canonical,
  all consulted before plan defaults.
- Usage-backed limit enforcement for `max_conversations`, `max_visitors`,
  `storage_gb`, `ai_kb_jobs_per_month`, `ai_credits_per_month`, and
  `max_contacts`.
- Plan modeling for Contacts and Call surfaces.
- Customer-facing Plan & Usage panel.
- Diagnostics endpoint surfacing drift between registry, plan JSON, and
  the usage-backed limit set.
- Tests: 72 passing across `src/test/billing/`, including the
  single-writer invariant, registry contract, override invariants, and
  per-limit middleware behavior.

### Deferred by design (recorded; not core blockers)

- Migrating legacy unknown plan keys discovered by `/admin/diagnostics`.
- Reconciling free/paid plan seed JSON with the registry.
- Broader call-route gating (queue / availability / cancel / list).
  Composer exists; rollout requires a "deny on create, allow on cleanup"
  drain policy. See `ENFORCEMENT_COVERAGE_AUDIT.md` §3.
  - **Recording start** — resolved (Call Route Enforcement Expansion).
    `POST /api/calls/:id/recording/start` and
    `POST /api/call-center/calls/:id/recording/start` are gated on
    `eff.recording_enabled`; `recording/stop` and `recording/status`
    remain ungated.
  - **Visitor call/callback request creation** — resolved (Call Public/
    Queue/Callback Route Enforcement — Strict Visitor-Safe Pass).
    `POST /api/call-widget/calls/request` is gated on
    `eff.visitor_voice_enabled` / `eff.visitor_video_enabled`;
    `POST /api/call-widget/callbacks/request` and
    `POST /api/widget-callbacks/request` are gated on
    `eff.callbacks_enabled`. All denials use the stable shape
    `{ error: "plan_forbidden", capability, upgrade_required: true }`
    and run before any DB insert / provider resolution. Cleanup, status,
    cancel, accept, reject, hangup, and end paths remain reachable.
  - **Operator call create** — resolved (Phase: Operator Call Route
    Split + Selective Gating — Strict Mixed-Handler Pass).
    `POST /api/calls/create` is gated branch-by-branch via the canonical
    composer: `audio` → `eff.voice_enabled` (`capability:
    voice_video.voice`), `video` → `eff.video_enabled` (`capability:
    voice_video.video`). The check runs before
    `resolveEffectiveCallProvider` and the `call_sessions` insert, so no
    half-created sessions are stranded. Cleanup / lifecycle branches in
    the same router (`/:id/{accept,reject,hangup,end,token}`,
    `GET /:id/state`) remain ungated.
  - **Operator `POST /api/calls/:id/invite`** — still deferred, now
    formally audited (Phase: Participant / Continuity Pass). The route
    is a single undifferentiated handler that inserts a
    `call_participants` row, flips `call_sessions.state` to `ringing`,
    and emits the visitor `call:incoming` envelope. The same path
    serves both **new optional participant adds** and **re-ring /
    recovery / rejoin** of an in-flight participant; no schema, body
    field, or code branch distinguishes the two. Per the
    deny-on-create / allow-on-continuity policy, gating the whole
    route would strand active-call continuity, so no rollout is
    applied. Unblocking requires either an explicit
    `reason: 'new' | 'reissue'` body signal or an idempotency contract
    on `call_participants` so a "brand-new optional participant"
    branch can be isolated. Mapping that would apply when separated:
    audio session → `eff.voice_enabled`, video session →
    `eff.video_enabled`.
  - **`call-queue/enqueue`** — **resolved (Phase: Visitor Queue Denial
    Policy + call-queue/enqueue Selective Gating — Strict Single-Surface
    Pass).** Gated at `POST /api/widget/call-queue/enqueue` via the
    canonical composer (`server/services/calls/queueEntitlementGate.ts`).
    Mapping: `queue_enabled=false` → `capability: 'call_queue'`
    (precedence); else `audio` → `eff.visitor_voice_enabled`
    (`capability: 'voice'`), `video` → `eff.visitor_video_enabled`
    (`capability: 'video'`). `plan_forbidden` (403) is strictly distinct
    from runtime queue/business-state denials inside `enqueueCall`
    (`queue_disabled` / `voice_disabled` / `video_disabled` → 409) and
    from `invalid_body` (400). Cancel/status surfaces remain ungated.
  - **Queue offer/accept** — still deferred: act on already-existing
    entries; gating would strand in-flight queue work.
- ~~Splitting `email.ts` into platform/auth vs channel-email before gating.~~
  **Resolved (Phase: Email Surface Split + Channel Gating).** Platform
  email stays on `POST /api/email/send` (un-gated). Channel email lands
  on `POST /api/email/send-channel` and `sendChannelEmail()`, both
  gated with `requireChannel('email')`. See `EMAIL_SURFACE_SPLIT.md`.
- `aiAgent.ts` per-route audit — **partially resolved** (Phase: AI Agent
  route audit + selective gating). `POST /generate-business-description`
  and `POST /learning-candidates/generate` are now gated with
  `requireModule('ai_assistant')` because both are pure new-action
  generators with no in-progress state. All settings/platform-settings/
  sources/data-sources/runs/qna CRUD/knowledge-index/files/workflows/
  topics/tools/test-cases/test-runs/regression/guidance/routing/learning-
  candidate finalization/operator-assist analytics/overview/debug routes
  remain intentionally admin-safe — they are read/status/config/finalize
  surfaces or operate on already-created rows, and `operator/suggest-
  reply` keeps its existing in-handler `checkEntitlementFromDB` +
  dev-bypass logic. See `ENFORCEMENT_COVERAGE_AUDIT.md` §1 and §3.

### Out of scope

- A second entitlement composer (SQL-side or client-side). The single
  canonical composition path is non-negotiable.
- Renaming any capability key, route, env var, schema, or middleware
  contract. All changes since the registry shipped are additive.

---

## 4. Optional future polish (not required)

These items are explicitly **not** unfinished plans work. Treat them as
independent enhancement tickets, scoped on demand:

- Customer usage history charts / time-series in the Plan & Usage panel.
- Context-aware upgrade CTAs and recommendation UX.
- Surfacing `max_contacts` live occupancy on the customer payload.
- Bulk-edit / CSV affordances for limit overrides in the admin console.
- Unifying the three override tables (`workspace_module_overrides`,
  `workspace_channel_overrides`, `workspace_limit_overrides`) into one
  schema.
- Audit-log surfacing improvements for plan / override mutations.
- Additional call-route enforcement once a drain policy is defined.

Each can be picked up without reopening the core plans system.

---

## 5. Backward-compatibility safeguards (still in force)

- No existing route, capability key, schema column, or env var was
  renamed across the entire plans rollout.
- Plan create/update accepts unknown keys with a soft warning — never a
  hard reject — to keep legacy plan rows valid.
- The registry is metadata only; it cannot deny runtime access.
- The `featureGating.ts` middleware contract is unchanged since shipping.
- Customer UI is read-only; admin mutation surfaces are exclusive to
  `PlansPage.tsx`.

---

## 6. Companion docs

- `docs/ENTITLEMENT_ARCHITECTURE.md` — layered authority model, how to
  add a capability or limit.
- `docs/ENFORCEMENT_COVERAGE_AUDIT.md` — per-route classification of
  what is gated, deferred, or must not be gated.
- `docs/USAGE_LIMIT_OVERRIDE_MODEL.md` — limit override precedence,
  admin API, `-1` semantics.
- `docs/CUSTOMER_USAGE_VISIBILITY.md` — what the customer sees and why.
- `docs/CONTACTS_PLAN_MODEL.md`, `docs/CONTACTS_LIMIT_POLICY.md` —
  Contacts modeling and `max_contacts` enforcement.
- `docs/CALL_SURFACES_PLAN_MODEL.md`, `docs/CALL_ENTITLEMENT_COMPOSITION.md`
  — call surfaces.
- `docs/PLAN_LIMIT_ALIGNMENT.md`, `docs/USAGE_METRICS.md` — counter
  semantics and per-limit policy index.
- `docs/ENTITLEMENT_TESTING.md` — what the test suite already protects
  (registry shape, override invariants, per-limit middleware, single-
  writer rule, customer panel rendering).
- `docs/PLAN_DATA_RECONCILIATION.md` — legacy plan-JSON key audit,
  per-key classification (LEGACY PRESERVED / DEFERRED / TOO AMBIGUOUS),
  and the explicit deferral list with unblock criteria.
- `docs/MAX_AGENTS_POLICY.md` — `max_agents` seat-limit semantics,
  counting model (live `count(*)` on `workspace_members`), and the
  exact Express-route unblock criterion that gates rollout and the
  `team_members / agents → max_agents` seed migration.
- `docs/DEFERRED_BACKLOG_MATRIX.md` — final triage matrix bucketing
  every remaining preserved/deferred item (compatibility / product /
  architecture / permanent / too-ambiguous) with explicit unblock
  criteria. Consult before touching any preserved surface.

_Status update 2026-06-22 (Post-Activation Cleanup phase):_
`max_agents` is **LIVE**. Canonical chokepoint:
`POST /api/workspace-members/accept-invitation` →
service-role-only `accept_workspace_invitation_as(_token, _user_id)`
RPC; resolver `resolveMaxAgents` (live `count(*)` on
`workspace_members`); `requireLimit` mounted with an already-member
skip; browser-side bypass on the original
`accept_workspace_invitation(text)` RPC is closed (`EXECUTE`
revoked from `anon`/`authenticated`/`public`, `service_role`
retained). Seed mirror is in place (`free=2`, `pro=10`,
`enterprise=-1`). Legacy `team_members` / `agents` plan keys are
intentionally **preserved for one release** as soft-warn aliases
— see `docs/MAX_AGENTS_POLICY.md` §6 for the full post-activation
deprecation classification and §8.1 for the deferred future-removal
checklist. The earlier per-phase "deferred / blocked / corrected"
status updates are superseded by this entry; the historical phase
log lives in `docs/MAX_AGENTS_POLICY.md` §§4.1–4.3.

If this doc disagrees with code, the code wins and this doc must be
updated — but the system itself is finished.

_Status update 2026-06-22 (Call-Side Policy Backlog Resolution —
single-decision pass):_ Audit-only. Outcome **B — no safe rollout**.
The remaining call-side backlog (`/api/calls/:id/invite`,
`call-queue offer/accept`, `call-center assign/transfer`,
`max_concurrent_calls`, `max_call_minutes_per_month`,
`recording_retention_days`) was re-classified against repository
truth and every item still requires either a product-policy
decision, a drain/continuity contract, or counter/resolver
architecture that does not yet exist. No code, schema, registry key,
route, env var, or middleware contract was changed. The smallest
next bounded step (when policy lands) is splitting
`/api/calls/:id/invite` into a `reason: 'new' | 'reissue'` contract
and gating only the `'new'` branch. See
`docs/CALL_ENTITLEMENT_COMPOSITION.md` §"Phase: Call-Side Policy
Backlog Resolution" for the full classification.
_Status update 2026-06-22 (`/api/calls/:id/invite` route-shape split):_
Selective gating now LIVE for the `'new'` branch on
`POST /api/calls/:id/invite` via the canonical call entitlement
composer. `'reissue'` and legacy callers default to continuity-safe
and remain reachable. Files changed: `server/routes/calls.ts`,
`src/lib/calls-api.ts`, `src/test/billing/callsInviteRouteSplit.test.ts`.
No capability key, route, env var, schema, or middleware contract was
renamed. See `docs/CALL_ENTITLEMENT_COMPOSITION.md` §"June 2026" for
the full audit and compatibility rationale.

## June 2026 — Queue Offer / Accept Drain Policy (No-Rollout)

Single-decision pass scoped strictly to
`POST /api/call-queue/:workspaceId/:entryId/offer` and
`POST /api/call-queue/:workspaceId/:entryId/accept`. Route-truth audit
confirmed both are pure in-flight continuation of an already-existing
queue row whose creation is gated at the visitor enqueue boundary.

Outcome: **honest defer / no rollout.** Drain policy now explicit —
queue rows, once created, must remain drainable to completion or
cancellation; gating offer/accept would strand visitors on downgrade.
No files under `server/`, `src/`, or `supabase/` changed. Canonical
composer untouched, no new capability key. Full rationale:
`docs/CALL_ENTITLEMENT_COMPOSITION.md` §"Queue Offer / Accept Drain
Policy". Next call-side backlog item: call-center `assign` /
`transfer`.

### June 2026 — Call-Center Assign / Transfer pass

Single-surface audit of the two remaining non-numeric call-center
transition routes (`/api/call-center/calls/:id/assign` and
`/transfer`). Both route through service helpers that load an existing
`call_sessions` row and mutate ownership/target only; `transfer`
additionally enforces an active-state precondition. Neither contains a
new-action branch. **Outcome: honest defer, no rollout.** No files
under `server/`, `src/`, or `supabase/` changed. Canonical composer
untouched, no capability key renamed, no schema change. Full rationale:
`docs/CALL_ENTITLEMENT_COMPOSITION.md` §"Call-Center Assign / Transfer
Drain Policy". With this, all non-numeric call surfaces have been
route-audited under the deny-on-create / allow-on-continuity policy.
Remaining call-side backlog: numeric call limits only, still blocked
on missing usage resolvers.

### June 2026 — Numeric Call Limits Feasibility Pass

Strict feasibility audit of the three remaining numeric call-side
limits: `max_concurrent_calls`, `max_call_minutes_per_month`,
`recording_retention_days`. **Outcome: honest defer, no rollout.**
No capability registry key was added, no usage resolver was added,
no plan default changed, no call route or middleware changed.
Per-limit blockers, semantics, counting models, and proposed unblock
paths are documented in the new file `docs/CALL_NUMERIC_LIMITS.md`.
Closest-to-ready limit is `max_concurrent_calls` (counting model is
exact via the `idx_call_sessions_state_active` partial index), but
it is blocked on a product-policy reconciliation with the existing
platform-admin `platform_call_center_settings.
max_concurrent_calls_per_workspace` knob already enforced at the
visitor widget. Until that reconciliation is decided, all three stay
deferred.

### June 2026 — `max_concurrent_calls` Precedence Resolution Pass

Single-key follow-up targeting only `max_concurrent_calls`.
**Outcome: honest defer, no rollout.** Precedence policy is now
locked for the eventual activation: `effective =
min(plan.max_concurrent_calls, platform.max_concurrent_calls_per_workspace)`
with `-1` and `null` ignored, canonical active-state counting
(`('pending','ringing','connecting','active')` over all
`entry_source` values, backed by `idx_call_sessions_state_active`),
and a single enforcement path covering operator `POST /api/calls/create`
and visitor `POST /api/widget/calls/request` through the canonical
resolver chain. Activation cannot ship in this pass because the
existing widget enforcement uses a strictly narrower counting model;
unifying it is a backward-compatibility-sensitive change that needs
its own isolated phase. No capability key was added, no resolver was
added, no plan default changed, no route, middleware, env var, or
schema changed. Full audit and locked rule live in
`docs/CALL_NUMERIC_LIMITS.md`.

---

## June 2026 — Widget Concurrency Counting-Model Migration (Defer)

Scope: migrate widget `POST /api/widget/calls/create` concurrency
check to the canonical active-session counting model.

**Outcome: no runtime change.** The live widget check counts only
`entry_source = 'call_widget'` sessions in states
`active|ringing|connecting` and compares against the **widget
knob** (`platform_call_center_settings.max_concurrent_calls_per_workspace`),
not the plan key `max_concurrent_calls`. Widening that query to the
canonical model (all entry sources, plus `pending`) would silently
tighten live tenants and re-scope the widget knob's documented
semantics.

Locked migration policy: **dual-knob, additive**. Keep the
widget-scoped query unchanged; add a second canonical
`countActiveCallSessions(workspace_id)` check gated by the plan
key, applied at both `POST /api/calls/create` and
`POST /api/widget/calls/create`. Precedence
`effective = min(plan, platform)` operates only on the canonical
count.

Full audit, behavioral delta, and unblock checklist in
`docs/CALL_NUMERIC_LIMITS.md` — "June 2026 — Widget Concurrency
Counting-Model Migration Pass".

Next phase: "`max_concurrent_calls` Dual-Knob Activation".

---

### June 2026 — `max_concurrent_calls` Dual-Knob Activation (LIVE)

`max_concurrent_calls` is now a live, workspace-wide plan-level
ceiling, enforced additively alongside the existing widget-scoped
platform-admin knob.

- Registry: `max_concurrent_calls` (limit, unit `count`, default
  `-1` = unlimited, plan-configurable, workspace-overridable).
- Resolver: canonical derived count over `call_sessions`
  (state ∈ {pending, ringing, connecting, active}, all
  `entry_source` values).
- Helper: `checkPlanConcurrencyCeiling` →
  `server/services/calls/concurrencyLimit.ts`.
- Enforcement: `POST /api/calls/create` (operator) +
  `POST /api/widget/calls/request` (visitor). Both routes also
  preserve the widget knob behavior unchanged at its existing
  boundary.
- Activation migration backfills `-1` on every existing plan.

Deferred (unchanged): `max_call_minutes_per_month`,
`recording_retention_days`.

---

### June 2026 — `max_call_minutes_per_month` Audit (no rollout)

Strict single-limit audit. Outcome: **honest defer, no runtime
change**. Five concurrent real blockers (see
`docs/CALL_NUMERIC_LIMITS.md` — "June 2026 —
`max_call_minutes_per_month` Billable-Minute Policy + Monthly
Aggregation Audit"):

1. No `call_minutes_used` column on `workspace_usage_counters`.
2. No settle-time monthly counter writer in `endSession.ts`.
3. `call_sessions.duration_seconds` conflates non-connected time
   (anchor fallback to `started_at`/`created_at`).
4. `connected_at` writer coverage across every accept path is
   not yet proven uniform.
5. Create-time deny vs settle-time finality is a stated product
   trade-off not yet locked at the product layer.

Locked for the future activation pass: billable-minute policy
(connected-only, `ceil((ended_at − connected_at)/60)`, UTC
calendar month), canonical aggregation model (single
`workspace_usage_counters.call_minutes_used` column with one
SOLE producer), enforcement boundary (`POST /api/calls/create`
+ `POST /api/widget/calls/request`, plan-level only, first
denial wins).

`recording_retention_days` remains deferred, blocked on missing
recording-janitor architecture (unchanged, out of scope).

---

## June 2026 — `max_call_minutes_per_month` foundation pass

Foundation landed; activation deferred.

- New monthly counter `workspace_usage_counters.call_minutes_used` (integer, default 0).
- Sole writer: DB trigger `tg_call_sessions_bill_minutes` on `call_sessions UPDATE OF state` — only fires `OLD.state != 'ended' → NEW.state = 'ended'`, skips when `connected_at` or `ended_at` is null, adds `CEIL((ended_at − connected_at) / 60)` minutes to the UTC-month bucket. End-path-agnostic — covers `endCallSession`, `livekitWebhook room_finished`, and `callWidget cancel-after-connect` without touching their code.
- Canonical read-side helper: `server/services/calls/billableMinutes.ts → computeBillable(row)` (mirrors the SQL exactly; used by tests).
- Resolver registered in `usageResolvers.ts`; capability registered in `capabilityRegistry.ts` with `unit: 'minutes'`, default `-1` (unlimited). Added to `USAGE_BACKED_LIMIT_KEYS`.
- Tests: `src/test/billing/billableCallMinutes.test.ts` (7 cases — non-ended, never-connected, normal CEIL, zero-duration, 1-second→1-minute, UTC month boundary, single-writer lint).
- **No** create-time enforcement gate was added. See `docs/CALL_NUMERIC_LIMITS.md` for the explicit list of remaining activation blockers (chief one: `connected_at` is only written by the operator accept route).
- `recording_retention_days` remains deferred.

---

## Phase Update — max_call_minutes_per_month: FINAL ACTIVATION (live)

**Status:** LIVE. Enforced at create-time.

**connected_at coverage audit (complete):**
- Producers that transition `call_sessions` into a billable lifecycle state:
  1. `server/routes/callCenter.ts` operator accept — writes `connected_at` idempotently (already correct).
  2. `server/routes/livekitWebhook.ts` `room_started` — NOW backfills `connected_at` when missing (this phase).
  3. No other writer sets `state='active'` on `call_sessions`.
- Result: every path that can produce a billable call now guarantees `connected_at`.

**connected_at write policy (locked):**
- Preferred early writer: operator accept route.
- Backfill writer: `livekitWebhook` `room_started`, only when `connected_at IS NULL` (never overwrites).
- Never written by `endSession` / `room_finished` / hangup paths — a call that never connected stays non-billable, by design.
- Trigger `tg_call_sessions_bill_minutes` remains the sole monthly-usage writer.

**Enforcement boundaries (only these two):**
- `POST /api/calls/create` (operator) — `checkPlanMonthlyMinutesCeiling` after concurrency check, before provider/DB insert.
- `POST /api/widget/calls/request` (visitor) — same helper, same ordering relative to the widget knob + plan concurrency.
- No other route gained a minutes gate. Queue/invite/accept paths are intentionally out of scope (continuity over deny-mid-flight).

**Denial contract:**
```
HTTP 429 { error: 'plan_limit_reached', capability: 'max_call_minutes_per_month', limit, used, plan, upgrade_required: true }
HTTP 403 { error: 'plan_forbidden',     capability: 'max_call_minutes_per_month', plan, upgrade_required: true }
HTTP 403 { error: 'usage_unavailable',  capability: 'max_call_minutes_per_month', ... }   // fail-closed
```

**Near-threshold behavior:** gate is `used >= limit` at create time. In-flight calls that settle after their own create-gate may push the total slightly past the cap; the next create attempt is then denied. No mid-call termination.

**Backward compatibility:**
- Plans backfilled to `max_call_minutes_per_month = -1` (unlimited) in the foundation migration — no existing tenant is silently denied.
- `connected_at` backfill in `room_started` is additive and idempotent; pre-existing rows with `connected_at` already set are untouched.

**Still deferred:** `recording_retention_days` (requires janitor/retention architecture; not in scope).

---

## Phase Update — recording_retention_days: LIVE

**Status:** LIVE. Sole enforcement path:
`server/services/recordings/retentionJanitor.ts`.

**Architecture (see docs/CALL_RECORDING_RETENTION.md for full detail):**
- Registry: `recording_retention_days` (limit, days, defaultValue `-1`, workspaceOverridable).
- Resolver: `resolveEffectiveRecordingRetentionDays` — workspace/plan override → `check_workspace_entitlement` → control-plane `retention_default_days` (30) → fallback 30.
- Stamper: `retention_expires_at = created_at + effective_days` written once on insert in `livekitWebhook.ts:egress_started`. `-1` → NULL (never expires).
- Janitor: 30-minute in-process sweep, batch 100, uses `idx_call_recordings_retention`. Storage object deleted first via `deleteFile(workspace_id, storage_path)`; row deleted only on success (or "not found"). `legal_hold = true` rows are never selected.

**Backward-compat safeguards:**
- Existing rows have `retention_expires_at = NULL` → janitor never touches them.
- Registry default `-1` means plans without the key keep retaining recordings indefinitely.
- Per-row retention is locked at creation; later plan changes do NOT re-stamp.

**Remaining backlog after this pass:** none for the numeric call-limit track. `recording_retention_days` was the last item.

---

## Phase Update — Recording Retention Operability (Legal Hold + Admin Visibility)

Narrow read + legal-hold-toggle surface added under super-admin
auth at `/api/admin/calls/recordings` (list) and
`/api/admin/calls/recordings/:id/legal-hold` (toggle). Janitor is
unchanged; `recording_retention_days` semantics are unchanged;
legacy rows (`retention_expires_at IS NULL`) remain untouched and
are labelled `legacy_unmanaged`. No backfill, no bulk actions, no
second deletion path. See `docs/CALL_RECORDING_RETENTION.md` for
the full status taxonomy.

## Phase Update — Recording Retention Admin UI

Frontend operability pass over the existing super-admin contract.
No new backend endpoints, no schema changes, no janitor changes.

- Home: **Admin → Voice & Video Center → Recordings tab**
  (`src/pages/admin/VoiceVideoPage.tsx`).
- Panel: `src/components/admin/calls/RecordingRetentionPanel.tsx`
  (paginated list, workspace + status filters, per-row legal-hold
  toggle with optional reason).
- API client: `fetchAdminRecordings` /
  `setAdminRecordingLegalHold` in `src/lib/admin-calls-api.ts`.
- Tests: `src/test/admin/recordingRetentionPanel.test.tsx`
  (status rendering for all four statuses, legal-hold endpoint
  contract, error/loading states, guardrail against any
  delete/backfill control).

Architectural guardrails enforced by the UI:
- No delete / purge controls (janitor is the sole deletion path).
- No editing of `retention_expires_at`.
- No bulk actions.
- No legacy backfill — `legacy_unmanaged` rows are shown as such.
- Super-admin scoped via the existing `adminRouter` middleware;
  no operator-side surface in this phase.

### Recording artifact access (super-admin, read-only)
- New route: `GET /api/admin/calls/recordings/:id/file` (super-admin scoped, proxied via canonical `downloadFile`).
- UI: per-row Open / Save buttons in the existing Recordings tab of Voice & Video Center.
- Read-only — janitor remains the sole deletion path. No new retention semantics.

### Recording inline playback (super-admin, read-only preview)
- UI-only pass on top of the existing artifact proxy — no new backend route.
- Per-row **Preview** toggle in the Recordings tab renders an inline
  `<audio>` or `<video>` element bound to a transient
  `URL.createObjectURL` from the proxied blob.
- Player kind is chosen from the proxy `Content-Type`; unknown types
  degrade to an explicit unsupported-preview state with Open/Save intact.
- Object URLs are revoked on collapse and unmount; no prefetch.
- Read-only — janitor remains the sole deletion path; no retention
  semantics, route, env, schema, or capability key changed.

### Recording ranged artifact access (super-admin, read-only streaming)
- Backend-only optimization on the existing artifact proxy.
- `GET /api/admin/calls/recordings/:id/file` now honors `Range:
  bytes=START-END`, returning `206 Partial Content` with
  `Content-Range` when the provider supports it, and always
  advertises `Accept-Ranges: bytes`. Requests without `Range` still
  return the full `200 OK` body (fully backward compatible).
- New storage helper `downloadFileRange` forwards `Range` to
  S3-family and Bunny providers and performs a true sliced read for
  the `local` provider. Provider abstraction remains canonical; no
  provider URLs or credentials are exposed.
- Unsatisfiable ranges return `416` with `Content-Range: */TOTAL`.
  Providers that ignore `Range` fall back to a normal `200 OK`.
- Frontend unchanged: the Recordings panel still uses the authed
  Blob + `URL.createObjectURL` path because authenticated
  `<video src>` would require a separate short-lived-token surface
  (deferred).
- Read-only — no route/env/schema/capability rename; janitor remains
  the sole deletion path.

### Recording tokenized native playback (super-admin, short-lived URL)
- Two narrow surfaces added; no rename/relocation of existing routes,
  env, schema, or capability keys.
  - `POST /api/admin/calls/recordings/:id/playback-token` (bearer-
    protected, super-admin) → mints a stateless HMAC-SHA256 grant
    bound to one recording id + disposition with default 5-minute TTL
    (hard cap 15 min). Returns `{ url, token, expires_at, ttl_seconds }`.
  - `GET /api/calls/recording-playback/:id?token=…&disposition=…`
    (token-validated, not under `/api/admin`) → validates the token
    and proxies bytes through `downloadFileRange`. Range / 206 /
    Accept-Ranges preserved end-to-end so native `<audio>` /
    `<video>` can issue Range requests directly.
- Signing key derives from the server-only service-role secret via
  domain-separated HMAC; never reaches the browser.
- Frontend `InlinePreview` now prefers the tokenized URL when the row
  metadata identifies audio vs video unambiguously; otherwise it falls
  back to the existing authenticated Blob + object-URL path.
- Open / Save remain on the bearer-protected Blob path — unchanged.
- Read-only: no writes to `call_recordings`, no edits to
  `retention_expires_at`, no deletes. Janitor remains the sole
  deletion path. Inline-only tokens cannot be escalated to forced
  downloads.

### Recording bulk legal-hold (super-admin)
- One narrow bulk surface added; no rename/relocation of any existing
  route, env, schema, or capability key.
  - `POST /api/admin/calls/recordings/legal-hold/bulk` — body
    `{ ids: string[] (1..200, uuid), enabled: boolean, reason?: string }`.
- `enabled` is a deterministic SET (not a per-row toggle): every
  supplied id ends in that state regardless of prior value, which is
  the only safe behaviour for mixed-state selections.
- Missing ids are reported per-id under `failures` (status `not_found`);
  the call still returns 200 with the actually-updated `succeeded` ids.
- Writes one `audit_logs` row per succeeded id, reusing the same action
  keys as the per-row endpoint (`bulk: true` in `new_value`).
- Frontend: Recordings tab grew row-level checkboxes, a
  "select all visible" checkbox, and a bulk action bar with
  **Set legal hold ON** / **Set legal hold OFF** / **Clear**.
  Selections are page-scoped — changing filter/page drops out-of-view
  ids so the bar never appears to "remember" hidden rows.
- Read-only with respect to retention: no deletes, no
  `retention_expires_at` edits, no backfill of `legacy_unmanaged`
  rows. Janitor remains the sole deletion path.
- Still deferred after this pass: bulk delete / bulk retention edits
  (intentionally absent), per-recording retention overrides,
  operator-side visibility, waveform/timeline UI, optional legacy
  backfill UI.

## Recording per-row retention override (super-admin)

- New backend route
  `POST /api/admin/calls/recordings/:id/retention-override` mutates
  only `retention_expires_at` and `retention_policy` on a single row.
  Modes: `exact` (ISO), `days_from_now` (0..3650), `unlimited`
  (NULL expiry → janitor never selects). Stamps the policy as
  `override:exact` / `override:Nd` / `override:unlimited`.
- `legal_hold` is never touched by this route. Legal hold continues
  to win over expiry — an expired override on a held row is still
  not deleted until the hold is released.
- Legacy/unmanaged rows are only modified through an explicit per-row
  override; there is no implicit backfill.
- Clearing an override is intentionally not supported in this pass
  (no preserved original plan-stamp). Operators set a new explicit
  value instead.
- One `audit_logs` row per call with action
  `call_recording.retention.override`.
- Frontend: per-row "Override" button in the Expires cell opens a
  small dialog; rows with a non-plan policy show an "Overridden (…)"
  tag inline.
- Janitor is unchanged: still the sole deletion path, still reading
  the same two fields.
- Still deferred after this pass: bulk retention edits / bulk delete,
  clear-override / restore-to-inherited, optional legacy backfill UI,
  operator-side visibility, waveform/timeline UI.
