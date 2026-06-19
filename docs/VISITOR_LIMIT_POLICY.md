# Visitor Limit Policy & Rollout Readiness

Status: **DEFERRED — no rollout in this phase.**
Scope: `max_visitors` numeric limit only. No storage/upload, no
conversation rollout, no schema/route renames.

This document is the route-truth and policy reference that the next
phase must resolve before `requireLimit('max_visitors', …)` can be
attached anywhere. It exists because `max_visitors` looked like the
next logical candidate after `max_conversations`, but a careful audit
showed it is **not yet safe to gate**.

---

## 1. Hard blocker (single root cause)

`workspace_usage_counters.visitors_count` is **never written**.

Evidence:

- The column is declared in
  `supabase/migrations/20260415220905_dd2492ef-…sql` with
  `DEFAULT 0`.
- A repo-wide search (`rg visitors_count`) finds **zero** producers:
  no SQL trigger, no RPC, no server-side increment, no worker job.
  The only readers are `usageResolvers.ts` (`resolveMaxVisitors`)
  and the column declaration itself.
- `visitor_sessions` rows are inserted from multiple paths
  (`widget.ts`, `widgetIdentity.ts`, `visitors.ts`) **without any
  corresponding usage-counter update**.

Consequence: `usageFnForLimit('max_visitors')` currently returns `0`
for every workspace, every period. Attaching
`requireLimit('max_visitors', …)` today would be a **silent no-op
gate** — it would never deny, would create the false impression that
the limit is enforced, and would mask the missing counter pipeline.

This is the same class of risk the audit explicitly warns about: do
not gate on a counter source that is not aligned with product
meaning.

## 2. Product policy still undefined

Even if the counter pipeline existed, the meaning of "a visitor" for
the cap has not been chosen. The candidate semantics are mutually
exclusive and produce very different numbers:

| Option | Counts toward `max_visitors` | Notes |
|---|---|---|
| A. New `visitor_sessions` row per period | Every first insert in a calendar month | Closest to current schema; double-counts users across browsers/devices. |
| B. Distinct `visitor_id` per period | Each unique widget-issued visitor identity | Requires de-dup against `identity_merges`. |
| C. Distinct identified contact per period | Visitors that resolve to a `contacts` row | Excludes anon traffic; smallest number. |
| D. Lifetime distinct visitors | Not period-scoped | Would require `periodKind: 'lifetime'`, different resolver shape. |

No product decision has been recorded. Until one is, the resolver, the
counter writer, and the gate cannot be aligned.

## 3. Cap-reached behavior also undefined

Open questions that must be answered before any widget-facing gate is
attached (cf. the same questions resolved for `max_conversations` in
`CONVERSATION_LIMIT_POLICY.md`):

1. When the cap is hit, must **existing known visitors** keep
   functioning? (Strongly recommended: yes — gate only on the
   *new-visitor* branch, never on revisits or message replies.)
2. Does widget chat continue for already-tracked visitors after the
   cap is reached? (Recommended: yes.)
3. What HTTP response should the widget surface for a denied
   first-track? Silent drop, 403, or a soft "tracking paused" signal?
4. Does the operator-side `POST /api/visitors/track` (if it exists as
   an authenticated path) share the same cap, to avoid asymmetric
   enforcement?

## 4. Route truth audit

Classification of every route that could plausibly consume
`max_visitors`. **No route is `SAFE TO GATE NOW`.**

| Route | Branch | Creates / counts a visitor? | Workspace_id at MW time? | Classification |
|---|---|---|---|---|
| `POST /api/widget/identify` (`widgetIdentity.ts`) | new `visitor_sessions` insert | Yes (first-seen branch) | Yes, after token verify | **STILL AMBIGUOUS** — counter not wired; semantics unchosen. |
| `POST /api/widget/identify` | existing-session update | No (revisit) | n/a | **DO NOT GATE** — revisit, never creation. |
| `POST /api/widget/message` | new `visitor_sessions` insert when missing | Yes (incidental) | Yes | **STILL AMBIGUOUS** — would also need same counter pipeline. Already gated for `max_conversations`; do not stack a no-op visitor gate on top. |
| `POST /api/widget/message` | reply branch | No | n/a | **DO NOT GATE**. |
| `POST /api/visitors/track` (`visitors.ts`) | session upsert + page view | Mixed: insert vs update | Yes | **STILL AMBIGUOUS** — the same row is both created and updated here; only the insert sub-branch is a candidate. |
| `POST /api/visitors/page-view` | page view only | No (visitor must already exist) | Yes | **DO NOT GATE** — page views must never consume `max_visitors`. |
| `GET /api/visitors/*` (list/detail) | read-only | No | n/a | **NOT A VISITOR-CREATION ROUTE**. |
| `POST /api/conversations/start-from-visitor` | reuses existing visitor | No | Yes | **DO NOT GATE** for `max_visitors` — already gated for `max_conversations`. |
| `widget*Attachments`, `widgetCallbacks`, `widgetCallInvitations`, `widgetDepartments` | various | No | — | **NOT A VISITOR-CREATION ROUTE**. |

Outcome: every candidate is blocked by §1 (no counter writer) and §2
(undefined semantics). None can be safely gated.

## 5. What must be true before rollout

The next phase MUST deliver, in this order, before any
`requireLimit('max_visitors', …)` attachment:

1. **Pick semantics** from §2 (recommended: Option B — distinct
   `visitor_id` per calendar month, de-duplicated against
   `identity_merges`).
2. **Wire a counter producer** that matches the chosen semantics.
   Two acceptable implementations:
   - DB trigger on `visitor_sessions` insert that upserts
     `workspace_usage_counters(workspace_id, period).visitors_count`
     for the current `to_char(now(),'YYYY-MM')` period; OR
   - server-side increment inside the single canonical first-track
     branch (mirroring the conversation pattern), guarded by the
     same period key.
   Whichever is chosen, it must be the **only** writer; no ad-hoc
   counting inside route handlers.
3. **Confirm resolver alignment** — `resolveMaxVisitors` already reads
   `visitors_count` from `workspace_usage_counters`. No resolver
   change is required if the producer writes that exact column.
4. **Decide cap-reached UX** per §3 and document it here.
5. **Then, and only then,** attach `requireLimit('max_visitors',
   usageFnForLimit('max_visitors'))` on exactly the *new-visitor*
   branch — never on revisits, never on page views, never on replies.
   Bypass policy stays route-local (`!auth.isAdmin` where
   applicable), matching the AI KB jobs and `max_conversations`
   precedent. No global admin short-circuit in `requireLimit`.

## 6. Out of scope for this phase

- No code changes in `server/`.
- No migrations.
- No changes to widget bootstrap, auth, or visitor tracking
  architecture.
- No storage/upload work.
- No re-touching of `max_conversations` rollout.