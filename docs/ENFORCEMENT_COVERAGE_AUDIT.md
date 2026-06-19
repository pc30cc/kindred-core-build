# Enforcement Coverage Audit

This audit classifies every plan-relevant backend route surface and records
exactly which middleware (`requireFeature`, `requireModule`, `requireChannel`,
`requireAICredits`, `requireLimit`) is — or is intentionally not — applied.

It is deliberately conservative. Gating is added only where policy is
unambiguous and the risk of blocking legitimate traffic is near-zero.
Everything else is recorded as "ambiguous — deferred" and stays untouched.
Per-limit truth (`max_conversations`, `max_visitors`, `storage_gb`,
`ai_credits_per_month`, `ai_kb_jobs_per_month`) lives in the per-limit
policy docs linked from §6.

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
| `server/routes/callInvitations.ts`, `callQueue.ts`, `callAvailability.ts`, `workspaceCalls.ts`, `widgetCallInvitations.ts`, `widgetCallbacks.ts` | `requireModule('voice_video')` + `requireChannel('voice'\|'video')` | A canonical composer now exists at `server/services/calls/entitlementComposer.ts` that ANDs plan flags with `loadEffectiveCallChannels`. Routes are still not gated: in-flight queue/offer/cancel semantics need a "deny on create, allow on cleanup" policy first. See `CALL_ENTITLEMENT_COMPOSITION.md`. |
| `server/routes/callQueue.ts`, `callAvailability.ts` | `requireModule('call_center')` + `requireFeature('call_queue')` | Composer can resolve effective state, but mid-session denial would break in-flight queue entries. Deferred until a drain policy exists. |
| `server/routes/callbacks.ts`, `widgetCallbacks.ts` | `requireFeature('call_callbacks')` | Visitor-side already gated by `callback_offer_after_timeout` runtime path; operator-side list/patch must remain reachable on downgrade for cleanup. Deferred. |
| `callCenter.ts` recording endpoints | `requireFeature('call_recording')` | Cleanest future enforcement point. Deferred because the composer is unwired from any handler this phase. |
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

## 6. Current numeric-limit rollout state

Per-limit truth lives in the dedicated policy docs. This table is the
quick index — it must agree with those docs and with the code.

| Limit key                | Status     | Gated surfaces                                                                                                                          | Policy doc                                  |
|--------------------------|------------|-----------------------------------------------------------------------------------------------------------------------------------------|---------------------------------------------|
| `max_conversations`      | rolled out | `POST /api/widget/message` (creation branch), `POST /api/widget/offline-messages`, `POST /api/conversations/start-from-visitor`         | `CONVERSATION_LIMIT_POLICY.md`              |
| `max_visitors`           | rolled out | `POST /api/visitors/track` (true-new-this-month insert), `POST /api/widget` `/track` (true-new-this-month insert)                       | `VISITOR_LIMIT_POLICY.md`                   |
| `storage_gb`             | rolled out | `POST /api/storage/upload`, `POST /api/conversation-attachments/:id/upload`, `POST /api/widget/attachments/:id/upload`                  | `STORAGE_LIMIT_POLICY.md` + counter arch    |
| `ai_kb_jobs_per_month`   | rolled out | `POST /api/ai-kb/jobs` (route-local Super Admin bypass kept explicit)                                                                   | `PLAN_LIMIT_ALIGNMENT.md`                   |
| `ai_credits_per_month`   | enforced via atomic RPC | `POST /api/ai/complete` + AI-KB worker per-page consumer (`deduct_ai_credits` RPC). `requireLimit` is intentionally NOT layered on top. | `AI_CREDITS_POLICY.md`                      |

Counters are written by a single canonical producer per metric (DB
trigger or atomic RPC). The application MUST NOT write
`workspace_usage_counters.*` directly outside the Super Admin "usage
adjust" route — enforced by a CI invariant test in
`src/test/billing/singleWriterInvariants.test.ts`.

Capability-registry, resolver, and middleware contracts remain
unchanged across rollouts. No global admin short-circuit was added to
`requireLimit`; bypasses (where they exist) are explicit and route-local.

## 7. Recommended follow-up

1. Decide whether `email.ts` should split into two endpoints — one for
   platform/auth mail (always allowed) and one for channel-email send
   (gated by `requireChannel('email')`).
2. Plan a coordinated `voice_video` rollout: backfill `voice_video=true`
   on plans that should have it, then gate the call routes in one pass.
3. Run `GET /api/plans/admin/diagnostics` periodically to surface drift
   between `CAPABILITY_REGISTRY`, `USAGE_BACKED_LIMIT_KEYS`, and
   `billing_plans.limits`.
4. Per-limit deferred items (e.g. AI-intro internal helper for
   `max_conversations`, `callWidget.ts` ensure-session for
   `max_visitors`, operator-assist credit wiring) — see the per-limit
   policy docs.
