# Visitor Limit Policy (`max_visitors`)

_Status: **rolled out** on the two true session-creation branches that
share the same workspace-token + `visitor_id` trust model. Reconnects,
revisits, page views, heartbeats, disconnects, and replies remain
ungated._

Counter foundation and locked semantics are documented in
[`VISITOR_COUNTER_ARCHITECTURE.md`](./VISITOR_COUNTER_ARCHITECTURE.md).

## Locked semantics

**Distinct `visitor_id` per workspace per UTC calendar month.** A
single `visitor_id` counts at most once per month, regardless of how
many `visitor_sessions` rows the 30-minute reconnect logic produces.
Revisits, identity-enrichment updates, page views, and message replies
do not increment.

Single canonical producer: `AFTER INSERT` trigger
`trg_visitor_sessions_count_visitor` on `public.visitor_sessions`. It
upserts `workspace_usage_counters(workspace_id, period).visitors_count`
only when no other `visitor_sessions` row exists for the same
`(workspace_id, visitor_id)` in the current UTC month. No application
code may write `visitors_count`.

## Gate-vs-counter granularity

Existing creation branches key off a 30-minute staleness window; the
counter keys off a UTC calendar month. To gate without contradicting
the counter, every gated branch routes through
`enforceMaxVisitorsLimitIfNewThisMonth(...)` in
`server/services/billing/visitorLimit.ts`, which:

1. Reads `visitor_sessions` for any row matching `(workspace_id,
   visitor_id)` with `created_at >= start of current UTC month`. The
   predicate is intentionally identical to the trigger's, so gate
   decisions and counter increments cannot disagree.
2. Row found → in-month reconnect; the helper returns `true`,
   `requireLimit` is **not** invoked, and the cap is **not** consumed.
3. No row found → true new-this-month visitor; the helper invokes
   `requireLimit('max_visitors', usageFnForLimit('max_visitors'))`
   inline. On cap reached, the middleware writes its standard 403 and
   the route aborts before insert.
4. On membership-read error → fail **open** (treat as reconnect) so
   transient DB hiccups never block legitimate traffic. The trigger
   remains source of truth.

The discriminator only **reads** `visitor_sessions`; it never
increments a counter and never inserts a session row.

## Route truth

| Route / branch                                                                  | Creation? | Classification          |
|---------------------------------------------------------------------------------|-----------|-------------------------|
| `POST /api/visitors/track` — new-session insert                                 | yes       | **GATED** via helper    |
| `POST /api/visitors/track` — update branch (30-min reuse)                       | no        | DO NOT GATE             |
| `POST /api/widget` `/track` — `else if (visitor_id)` insert sub-branch          | yes       | **GATED** via helper    |
| `POST /api/visitors/heartbeat`, `/page-view`, `/disconnect`                     | no        | DO NOT GATE             |
| `POST /api/widget/identify`                                                     | no (SELECT only) | NOT A CREATION ROUTE |
| `POST /api/widget/message` — visitor-session insert sub-branch                  | yes (incidental) | NOT GATED — already gated for `max_conversations`; do not stack |
| `POST /api/widget/message` — reply branch                                       | no        | DO NOT GATE             |
| `POST /api/conversations/start-from-visitor`                                    | no (visitor exists) | DO NOT GATE for `max_visitors` (gated for `max_conversations`) |
| `callWidget.ts` `ensureVisitorSessionRow`                                       | yes (best-effort) | **DEFERRED** — see below |
| `widgetCallInvitations.ts`, `calls.ts`                                          | no (SELECT only) | NOT A CREATION ROUTE |
| `GET /api/visitors/*` (list/detail), other widget routes                        | no        | NOT A CREATION ROUTE    |

## Cap-reached behavior

- Standard `requireLimit` 403 (`{ error, feature: 'max_visitors',
  limit, used, upgrade_required: true }`). No bespoke widget UX.
- Existing visitors continue to receive page views, heartbeats, and
  chat traffic without any new gate.
- Reads, identity updates, and operator surfaces are unaffected.

## Bypass policy

None. The gated routes are public/widget traffic, so the
`!auth.isAdmin` bypass used by operator-side surfaces does not apply.
No global admin short-circuit was added to `requireLimit`.

## Intentionally deferred

- `callWidget.ts` `ensureVisitorSessionRow` — explicitly best-effort
  ("failures are swallowed; the merge will still run"). Attaching the
  helper there would convert a silent branch into a hard 403 on
  call-widget entry, which is a UX regression. Will require explicit
  cap-reached UX before adoption.
- Any future creation site MUST go through
  `enforceMaxVisitorsLimitIfNewThisMonth` — no second writer, no
  second discriminator, no route-local counting.
