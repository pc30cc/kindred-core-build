-- 298 — the call state machine's guards in the database (audit 2026-11-04,
-- calls-1, calls-2, sql-3).
--
-- APPLIED BY HAND on WebYar's database (host.respok.app), BEFORE the merge of
-- the code that calls the new team_call_place() overload, per CLAUDE.md
-- "Migrations": a dry run inside BEGIN … ROLLBACK first. RESPOK's migrator
-- applies it on push. It writes no data; a second run changes nothing.
--
-- Its index is built CONCURRENTLY beforehand, outside any transaction (the
-- statement below then finds it and does nothing):
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS call_sessions_unanswered_created_idx
--     ON public.call_sessions (created_at)
--     WHERE state IN ('pending', 'ringing');
--
-- 1. A call that is over never moves to another state.
--    tg_call_sessions_bill_minutes (016a) adds a call's minutes on every move
--    into 'ended'. A call-centre call that ended came back 'active' when a
--    visitor kept their join token and LiveKit made its room again
--    (auto_create: room_started set it active), then room_finished ended it,
--    and billed it, a second time — over and over, until the plan's monthly
--    minutes were used up. The server now moves a call only from a live state
--    (server/services/calls/callStateGuards.ts); this trigger holds the same
--    line for any writer: an UPDATE that would move a row out of 'ended',
--    'failed', 'cancelled' or 'missed' to any other state leaves that row as
--    it is (the row is skipped, as a compare-and-set that lost would be). An
--    update that keeps the state (recording, metadata) passes. Colleague
--    calls already never leave an over state (teamCallLifecycle.ts).
--
-- 2. The index the stale-call sweep reads (server/services/calls/queue.ts
--    sweepStalePendingCalls, once a minute): call-centre calls nobody
--    answered, left 'pending' for ever before calls-2's fix.
--
-- 3. team_call_place() with the plan's concurrency limit, counted under a
--    per-workspace lock. POST /api/team-calls checked max_concurrent_calls
--    before the RPC and outside any lock, so two placements by two disjoint
--    pairs at limit − 1 both went through. The new overload takes the
--    workspace's lock, counts the workspace's live calls the way the API's
--    resolver does (usageResolvers.ts resolveMaxConcurrentCalls: pending,
--    ringing, connecting, active, every entry source) and answers
--    {"verdict": "limit_reached", "used": n, "max": m} with nothing written
--    when the limit is met; otherwise it places the call exactly as 293's
--    function does (which it calls, under the members' locks). A NULL or
--    negative limit is no limit. 293's eight-argument function stays as it
--    is, for the backend that runs until the merge.

-- ─── 1. An over call keeps its state ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.call_sessions_keep_finished_state()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF OLD.state IN ('ended', 'failed', 'cancelled', 'missed')
     AND NEW.state IS DISTINCT FROM OLD.state THEN
    -- Skip this row: the call stays as it ended (and is billed once).
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.call_sessions_keep_finished_state() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_call_sessions_keep_finished_state ON public.call_sessions;
CREATE TRIGGER trg_call_sessions_keep_finished_state
  BEFORE UPDATE OF state ON public.call_sessions
  FOR EACH ROW
  WHEN (OLD.state IN ('ended', 'failed', 'cancelled', 'missed') AND NEW.state IS DISTINCT FROM OLD.state)
  EXECUTE FUNCTION public.call_sessions_keep_finished_state();

-- ─── 2. The sweep's index ────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS call_sessions_unanswered_created_idx
  ON public.call_sessions (created_at)
  WHERE state IN ('pending', 'ringing');

-- ─── 3. Placing a colleague call within the plan's concurrency ───────────
CREATE OR REPLACE FUNCTION public.team_call_place(
  p_workspace_id   uuid,
  p_caller_id      uuid,
  p_callee_id      uuid,
  p_channel        text,
  p_provider       text,
  p_metadata       jsonb,
  p_ring_cutoff    timestamptz,
  p_live_since     timestamptz,
  p_max_concurrent integer
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_used integer;
BEGIN
  IF p_workspace_id IS NULL THEN
    RAISE EXCEPTION 'team_call_place: a workspace is required' USING ERRCODE = '22023';
  END IF;

  IF p_max_concurrent IS NOT NULL AND p_max_concurrent >= 0 THEN
    -- One placement at a time per workspace, so the count below and the row
    -- the placement writes are one step. Released with the transaction.
    PERFORM pg_advisory_xact_lock(hashtextextended('call_concurrency:' || p_workspace_id::text, 0));
    SELECT count(*)::integer
      INTO v_used
      FROM public.call_sessions s
     WHERE s.workspace_id = p_workspace_id
       AND s.state IN ('pending', 'ringing', 'connecting', 'active');
    IF v_used >= p_max_concurrent THEN
      RETURN jsonb_build_object('verdict', 'limit_reached', 'used', v_used, 'max', p_max_concurrent);
    END IF;
  END IF;

  RETURN public.team_call_place(p_workspace_id, p_caller_id, p_callee_id, p_channel, p_provider,
                                p_metadata, p_ring_cutoff, p_live_since);
END;
$$;

REVOKE ALL ON FUNCTION public.team_call_place(uuid, uuid, uuid, text, text, jsonb, timestamptz, timestamptz, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.team_call_place(uuid, uuid, uuid, text, text, jsonb, timestamptz, timestamptz, integer)
  TO service_role;
