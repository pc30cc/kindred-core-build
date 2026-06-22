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