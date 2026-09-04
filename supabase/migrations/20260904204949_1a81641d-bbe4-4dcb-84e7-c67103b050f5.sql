-- Presence scalability: the (workspace_id, last_seen_at DESC) secondary index
-- is never chosen by the planner — every presence read filters on
-- (workspace_id, user_id IN ...), which is served by the primary key:
--   Index Scan using operator_presence_live_pkey
--     Index Cond: (workspace_id = $1 AND user_id = ANY($2))
--     Filter: (last_seen_at >= $3)
-- Dropping it removes index maintenance from every fallback UPSERT and
-- allows HOT updates on last_seen_at.
DROP INDEX IF EXISTS public.idx_operator_presence_live_ws_seen;