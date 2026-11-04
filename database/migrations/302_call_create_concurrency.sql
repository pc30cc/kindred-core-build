-- 302 — a call is created within the plan's concurrency limit, counted under
-- the workspace's lock (audit 2026-11-04, the leftover of calls-1).
--
-- APPLIED BY HAND on WebYar's database (host.respok.app), BEFORE the merge of
-- the code that calls call_session_create(), per CLAUDE.md "Migrations": a dry
-- run inside BEGIN … ROLLBACK first. RESPOK's migrator applies it on push. It
-- only adds a function and writes no data; a second run changes nothing.
--
-- POST /api/calls/create (an operator's call) and the widget's
-- POST /calls/request (a visitor's call) checked the plan's
-- max_concurrent_calls before inserting the call and outside any lock, so two
-- requests at limit − 1 both went through. 298 closed that for colleague calls
-- only (team_call_place with p_max_concurrent). call_session_create() takes the
-- same per-workspace lock as 298 ('call_concurrency:' || workspace), so all
-- three ways of starting a call queue behind each other; counts the
-- workspace's live calls the way 298 and the API's resolver do
-- (usageResolvers.ts resolveMaxConcurrentCalls: pending, ringing, connecting,
-- active, every entry source); and either answers
-- {"verdict": "limit_reached", "used": n, "max": m} with nothing written, or
-- inserts the row and answers {"verdict": "created", "call": <the row>}.
-- A NULL or negative limit is no limit (no lock, no count).
--
-- p_row is the call_sessions row as JSON. Only the columns it names are
-- written, so every other column keeps its default (id, created_at, …); a
-- key that is not a column of call_sessions is refused (22023).

CREATE OR REPLACE FUNCTION public.call_session_create(
  p_row            jsonb,
  p_max_concurrent integer
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_workspace_id uuid;
  v_used         integer;
  v_unknown      text;
  v_columns      text;
  v_call         jsonb;
BEGIN
  IF p_row IS NULL OR jsonb_typeof(p_row) <> 'object' THEN
    RAISE EXCEPTION 'call_session_create: a row object is required' USING ERRCODE = '22023';
  END IF;
  v_workspace_id := NULLIF(p_row->>'workspace_id', '')::uuid;
  IF v_workspace_id IS NULL THEN
    RAISE EXCEPTION 'call_session_create: a workspace is required' USING ERRCODE = '22023';
  END IF;

  SELECT string_agg(k, ', ' ORDER BY k)
    INTO v_unknown
    FROM jsonb_object_keys(p_row) AS k
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = 'public.call_sessions'::regclass
        AND a.attname = k AND a.attnum > 0 AND NOT a.attisdropped
        AND a.attgenerated = ''
   );
  IF v_unknown IS NOT NULL THEN
    RAISE EXCEPTION 'call_session_create: not a column of call_sessions: %', v_unknown USING ERRCODE = '22023';
  END IF;

  IF p_max_concurrent IS NOT NULL AND p_max_concurrent >= 0 THEN
    -- One creation at a time per workspace (the lock team_call_place takes
    -- too), so the count below and the row written are one step. Released
    -- with the transaction.
    PERFORM pg_advisory_xact_lock(hashtextextended('call_concurrency:' || v_workspace_id::text, 0));
    SELECT count(*)::integer
      INTO v_used
      FROM public.call_sessions s
     WHERE s.workspace_id = v_workspace_id
       AND s.state IN ('pending', 'ringing', 'connecting', 'active');
    IF v_used >= p_max_concurrent THEN
      RETURN jsonb_build_object('verdict', 'limit_reached', 'used', v_used, 'max', p_max_concurrent);
    END IF;
  END IF;

  SELECT string_agg(quote_ident(k), ', ')
    INTO v_columns
    FROM jsonb_object_keys(p_row) AS k;
  EXECUTE format(
    'INSERT INTO public.call_sessions (%1$s) SELECT %1$s FROM jsonb_populate_record(NULL::public.call_sessions, $1) RETURNING to_jsonb(call_sessions.*)',
    v_columns
  ) USING p_row INTO v_call;

  RETURN jsonb_build_object('verdict', 'created', 'call', v_call);
END;
$$;

REVOKE ALL ON FUNCTION public.call_session_create(jsonb, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.call_session_create(jsonb, integer) TO service_role;
