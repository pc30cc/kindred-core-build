
-- 1) New monthly counter column for billable call minutes.
ALTER TABLE public.workspace_usage_counters
  ADD COLUMN IF NOT EXISTS call_minutes_used integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.workspace_usage_counters.call_minutes_used IS
  'Canonical monthly aggregate of billable call minutes per workspace per UTC month. Sole writer: trigger tg_call_sessions_bill_minutes. Billable policy: only when call_sessions.connected_at IS NOT NULL AND state transitions to ''ended''; minutes = CEIL((ended_at - connected_at) / 60). Period bucket: UTC YYYY-MM of ended_at.';

-- 2) Canonical billable-minute aggregator. Fires exactly once per finalized
-- call: only on the state transition into 'ended' (OLD.state distinct from
-- 'ended'), and only when connected_at + ended_at are both present.
CREATE OR REPLACE FUNCTION public.tg_call_sessions_bill_minutes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_seconds  bigint;
  v_minutes  integer;
  v_period   text;
BEGIN
  -- Guard: only fire on transition into 'ended'.
  IF NEW.state IS DISTINCT FROM 'ended' THEN
    RETURN NEW;
  END IF;
  IF OLD.state IS NOT DISTINCT FROM 'ended' THEN
    -- Already ended; do not double-count on subsequent updates.
    RETURN NEW;
  END IF;

  -- Billable only if the call actually connected and we know when it ended.
  IF NEW.connected_at IS NULL OR NEW.ended_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.workspace_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_seconds := GREATEST(0, EXTRACT(EPOCH FROM (NEW.ended_at - NEW.connected_at))::bigint);
  IF v_seconds = 0 THEN
    RETURN NEW;
  END IF;

  v_minutes := CEIL(v_seconds::numeric / 60.0)::integer;
  v_period  := to_char((NEW.ended_at AT TIME ZONE 'UTC'), 'YYYY-MM');

  INSERT INTO public.workspace_usage_counters
    (workspace_id, period, call_minutes_used)
  VALUES
    (NEW.workspace_id, v_period, v_minutes)
  ON CONFLICT (workspace_id, period) DO UPDATE
    SET call_minutes_used = public.workspace_usage_counters.call_minutes_used + v_minutes,
        updated_at        = now();

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.tg_call_sessions_bill_minutes() IS
  'Canonical, sole writer for workspace_usage_counters.call_minutes_used. Fires on call_sessions UPDATE when state transitions OLD<>''ended'' -> NEW=''ended''. Adds CEIL((ended_at-connected_at)/60) minutes to the UTC-month bucket. Skips non-connected outcomes. Idempotent: the OLD-state guard prevents double-counting on subsequent updates to an already-ended row. Do NOT add server-side increments for call_minutes_used elsewhere.';

DROP TRIGGER IF EXISTS trg_call_sessions_bill_minutes ON public.call_sessions;

CREATE TRIGGER trg_call_sessions_bill_minutes
AFTER UPDATE OF state ON public.call_sessions
FOR EACH ROW
EXECUTE FUNCTION public.tg_call_sessions_bill_minutes();
