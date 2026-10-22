-- 282b — An operator who closes the panel stops being "here" at once, while
-- their other tabs and apps keep them here (audit finding R-11).
--
-- What it fixes: the live-presence lease (operator_presence_live, 130) is one
-- row per (workspace, operator), refreshed by every heartbeat of every source
-- — each open panel tab, the desktop app, the phone — and only ever expires:
-- PRESENCE_LIVENESS_MS, 5 minutes after the last beat. Routing reads it (with
-- Centrifugo's presence, which it can only add to), so an operator who had
-- just closed their last tab was still given new chats for up to 5 minutes.
-- The panel now sends a beacon when its tab goes away (pagehide; on iPhone
-- and iPad also when it is hidden) naming that tab, and the lease must end
-- only that tab's part of it.
--
-- 1. operator_presence_live.sources (jsonb, default '{}'): which sources hold
--    the lease, { source id: last beat, epoch milliseconds }. A source is a
--    panel tab's random id; '_' stands for every client that sends none (the
--    desktop and phone apps, older panels), which never send a beacon either.
--    last_seen_at stays the lease every reader reads, unchanged.
-- 2. operator_presence_beat(workspace, user, source, now, window_ms): the
--    heartbeat's write, one statement: the row's last_seen_at = now (as the
--    upsert it replaces), and this source's entry stamped, entries older than
--    the window dropped (a tab that crashed without its beacon).
-- 3. operator_presence_leave(workspace, user, source, now, window_ms): the
--    beacon's. Removes that source; if another source beat within the window
--    the lease stays, dated by the newest of them ('present'); if none did
--    the row is deleted ('gone'), so the operator is no longer connected for
--    routing and teammates. 'unknown': no row, or the source is not in it (a
--    lease written before this file): nothing is changed, and the lease
--    expires as before.
-- 4. operator_presence_live_sources(sources, except, now, window_ms): the
--    entries still live (pure; used by 2 and 3).
--
-- The backend writes through 2 once this file is applied and keeps the plain
-- upsert of the lease while the function is missing (a database before
-- 282b), so the code may deploy either side of it; 3 then has nothing to
-- read, and the lease simply expires as it always did.
--
-- Locks: ADD COLUMN with a constant default is metadata only on PostgreSQL 11
-- and later (no rewrite): ACCESS EXCLUSIVE on this small table for an
-- instant, none on a second run (IF NOT EXISTS). The functions take the one
-- row they change (FOR UPDATE in 3). Every existing row reads '{}'. The file
-- sets lock_timeout 5s itself (RESPOK's migrator runs without PGOPTIONS); a
-- statement stopped by it is simply run again. SECURITY INVOKER with a pinned
-- search_path, executable by service_role only. Re-runnable (IF NOT EXISTS,
-- CREATE OR REPLACE). Dry run: the file inside BEGIN … ROLLBACK. Drops
-- nothing; touches no archive schema or table.

SET lock_timeout = '5s';

-- ─── 1. Which sources hold the lease ──────────────────────────────────────
ALTER TABLE public.operator_presence_live
  ADD COLUMN IF NOT EXISTS sources jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.operator_presence_live.sources IS
  'The sources holding this lease: { source id: last beat in epoch milliseconds }. A panel tab''s random id, or ''_'' for clients that send none. Written by operator_presence_beat / operator_presence_leave. Migration 282b.';

-- ─── 4. The entries still live ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.operator_presence_live_sources(
  p_sources jsonb,
  p_except text,
  p_now timestamptz,
  p_window_ms bigint
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $fn_live_sources$
  SELECT COALESCE(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
    FROM jsonb_each(CASE WHEN jsonb_typeof(p_sources) = 'object' THEN p_sources ELSE '{}'::jsonb END) AS e(key, value)
   WHERE e.key IS DISTINCT FROM p_except
     AND jsonb_typeof(e.value) = 'number'
     AND (e.value)::numeric >= (extract(epoch FROM p_now) * 1000) - p_window_ms;
$fn_live_sources$;

COMMENT ON FUNCTION public.operator_presence_live_sources(jsonb, text, timestamptz, bigint) IS
  'The entries of an operator_presence_live.sources map that beat within the window, without p_except. Migration 282b.';

-- ─── 2. A heartbeat ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.operator_presence_beat(
  p_workspace_id uuid,
  p_user_id uuid,
  p_source text,
  p_now timestamptz,
  p_window_ms bigint
)
RETURNS void
LANGUAGE sql
VOLATILE
SET search_path = public, pg_temp
AS $fn_beat$
  INSERT INTO public.operator_presence_live AS l (workspace_id, user_id, last_seen_at, updated_at, sources)
  VALUES (p_workspace_id, p_user_id, p_now, p_now,
          jsonb_build_object(COALESCE(p_source, '_'), floor(extract(epoch FROM p_now) * 1000)::bigint))
  ON CONFLICT (workspace_id, user_id) DO UPDATE
     SET last_seen_at = EXCLUDED.last_seen_at,
         updated_at = EXCLUDED.updated_at,
         sources = public.operator_presence_live_sources(l.sources, COALESCE(p_source, '_'), p_now, p_window_ms)
                   || EXCLUDED.sources;
$fn_beat$;

COMMENT ON FUNCTION public.operator_presence_beat(uuid, uuid, text, timestamptz, bigint) IS
  'The operator heartbeat''s lease write: last_seen_at = p_now and this source stamped in sources (entries older than the window dropped). Server-only. Migration 282b.';

-- ─── 3. A source went away ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.operator_presence_leave(
  p_workspace_id uuid,
  p_user_id uuid,
  p_source text,
  p_now timestamptz,
  p_window_ms bigint
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SET search_path = public, pg_temp
AS $fn_leave$
DECLARE
  v_sources jsonb;
  v_rest jsonb;
  v_last numeric;
BEGIN
  IF p_workspace_id IS NULL OR p_user_id IS NULL OR p_source IS NULL THEN
    RETURN 'unknown';
  END IF;
  SELECT l.sources INTO v_sources
    FROM public.operator_presence_live l
   WHERE l.workspace_id = p_workspace_id AND l.user_id = p_user_id
   FOR UPDATE;
  IF NOT FOUND OR jsonb_typeof(v_sources) IS DISTINCT FROM 'object' OR NOT (v_sources ? p_source) THEN
    RETURN 'unknown';
  END IF;
  v_rest := public.operator_presence_live_sources(v_sources, p_source, p_now, p_window_ms);
  SELECT max((e.value)::numeric) INTO v_last FROM jsonb_each(v_rest) AS e(key, value);
  IF v_last IS NULL THEN
    DELETE FROM public.operator_presence_live
     WHERE workspace_id = p_workspace_id AND user_id = p_user_id;
    RETURN 'gone';
  END IF;
  UPDATE public.operator_presence_live
     SET sources = v_rest,
         last_seen_at = to_timestamp(v_last / 1000.0),
         updated_at = p_now
   WHERE workspace_id = p_workspace_id AND user_id = p_user_id;
  RETURN 'present';
END;
$fn_leave$;

COMMENT ON FUNCTION public.operator_presence_leave(uuid, uuid, text, timestamptz, bigint) IS
  'A panel tab went away: removes its source from the operator''s lease; the lease stays while another source beat within the window (''present''), else the row is deleted (''gone''); ''unknown'' changes nothing. Server-only. Migration 282b.';

-- ─── Access: the backend (service_role) only ──────────────────────────────
DO $acl$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.operator_presence_live_sources(jsonb, text, timestamptz, bigint)',
    'public.operator_presence_beat(uuid, uuid, text, timestamptz, bigint)',
    'public.operator_presence_leave(uuid, uuid, text, timestamptz, bigint)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', f);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', f);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
    END IF;
  END LOOP;
END $acl$;

RESET lock_timeout;
