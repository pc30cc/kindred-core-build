# Visitor Counter Architecture

Locked: Phase 7 — Canonical Visitor Counter Producer.

## 1. Locked semantics for `max_visitors`

`max_visitors` counts **distinct `visitor_id` per workspace per UTC
calendar month.**

- The first `visitor_sessions` row for a given `(workspace_id,
  visitor_id)` within the current UTC month increments the counter
  by exactly 1.
- Subsequent `visitor_sessions` rows for the same
  `(workspace_id, visitor_id)` in the same UTC month — including the
  30-minute reconnect path that inserts a new row instead of
  updating the existing one — DO NOT increment.
- Page views (`visitor_page_views`) DO NOT increment.
- Conversation messages and replies DO NOT increment.
- Identity-enrichment updates on an existing `visitor_sessions` row
  (e.g. attaching a `contact_id`) DO NOT increment.
- Period boundary is `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM')`,
  matching `currentMonthPeriod()` in
  `server/services/billing/usageResolvers.ts`.

Rejected alternatives (kept here so future phases don't relitigate):

| Option | Why rejected |
|---|---|
| Per-`visitor_sessions` row insert | Double-counts the 30-minute reconnect branch that creates a fresh row for the same `visitor_id`. |
| Distinct identified `contact_id` per period | Excludes anonymous traffic, which is the dominant widget case. |
| Lifetime distinct visitors | Requires a different resolver shape (`periodKind: 'lifetime'`) and breaks calendar-month parity with the other usage counters. |

## 2. Canonical producer (single writer)

There is **exactly one** writer for
`workspace_usage_counters.visitors_count`:

- `public.tg_visitor_sessions_count_visitor()` — `AFTER INSERT` row
  trigger on `public.visitor_sessions`, attached as
  `trg_visitor_sessions_count_visitor`.

The trigger:

1. Skips rows where `workspace_id IS NULL` or `visitor_id IS NULL`
   (cannot count by an unknown dimension).
2. Computes the current UTC period and period-start.
3. Looks for any other `visitor_sessions` row for the same
   `(workspace_id, visitor_id)` whose `COALESCE(started_at,
   last_seen_at, now())` falls in the current UTC month. If one
   exists, the trigger returns without incrementing — this is the
   monthly de-dup invariant.
4. Otherwise, upserts `workspace_usage_counters(workspace_id,
   period)` with `visitors_count = 1` on insert, or
   `visitors_count = visitors_count + 1` on conflict, plus
   `updated_at = now()`.

The function is `SECURITY DEFINER` with `search_path = 'public'`,
matching the convention used by other counter helpers in this repo
(e.g. `increment_workspace_counter`).

## 3. Why no server-side increment

Server-side increments were rejected because `visitor_sessions`
rows are inserted from at least two routes (`server/routes/widget.ts`
`/track`-style branch and `server/routes/visitors.ts` `/track`),
plus identify and offline paths. A trigger keeps the writer a
single, schema-local invariant; any future creation path that
inserts a `visitor_sessions` row participates automatically without
having to remember to call a counter helper.

## 4. Hard rule

**No application code may increment
`workspace_usage_counters.visitors_count` directly.** The only
permitted writer is the trigger above. Future limit-enforcement
phases must read via `usageFnForLimit('max_visitors')` and never
introduce a competing producer.

## 5. Resolver alignment

`resolveMaxVisitors` in
`server/services/billing/usageResolvers.ts` already reads
`workspace_usage_counters.visitors_count` for the current
`YYYY-MM` UTC period. No resolver change is required: the producer
was designed to match the existing reader contract exactly.