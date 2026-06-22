# Call-Side Numeric Limits — Feasibility Audit

_Last updated: June 2026._

This document records the strict feasibility audit for the three
remaining numeric call-side limits in the backlog. It is the canonical
reference for why none of them were activated in the "Numeric Call
Limits Feasibility + First Activation" pass.

Scope is exactly:

- `max_concurrent_calls`
- `max_call_minutes_per_month`
- `recording_retention_days`

No other call backlog items are in scope here. Non-numeric call
surfaces have already been route-audited under the locked
deny-on-create / allow-on-continuity policy and are documented in
`docs/CALL_ENTITLEMENT_COMPOSITION.md`.

## Outcome

**No safe activation.** All three limits remain deferred. Each one is
blocked on at least one independent, clearly-identified prerequisite
listed below. No file under `server/services/billing/` (capability
registry, usage resolvers, plan defaults), no enforcement middleware,
and no call route was changed by this pass.

## Per-limit classification

### 1. `max_concurrent_calls`

- **Classification:** NEEDS PRODUCT POLICY.
- **Semantics (proposed):** maximum simultaneously-active
  `call_sessions` rows per workspace, where "active" matches the
  canonical partial index
  `idx_call_sessions_state_active (workspace_id, state)
  WHERE state IN ('pending','ringing','connecting','active')`
  defined in
  `supabase/migrations/20260422123023_*.sql`.
- **Source of truth for current state:** `public.call_sessions.state`.
  The partial index above makes an exact `count(*)` cheap and
  deterministic.
- **Counting model:** would be a `derived_count` resolver against
  `call_sessions` filtered by `workspace_id` and the four active
  states. No new counter column required.
- **Enforcement boundary:** create-time, at the canonical operator
  call-creation route `POST /api/calls/create`
  (`server/routes/calls.ts`). The visitor widget request handler
  (`POST /api/widget/calls/request` in `server/routes/callWidget.ts`)
  is the second creation boundary.
- **Blocker — why not activated:** the capability registry
  (`server/services/billing/capabilityRegistry.ts`) does **not**
  currently expose `max_concurrent_calls` as a `type: 'limit'` plan
  key. A different, orthogonal knob already exists:
  `platform_call_center_settings.max_concurrent_calls_per_workspace`
  (a **platform-admin** setting, not a plan entitlement). The visitor
  widget already enforces this admin knob at row-creation time
  (`server/routes/callWidget.ts`, "Concurrency / queue limit").
  Introducing a plan-level `max_concurrent_calls` without first
  reconciling semantics with the existing admin knob would create two
  concurrency limits competing on the same boundary, with no documented
  precedence rule. That is a product-policy decision (precedence,
  override direction, registry naming) — not a wiring task — and is
  out of scope for a strict counter/resolver pass.
- **Unblocker:** product decision on whether plan limit overrides,
  is overridden by, or composes with the platform-admin knob; then a
  single registry key, a `derived_count` resolver, and a
  `requireLimit` consumer at `POST /api/calls/create`.

### 2. `max_call_minutes_per_month`

- **Classification:** NEEDS COUNTER / RESOLVER WORK.
- **Semantics (proposed):** sum of billable call duration in minutes
  per workspace per calendar month.
- **Source of truth for current state:** `call_sessions.duration_seconds`
  is written by `endSession.ts` when a call transitions to `ended`.
  No monthly aggregate exists.
- **Counting model required:** either (a) a new column on
  `workspace_usage_counters` (e.g. `call_minutes_used`) populated by a
  **settle-time** hook inside `endSession.ts`, or (b) a derived
  `sum(duration_seconds) / 60` query against `call_sessions` filtered
  by `workspace_id` and the current UTC calendar month. Option (b) is
  not safe at expected cardinality without an added index and an
  explicit "what counts as billable" rule (e.g. should rejected /
  cancelled / zero-duration rows be excluded?).
- **Enforcement boundary:** create-time at `POST /api/calls/create`
  is the only deny-on-create boundary; settle-time accounting in
  `endSession.ts` is required so the create-time check has a value
  to compare against.
- **Blocker — why not activated:** there is no settle-time consumer
  writing minutes into `workspace_usage_counters` and no resolver for
  `max_call_minutes_per_month` in `server/services/billing/
  usageResolvers.ts`. The capability registry also does not expose
  the key. Implementing this without a settle-time hook would silently
  produce zero usage forever and effectively disable the limit — the
  exact "fake counter" failure mode this phase forbids.
- **Unblocker:** add a counter column + settle-time write in
  `endSession.ts`, define the billable-duration rule explicitly,
  then add a registry key, resolver, and create-time `requireLimit`.

### 3. `recording_retention_days`

- **Classification:** NEEDS RETENTION / JANITOR ARCHITECTURE.
- **Semantics (proposed):** maximum age, in days, of a row in
  `public.call_recordings` (and its underlying storage object) before
  it must be deleted.
- **Source of truth for current state:** `call_recordings.created_at`
  (or equivalent finalized-at timestamp); the table exists and is
  written by `server/routes/livekitWebhook.ts`.
- **Enforcement mechanism required:** a scheduled janitor analogous
  to `server/services/attachmentJanitor.ts`, which would (a) select
  recordings older than the workspace's resolved retention window,
  (b) delete the underlying storage object via the configured storage
  provider, and (c) delete (or tombstone) the `call_recordings` row.
- **Blocker — why not activated:** no such janitor exists. The only
  retention-style worker in `server/services/` is `attachmentJanitor.ts`,
  which is scoped to conversation attachments. A retention limit is
  not a usage-vs-limit gate — it has no create-time meaning — so it
  cannot be activated by wiring `requireLimit`. Activating it without
  a janitor would be a display-only metadata field, which this phase
  explicitly forbids ("conflate retention policy with usage counting
  unless repo truth supports it").
- **Unblocker:** implement a `callRecordingsJanitor.ts` worker
  modeled after `attachmentJanitor.ts`, plumb the per-workspace
  retention window through the canonical resolver chain, and only
  then expose `recording_retention_days` as a registry key.

## Why this is not a partial activation

The phase rules forbid partially advancing all three limits.
`max_concurrent_calls` is the closest to ready (the counting model is
exact and the boundary is canonical), but it is blocked on a real
product-policy reconciliation with the existing platform-admin
`max_concurrent_calls_per_workspace` knob. Shipping a registry key
without that reconciliation would create two competing limits on the
same boundary — a regression risk strictly larger than continuing to
defer.

## Next most logical phase

Resolve the `max_concurrent_calls` product-policy question first:

1. Decide precedence between plan-level `max_concurrent_calls` and
   platform-admin `max_concurrent_calls_per_workspace` (likely:
   `min(plan_limit, admin_limit)`, with `-1` meaning unlimited).
2. Add the registry key and plan defaults.
3. Add a `derived_count` resolver against the active-state partial
   index.
4. Wire `requireLimit` at `POST /api/calls/create` and reconcile the
   existing visitor-widget check to consume the same composed value.

Until that product-policy step is done, this entire backlog stays
deferred.

## Hard non-changes in this pass

- No capability key was added, removed, or renamed.
- No plan defaults changed.
- No call route, middleware, env var, or schema changed.
- No counter column added.
- No resolver added.
- No test added (runtime behavior unchanged — Part F of the phase
  spec).

This document is the only artifact of this pass besides short
append-only notes in `docs/CALL_ENTITLEMENT_COMPOSITION.md`,
`docs/ENFORCEMENT_COVERAGE_AUDIT.md`, and
`docs/PLANS_SYSTEM_HANDOFF.md`.

---

## June 2026 (follow-up) — `max_concurrent_calls` Precedence Resolution Pass

Strict single-key follow-up to determine whether the precedence
conflict identified above could be resolved cleanly enough to
activate `max_concurrent_calls` end-to-end.

### Precedence audit findings

**Existing enforcement (the only concurrency check live today)** lives
at `server/routes/callWidget.ts` L863–869, inside the visitor widget
`POST /api/widget/calls/request` handler:

```ts
const [{ count: active }, { count: queued }] = await Promise.all([
  sb.from('call_sessions').select('id', { count: 'exact', head: true })
    .eq('workspace_id', ws.workspace_id)
    .eq('entry_source', 'call_widget')
    .in('state', ['active', 'ringing', 'connecting']),
  ...
]);
if ((active || 0) >= effective.max_concurrent_calls)
  return res.status(429).json({ error: 'limit_reached', kind: 'concurrent' });
```

`effective.max_concurrent_calls` comes from
`computeEffectiveCallCenterCaps` in
`server/services/callCenter/settings.ts` and is simply
`platform.max_concurrent_calls_per_workspace` — a **super-admin
global ceiling** applied uniformly to every workspace. It is NOT a
plan/workspace entitlement; it cannot vary per plan or per workspace.

**Counting model used by the existing check:**

- scoped by `entry_source = 'call_widget'` (operator-initiated and
  invitation-initiated `call_sessions` are excluded);
- state set `('active','ringing','connecting')` (excludes
  `'pending'`).

**Canonical active-call definition** (per
`supabase/migrations/20260422123023_*.sql`,
`idx_call_sessions_state_active`) is broader:

- all `entry_source` values;
- state set `('pending','ringing','connecting','active')`.

### The real conflict is not precedence, it is semantics

A pure precedence rule like
`effective = min(plan_limit, platform_admin_limit)` (with `-1` =
unlimited, `null` = absent → skipped) is **easy to write** and
would behave intuitively for super-admins. That is not the blocker.

The blocker is that the two limits, if both live, do not count the
same thing:

| Aspect | Existing platform-admin enforcement | Canonical plan-style enforcement |
|---|---|---|
| Scope | `entry_source = 'call_widget'` only | All entry sources (operator, invitation, widget) |
| States counted | `active`, `ringing`, `connecting` | `pending`, `ringing`, `connecting`, `active` |
| Boundary covered | `POST /api/widget/calls/request` | `POST /api/calls/create` (operator) + visitor widget |
| Source of truth | `platform_call_center_settings` | `billing_plans` + `workspace_limit_overrides` |

Resolving this requires choosing one of:

1. **Widen the existing widget check** to the canonical scope/state
   set so plan and admin share one counting model.
   → Silently changes shipped runtime behavior of the existing
   super-admin knob: workspaces that today sit under the limit with
   pending or operator-initiated calls would suddenly count those
   rows and could hit the cap mid-day. This is a backward-incompatible
   semantic change to a live admin-facing knob and out of scope for a
   single-key activation pass.
2. **Activate plan-level `max_concurrent_calls` with the canonical
   counting model** at `POST /api/calls/create` and leave the widget
   check as-is.
   → Leaves two competing effective concurrency rules behind that can
   disagree silently (one workspace can be denied by the plan ceiling
   on operator create while still being well under the admin widget
   ceiling, or vice versa). Explicitly forbidden by Part D of the
   phase spec ("there is not more than one competing effective
   concurrency rule left behind").
3. **Activate plan-level `max_concurrent_calls` and rewrite the widget
   check to consume the same composed value with the canonical
   counting model.**
   → Equivalent to (1) for runtime behavior; same backward-
   compatibility risk, plus a broader code change than this strict
   single-key pass allows.

There is no fourth option that satisfies both "single counting model"
(Part C) and "single enforcement path" (Part D) without changing
already-shipped admin behavior.

### Precedence policy (locked, pending unblock)

When the activation eventually happens, the locked rule is:

- **Effective concurrency ceiling** =
  `min(plan.max_concurrent_calls, platform.max_concurrent_calls_per_workspace)`,
  treating `-1` and `null` as "no contribution to the min".
- **If both are unlimited:** no enforcement.
- **Platform-admin knob retains hard-ceiling semantics:** plan
  entitlements can never raise concurrency above the super-admin's
  global cap.
- **Counting model:** canonical active-state set
  `('pending','ringing','connecting','active')` over all
  `entry_source` values, via a live `count: 'exact'` query backed by
  `idx_call_sessions_state_active`.
- **Single enforcement path:** `POST /api/calls/create` (operator)
  AND `POST /api/widget/calls/request` (visitor) MUST both consume
  the same composed value through the canonical resolver / middleware
  chain — no inline ad-hoc checks left behind.

This rule is recorded here so a future pass does not have to re-derive
it. It does NOT take effect in this pass.

### Decision: no rollout

Activating now requires either (a) silently widening the existing
widget enforcement to the canonical counting model, or (b) leaving
two competing concurrency rules behind. Both violate the phase's
strict rules. The honest result is to defer until a dedicated phase
can perform the backward-compatibility-safe widget rewrite as its
primary, isolated change.

### Files changed by this pass

- this section appended to `docs/CALL_NUMERIC_LIMITS.md`;
- short append-only notes in
  `docs/CALL_ENTITLEMENT_COMPOSITION.md`,
  `docs/ENFORCEMENT_COVERAGE_AUDIT.md`,
  `docs/PLANS_SYSTEM_HANDOFF.md`.

No file under `server/`, `src/`, or `supabase/` was touched. The
capability registry, usage resolvers, plan defaults, all call routes,
middleware contracts, env vars, and schema remain unchanged. The
already-live platform-admin widget concurrency check continues to
behave exactly as before.

### Sharpened blocker (replaces the prior "NEEDS PRODUCT POLICY"
blocker for this limit)

The remaining blocker for `max_concurrent_calls` is now precisely:

> The existing platform-admin enforcement at
> `server/routes/callWidget.ts` counts a strictly narrower set of
> rows (widget-only entry source, no `pending` state) than the
> canonical `idx_call_sessions_state_active` definition. Activating a
> plan-level limit requires first migrating that widget check to the
> canonical counting model in a dedicated backward-compatibility-safe
> phase; the precedence rule (`min(plan, admin)` with `-1`/`null`
> ignored) is already locked above and is not itself the blocker.

`max_call_minutes_per_month` and `recording_retention_days` remain
deferred for the unchanged reasons documented earlier in this file
(no settle-time counter; no retention janitor).
---

## June 2026 — Widget Concurrency Counting-Model Migration Pass

**Scope:** evaluate whether `POST /api/widget/calls/create` can be
migrated from its current widget-scoped concurrency count to the
canonical active-session counting model used by the future
`max_concurrent_calls` plan enforcement.

### A. Widget concurrency audit

- **Route:** `POST /api/widget/calls/create` in
  `server/routes/callWidget.ts` (concurrency check at line 869).
- **Limit source:** `effective.max_concurrent_calls` from
  `computeEffectiveCallCenterCaps(platform, ws)` — i.e. the
  workspace/platform **call-center settings** knob, *not* the plan
  capability key `max_concurrent_calls`.
- **Counting query (today):**
  ```ts
  sb.from('call_sessions')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', ws.workspace_id)
    .eq('entry_source', 'call_widget')
    .in('state', ['active', 'ringing', 'connecting']);
  ```
- **States counted today:** `active`, `ringing`, `connecting`.
  Excludes `pending`.
- **Entry sources counted today:** only `call_widget`.
  Excludes operator-initiated, invitation-initiated, callback-initiated,
  and call-center-initiated sessions.
- **Canonical active-call model** (target):
  `state IN ('pending','ringing','connecting','active')` across
  **all** `entry_source` values, backed by
  `idx_call_sessions_state_active`.

### Behavioral delta if widened immediately

1. **`pending` inclusion** — silently tightens the live limit by ~1
   for every in-flight create (race window between insert and
   transition to `ringing`). Tenants at the current cap would start
   hitting `429 limit_reached` on otherwise-valid first calls.
2. **Cross-entry-source inclusion** — operator-dialed, invitation,
   and callback calls would begin consuming the **widget** budget.
   The widget knob's documented semantics are "max simultaneous
   *widget* calls", so this is a semantic change, not just a count
   change. Workspaces with active operator-side traffic would see
   widget rejection rates rise with no migration notice.

### B. Backward-compatibility policy locked

- The widget knob (`platform_call_center_settings.max_concurrent_calls_per_workspace`
  / workspace override) and the future plan key
  `max_concurrent_calls` are **two different products**:
  - widget knob = "how many simultaneous **widget-originated** calls"
  - plan key = "how many simultaneous **workspace-wide** active calls"
- Silently merging them by widening the widget count violates the
  locked deny-on-create / allow-on-continuity policy and would
  retroactively tighten live tenants without a policy decision.
- Acceptable migration paths (none applied this pass):
  1. **Dual-knob model.** Keep widget-scoped count for the widget
     knob; introduce a **separate** workspace-wide count for the
     plan key. Both checks run; first denial wins. This is the
     least risky path but requires a second count query and a
     dedicated capability activation phase.
  2. **Rename + re-scope.** Reinterpret the widget knob as the
     workspace-wide cap, document the breaking change, ship a
     migration note, and only then widen the count. Requires
     product sign-off and a release-note plan.

### C. Outcome — HONEST DEFER (Path B from spec)

**No runtime change applied.** The mismatch is real and the
correct migration path is Option 1 (dual-knob), not in-place
widening of the existing query. Activating that requires:

- a new counting helper `countActiveCallSessions(workspace_id)`
  that queries `call_sessions` with the canonical state set across
  all entry sources (uses `idx_call_sessions_state_active`);
- a new check at `POST /api/calls/create` and
  `POST /api/widget/calls/create` that runs **in addition to** the
  existing widget-scoped check, gated on plan
  `max_concurrent_calls` (with `-1`/`null` = unlimited);
- preserving the existing widget-scoped query unchanged so the
  widget knob keeps its documented meaning.

### Remaining blockers before final `max_concurrent_calls` activation

1. Implement `countActiveCallSessions` helper (canonical counting).
2. Wire it as a **second, additive** check at the two create
   boundaries — never replacing the widget-scoped query.
3. Apply the locked precedence rule
   `effective = min(plan, platform)` only over the **canonical**
   count, not the widget-scoped count.
4. Tests proving: (a) widget-scoped denial still fires at the
   existing boundary; (b) canonical denial fires independently
   when plan cap is lower; (c) `-1`/`null` on either side does
   not contribute to the `min`.

### Next phase after this one

"`max_concurrent_calls` Dual-Knob Activation" — implement the
canonical counting helper and add the second additive check at
both create boundaries, leaving the widget knob's semantics
intact.

---

## June 2026 — `max_concurrent_calls` Dual-Knob Activation (LIVE)

**Status:** `max_concurrent_calls` is now a live plan-level limit
enforced at both call-creation boundaries via a separate, additive
ceiling. The widget-scoped platform-admin knob keeps its prior
meaning unchanged.

### Dual-knob policy (LOCKED, NOW LIVE)

| Knob | Source of truth | Scope | Counting model | Enforced at | Denial shape |
|---|---|---|---|---|---|
| Widget platform knob | `platform_call_center_settings.max_concurrent_calls_per_workspace` (admin) | **Widget-only** (`entry_source = 'call_widget'`) | `state IN ('active','ringing','connecting')` (excludes `pending`) | `POST /api/widget/calls/request` only | `429 { error: 'limit_reached', kind: 'concurrent' }` (unchanged) |
| Plan key | `billing_plans.limits.max_concurrent_calls` + `workspace_limit_overrides` | **Workspace-wide** (all `entry_source` values) | `state IN ('pending','ringing','connecting','active')` via `idx_call_sessions_state_active` | `POST /api/calls/create` (operator) AND `POST /api/widget/calls/request` (visitor) | `429 { error: 'plan_limit_reached', capability: 'max_concurrent_calls', limit, used, plan, upgrade_required: true }` (at-or-over) / `403 { error: 'plan_forbidden', … }` (key missing on plan) |

**Independence:** the two knobs are intentionally NOT composed via
`min(plan, admin)`. They count different row sets and exist for
different reasons. Both checks run independently at the create
boundary; **first denial wins**. Order of checks at the visitor
widget boundary: existing widget knob first (preserves shipped
behavior), then plan ceiling.

### Enforcement boundaries (live)

- **`POST /api/calls/create`** (operator) — `server/routes/calls.ts`:
  plan ceiling check via `checkPlanConcurrencyCeiling(config, ws)`
  runs AFTER the call-type composer gate and BEFORE any provider
  resolution / row insert. No widget-knob check here (this route
  is not widget-scoped).
- **`POST /api/widget/calls/request`** (visitor) — `server/routes/callWidget.ts`:
  existing widget-knob check at L869 retained as-is; new plan
  ceiling check added immediately after, also pre-insert. Both
  ceilings can deny; first denial wins.

### Canonical counting model (plan key only)

Defined in `server/services/billing/usageResolvers.ts`:
`resolveMaxConcurrentCalls`. Single live `count: 'exact'` query
against `public.call_sessions` filtered by `workspace_id` and the
four canonical active states, no `entry_source` filter. Backed by
`idx_call_sessions_state_active`. Period kind = `lifetime` (this is
occupancy, not a monthly throughput).

The widget-scoped count in `callWidget.ts` is UNCHANGED.
There are now exactly TWO concurrency count queries in the system,
each scoped to its own knob, each documented above.

### Capability registry & seed

- `max_concurrent_calls` added to `CAPABILITY_REGISTRY` in
  `server/services/billing/capabilityRegistry.ts`
  (`type: 'limit'`, `group: 'calls'`, `defaultValue: -1`,
  `planConfigurable: true`, `workspaceOverridable: true`,
  `unit: 'count'`). Also added to `USAGE_BACKED_LIMIT_KEYS` so the
  plan-create normalizer fills the key on new plans.
- Activation migration `20260622-* — max_concurrent_calls dual-knob`
  backfills every existing `billing_plans.limits` row with
  `max_concurrent_calls = -1` (unlimited) where absent. This
  preserves current behavior; without this seed
  `check_workspace_entitlement('max_concurrent_calls')` would
  return `feature_not_in_plan` and silently deny every call.

### Denial contract (live)

- Widget knob denial: `429 { error: 'limit_reached', kind: 'concurrent' }`
  — **unchanged**, distinguishable by `kind`.
- Plan ceiling denial (over limit): `429 { error: 'plan_limit_reached',
  capability: 'max_concurrent_calls', limit, used, plan,
  upgrade_required: true }`.
- Plan ceiling denial (plan missing key — should not happen post-seed):
  `403 { error: 'plan_forbidden', capability: 'max_concurrent_calls', … }`.
- Plan ceiling denial (count failed): `403 { error: 'usage_unavailable',
  capability: 'max_concurrent_calls', … }` — fail-closed.
- Both fired in the same request: the first ceiling to deny wins
  (widget knob is checked first at the visitor widget boundary, so
  its `limit_reached` shape takes precedence there).

### Backward-compatibility safeguards

- Widget knob query, source-of-truth, and denial shape UNCHANGED.
- Existing tenants get `max_concurrent_calls = -1` (unlimited) by
  the activation migration → no observable behavior change on
  upgrade.
- No call capability key renamed; no route, env var, schema, or
  middleware contract renamed; no call lifecycle branch (accept /
  reject / hangup / end / token / state / recording-stop) gated
  (deny-on-create / allow-on-continuity preserved).
- `-1` and any negative limit are treated as unlimited (registry
  convention).

### Validation performed

- New focused test
  `src/test/billing/maxConcurrentCallsDualKnob.test.ts`:
  - resolver returns canonical count; under-limit allows;
    at-limit denies with `plan_limit_reached`; unlimited (-1)
    short-circuits; missing key → `plan_forbidden`; count
    failure → fail-closed `usage_unavailable`;
  - denial body shape distinct from widget-knob shape.
- Existing `operatorCallCreateGating.test.ts` mocks
  `loadEffectiveCallEntitlements` only; the new helper is not on
  its mock graph, so its assertions about `plan_forbidden` from
  the composer remain valid.
- Existing test suites that asserted the widget-knob denial shape
  continue to pass — the widget-knob query is byte-identical.

### What remains deferred after this pass

- `max_call_minutes_per_month` — still blocked on missing monthly
  aggregation column / billable-minute policy (no settle-time
  hook). Not in scope.
- `recording_retention_days` — still blocked on missing
  recording-janitor architecture. Not in scope.
- Composing the widget-knob and plan key into a single `min`
  effective value is INTENTIONALLY not done; their counting models
  count different things and combining them would silently
  reinterpret the widget knob (the failure mode the prior audit
  was created to avoid).

---

## June 2026 — `max_call_minutes_per_month` Billable-Minute Policy + Monthly Aggregation Audit

### Outcome: NO RUNTIME ROLLOUT (honest defer)

This phase was a strict single-limit audit for
`max_call_minutes_per_month`. After auditing the call lifecycle,
the settle path, the canonical usage-counter table, and the
create-time boundary semantics, **no activation is safe in this
pass**. Multiple independent real blockers remain. Each is listed
with the exact unblock work required.

### Part A — Billable-minute audit findings (repo truth)

1. **No monthly call-minute column exists.**
   `public.workspace_usage_counters` (migration
   `20260415220905_dd2492ef…sql`) declares: `messages_count`,
   `ai_requests_count`, `ai_credits_used`, `ai_credits_balance`,
   `visitors_count`, `storage_bytes`, `conversations_count`,
   `email_sent_count`. There is **no `call_minutes_used`** (or
   equivalent) column. The canonical counter table physically
   cannot store this metric today.

2. **No settle-time writer for monthly call usage.**
   The single canonical end-of-call path —
   `server/services/calls/endSession.ts` — writes
   `call_sessions.duration_seconds`, an `ended` system message, a
   `call_events` row, and emits realtime events. It does **NOT**
   increment any column on `workspace_usage_counters`. No trigger
   on `call_sessions` aggregates duration into a monthly counter.
   Adding a writer is a real change (new producer function,
   matching the existing canonical `storage_bytes` /
   `visitors_count` producer pattern in
   `20260619122331…sql` / `20260619132128…sql`).

3. **`duration_seconds` is NOT a clean billable-minute signal.**
   `endSession.computeDuration` picks the earliest of
   `connected_at → started_at → created_at` as the anchor (see
   `server/services/calls/endSession.ts` L72–86). When
   `connected_at` is missing (ringing-only, abandoned, rejected
   before answer), the recorded `duration_seconds` includes
   pre-connect time. Treating this column as billable minutes
   would inflate usage with non-connected attempts and silently
   change the semantics of the existing field. A billable signal
   must require `connected_at IS NOT NULL` and measure
   `ended_at − connected_at`.

4. **`connected_at` writer coverage is not yet uniform.**
   `connected_at` is set on operator accept in
   `server/routes/callCenter.ts` L597–605, and read (not written)
   by `server/routes/callWidget.ts` L1034–1044 and by
   `endSession`. There is no shared, canonical "mark as connected"
   helper proven to fire on every entry path (operator-originated
   create, invitation accept, widget visitor-initiated accept,
   callback fulfillment, queue-offered accept, LiveKit
   `participant_joined` webhook). A `connected_at`-gated billable
   policy can only be trusted once every accept path is proven to
   write it.

5. **Create-time enforcement against a monthly cap is fundamentally
   approximate.** Usage is only final at settle time. A workspace
   one minute below the cap can start a new call whose total
   minutes push usage well past the cap. This is acceptable
   product policy (industry-standard for time-based plans), but
   it must be stated explicitly before shipping enforcement
   semantics; otherwise the deny model misrepresents itself.

### Part B — Billable-minute policy (locked here, not yet enforced)

When activation eventually happens, the policy is:

- **What counts:** call_sessions where `connected_at IS NOT NULL`
  AND `state = 'ended'`. All entry_sources (operator, invitation,
  callback, call_widget, call_center) count equally.
- **What does NOT count:** ringing-only / cancelled / rejected /
  abandoned / failed calls (i.e. anything without a
  `connected_at`).
- **Billable duration formula:** `ended_at − connected_at`,
  measured in seconds, then aggregated. The monthly counter is
  expressed in whole **minutes**, using `CEIL(seconds / 60)` at
  aggregation time so that a 30-second connected call still
  consumes 1 billable minute. Limit comparisons are in minutes.
- **Period:** UTC calendar month, matching
  `workspace_usage_counters.period = to_char(now(), 'YYYY-MM')`.
- **Recordings, queue wait, hold time:** do NOT count. Only the
  connected window counts.
- **Threshold semantics:** create-time deny when
  `usage >= effective_limit`. In-flight calls are allowed to
  complete and may push usage slightly over the cap; this is the
  stated policy.
- **`-1` = unlimited** (registry-wide convention).

This policy is locked here so that when the blockers below are
removed in a future pass, no fresh debate is needed.

### Part C — Canonical aggregation model (locked, not yet built)

One source of truth: a new `call_minutes_used integer NOT NULL
DEFAULT 0` column on `public.workspace_usage_counters`, written
by a SOLE canonical producer (Postgres function invoked from a
trigger on `call_sessions` AFTER UPDATE OF state, OR a direct
increment inside `endSession.ts` — to be chosen in the activation
pass, but exactly one of the two; not both). The producer fires
exactly once per settled call and only when `connected_at IS NOT
NULL`. The resolver reads this column via the existing
`readCounterColumn` factory in
`server/services/billing/usageResolvers.ts`.

No ad-hoc live `sum(duration_seconds)` query is acceptable as the
enforcement source — `duration_seconds` includes non-connected
time (see blocker #3) and a workspace-scoped sum scales poorly.

### Part D — Enforcement boundary (locked, not yet wired)

When live, plan-level enforcement attaches to BOTH new-call
create boundaries already used by `max_concurrent_calls`:
`POST /api/calls/create` (operator) and
`POST /api/widget/calls/request` (visitor), via a
`checkPlanCallMinutesBudget(workspaceId)` helper that mirrors the
shape of `checkPlanConcurrencyCeiling`. First denial wins, no
composition with other knobs.

### Part E — Why no activation in this pass

Activating now would require, in a single pass, ALL of:
(a) schema migration adding `call_minutes_used`;
(b) canonical producer that ONLY fires on connected settle;
(c) audit + uniform writes of `connected_at` across every accept
    path;
(d) resolver registration;
(e) enforcement helper + wiring at two create boundaries;
(f) tests covering connected vs non-connected, below/at/above
    cap, and idempotent settle.

That is a real multi-surface change. The phase brief explicitly
prefers one honest defer over one fake monthly-usage rollout.
Shipping a resolver that reads a column that doesn't exist, or a
writer over today's `duration_seconds`, would be exactly the
failure mode the brief forbids.

### Backward compatibility safeguards

- No registry key added or removed.
- No schema change.
- No resolver, route, middleware, env var, or contract changed.
- `max_call_minutes_per_month` continues to read as
  `supported: false` via `KNOWN_UNSUPPORTED` (it is not in
  `RESOLVERS`), so any caller using `requireLimit` against it
  still fails-closed at usage resolution time — matching the
  pre-existing contract.

### Validation performed

- Inspected `workspace_usage_counters` schema — confirmed no
  call-minutes column.
- Inspected `endSession.ts` end-to-end — confirmed no counter
  increment, confirmed anchor fallback widens duration to
  non-connected time.
- Inspected every server reference to `connected_at` — confirmed
  only one writer in `callCenter.ts`; not proven uniform across
  all accept paths.
- Inspected `usageResolvers.ts` — confirmed
  `max_call_minutes_per_month` is absent from both `RESOLVERS`
  and `KNOWN_UNSUPPORTED`; the default "no resolver registered"
  branch correctly returns `supported: false`. (Optional doc-only
  follow-up: explicitly list it in `KNOWN_UNSUPPORTED` with the
  blockers above. Not done here because adding the entry is a
  runtime-observable change in the diagnostics surface and this
  pass is strictly docs-only.)
- Inspected `capabilityRegistry.ts` — confirmed
  `max_call_minutes_per_month` is not (yet) registered as a
  capability. Activation will add it under the `calls` group,
  `unit: 'per_month'`, `defaultValue: -1`.

### What remains deferred after this pass

- `max_call_minutes_per_month` — blocked on the five items in
  Part E above. Policy is now locked; implementation is not.
- `recording_retention_days` — unchanged. Still blocked on
  missing recording-janitor architecture. Out of scope for this
  phase by directive.

---

## June 2026 — Foundation Pass: `max_call_minutes_per_month`

Status: **foundation landed, activation deferred (honest defer).**

### connected_at coverage audit

| Writer | Path | Behavior |
|---|---|---|
| `server/routes/callCenter.ts` `POST /api/calls/:id/accept` | operator accept | sets `connected_at = now()` iff not already set (idempotent) |
| `server/routes/livekitWebhook.ts` `room_started` | provider webhook | sets `state='active'` + `started_at`; **does NOT touch `connected_at`** |
| `server/routes/callWidget.ts` `POST /api/widget/calls/:id/cancel` | visitor cancel | reads `connected_at` to branch ended-vs-cancelled; does not write it |
| `server/services/calls/endSession.ts` | end-of-call settle | reads `connected_at` for duration anchor; does not write it |

The operator accept route is currently the **only** writer of `connected_at`. In all production flows on file, the operator accept precedes the LiveKit `room_started` webhook, so `connected_at` is set before the call goes live. There is no `connected_at` backfill on `room_started`; this is the smallest remaining gap and is the one blocker on the connect-time side.

### Billable-minute signal — locked

Pure helper: `server/services/calls/billableMinutes.ts → computeBillable(row)`.

- Billable iff `state === 'ended'` AND `connected_at != null` AND `ended_at != null`.
- `seconds = max(0, round((ended_at − connected_at) / 1000))`.
- `minutes = CEIL(seconds / 60)`; zero-second outcomes produce zero minutes (no write).
- Period bucket = UTC `YYYY-MM` of `ended_at`.
- Pre-connect, queue, hold, and recording-only time DO NOT count.
- `duration_seconds` on `call_sessions` is **not** the billable signal (it anchors on `started_at` / `created_at` when `connected_at` is missing). It remains the UI-facing duration only.

### Monthly aggregate sink — locked

- Column: `public.workspace_usage_counters.call_minutes_used integer NOT NULL DEFAULT 0`.
- Period semantics: identical to `visitors_count` / `conversations_count` (UTC `YYYY-MM`).
- This is the **only** monthly sink for call minutes. No second counter, no derived sum.

### Sole writer — locked (DB trigger)

- Trigger `trg_call_sessions_bill_minutes` (`AFTER UPDATE OF state`) → function `public.tg_call_sessions_bill_minutes()`.
- Fires only on `OLD.state IS DISTINCT FROM 'ended' AND NEW.state = 'ended'`. The OLD-state guard makes a second update to an already-ended row a no-op (idempotent).
- Skips when `connected_at IS NULL` or `ended_at IS NULL` (locked policy).
- Increments `call_minutes_used` by `CEIL((ended_at − connected_at) / 60)` for the UTC month of `ended_at`.
- End-path-agnostic: the same trigger handles `endCallSession`, `livekitWebhook room_finished`, and `callWidget cancel-after-connect` writers — there is one canonical sink even though there are still three application-side end writers.
- Application code MUST NOT write `call_minutes_used` directly. Enforced by a lint-level test in `src/test/billing/billableCallMinutes.test.ts`.

### Resolver

`max_call_minutes_per_month` is registered in `usageResolvers.ts → RESOLVERS` and reads `workspace_usage_counters.call_minutes_used`. It is also added to `CAPABILITY_REGISTRY` (`unit: 'minutes'`, default `-1` = unlimited) and to `USAGE_BACKED_LIMIT_KEYS`. PlanUsagePanel / admin diagnostics can now display monthly minutes; create-time enforcement is intentionally NOT wired.

### Why activation was NOT performed in this pass

Activation requires a create-time gate (`requireLimit('max_call_minutes_per_month')` or equivalent) on `POST /api/calls/create` (operator) and `POST /api/widget/calls/request` (visitor). That step is deferred because:

1. **`connected_at` is not yet uniformly written on every accept-equivalent path.** In particular, `livekitWebhook room_started` does not backfill `connected_at` when the operator accept did not write it (e.g., future outbound or auto-accept flows). Activating now would under-count billable usage for any such flow and silently let workspaces over the cap continue placing calls.
2. **Three end-of-call application writers still exist** (`endCallSession`, `livekitWebhook room_finished`, `callWidget cancel`). The DB trigger makes the **counter** safe regardless, but the asymmetry means we cannot yet add an end-time observability hook on a single application chokepoint. This is acceptable for foundation but worth resolving before activation.
3. **Near-threshold UX semantics** (deny on create vs. allow in-flight calls to finish past the cap) is locked in policy but has no in-flight back-pressure path; that's an activation-time concern.

### Acceptance for this pass

- Only `max_call_minutes_per_month` was in scope. ✅
- No fake activation. ✅
- One billable-minute source of truth (`computeBillable` + the trigger SQL mirror it exactly). ✅
- One monthly aggregate sink (`workspace_usage_counters.call_minutes_used`). ✅
- No route / env / schema-key rename. ✅
- Repo is materially closer to true activation than before. ✅

### `recording_retention_days` — still deferred

Unchanged from the prior audit: blocked on missing janitor / retention worker architecture. Not in scope this pass.

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
