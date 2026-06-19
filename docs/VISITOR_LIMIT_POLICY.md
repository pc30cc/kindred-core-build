# Visitor Limit Policy & Rollout Readiness

Status: **Counter foundation in place (Phase 7). Rollout still
deferred — one tiny follow-up phase remaining to attach the gate.**
Scope: `max_visitors` numeric limit only. No storage/upload, no
conversation rollout, no schema/route renames.

This document is the route-truth and policy reference for
`max_visitors`. The original blocker (no producer for
`workspace_usage_counters.visitors_count`) was resolved in Phase 7;
see [`VISITOR_COUNTER_ARCHITECTURE.md`](./VISITOR_COUNTER_ARCHITECTURE.md)
for the locked semantics and the single-writer trigger.

---

## 1. Hard blocker (single root cause)

~~`workspace_usage_counters.visitors_count` is never written.~~
**Resolved in Phase 7.** The canonical producer is now the
`AFTER INSERT` trigger
`trg_visitor_sessions_count_visitor` on `public.visitor_sessions`,
backed by `public.tg_visitor_sessions_count_visitor()`. It is the
single writer; no server-side increment is permitted. See
`VISITOR_COUNTER_ARCHITECTURE.md` for the full contract.

## 2. Product policy still undefined

**Resolved in Phase 7.** Locked semantics:
**distinct `visitor_id` per workspace per UTC calendar month.**
Revisits, 30-minute reconnects that insert a new
`visitor_sessions` row, page views, and message replies do not
increment. Identity-enrichment updates do not increment. Rejected
alternatives are recorded in `VISITOR_COUNTER_ARCHITECTURE.md` §1.

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

Status of the unblock checklist after Phase 7:

1. ~~Pick semantics.~~ **Done** — distinct `visitor_id` per UTC
   calendar month.
2. ~~Wire a single canonical counter producer.~~ **Done** — DB
   trigger `trg_visitor_sessions_count_visitor`.
3. ~~Confirm resolver alignment.~~ **Done** — `resolveMaxVisitors`
   reads `workspace_usage_counters.visitors_count` for the current
   UTC `YYYY-MM` period; the producer writes that exact column for
   that exact period.
4. **Open** — decide cap-reached widget UX (recommend: deny only
   the *new-visitor* branch, never revisits/page-views/replies).
5. **Open** — attach `requireLimit('max_visitors',
   usageFnForLimit('max_visitors'))` on exactly that new-visitor
   branch, with route-local `!auth.isAdmin` bypass, matching the
   AI KB jobs and `max_conversations` precedent. No global admin
   short-circuit in `requireLimit`.

Items 4–5 are the entire remaining scope for the next phase.

## 6. Out of scope for this phase

- No code changes in `server/`.
- No migrations.
- No changes to widget bootstrap, auth, or visitor tracking
  architecture.
- No storage/upload work.
- No re-touching of `max_conversations` rollout.