CREATE OR REPLACE FUNCTION public.tg_visitor_sessions_count_visitor()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_period       text;
  v_period_start timestamptz;
  v_existing     int;
BEGIN
  IF NEW.workspace_id IS NULL OR NEW.visitor_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_period       := to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM');
  v_period_start := date_trunc('month', (now() AT TIME ZONE 'UTC'))
                    AT TIME ZONE 'UTC';

  SELECT count(*) INTO v_existing
  FROM public.visitor_sessions
  WHERE workspace_id = NEW.workspace_id
    AND visitor_id   = NEW.visitor_id
    AND id <> NEW.id
    AND COALESCE(started_at, last_seen_at, now()) >= v_period_start;

  IF v_existing > 0 THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.workspace_usage_counters
    (workspace_id, period, visitors_count)
  VALUES
    (NEW.workspace_id, v_period, 1)
  ON CONFLICT (workspace_id, period) DO UPDATE
    SET visitors_count = public.workspace_usage_counters.visitors_count + 1,
        updated_at     = now();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_visitor_sessions_count_visitor
  ON public.visitor_sessions;

CREATE TRIGGER trg_visitor_sessions_count_visitor
AFTER INSERT ON public.visitor_sessions
FOR EACH ROW
EXECUTE FUNCTION public.tg_visitor_sessions_count_visitor();

COMMENT ON FUNCTION public.tg_visitor_sessions_count_visitor() IS
  'Canonical, sole writer for workspace_usage_counters.visitors_count. Increments by 1 only on the first visitor_sessions insert per (workspace_id, visitor_id) within the current UTC calendar month. Do NOT add server-side increments for visitors_count elsewhere.';