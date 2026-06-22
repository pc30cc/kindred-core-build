# Deferred / Preserved Backlog Matrix

_Last updated: 2026-06-22. Status: **AUDIT-ONLY PASS — zero runtime / schema / seed mutations applied (by design)**._

This document is the final triage pass over every intentionally
**preserved** or **deferred** item that remains after the plans /
entitlements work. It is the single, precise decision matrix future
maintainers should consult before touching any of these surfaces.

It does **not** introduce new policy. Each row consolidates a
classification already present in one of the authoritative companion
docs and pins it into a single bucket so cleanup, product, and
architecture work can be planned independently.

## 0. Authoritative companion docs

| Doc | Scope it owns |
|---|---|
| `docs/PLANS_SYSTEM_HANDOFF.md` | Top-level handoff and "deferred by design" list. |
| `docs/PLAN_DATA_RECONCILIATION.md` | Per-key audit of `billing_plans` legacy plan-JSON keys. |
| `docs/MAX_AGENTS_POLICY.md` | `max_agents` activation, deprecation policy, future-removal checklist. |
| `docs/ENFORCEMENT_COVERAGE_AUDIT.md` | Per-route gating / deferred / do-not-gate classification. |
| `docs/ENTITLEMENT_ARCHITECTURE.md` | Layered authority model and intentionally-deferred core items. |

If this matrix and a companion doc disagree, the companion doc wins
and this matrix must be updated to match.

## 1. Bucket definitions

| Bucket | Meaning | Action shape |
|---|---|---|
| **A — SAFE TO REMOVE NOW** | No live caller, no compatibility value, no policy ambiguity. | Mechanical removal in a focused cleanup. |
| **B — KEEP FOR ONE-RELEASE COMPATIBILITY** | Mirrors a canonical surface; preserved so a rollback does not lose data/limit. | Remove only after one full release on the canonical surface. |
| **C — NEEDS PRODUCT DECISION** | Removal or promotion would change shipped customer access, or requires admin sign-off on intended values. | Block on product owner; not an engineering decision. |
| **D — NEEDS ARCHITECTURE / COUNTER / RESOLVER WORK** | Cannot be activated/cleaned without a missing piece (resolver, helper, branch signal, drain policy). | Block on a scoped engineering pass; explicit unblock criterion required. |
| **E — KEEP PERMANENTLY** | Required by the layered model or by an internal/service contract. Not legacy. | No action. Documented as canonical. |
| **F — TOO RISKY / AMBIGUOUS — DO NOT TOUCH YET** | Plausibly needed, downstream consumers unknown, no safe canonical mapping. | Preserve with warnings; revisit only with explicit consumer audit. |

Bucket **A** is currently empty after this pass — see §4.

## 2. Decision matrix

### 2.1 Plan-JSON legacy keys (source: `PLAN_DATA_RECONCILIATION.md` §2)

| Item | Bucket | Why it sits here | Unblock criterion |
|---|---|---|---|
| `billing_plans.limits.team_members` | **B** | Mirrors `max_agents` exactly post-activation; preserved for rollback safety. | One full release on `max_agents` LIVE; then `UPDATE … limits - 'team_members'`. |
| `billing_plans.limits.agents` (`free`) | **B** | Same family as `team_members`; mirrors free-plan seat ceiling. | Same as above. |
| `billing_plans.limits.contacts` | **C** | Migrating to `max_contacts` would silently lift Pro 100 → 5000 and Enterprise 100 → unlimited. | Admin sign-off on intended Pro/Enterprise contact ceiling captured in `CONTACTS_LIMIT_POLICY.md`. |
| `conversations_monthly` | **F** | Mirrors `max_conversations` exactly; downstream consumers unproven. | Exhaustive consumer search across analytics/UI. |
| `conversations` (`free=100`) | **F** | Diverges from `max_conversations:50`; UI may still key off it. | Same as above. |
| `storage_mb`, `file_storage_mb` | **F** | Mirror `storage_gb`; no middleware consumer but unverified UI/analytics. | Consumer search. |
| `ai_credits` (`free`) | **F** | Mirrors `ai_credits_per_month`. | Consumer search. |
| `advanced_analytics` (entitlement) | **C** | No canonical equivalent; semantically distinct "advanced tier" flag. | Product decision: promote to registry as a feature, or deprecate. |
| `ai_enabled` (entitlement) | **C** | Predates the AI capability split (`ai_assistant` / `advanced_ai_agent` / `ai_kb_builder` / `ai_operator_assist`). | Product decision on which canonical surface(s) it maps to. |
| `ai_kb_monthly_credits`, `ai_kb_max_articles`, `ai_kb_max_chars`, `ai_requests_monthly`, `kb_articles` | **C** | Distinct units/scope vs canonical AI-KB limits; possibly real, possibly dead. | Product decision per key: promote with resolver, or formal deprecation. |
| `max_workspaces`, `data_retention_days`, `ai_kb_file_size_mb`, `ai_kb_file_count` (missing from seeds) | **D** | Canonical keys without resolvers/consumers; registry default applies harmlessly. | Land the corresponding resolver/consumer, then backfill seeds. |

### 2.2 RPC / SQL surfaces (source: `MAX_AGENTS_POLICY.md` §6)

| Item | Bucket | Why it sits here | Unblock criterion |
|---|---|---|---|
| `public.accept_workspace_invitation(text)` RPC body | **E (with future-removal option in `MAX_AGENTS_POLICY.md` §8.1)** | `EXECUTE` revoked from `anon`/`authenticated`/`public`; `service_role` only. No live caller in `server/` or `src/`, but Supabase `types.ts` still references it and SQL/admin contexts may call it. | Explicit DB-cleanup approval + final internal-caller audit + `types.ts` regeneration. |
| `accept_workspace_invitation_as(_token, _user_id)` companion RPC | **E (canonical)** | Sole reachable path from the canonical Express route. | n/a. |
| `requireLimit('max_agents', …)` on `POST /api/workspace-members/accept-invitation` | **E (canonical)** | Only valid `max_agents` chokepoint. | n/a — do not duplicate. |
| Diagnostics warning text for `team_members` / `agents` | **E** | The drift is real until §2.1 row 1/2 retire; warning is the operator reminder. | Silenced only as part of the legacy-key removal pass. |

### 2.3 Route enforcement (source: `ENFORCEMENT_COVERAGE_AUDIT.md` §3)

| Item | Bucket | Why it sits here | Unblock criterion |
|---|---|---|---|
| `POST /api/conversations` (create) — `max_conversations` | **D** | A correct `currentUsageFn` must mirror counter semantics; getting it wrong silently blocks chat. | Single shared usage helper (already enforced at the widget message / offline-message / start-from-visitor boundaries; this route is a redundant secondary surface). |
| `POST /api/visitors/track` — `max_visitors` (workspace router) | **D** | Visitor-tracking is widget-public; workspace-only middleware would mis-deny anonymous visitors. | Widget-aware limit pass (already gated at `POST /api/widget/track`). |
| `POST /api/calls/:id/invite` — voice/video gating | **D** | Single undifferentiated handler covers both new participant adds and re-ring/recovery; deny-on-create vs allow-on-continuity cannot be expressed without a branch signal. | Either an explicit `reason: 'new' \| 'reissue'` body field, or a `call_participants` idempotency contract. |
| `callQueue.ts` offer/accept | **D** | Acts on already-existing queue entries; gating would strand in-flight queue work. | Per-surface drain policy decision. |
| `storage.ts`, `widgetAttachments.ts` — `storage_gb` | **D** | No usage helper aggregates total stored bytes per workspace; `requireLimit` fails closed. | Land a storage-bytes usage helper, then mount `requireLimit('storage_gb', …)`. |
| `cannedResponses.ts` under `automation` | **F** | Concepts are not equivalent; gating would over-scope. | Product decision on whether canned responses are an `automation` sub-feature or a separate capability. |
| All `aiAgent.ts` non-generator routes (settings / runs / qna / knowledge-index / files / topics / workflows / tools / tests / regression / guidance / routing / learning / overview / debug) | **E** | Read/status/admin/finalize surfaces; blanket-gating strands in-progress work and breaks admin tooling. | n/a — explicitly classified as do-not-gate. |
| `aiKb.ts` job-consumption routes (`generated/accept|publish`, `jobs/:id`) | **E** | Act on already-paid jobs; re-gating consumption blocks finishing paid work. | n/a. |
| `callInvitations.ts` cancel/get/list, `widgetCallInvitations.ts`, `callbacks.ts`, `widgetCallbacks.ts` cancel/status, `callAvailability.ts`, `workspaceCalls.ts` | **E** | Read/cancel/cleanup must survive plan downgrade. | n/a. |
| Admin / health / auth / billing / plans / privacy / livekitWebhook / widget bootstrap / cdn / mapGeo / realtimeControl | **E** | Locking these creates deadlocks or breaks public widget loading. | n/a. |

### 2.4 Optional polish (source: `PLANS_SYSTEM_HANDOFF.md` §4)

These are not deferred work — they are explicitly **optional future
polish**. Reclassified here so they are no longer mixed into the
deferred backlog:

- Customer usage history charts / time-series.
- Context-aware upgrade CTAs and recommendation UX.
- Surfacing `max_contacts` live occupancy in the customer payload.
- Bulk-edit / CSV affordances for limit overrides in admin.
- Unifying the three override tables into one schema.
- Audit-log surfacing improvements for plan / override mutations.
- Additional call-route enforcement once a drain policy is defined.

Bucket: **optional polish**, outside this matrix's tracking responsibility.

## 3. Triage policy locked

1. Compatibility items stay until proven safe to remove. "Old" is not
   evidence; "no live caller AND one full release on the canonical
   surface" is.
2. Policy-heavy items (bucket **C**) are not forced into engineering
   cleanup passes. They block on a product owner.
3. Architecture-heavy items (bucket **D**) are not mislabeled as simple
   cleanup. Each carries an explicit unblock criterion.
4. Legacy keys without a safe canonical mapping (bucket **F**) remain
   preserved with `validatePlanPayload` warnings. Removal requires an
   exhaustive consumer search.
5. Diagnostics output is the long-running drift surface and must not be
   silenced for cosmetic reasons.
6. Bucket transitions happen only via an explicit follow-up phase that
   names the row, the prior bucket, the new bucket, and the evidence.

## 4. Cleanup actually applied this pass

**None.** This is an audit/triage pass.

- No row in `billing_plans` was mutated.
- No registry key was added, removed, or renamed.
- No middleware, route, or RPC was modified.
- No test was added or removed.
- The only change in this phase is documentation (this file plus
  cross-reference pointers in the four companion docs listed in §0).

The audit confirmed bucket **A (SAFE TO REMOVE NOW)** is currently
empty: every preserved item has a documented compatibility, policy,
or architecture rationale. Per the standing rule _"prefer one safely
preserved deferred item over one risky cleanup,"_ no cleanup is
performed.

## 5. Backward-compatibility safeguards still in force

- `validatePlanPayload` continues to soft-warn (never error) on every
  legacy key listed in §2.1.
- `legacyPlanKeys.test.ts` continues to pin the soft-warn contract.
- Browser-side bypass on `accept_workspace_invitation(text)` remains
  closed; `service_role` retains `EXECUTE`.
- `requireLimit('max_agents', …)` chokepoint is unique and unchanged.
- Customer-facing `/api/plans/workspace/:id/effective` payload is
  unchanged.

## 6. How to extend this matrix

1. When adding a new preserved/deferred item anywhere in the codebase,
   add a row here with its bucket and unblock criterion in the same
   change.
2. When closing a row, move it to the relevant companion doc's
   "applied" / "removed" log first, then strike (do not delete) the
   row here with the date and the closing phase name. The matrix is an
   audit trail.
3. Never silently re-bucket. Every transition cites prior bucket → new
   bucket and the evidence.

## 7. Hard acceptance checks (this phase)

- [x] No canonical capability key renamed.
- [x] No customer-facing entitlement behavior changed.
- [x] No compatibility item removed prematurely.
- [x] Every remaining intentional backlog item is bucketed.
- [x] Cleanup-only, policy-heavy, and architecture-heavy items are
      separated.
- [x] Optional polish is reclassified out of the deferred backlog.
- [x] No route / env / schema / key rename occurred.
- [x] Future maintainers can identify the next safe action per row
      without re-reading the full phase log.
