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