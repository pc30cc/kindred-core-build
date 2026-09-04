-- ============================================================
-- Presence scalability — drop an unused secondary index.
--
-- Live presence is now realtime-first (Centrifugo presence over
-- ws:{workspace_id}:operators). `operator_presence_live` is only the
-- FALLBACK lease, refreshed by the operator heartbeat when the realtime
-- provider cannot supply presence.
--
-- The planner never used (workspace_id, last_seen_at DESC): every read is
--   WHERE workspace_id = $1 AND user_id = ANY($2) AND last_seen_at >= $3
-- which resolves through the primary key:
--   Index Scan using operator_presence_live_pkey
--     Index Cond: (workspace_id = $1 AND user_id = ANY($2))
--     Filter: (last_seen_at >= $3)
--
-- Dropping it removes index maintenance from every fallback UPSERT and
-- permits HOT updates on last_seen_at. Forward-only, idempotent.
-- ============================================================

DROP INDEX IF EXISTS public.idx_operator_presence_live_ws_seen;
