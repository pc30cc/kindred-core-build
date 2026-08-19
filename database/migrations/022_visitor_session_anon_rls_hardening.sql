-- 022 — Close the self-host visitor_sessions/visitor_presence RLS drift.
--
-- The self-host chain (003_visitors_kb_config.sql) and the hosted chain
-- (supabase/migrations/20260413202349_...sql) started from byte-identical
-- policies:
--
--   visitor_sessions: "Anon can insert visitor sessions" WITH CHECK (true)
--                      "Anon can update visitor sessions" USING (true)
--   visitor_presence:  "Anon can manage presence" FOR ALL USING (true)
--
-- The hosted chain tightened these the same/next day
-- (supabase/migrations/20260415082424_..., 20260415082519_...) to require a
-- non-null visitor_id/workspace_id, the target workspace's widget tracking
-- actually being enabled, and — for UPDATE/read of an existing row — a
-- caller-supplied `x-visitor-id` header matching the row's own visitor_id
-- (PostgREST's `current_setting('request.headers', true)`, no Supabase Auth
-- involved). The self-host chain never received the equivalent tightening,
-- so a fresh self-host install following database/README.md's own
-- instructions ends up with anon able to write/overwrite ANY workspace's
-- visitor_sessions/visitor_presence rows via the public anon key, directly
-- against PostgREST, bypassing this app's own Express ingestion routes
-- entirely. This migration ports the hosted fix verbatim — schemas were
-- confirmed identical (workspace_id, visitor_id, id, visitor_session_id,
-- and widget_settings.{enabled,visitor_tracking_enabled} all match) before
-- porting, per the forward-only / additive rule: this is a NEW file, 003 is
-- never edited.

-- ---------- visitor_sessions ----------
DROP POLICY IF EXISTS "Anon can insert visitor sessions" ON visitor_sessions;
CREATE POLICY "Anon can insert visitor sessions"
  ON visitor_sessions FOR INSERT TO anon
  WITH CHECK (
    visitor_id IS NOT NULL
    AND workspace_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM widget_settings ws
      WHERE ws.workspace_id = visitor_sessions.workspace_id
      AND ws.visitor_tracking_enabled = true
      AND ws.enabled = true
    )
  );

DROP POLICY IF EXISTS "Anon can update visitor sessions" ON visitor_sessions;
DROP POLICY IF EXISTS "Anon can update own visitor sessions" ON visitor_sessions;
CREATE POLICY "Anon can update own visitor sessions"
  ON visitor_sessions FOR UPDATE TO anon
  USING (visitor_id = current_setting('request.headers', true)::json->>'x-visitor-id')
  WITH CHECK (visitor_id = current_setting('request.headers', true)::json->>'x-visitor-id');

-- ---------- visitor_presence ----------
DROP POLICY IF EXISTS "Anon can manage presence" ON visitor_presence;

DROP POLICY IF EXISTS "Anon can insert own presence" ON visitor_presence;
CREATE POLICY "Anon can insert own presence"
  ON visitor_presence FOR INSERT TO anon
  WITH CHECK (
    visitor_session_id IS NOT NULL
    AND workspace_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM visitor_sessions vs
      WHERE vs.id = visitor_presence.visitor_session_id
      AND vs.workspace_id = visitor_presence.workspace_id
      AND vs.visitor_id = current_setting('request.headers', true)::json->>'x-visitor-id'
    )
  );

DROP POLICY IF EXISTS "Anon can update own presence" ON visitor_presence;
CREATE POLICY "Anon can update own presence"
  ON visitor_presence FOR UPDATE TO anon
  USING (
    EXISTS (
      SELECT 1 FROM visitor_sessions vs
      WHERE vs.id = visitor_presence.visitor_session_id
      AND vs.visitor_id = current_setting('request.headers', true)::json->>'x-visitor-id'
    )
  );

DROP POLICY IF EXISTS "Anon can read own presence" ON visitor_presence;
CREATE POLICY "Anon can read own presence"
  ON visitor_presence FOR SELECT TO anon
  USING (
    EXISTS (
      SELECT 1 FROM visitor_sessions vs
      WHERE vs.id = visitor_presence.visitor_session_id
      AND vs.visitor_id = current_setting('request.headers', true)::json->>'x-visitor-id'
    )
  );

-- ---------- in-migration proof (fails the chain instead of shipping silently broken) ----------
DO $verify$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM pg_policies
  WHERE tablename = 'visitor_sessions' AND policyname = 'Anon can insert visitor sessions'
    AND qual IS NULL AND with_check LIKE '%widget_settings%';
  IF n <> 1 THEN
    RAISE EXCEPTION '022: visitor_sessions insert policy did not tighten as expected';
  END IF;

  SELECT count(*) INTO n FROM pg_policies
  WHERE tablename = 'visitor_sessions' AND policyname = 'Anon can update visitor sessions';
  IF n <> 0 THEN
    RAISE EXCEPTION '022: old wide-open "Anon can update visitor sessions" policy still present';
  END IF;

  SELECT count(*) INTO n FROM pg_policies
  WHERE tablename = 'visitor_presence' AND policyname = 'Anon can manage presence';
  IF n <> 0 THEN
    RAISE EXCEPTION '022: old wide-open "Anon can manage presence" policy still present';
  END IF;

  SELECT count(*) INTO n FROM pg_policies
  WHERE tablename = 'visitor_presence' AND policyname IN
    ('Anon can insert own presence', 'Anon can update own presence', 'Anon can read own presence');
  IF n <> 3 THEN
    RAISE EXCEPTION '022: visitor_presence scoped policies did not install as expected (found %)', n;
  END IF;

  RAISE NOTICE '022: visitor_sessions/visitor_presence anon RLS hardening verified';
END
$verify$;
