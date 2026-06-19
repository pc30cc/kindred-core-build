# Visitor Limit Policy & Rollout Readiness

Status: **Phase 9 — `max_visitors` is now safely gated on the
true-new-this-month branch of `POST /api/visitors/track`.**
Reconnects, revisits, updates, page views, heartbeats, disconnects,
and replies remain ungated. The DB trigger
`trg_visitor_sessions_count_visitor` remains the single writer of
`workspace_usage_counters.visitors_count`.
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
`max_visitors`. **No route is `SAFE TO GATE NOW`** — re-confirmed in
Phase 8 against the locked monthly counter.

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

Outcome (post-Phase 7+8): §1 and §2 are resolved, but every existing
creation branch (`/api/visitors/track` insert, `/api/widget/message`
visitor-session insert, `callWidget.ts` ensure-session insert) keys
off a **30-minute staleness window**, while the counter and locked
semantics key off a **UTC calendar month**. Attaching the gate at a
30-minute branch would deny same-month revisits when the cap is
reached — which the trigger correctly does NOT count — and so
contradicts the locked rule. None can be safely gated yet.

## 4a. Phase 8 audit — exact blocker

Gate granularity ≠ counter granularity. To gate correctly, the
chosen branch must run `requireLimit('max_visitors',
usageFnForLimit('max_visitors'))` **only** when the request would
actually create the first `visitor_sessions` row for
`(workspace_id, visitor_id)` this UTC month.

Resolution path for the next phase (not implemented here):

1. Pick a single creation site (preferred: `POST /api/visitors/track`
   insert sub-branch). Do not touch the others.
2. Add a **route-local membership pre-check**: "is there any
   `visitor_sessions` row for `(workspace_id, visitor_id)` with
   `created_at >= date_trunc('month', now() AT TIME ZONE 'UTC')`?"
   This mirrors the predicate the trigger already uses; it is a
   membership read, not a second counter.
3. If the pre-check says "in-month revisit" → skip the gate, proceed.
4. If the pre-check says "new this month" → invoke
   `requireLimit('max_visitors', usageFnForLimit('max_visitors'))`
   before the insert.
5. Keep route-local `!auth.isAdmin` bypass; no global short-circuit
   in `requireLimit`.

The trigger remains the **only** writer of `visitors_count`. The
pre-check reads `visitor_sessions` only and never writes counters.

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
4. **Decided (recommended, not yet enforced)** — cap-reached UX:
   deny only the true new-visitor branch with the standard
   `requireLimit` 403; revisits, updates, page views, heartbeats,
   disconnects, and replies continue unchanged.
5. **Open** — add the route-local in-month membership pre-check at
   one creation site (preferred: `POST /api/visitors/track` insert
   sub-branch) and attach `requireLimit('max_visitors',
   usageFnForLimit('max_visitors'))` only on the true-new-visitor
   path of that pre-check, with route-local `!auth.isAdmin` bypass.
   No global admin short-circuit in `requireLimit`. No second
   counter writer.

Item 5 is the entire remaining scope for the next phase.

## 5a. Phase 9 — rollout result

**Chosen rollout site:** `POST /api/visitors/track`, the
`else { /* Create new session */ }` sub-branch in
`server/routes/visitors.ts` (the only path on that route that can
produce a `visitor_sessions` row for a previously-unseen 30-minute
window). This is the canonical public ingestion endpoint and the
only one touched in this phase.

**True-new-vs-reconnect discriminator:**
`server/services/billing/visitorLimit.ts` →
`enforceMaxVisitorsLimitIfNewThisMonth(req, res, supabase,
workspaceId, visitorId)`. Before invoking the shared limit
middleware, the helper reads `visitor_sessions` for any row matching
`(workspace_id, visitor_id)` with `created_at >= start of current
UTC month`. This predicate is intentionally identical to the one
used by `tg_visitor_sessions_count_visitor()`, so gate decisions and
counter increments cannot disagree.

- Row found → in-month reconnect/revisit. The helper returns `true`
  immediately. `requireLimit` is **not** invoked. The cap is **not**
  consumed. The route proceeds to insert the new
  `visitor_sessions` row; the trigger then runs its own check and
  correctly leaves `visitors_count` unchanged.
- No row found → true-new-this-month visitor. The helper invokes
  `requireLimit('max_visitors', usageFnForLimit('max_visitors'))`
  inline, mirroring the Phase 5 `enforceMaxConversationsLimit`
  pattern. On cap-reached, the middleware writes its standard 403
  and the route aborts before the insert; the trigger never runs,
  so `visitors_count` stays consistent.
- On read error, the helper fails **open** (treats the request as
  an in-month revisit) so transient DB hiccups never block
  legitimate traffic. The trigger remains source of truth.

**Branches that stay ungated (re-confirmed):**

- `POST /api/visitors/track` update branch (existing 30-min session
  row found).
- `POST /api/visitors/heartbeat`, `/page-view`, `/disconnect`.
- `POST /api/widget/identify` (no `visitor_sessions` insert in this
  route).
- `POST /api/widget/message` reply branch and visitor-session
  insert sub-branch (already gated for `max_conversations`; no
  visitor gate stacked on top).
- `callWidget.ts` ensure-session insert,
  `widgetCallInvitations.ts`, `calls.ts`.
- All operator-side reads.

**Cap-reached behavior:** standard `requireLimit` 403 response
shape, identical to AI KB jobs and `max_conversations`. No new
widget UX surface introduced. Existing `visitor_sessions` rows
continue to receive page views, heartbeats, and chat traffic without
any new gate.

**Bypass:** none added. The route is public/widget traffic, so the
`!auth.isAdmin` route-local bypass used by operator-side surfaces
does not apply. No global admin short-circuit added to
`requireLimit`.

**Producer / resolver invariants (preserved):**

- `trg_visitor_sessions_count_visitor` is still the **only** writer
  of `workspace_usage_counters.visitors_count`.
- The discriminator only **reads** `visitor_sessions`; it never
  writes a counter and never inserts a session row.
- `resolveMaxVisitors` and `usageFnForLimit('max_visitors')` are
  unchanged.

## 6. Out of scope for this phase

- No migrations.
- No changes to widget bootstrap, auth, or visitor tracking
  architecture.
- No storage/upload work.
- No re-touching of `max_conversations` rollout.
- No second producer for `visitors_count`.
- No additional visitor-creation routes gated. Other creation
  branches (`callWidget.ts` ensure-session,
  `widget.ts` visitor-session insert) remain intentionally ungated;
  they share the same 30-min granularity and would need the same
  discriminator to be wired in if a future phase decides to
  broaden coverage.
## 7. Phase 10 — Coverage broadening (secondary widget /track branch)

**Date:** 2026-06-19. Status: **partial broadening applied**.

**Secondary branch audit:**

| Site | Inserts `visitor_sessions`? | True creation? | `workspace_id` + `visitor_id` trusted? | Helper fits? | Decision |
|---|---|---|---|---|---|
| `widget.ts` `POST /track` `else if (visitor_id)` (line ~1524) | yes | yes (no recent 30-min session) | yes — `resolveWorkspaceId` + body `visitor_id` | yes (mirrors `visitors.ts` /track) | **SAFE TO ADOPT** |
| `widgetIdentity.ts` lines 139/290/454 | no — SELECT only | n/a | n/a | n/a | NOT A CREATION BRANCH |
| `callWidget.ts` `ensureVisitorSessionRow` (line ~212) | yes | yes (only when no row exists at all) | partial — called from call-widget bootstrap; failures intentionally swallowed | risky — would convert a best-effort row into a hard 403 cap-block on call entry | **STILL DEFERRED** |
| `widgetCallInvitations.ts` line ~316 | SELECT only (lookup) | n/a | n/a | n/a | NOT A CREATION BRANCH |
| `calls.ts` line ~164 | SELECT only | n/a | n/a | n/a | NOT A CREATION BRANCH |

**Rollout applied:** `widget.ts` `POST /track` insert sub-branch only.
The existing `enforceMaxVisitorsLimitIfNewThisMonth` helper is
invoked immediately before the `visitor_sessions` insert. No second
helper, no second writer, no new discriminator variant. The 30-min
reconnect / update branch above it remains untouched, page-view
inserts remain untouched, and `visitor_presence` writes remain
untouched.

**Why `callWidget.ts` stays deferred:** the ensure-session path is
explicitly best-effort ("failures are swallowed; the merge will
still run"). Attaching `requireLimit` there would convert a
historically silent branch into a hard 403 on call-widget entry,
which is a UX regression we are not authorized to make in this
phase. Call-widget visitors that have never been tracked through
the chat widget will therefore not yet consume the cap until a
future phase wires the helper in deliberately with the correct
cap-reached UX.

**Invariants preserved:** trigger remains the sole writer of
`visitors_count`; `resolveMaxVisitors` unchanged; locked semantics
unchanged; fail-open behavior unchanged.
