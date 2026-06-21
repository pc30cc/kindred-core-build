# Enforcement Coverage Audit

_Last updated: 2026-06-21. Status: **CORE COMPLETE** — see
[PLANS_SYSTEM_HANDOFF.md](./PLANS_SYSTEM_HANDOFF.md). Items below remain
as the per-route source of truth for which surfaces are gated, deferred,
or intentionally ungated._

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
| `POST /api/ai-agent/generate-business-description` (`aiAgent.ts`) | `requireModule('ai_assistant')` | **Added (AI Agent route audit + selective gating).** Brand-new optional generate action — calls a real AI completion. Owner/admin auth still enforced in-handler. No in-progress state, so denial blocks only NEW work. |
| `POST /api/ai-agent/learning-candidates/generate` (`aiAgent.ts`) | `requireModule('ai_assistant')` | **Added (same phase).** Discrete generator that drafts new pending candidates. Review / approve / reject / convert routes remain ungated so existing candidates can always be finalized. |

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
| `server/routes/callInvitations.ts` POST `/` | composed via `loadEffectiveCallEntitlements` | **GATED.** Channel-scoped (`voice_enabled` / `video_enabled`). Denial returns `403 plan_forbidden`; cancel/get/list ungated. |
| `server/routes/calls.ts` POST `/:id/recording/start` | `eff.recording_enabled` | **GATED (Phase: Call Route Enforcement Expansion — Strict Drain-Policy Pass).** Pure create boundary. `recording/stop` and call end/hangup remain ungated so in-flight recordings always finalize. |
| `server/routes/callCenter.ts` POST `/calls/:id/recording/start` | `eff.recording_enabled` | **GATED (same phase).** Operator-side mirror of the above; same composer, same denial shape. `/recording/stop` and `/recording/status` ungated. |
| `server/routes/callInvitations.ts` cancel/get/list, `widgetCallInvitations.ts`, `callbacks.ts`, `widgetCallbacks.ts` | composer exists | DO NOT GATE — read/cancel/cleanup must survive plan downgrade. |
| `server/routes/callQueue.ts` (offer/accept), `widget` `call-queue/enqueue`, `callWidget.ts` `calls/request` and `callbacks/request` | composed call entitlements | DEFERRED — operate on already-existing queue entries OR are public/widget surfaces with undefined denial UX. Need per-surface drain decision before gating. |
| `server/routes/callAvailability.ts`, `workspaceCalls.ts` | n/a | DO NOT GATE — visibility/configuration screens needed during downgrade management. |
| `server/routes/cannedResponses.ts` | `requireFeature('automation')` | "Canned responses" and the `automation` feature are not the same concept; gating them under `automation` would over-scope. |
| `server/routes/email.ts` (`POST /send`) | `requireChannel('email')` | **RESOLVED via split (Phase: Email Surface Split + Channel Gating).** `POST /api/email/send` stays as the platform/auth/transactional surface and is intentionally NOT plan-gated. A dedicated `POST /api/email/send-channel` was added as the canonical channel-email surface and is gated with `requireChannel('email')`. In-process channel sends use `server/services/email/sendChannelEmail.ts`. See `EMAIL_SURFACE_SPLIT.md`. |
| `server/routes/storage.ts`, `server/routes/widgetAttachments.ts` | `requireLimit('storage_gb', …)` | No usage helper currently aggregates total stored bytes per workspace. `requireLimit` fails closed when usage cannot be determined — wiring it without that helper would deny every upload. |
| `server/routes/aiAgent.ts` — settings / platform-settings / sources / data-sources / runs / runs/:id/inspect / qna CRUD / knowledge-index (rebuild, status, sync-source, chunks, rebuild-source) / files (upload, list, limits, reindex, pause, resume, preview, logs, delete) / topics / workflows / message-triggers / tools / tool-servers / test-cases / test-runs / test-summary / suggested-test-cases / regression-* / guidance / routing / learning-candidates (list, patch, approve, reject, convert-*) / operator-assist analytics / overview / debug | `requireModule('ai_assistant')` | **Audited (AI Agent route audit + selective gating).** These are read/status/admin/config/finalize surfaces, or operate on already-created rows/jobs/runs. Many are reached by global admins and operational tooling, several have explicit dev/admin bypass semantics (e.g. `operator/suggest-reply`). Blanket-gating would strand in-progress work or break admin tooling — kept admin-safe. Only the two pure new-action generators above were promoted in this phase. |
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

1. ~~Decide whether `email.ts` should split into two endpoints~~ — **done.**
   See `EMAIL_SURFACE_SPLIT.md`.
2. Plan a coordinated `voice_video` rollout: backfill `voice_video=true`
   on plans that should have it, then gate the call routes in one pass.
3. Run `GET /api/plans/admin/diagnostics` periodically to surface drift
   between `CAPABILITY_REGISTRY`, `USAGE_BACKED_LIMIT_KEYS`, and
   `billing_plans.limits`.
4. Per-limit deferred items (e.g. AI-intro internal helper for
   `max_conversations`, `callWidget.ts` ensure-session for
   `max_visitors`, operator-assist credit wiring) — see the per-limit
   policy docs.
5. **Contacts (final state).** Contacts is plan-modeled (`contacts`
   module + `contact_import` / `contact_export` / `contact_tags` /
   `contact_notes` / `bulk_contact_actions` features) and `max_contacts`
   is promoted and enforced through the canonical TypeScript stack at
   `POST /api/contacts` and `POST /api/contacts/bulk`
   (`requireLimit('max_contacts', usageFnForLimit('max_contacts'))`).
   `resolveMaxContacts` lives in `usageResolvers.ts`; the route helper
   is `server/services/billing/contactsLimit.ts`. Bypass is closed:
   `INSERT ON public.contacts` and `EXECUTE ON create_contact /
   bulk_create_contacts` are revoked from `authenticated`. No SQL-side
   entitlement composer was introduced. Update / delete / tag / note
   flows remain direct PostgREST and are intentionally out of scope.
   Counting model and bulk all-or-nothing semantics are recorded in
   `docs/CONTACTS_LIMIT_POLICY.md`.

---

## Workspace-Level Limit Overrides — Cross-cutting pass (2026-06-21)

Closed the long-standing gap where usage-backed numeric limits were
plan-only. New canonical resolution path:

```
workspace_limit_overrides[ws][key]  →  billing_plans.limits[key]  →  registry.default
```

**Implementation:** `public.check_workspace_entitlement` (the single
RPC every TypeScript enforcement consumer reaches via
`checkEntitlementFromDB`) now consults `public.workspace_limit_overrides`
before the plan JSONB. Because every usage-backed limit consumer
already routes through `requireLimit(...)` → `checkEntitlementFromDB`
→ this RPC, override support is automatic for:

- `max_conversations`
- `max_visitors`
- `storage_gb`
- `ai_kb_jobs_per_month`
- `ai_credits_per_month` (also via `deduct_ai_credits`, which itself
  calls `check_workspace_entitlement`)
- `max_contacts`

The `-1` unlimited sentinel and all fail-closed branches are preserved.
The diagnostics endpoint `GET /api/plans/workspace/:id/effective` now
stamps `source: 'override' | 'plan' | 'default'` on every limit and
reads the same overrides table — diagnostics, effective-state, and
enforcement therefore agree by construction.

Admin surface (additive, no rename): `POST /api/plans/admin/overrides/limit`,
`DELETE /api/plans/admin/overrides/limit/:id`, and the existing
`GET /api/plans/admin/overrides/:workspaceId` now also returns `limits`.
Registry guardrails: only keys with `type === 'limit'` and
`workspaceOverridable !== false` are accepted.

See [USAGE_LIMIT_OVERRIDE_MODEL.md](./USAGE_LIMIT_OVERRIDE_MODEL.md).

## Super Admin Limit Override UI Completion (operability pass)

The Plans admin Workspace Console now exposes set / update / clear
controls for every registry-declared limit on a per-workspace basis.
The UI consumes the canonical helpers `setWorkspaceLimitOverride` and
`deleteWorkspaceLimitOverride`, and reloads the effective payload after
each mutation. No new backend rollout, route, capability key, or
schema rename was introduced. Module/channel/feature overrides retain
their existing interaction pattern; the limit row reuses the same
source-badge + Clear affordance for visual parity.

## Customer-Facing Usage / Plan Visibility (product completion pass)

`/app/billing` now ships a default **Plan & Usage** tab
(`src/components/billing/PlanUsagePanel.tsx`) that renders the
canonical `/api/plans/workspace/:id/effective` payload plus the
registry catalog. Workspace owners can see plan name, every
`userVisible` limit's effective value and source, current usage from
the canonical counter columns where available, modules, channels and
features. `-1` renders as `Unlimited`. Limits without a canonical
customer-payload counter render a "not tracked in this view" notice
rather than fabricated `0 / N` math. Super Admin override mutation
controls remain exclusive to `PlansPage.tsx`. No enforcement boundary,
capability key, route, env, or schema changed. See
`docs/CUSTOMER_USAGE_VISIBILITY.md`.
