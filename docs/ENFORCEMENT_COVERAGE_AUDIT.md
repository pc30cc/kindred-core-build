# Enforcement Coverage Audit

_Last updated: Plan Limits Backfill phase — plan-data alignment complete; see §7 + §8._

This audit classifies every plan-relevant backend route surface and records
exactly which middleware (`requireFeature`, `requireModule`, `requireChannel`,
`requireAICredits`, `requireLimit`) is — or is intentionally not — applied.

It is deliberately conservative. Phase 1 added gating only where the policy
was unambiguous and the risk of blocking legitimate traffic was near-zero.
Everything else is recorded as "ambiguous — deferred" and stays untouched.

## Legend

- **GATED** — middleware attached to this route.
- **ALREADY ENFORCED (in-handler)** — the handler does its own equivalent
  entitlement check (e.g. `checkEntitlementFromDB` / `checkModuleAccess`
  inline) and migrating to middleware would be a refactor, not a fix.
- **SAFE TO GATE NOW** — newly added in Phase 1.
- **AMBIGUOUS — DEFERRED** — policy is unclear or would risk locking out
  in-flight traffic / non-paying users that are intended to keep working.
- **DO NOT GATE** — gating would break the platform (auth, billing,
  admin, public bootstrap, webhooks).

## 1. Already gated (middleware)

| Route | Middleware | Notes |
|---|---|---|
| `POST /api/ai/complete` (`server/routes/ai.ts`) | `requireModule('ai_assistant')` + `requireAICredits(1)` | Canonical reference. |
| `POST /api/ai-agent/playground/test` (`server/routes/aiAgent.ts`) | `requireModule('ai_assistant')` | **Added in Phase 1.** Playground is by definition an `ai_assistant` surface; existing per-user rate limit and member auth are preserved. |

## 2. Already enforced inside the handler

These routes already deny on the same capability the middleware would check.
Migrating them to middleware is **not** part of Phase 1 because the in-handler
logic also coordinates admin bypass, dev-only overrides, or workspace-domain
resolution that the generic middleware does not model.

| Route | In-handler check | Capability key |
|---|---|---|
| `POST /api/ai-kb/jobs` (`aiKb.ts`) | `ensureModulesEnabled` + monthly job count | `knowledge_base`, `ai_kb_builder`, `ai_kb_jobs_per_month` |
| `GET /api/ai-kb/source` (`aiKb.ts`) | `checkModuleAccess` ×2 | `knowledge_base`, `ai_kb_builder` |
| `POST /api/ai-agent/operator/suggest-reply` (`aiAgent.ts`) | `checkEntitlementFromDB('ai_operator_assist')` with explicit dev bypass env var | `ai_operator_assist` |
| Call control plane (`workspaceCalls.ts`, `adminCalls.ts`, `callCenter.ts`) | `loadEffectiveCallChannels` resolves `voice_calls_enabled` / `video_calls_enabled` from global+workspace settings | (effective gates only — see §3) |

## 3. Ambiguous — deferred

These routes look plan-relevant but the correct policy is **not** obvious or
would risk regressions. They are intentionally unchanged. A future focused
pass should resolve each one in isolation.

| Route | Candidate gate | Why deferred |
|---|---|---|
| `server/routes/conversations.ts` (create) | `requireLimit('max_conversations', …)` | A `currentUsageFn` that correctly counts conversations per current period would have to mirror the existing usage-counter semantics; getting this wrong silently blocks customer-facing chat. Defer until a single shared usage helper exists. |
| `server/routes/visitors.ts` (track) | `requireLimit('max_visitors', …)` | Visitor tracking happens through public/widget paths; gating with a workspace-only middleware would either deny anonymous visitors outright or silently let them through. Needs a dedicated widget-aware limit pass. |
| `server/routes/callInvitations.ts`, `callQueue.ts`, `callAvailability.ts`, `workspaceCalls.ts`, `widgetCallInvitations.ts`, `widgetCallbacks.ts` | `requireModule('voice_video')` + `requireChannel('voice'\|'video')` | The call subsystem already has its own multi-layer gating via `controlPlane.ts` (global × workspace toggles). Adding plan-level module gating on top is desirable but could lock out workspaces whose plan currently lacks `voice_video` even though admins explicitly enabled calls for them. Needs a coordinated migration that first ensures plans expose `voice_video`. |
| `server/routes/cannedResponses.ts` | `requireFeature('automation')` | "Canned responses" and the `automation` feature are not the same concept; gating them under `automation` would over-scope. |
| `server/routes/email.ts` (`POST /send`) | `requireChannel('email')` | This route also serves transactional/auth emails (password reset, confirmation, notifications). Gating with `requireChannel('email')` would lock out core auth flows on plans where the channel isn't explicitly enabled. The split between "platform email" and "channel email" must be made explicit before gating. |
| `server/routes/storage.ts`, `server/routes/widgetAttachments.ts` | `requireLimit('storage_gb', …)` | No usage helper currently aggregates total stored bytes per workspace. `requireLimit` fails closed when usage cannot be determined — wiring it without that helper would deny every upload. |
| `server/routes/aiAgent.ts` — settings / sources / runs / qna / knowledge-index endpoints | `requireModule('ai_assistant')` | Many of these paths are currently usable by global admins and free workspaces with admin overrides. Blanket-gating them would surface as a regression for in-flight admin tooling. The agent already has fine-grained guards inside `runPlayground`, `operator/suggest-reply`, etc. Per-route pass needed. |
| `server/routes/aiKb.ts` — generated/accept|publish, jobs/:id | (none) | These act on already-created jobs whose creation is gated. Re-gating consumption of a paid result would block users from finalising work they already paid for. |

## 4. Do not gate

These are correct as-is and must stay reachable regardless of plan state.

- All `server/routes/admin*.ts` — Super Admin surfaces.
- `server/routes/health.ts` — operational/liveness.
- `server/routes/auth.ts`, `auth-email.ts` — authentication must always work.
- `server/routes/billing.ts`, `plans.ts` — these endpoints _provide_ the
  state that gating depends on; gating them creates a deadlock.
- `server/routes/account.ts`, `privacy.ts` — user-data rights endpoints.
- `server/routes/livekitWebhook.ts` — provider webhook (signature-auth).
- `server/routes/widgetIdentity.ts`, `widgetDepartments.ts`, public widget
  bootstrap surfaces — access controlled by signed widget tokens / CORS,
  not by plan; gating breaks public widget loading.
- `server/routes/cdn.ts`, `mapGeo.ts` — infra utilities.
- `server/routes/realtimeControl.ts` — operational realtime control plane.

## 5. Risks if gating were added blindly

- Locking out free-plan workspaces from features that are intended to be free.
- Breaking widget bootstrap or call flows on workspaces not yet migrated to a
  plan with the corresponding module enabled.
- Creating circular dependencies between billing and gating.
- Failing-closed on routes whose `currentUsageFn` is not yet implemented (the
  middleware denies when usage cannot be determined).

## 6. Recommended follow-up (out of scope for Phase 1)

1. Define a single `usageCounters.ts` helper exposing per-workspace counts
   for conversations, visitors, AI KB jobs, and storage bytes. Without it,
   `requireLimit` cannot be safely attached to most candidate routes.
2. Decide whether `email.ts` should split into two endpoints — one for
   platform/auth mail (always allowed) and one for channel-email send
   (gated by `requireChannel('email')`).
3. Plan a coordinated `voice_video` rollout: backfill `voice_video=true`
   on plans that should have it, then gate the call routes in one pass.
4. Add a small CI check that fails if any `require*(...)` call references
   a capability key absent from `CAPABILITY_REGISTRY`.
5. Run `GET /api/plans/admin/diagnostics` periodically to surface drift.

## 7. Phase 2 — Limit enforcement candidate audit

Phase 2 set out to attach `requireLimit(...)` to 1–2 obviously-safe routes
using the new shared usage foundation (`server/services/billing/usageResolvers.ts`).

After a route-truthful audit, **no route met the bar this phase**. The
blockers below are concrete, not speculative — gating any candidate now
would deny legitimate traffic on day one.

| Limit key | Usage resolver ready? | Gate-now classification | Blocker |
|---|---|---|---|
| `max_conversations` | yes (`workspace_usage_counters.conversations_count`) | **DO NOT GATE** | The key is **not** present in any seeded plan's `billing_plans.limits` jsonb. `check_workspace_entitlement` returns `allowed:false / reason:feature_not_in_plan` for unknown keys (fail-closed by design). Attaching `requireLimit('max_conversations', …)` would deny `POST /conversations/start-from-visitor` for **every** workspace. Backfill plan limits first. |
| `max_visitors` | yes (`workspace_usage_counters.visitors_count`) | **DO NOT GATE** | Same plan-limits gap as above, plus visitor tracking flows through public/widget paths where a workspace-scoped middleware would either fail-closed for anonymous traffic or be bypassed entirely. |
| `storage_gb` | yes (`workspace_usage_counters.storage_bytes`, now backed by canonical producer `trg_storage_usage_logs_apply`) | **DO NOT GATE (this phase)** | Counter is now real and forward-correct. Rollout deferred to its own narrow phase, starting with `POST /api/storage/upload`. Widget-attachment branches still need widget-runtime UX before any 403 can be surfaced cleanly. |
| `ai_kb_jobs_per_month` | yes (`countJobsThisMonth`) | **STILL AMBIGUOUS — DEFERRED** | Key **is** present in plan limits, but `POST /api/ai-kb/jobs` already enforces this exact rule in-handler **with an admin bypass** (`!auth.isAdmin && jobsUsed >= …`). `requireLimit` has no admin bypass, so layering it on top would regress Super-Admin workflows that currently rely on the in-handler bypass. Migrating this route is a refactor, not a Phase-2 add. |

**Routes gated in Phase 2:** none.
**Capability registry / route / env / schema renames in Phase 2:** none.

### Required precondition for Phase 3

Before any of the above can be safely gated, plan-data must catch up
with the registry:

1. Backfill `billing_plans.limits` jsonb with `max_conversations`,
   `max_visitors`, and `storage_gb` for every active plan (use `-1`
   for unlimited where appropriate).
2. Decide the admin-bypass policy for `requireLimit` — either add an
   admin short-circuit to the middleware itself, or accept that the
   middleware applies to admins too and adjust ops workflows.
3. Only then move `POST /api/ai-kb/jobs` from in-handler enforcement
   to `requireLimit('ai_kb_jobs_per_month', usageFnForLimit('ai_kb_jobs_per_month'))`,
   in a single focused pass that also removes the duplicated count.

The shared usage foundation (`usageResolvers.ts`) is ready and waiting;
the gap is on the plan-data and middleware-policy side.

## 8. Plan Limits Backfill phase (resolved §7 plan-data blocker)

The plan-data half of §7 is now resolved. See `docs/PLAN_LIMIT_ALIGNMENT.md`
for the full record.

- `billing_plans.limits` now contains `max_conversations`, `max_visitors`,
  `storage_gb`, `ai_credits_per_month`, and `ai_kb_jobs_per_month` on every
  active plan (`free`, `pro`, `enterprise`). Values were derived from each
  plan's pre-existing legacy keys to preserve product semantics; `-1`
  marks unlimited.
- `POST /api/plans/admin` now runs `normalizePlanLimitsForCreate(...)` so
  newly-created plans cannot reintroduce the gap. `PUT` is intentionally
  left untouched (admin intent stays explicit).
- `GET /api/plans/admin/diagnostics` now reports
  `usageBackedLimitKeys` and `usageBackedKeysMissingByPlan` so drift is
  observable going forward.

The middleware-policy half of §7 — admin-bypass on `requireLimit` — has
a documented recommendation in `PLAN_LIMIT_ALIGNMENT.md`:
**keep admin-bypass route-specific; do not add a generic short-circuit
to the middleware.** The recipe for migrating `POST /api/ai-kb/jobs` to
middleware (with explicit bypass) is recorded there.

Phase 3 (selective `requireLimit` rollout) is now unblocked at the
data layer. It is still NOT executed in this phase.

## 8. Phase 3 — AI KB jobs migrated to shared `requireLimit`

`POST /api/ai-kb/jobs` is now the **first** real consumer of
`requireLimit(...)` + `usageFnForLimit(...)`. The route-local logic is:

1. Authenticate caller and resolve `auth.isAdmin` (Super Admin) as today.
2. Run existing module gating (`knowledge_base`, `ai_kb_builder`).
3. If `auth.isAdmin` → bypass the cap (preserves the prior in-handler
   `!auth.isAdmin && …` admin bypass exactly).
4. Otherwise invoke
   `requireLimit('ai_kb_jobs_per_month', usageFnForLimit('ai_kb_jobs_per_month'))`
   inline. The middleware writes its own 403 on cap-reached / not-in-plan;
   the handler returns early when the middleware did not call `next()`.
5. Continue to the unchanged job-creation flow (plan snapshot, insert,
   usage log).

Notes:

- The duplicate in-handler monthly count (`countJobsThisMonth` +
  `jobsUsed >= limitsInfo.limits.jobsPerMonth`) was removed — it is now
  resolved by `usageFnForLimit('ai_kb_jobs_per_month')`, which delegates
  to the same `countJobsThisMonth` helper.
- `resolveAiKbLimits` is still called because the `plan_snapshot`
  written into `ai_kb_jobs` carries plan slug + per-job caps the worker
  reads. That snapshot semantics is unchanged.
- No global admin short-circuit was added to `requireLimit`. The bypass
  is explicit and visible at the call site.
- All other numeric-limit routes (`max_conversations`, `max_visitors`,
  `storage_gb`, `ai_credits_per_month`) **remain deferred** per §7.
  They still need workspace/widget-aware policy decisions before any
  middleware is attached.

## 9. Phase 5 — `max_conversations` widget-aware rollout

Outcome: **GATED on all conversation-creation branches**, widget and
operator alike. Full policy in
[`CONVERSATION_LIMIT_POLICY.md`](./CONVERSATION_LIMIT_POLICY.md).

| Route / branch | Classification |
|---|---|
| `POST /api/widget/message` — `if (!convId)` creation branch | **GATED** via `enforceMaxConversationsLimit(req, res)` |
| `POST /api/widget/offline-messages` — pre-insert | **GATED** via `enforceMaxConversationsLimit(req, res)` |
| `POST /api/conversations/start-from-visitor` — after reuse short-circuit | **GATED** via `enforceMaxConversationsLimit(req, res)` |
| `POST /api/widget/message` — existing-conversation branch | NEVER gated (replies are not creation) |
| `POST /api/conversations/send-message` | NEVER gated (replies are not creation) |
| `services/ai-agent/intro.ts` (internal) | Deferred — not an HTTP route, requires a separate decision on AI-intro counting |

Hard rule preserved: `requireLimit('max_conversations', …)` is only
attached on actual creation branches, never on message-send into an
existing conversation. Usage math is shared via
`usageFnForLimit('max_conversations')` — no ad-hoc counting was
introduced. No global admin bypass was added to `requireLimit`.

## 10. Phase 6 — `max_visitors` readiness pass (NO ROLLOUT)

Outcome: **DEFERRED.** No route gated. No code changed. Full policy
and route truth recorded in
[`VISITOR_LIMIT_POLICY.md`](./VISITOR_LIMIT_POLICY.md).

Single hard blocker:
`workspace_usage_counters.visitors_count` has **no producer** anywhere
in the codebase (no trigger, no server increment, no worker write).
`resolveMaxVisitors` therefore returns `0` for every workspace, and
attaching `requireLimit('max_visitors', …)` today would be a silent
no-op gate. That is exactly the failure mode the audit forbids.

Secondary blocker: the product semantics of "a visitor" for the cap
(unique session vs. distinct `visitor_id` vs. identified contact vs.
lifetime distinct) are not chosen, so the missing producer cannot be
designed yet.

Route classification summary (full table in the policy doc):

| Route / branch | Classification |
|---|---|
| `POST /api/widget/identify` — first-seen insert | STILL AMBIGUOUS (no counter; semantics undefined) |
| `POST /api/widget/identify` — revisit update | DO NOT GATE |
| `POST /api/widget/message` — incidental session insert | STILL AMBIGUOUS; do not stack on existing `max_conversations` gate |
| `POST /api/widget/message` — reply branch | DO NOT GATE |
| `POST /api/visitors/track` — insert sub-branch | STILL AMBIGUOUS |
| `POST /api/visitors/page-view` | DO NOT GATE (page views must never consume `max_visitors`) |
| `GET /api/visitors/*` | NOT A VISITOR-CREATION ROUTE |
| Other widget routes (attachments, callbacks, departments, …) | NOT A VISITOR-CREATION ROUTE |

Unblock sequence (must be done before any rollout phase):
1. Choose visitor semantics (recommend: distinct `visitor_id` per
   calendar month, de-duped via `identity_merges`).
2. Wire a single canonical producer for
   `workspace_usage_counters.visitors_count` (DB trigger on
   `visitor_sessions` insert, or one server-side increment in the
   first-track branch). No ad-hoc counting in handlers.
3. Decide cap-reached widget UX (recommend: deny first-track only;
   never block revisits, page views, or replies).
4. Then attach `requireLimit('max_visitors',
   usageFnForLimit('max_visitors'))` on exactly the new-visitor
   branch, with route-local `!auth.isAdmin` bypass — no global
   short-circuit in `requireLimit`.

No other limit keys touched in this phase. `storage_gb`,
`ai_credits_per_month`, and any storage/upload work remain deferred
per §7.

## 12. Phase 8 — `max_visitors` widget rollout pass (NO ROLLOUT)

Outcome: **rollout still deferred.** No `requireLimit('max_visitors',
…)` was attached. The counter foundation from §11 is correct and
remains the single producer; the blocker this phase exposed is a
gate-granularity mismatch at the existing visitor-creation routes.

### Branch-level audit

| Branch | First-session-this-month? | `workspace_id` at gate time? | Traffic | Classification |
|---|---|---|---|---|
| `POST /api/visitors/track` — insert branch (`visitors.ts` ~L144) | **No.** Fires whenever no session exists in the last **30 minutes**, including same-month revisits. | Yes (body) | Public/widget | **STILL AMBIGUOUS** — gating here would deny same-month revisits when the cap is reached. The trigger correctly does NOT count those, so the gate would over-deny relative to locked semantics. |
| `POST /api/visitors/track` — update branch (~L134) | No (revisit) | Yes | Public/widget | **UPDATE/REVISIT ONLY — DO NOT GATE.** |
| `POST /api/widget/message` — visitor-session insert sub-branch (`widget.ts` ~L1522) | **No.** Same 30-minute-window logic as `/track`. Already gated for `max_conversations`. | Yes | Public/widget | **STILL AMBIGUOUS** — same over-deny risk; do not stack a misaligned `max_visitors` gate on top of the `max_conversations` gate. |
| `POST /api/widget/message` — reply branch | No | n/a | Public/widget | **DO NOT GATE.** |
| `POST /api/widget/identify` (`widgetIdentity.ts`) | Does not insert `visitor_sessions` rows itself; only resolves cookie identity and reads sessions. | Yes | Public/widget | **NOT A VISITOR-CREATION ROUTE.** |
| `POST /api/visitors/page-view`, `/heartbeat`, `/disconnect` | No | — | Public/widget | **DO NOT GATE** (page views/heartbeats/disconnects must never consume `max_visitors`). |
| `POST /api/conversations/start-from-visitor` | No (operates on existing visitor) | Yes | Operator | **DO NOT GATE** for `max_visitors`. |
| `callWidget.ts` ensure-session insert (~L212), `widgetCallInvitations.ts`, `calls.ts` | No (mirror of the same 30-min reconnect pattern) | Yes | Public/widget | **STILL AMBIGUOUS** — same granularity mismatch. |

No branch in the codebase today represents "first
`visitor_sessions` row for `(workspace_id, visitor_id)` this UTC
month". Every existing creation site uses a 30-minute staleness
window, which is strictly narrower than the locked monthly
semantics. `requireLimit('max_visitors', …)` reads the counter but
does not know whether the current request is a true new visitor or
an in-month revisit, so attaching it at any of these branches would
contradict the locked rule "subsequent `visitor_sessions` rows for
the same pair in the same month do NOT count".

### Exact reason rollout stayed deferred

Gate granularity ≠ counter granularity. The counter is per-UTC-month
distinct; the candidate route branches are per-30-minutes distinct.
A correct gate therefore needs a **route-local membership pre-check**
("does any `visitor_sessions` row exist for `(workspace_id,
visitor_id)` in the current UTC month?") to decide whether the
request is a true new visitor before invoking
`requireLimit('max_visitors', usageFnForLimit('max_visitors'))`.
That pre-check is intentionally out of scope for this phase because
(a) the brief forbids ad-hoc counting/decision logic in routes
without an explicit policy decision, and (b) its placement and
failure mode (silent allow vs. 403) is the open cap-reached UX
question still tracked in `VISITOR_LIMIT_POLICY.md` §3.

### Cap-reached behavior chosen (for the next phase, not this one)

Recommended and recorded — not yet enforced:

- Deny **only** the true new-visitor branch with the standard
  `requireLimit` 403 response shape.
- Allow revisits, updates, page views, heartbeats, disconnects, and
  message replies to continue unchanged regardless of cap state.
- No new widget UX surface; the widget's existing `requireLimit`
  error path (already used for `max_conversations`) is reused.
- Route-local `!auth.isAdmin` bypass mirroring AI KB jobs and
  `max_conversations` precedent. No global admin short-circuit added
  to `requireLimit`.

### Routes/branches gated in this phase

None. No `server/` code changed.

### Producer/resolver invariants preserved

- `trg_visitor_sessions_count_visitor` remains the **sole writer**
  of `workspace_usage_counters.visitors_count`.
- `resolveMaxVisitors` / `usageFnForLimit('max_visitors')` unchanged.
- No second counter path, no server-side increment, no schema or
  middleware contract changes.

No other limit keys touched in this phase. `storage_gb`,
`ai_credits_per_month`, and storage/upload work remain deferred
per §7.

## 13. Phase 9 — `max_visitors` minimal rollout (TRUE-NEW BRANCH ONLY)

Outcome: **`max_visitors` is now gated on exactly one branch — the
true-new-this-month `visitor_sessions` insert in
`POST /api/visitors/track`.** Reconnects, revisits, updates,
page views, heartbeats, disconnects, and replies remain ungated.
The DB trigger `trg_visitor_sessions_count_visitor` remains the
single writer of `workspace_usage_counters.visitors_count`.

### Chosen rollout site

`POST /api/visitors/track` → `else { /* Create new session */ }`
sub-branch in `server/routes/visitors.ts`. This is the canonical
public visitor-tracking ingestion endpoint and the only branch on
that route that can produce a `visitor_sessions` row for a
previously-unseen 30-minute window. Other creation paths
(`widget.ts` visitor-session insert, `callWidget.ts` ensure-session
insert, `widgetCallInvitations.ts`) share the same 30-min
granularity and were intentionally **not** gated in this phase to
keep the rollout to a single product surface.

### True-new-vs-reconnect discriminator

New helper `server/services/billing/visitorLimit.ts` →
`enforceMaxVisitorsLimitIfNewThisMonth(req, res, supabase,
workspaceId, visitorId)`:

1. Reads `visitor_sessions` for any row matching
   `(workspace_id, visitor_id)` with `created_at >= start of current
   UTC month`. The predicate matches the one used by
   `tg_visitor_sessions_count_visitor()`, so gate decisions and
   counter increments cannot disagree.
2. If a row exists → in-month reconnect/revisit, helper returns
   `true`, `requireLimit` is **not** invoked, the cap is **not**
   consumed, and the route proceeds to insert. The trigger then
   runs its own predicate and correctly leaves `visitors_count`
   unchanged.
3. If no row exists → true-new-this-month visitor. The helper
   invokes `requireLimit('max_visitors',
   usageFnForLimit('max_visitors'))` inline (same inline pattern as
   `enforceMaxConversationsLimit`). Cap-reached → standard 403,
   route aborts before insert.
4. On read error → fail **open** (treat as reconnect) so transient
   DB hiccups never block legitimate traffic; the trigger remains
   source of truth and self-corrects on the next true-new visitor.

The discriminator only **reads** `visitor_sessions`. It never
increments a counter, never writes a session row, and never invokes
ad-hoc counting math.

### Routes/branches gated in this phase

- `POST /api/visitors/track` true-new-session insert sub-branch
  only.

### Branches that stay ungated (re-confirmed)

- `POST /api/visitors/track` update branch (30-min session reuse).
- `POST /api/visitors/heartbeat`, `/page-view`, `/disconnect`.
- `POST /api/widget/identify`.
- `POST /api/widget/message` reply branch and its visitor-session
  insert sub-branch (already gated for `max_conversations`).
- `callWidget.ts` ensure-session insert,
  `widgetCallInvitations.ts`, `calls.ts`.
- All operator-side reads.

### Producer / resolver invariants preserved

- `trg_visitor_sessions_count_visitor` is still the **only** writer
  of `workspace_usage_counters.visitors_count`. No second producer
  introduced.
- `resolveMaxVisitors` / `usageFnForLimit('max_visitors')` unchanged.
- No schema, route, env-var, key, or middleware-contract renames.
- Cap-reached response uses the existing `requireLimit` 403 shape;
  no new widget UX surface.
- Bypass: none added — the route is public/widget traffic, so the
  `!auth.isAdmin` operator-bypass used elsewhere does not apply,
  and no global admin short-circuit was added to `requireLimit`.

No other limit keys touched. `storage_gb`, `ai_credits_per_month`,
and storage/upload work remain deferred per §7.

## 11. Phase 7 — Canonical visitor counter producer + semantics lock

Outcome: **counter foundation in place; rollout still deferred to a
tiny follow-up phase.** No `requireLimit('max_visitors', …)` attached
yet.

Locked semantics: **distinct `visitor_id` per workspace per UTC
calendar month.** Revisits, 30-minute reconnects that insert a new
`visitor_sessions` row, page views, message replies, and
identity-enrichment updates DO NOT increment. Full rationale and
rejected alternatives in
[`VISITOR_COUNTER_ARCHITECTURE.md`](./VISITOR_COUNTER_ARCHITECTURE.md);
route truth and unblock checklist in
[`VISITOR_LIMIT_POLICY.md`](./VISITOR_LIMIT_POLICY.md).

Canonical producer (single writer):
`trg_visitor_sessions_count_visitor` — `AFTER INSERT` row trigger on
`public.visitor_sessions`, backed by
`public.tg_visitor_sessions_count_visitor()`. The trigger upserts
`workspace_usage_counters(workspace_id, period).visitors_count` only
when no other `visitor_sessions` row exists for the same
`(workspace_id, visitor_id)` in the current UTC month. Period key
`to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM')` matches
`currentMonthPeriod()` in `usageResolvers.ts`.

Double-counting safeguards:

- `RETURN NEW` short-circuit if a prior in-period sibling row
  exists for `(workspace_id, visitor_id)` — the 30-minute reconnect
  insert path therefore does not double-count.
- Trigger fires only on `INSERT` — `UPDATE`s on the existing row
  (page navigation, geo enrichment, identity attach) never run the
  counter logic.
- `visitor_page_views` is a separate table and is unaffected.
- No application-side increment exists for `visitors_count`; the
  hard rule recorded in `VISITOR_COUNTER_ARCHITECTURE.md` §4
  forbids any future server-side increment.

Resolver alignment: `resolveMaxVisitors` is unchanged. It already
reads `workspace_usage_counters.visitors_count` for the current UTC
`YYYY-MM` period, which is exactly what the producer writes.

Why no rollout in this phase: the counter has just gone from "always
0" to "real values starting now". Workspaces have a back-filled
history of `0`, which is harmless, but cap-reached widget UX
(deny-first-track only vs. soft-degrade vs. silent drop) was
intentionally not relitigated in this phase. That single decision is
the only remaining blocker for the gate.

No other limit keys touched in this phase. `storage_gb`,
`ai_credits_per_month`, and any storage/upload work remain deferred
per §7.

## Phase 10 — max_visitors coverage broadening

Applied the existing `enforceMaxVisitorsLimitIfNewThisMonth` helper
to the second true session-creation branch:
`server/routes/widget.ts` `POST /track` `else if (visitor_id)`
sub-branch (~line 1524). Reuses the Phase 9 contract verbatim — no
second helper, no second writer of `workspace_usage_counters.visitors_count`.

Branches still ungated and intentionally deferred:

- `callWidget.ts` `ensureVisitorSessionRow` insert — best-effort
  semantics; gating would convert a swallow-on-failure code path
  into a hard 403 on call-widget entry. Needs an explicit
  cap-reached UX decision before adoption.
- `widgetIdentity.ts`, `widgetCallInvitations.ts`, `calls.ts` —
  not session-creation branches (SELECT only).
- `widget.ts` `/track` 30-min reconnect branch, page-view branch,
  presence inserts — not creation branches per locked semantics.

Trigger `trg_visitor_sessions_count_visitor` is still the only
writer. `resolveMaxVisitors` and `usageFnForLimit('max_visitors')`
unchanged. All gated branches now share one discriminator contract.

## Phase 11 — storage_gb readiness audit (no rollout)

Outcome: **rollout deferred.** Full policy and resolution path are in
`docs/STORAGE_LIMIT_POLICY.md`. Summary recorded here for the audit
trail.

### Route audit

| Route / branch | Verdict | Notes |
|---|---|---|
| `POST /api/storage/upload` (`server/routes/storage.ts`) | **STILL AMBIGUOUS** — would be the eventual first rollout site | Operator-authenticated, lowest-UX-risk. Blocked only by missing producer. |
| `POST /api/conversation-attachments/:id/upload` | **STILL AMBIGUOUS** | Member-authenticated, but blocked by same producer gap. |
| `server/routes/widgetAttachments.ts` upload branches | **DO NOT GATE** (this phase, and one more after producer ships) | Public/widget surface. Hard 403 from `requireLimit` would surface as a raw error in the widget runtime. Needs widget UX before gating, even after counter is real. |
| `server/routes/storage.ts` `POST /delete`, `POST /test` | **NOT A STORAGE-CREATION ROUTE** | Deletes free bytes; `/test` is a config probe. Never gate. |
| `GET` storage / download paths | **NOT A STORAGE-CREATION ROUTE** | Reads do not consume the cap. |

### Counter / resolver alignment

- Column: `workspace_usage_counters.storage_bytes` — declared in
  `supabase/migrations/20260415220905_*.sql`, default `0`.
- Producer: **`trg_storage_usage_logs_apply` →
  `public.apply_storage_usage_log()`** on `storage_usage_logs`. Sole
  writer. Increments on successful uploads with `file_size > 0`,
  decrements on successful deletes (clamped at zero), seeds new
  monthly rows from the prior period to preserve cumulative occupancy.
- `deleteFile()` in `server/services/storage/index.ts` now resolves
  `file_size` from the most recent successful upload row for the same
  `(workspace_id, file_key)` and stamps it on the delete log row, so
  the trigger decrements exactly. No guessed sizes.
- Resolver `resolveStorageGb` is unchanged. It reads the same
  current-month row the producer writes to.
- Backfill is intentionally skipped: historical delete rows lack
  `file_size`, so a backfill would systematically over-count.
  See `docs/STORAGE_COUNTER_ARCHITECTURE.md`.

### Why no rollout (this phase)

The producer is now live, but rollout is intentionally a separate,
narrow follow-up phase. This phase is strictly the counter-truth
phase: install one canonical writer, fix delete accounting, document
the invariants. Attaching `requireLimit` is the next phase, starting
with `POST /api/storage/upload`.

### What this phase changed

- Installed canonical producer trigger
  (`trg_storage_usage_logs_apply`) — sole writer of `storage_bytes`.
- Patched `deleteFile()` in `server/services/storage/index.ts` to
  capture freed `file_size` on every delete log row.
- Added `docs/STORAGE_COUNTER_ARCHITECTURE.md` with full invariants.
- Updated `docs/STORAGE_LIMIT_POLICY.md` to reflect producer status.
- `resolveStorageGb`, `usageFnForLimit('storage_gb')`, the capability
  registry entry, and every upload route remain untouched.

### Deferred to later phases

- First rollout: `POST /api/storage/upload`.
- Conversation-attachments rollout.
- Widget-attachments rollout (paired with widget-runtime UX).

## Phase 12 — storage_gb first narrow rollout (operator upload only)

### Policy decision

**Position A — forward-correct rollout accepted.** Backfill is
intentionally skipped (historical delete logs lack `file_size`, so
reconstruction would over-count). Existing workspaces start at zero on
the canonical counter and accumulate forward; this is the conservative
tradeoff documented in `docs/STORAGE_LIMIT_POLICY.md` § "Phase 12 —
Forward-correct rollout decision".

### Storage route audit (Phase 12)

| Route | Verdict | Why |
| --- | --- | --- |
| `POST /api/storage/upload` (`server/routes/storage.ts`) | **SAFEST FIRST ROLLOUT SITE — gated this phase** | Bearer must equal anon or service-role key (operator/server-side, not widget). `workspaceId` in body, exposed via `extractWorkspaceId`. Goes through canonical `uploadFile()` → `storage_usage_logs` → trigger. A 403 surfaces in operator UI, not visitor UX. |
| `POST /api/conversation-attachments/:id/upload` (`server/routes/conversationAttachments.ts`) | **TOO SENSITIVE FOR THIS PHASE** | Operator-authenticated and goes through `uploadFile()`, but Phase 12 is capped at one route. Deferred to its own phase. |
| `widgetAttachments.ts` upload endpoints | **TOO SENSITIVE FOR THIS PHASE** | Widget/public-facing. A raw 403 needs visitor-side UX (error message, retry, disable upload affordance). Deferred until that UX lands. |
| `POST /api/storage/delete` | **NOT A STORAGE-CREATION ROUTE** | Frees bytes; gating it would block recovery from a full quota. |
| `POST /api/storage/test` | **NOT A STORAGE-CREATION ROUTE** | Config probe; logs are best-effort and not workspace-billable. |
| `GET /api/storage/url`, `GET /api/storage/config/:workspaceId` | **NOT A STORAGE-CREATION ROUTE** | Read-only. |

### Rollout applied

- `server/routes/storage.ts` — `POST /api/storage/upload`: after the
  existing bearer-token auth, body validation, and size cap, invoke
  `requireLimit('storage_gb', usageFnForLimit('storage_gb'))` once
  inline (mirrors the `aiKb.ts` pattern). On rejection the middleware
  has already written 403 and we early-return. No route-local storage
  math, no second producer, no schema/route rename.

### Backward-compatibility safeguards

- Workspaces on plans with `storage_gb = -1` (unlimited) skip the usage
  comparison inside `requireLimit` — unchanged behavior.
- The bearer-token auth and `MAX_UPLOAD_SIZE` checks run first, so the
  gate never reveals limit info to unauthenticated callers.
- `usageFnForLimit('storage_gb')` is the only usage source. If the
  resolver throws, `requireLimit` fail-closes with a 403 — same
  contract as every other gated limit.
- Counter producer, resolver, capability registry, and middleware
  contracts untouched.

### Validation

- Verified `extractWorkspaceId` reads `req.body.workspaceId` (camelCase),
  matching the upload route's payload shape.
- Confirmed `usageFnForLimit('storage_gb')` resolves through
  `resolveStorageGb` → `workspace_usage_counters.storage_bytes`
  (canonical column, single producer).
- No other upload route was modified.

### Intentionally deferred

- Conversation-attachments rollout (own phase).
- Widget-attachments rollout (paired with widget-runtime UX for 403).
- Backfill of historical occupancy — only revisit if product decides
  forward-correct enforcement is too lenient for legacy workspaces.

## Phase 13 — conversation-attachment storage_gb rollout

### Audit findings

| Route | Classification | Notes |
| --- | --- | --- |
| `POST /api/conversation-attachments/:id/upload` | **SAFE TO GATE NOW** | Operator-authenticated via Supabase user token + `is_workspace_member` RPC. `workspace_id` arrives in the JSON body and is re-checked against the attachment row before upload. Uses canonical `uploadFile()`. Lower risk than widget/public paths — operator UX can surface a 403 without breaking visitors. |
| `POST /api/conversation-attachments/init` | **NOT A STORAGE-CREATION ROUTE** | Reserves a DB row only; no bytes persisted. Gating here would block visibility into the limit at upload time and split enforcement across two endpoints. |
| `DELETE /api/conversation-attachments/:id` | **NOT A STORAGE-CREATION ROUTE** | Frees bytes; gating would block quota recovery. |
| `server/routes/widgetAttachments.ts` (all) | **DO NOT GATE THIS PHASE** | Visitor/public-facing. Needs widget-runtime UX for a 403 before any rollout. Deferred. |

### Rollout applied

- `server/routes/conversationAttachments.ts` — `POST /:id/upload`:
  after operator auth, attachment-row ownership/state checks, and the
  declared-size guard, invoke
  `requireLimit('storage_gb', usageFnForLimit('storage_gb'))` once
  inline (mirrors `server/routes/storage.ts`). On rejection the
  middleware has already written 403; we additionally flip the reserved
  row to `status = 'failed'` so it does not strand in `'uploading'`. No
  route-local storage math, no second producer.

### Backward-compatibility safeguards

- Plans with `storage_gb = -1` (unlimited) skip the usage comparison —
  unchanged.
- All existing 401/403/404/409/413 paths still execute before the gate,
  so the gate never leaks limit info to unauthorized callers.
- Counter producer, resolver, capability registry, and middleware
  contracts untouched.

### Validation

- Confirmed `extractWorkspaceId` reads `req.body.workspace_id`
  (snake_case), matching this route's payload shape.
- Confirmed `usageFnForLimit('storage_gb')` resolves through
  `resolveStorageGb` → `workspace_usage_counters.storage_bytes`
  (canonical column, single producer).
- No widget/public attachment route was touched.

### Intentionally deferred

- `widgetAttachments.ts` rollout — visitor-facing UX for a 403 must
  land first.
- Backfill of historical occupancy — unchanged stance from Phase 12.

## Phase 14 — widget-attachment storage rollout

### Status

**Gated:** `POST /api/widget/attachments/:id/upload`.

### Implementation

- After token enforcement, row lookup, path scope check, and the
  declared-size guard, inject the trusted `workspace_id` (resolved
  from the widget token) into `req.body.workspace_id` and invoke
  `requireLimit('storage_gb', usageFnForLimit('storage_gb'))` once
  inline. Mirrors `server/routes/storage.ts` and
  `server/routes/conversationAttachments.ts`.
- On rejection the reserved `conversation_attachments` row is flipped
  to `status = 'failed'` (the middleware has already written the 403).

### Visitor-facing behavior

- Standard `requireLimit` 403 surfaces to the widget runtime as a
  generic upload failure — acceptable for v1.
- No read/download paths affected; only new uploads can be denied.
- No bespoke error mapping, no widget UX redesign.

### Backward-compatibility safeguards

- `storage_gb = -1` (unlimited) bypasses the comparison — unchanged.
- All prior 400/403/404/409/413/500 paths still run before the gate.
- Counter producer, resolver, capability registry, and middleware
  contracts untouched.

### Validation

- Confirmed `/init` does **not** call `uploadFile()`; only `/:id/upload`
  does. Single byte-creating branch gated.
- Confirmed `extractWorkspaceId` reads `req.body.workspace_id` after
  injection; the injected value is the server-resolved trusted one.
- Confirmed reserved-row failure flip mirrors operator-side behavior.

### Intentionally deferred

- Bespoke widget UX for cap-reached 403 (friendlier message, retry
  disable, admin-side telemetry banner).
- Historical storage backfill — unchanged stance from Phase 12.
