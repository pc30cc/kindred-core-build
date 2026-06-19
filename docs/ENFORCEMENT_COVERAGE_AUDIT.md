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
| `storage_gb` | yes (`workspace_usage_counters.storage_bytes`) | **DO NOT GATE** | Same plan-limits gap. Also: `POST /api/storage/upload` accepts service-role / anon tokens used by widget attachment flows — gating fail-closed would break visitor-side uploads system-wide. |
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

## 9. Phase 4 — Conversation creation readiness (no rollout)

Outcome: **`max_conversations` remains DEFERRED.** No route was gated
this phase. Full route truth and the recommended unblock sequence
live in [`CONVERSATION_LIMIT_POLICY.md`](./CONVERSATION_LIMIT_POLICY.md).

Summary of the audit:

| Route | Classification |
|---|---|
| `POST /api/conversations/start-from-visitor` | AMBIGUOUS — DEFERRED. Operator-initiated, idempotent (reuses open conversations); not the dominant creator, so isolated gating would produce asymmetric enforcement vs widget traffic. |
| `POST /api/conversations/send-message` | NOT A CREATION ROUTE. Sends into an existing conversation — must never be gated by `max_conversations`. |
| `POST /api/widget/message` | DO NOT GATE (this phase). Visitor/public traffic, post-`enforceWidgetToken`; needs a widget-aware adapter and defined cap-reached UX before middleware. |
| `POST /api/widget/offline-messages` | DO NOT GATE (this phase). Same widget/public concerns as above. |
| `services/ai-agent/intro.ts` | NOT A ROUTE. Internal server-side intro insert. |

Hard rule preserved: `requireLimit('max_conversations', …)` will only
ever be attached on **conversation-creation branches**, never on
message-send branches inside an existing conversation.
