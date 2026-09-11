-- =========================================================================
-- Harden anon-role RLS on visitor_sessions / visitor_presence
-- =========================================================================
-- 003_visitors_kb_config.sql granted the `anon` Postgres role blanket
-- UPDATE (visitor_sessions) and ALL (visitor_presence) access via
-- `USING (true)`, relying entirely on the caller already knowing the
-- target row's UUID. In production, all visitor-facing writes to these
-- tables go through the Express backend (server/routes/widget.ts) using
-- the service-role client, which is not governed by these policies at
-- all — but the tables remain reachable directly through PostgREST with
-- nothing but the public anon key, so the permissive policies are a real
-- gap for any self-host deployment that exposes PostgREST.
--
-- This was already fixed for the Supabase-managed deployment path in
-- supabase/migrations/20260415082424_*.sql and
-- supabase/migrations/20260415082519_*.sql, but that fix was never
-- ported to the numbered self-host migrations. This migration applies
-- the same end state here so both deployment paths match.
--
-- PostgREST injects the incoming HTTP request headers into the
-- `request.headers` session setting for every request (standard
-- PostgREST behavior, not Supabase-Cloud-specific), so `x-visitor-id`
-- below is read from that, matching what the widget already sends.
-- =========================================================================

-- visitor_sessions: scope UPDATE to the session's own visitor_id.
DROP POLICY IF EXISTS "Anon can update visitor sessions" ON public.visitor_sessions;
CREATE POLICY "Anon can update own visitor sessions"
  ON public.visitor_sessions FOR UPDATE TO anon
  USING (visitor_id = current_setting('request.headers', true)::json->>'x-visitor-id')
  WITH CHECK (visitor_id = current_setting('request.headers', true)::json->>'x-visitor-id');

-- visitor_sessions: require non-null identifiers and an active,
-- tracking-enabled workspace on INSERT.
DROP POLICY IF EXISTS "Anon can insert visitor sessions" ON public.visitor_sessions;
CREATE POLICY "Anon can insert visitor sessions"
  ON public.visitor_sessions FOR INSERT TO anon
  WITH CHECK (
    visitor_id IS NOT NULL
    AND workspace_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.widget_settings ws
      WHERE ws.workspace_id = visitor_sessions.workspace_id
      AND ws.visitor_tracking_enabled = true
      AND ws.enabled = true
    )
  );

-- visitor_presence: split the blanket ALL policy into scoped
-- INSERT / UPDATE / SELECT policies tied to the owning visitor_sessions row.
DROP POLICY IF EXISTS "Anon can manage presence" ON public.visitor_presence;

CREATE POLICY "Anon can insert own presence"
  ON public.visitor_presence FOR INSERT TO anon
  WITH CHECK (
    visitor_session_id IS NOT NULL
    AND workspace_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.visitor_sessions vs
      WHERE vs.id = visitor_presence.visitor_session_id
      AND vs.workspace_id = visitor_presence.workspace_id
      AND vs.visitor_id = current_setting('request.headers', true)::json->>'x-visitor-id'
    )
  );

CREATE POLICY "Anon can update own presence"
  ON public.visitor_presence FOR UPDATE TO anon
  USING (
    EXISTS (
      SELECT 1 FROM public.visitor_sessions vs
      WHERE vs.id = visitor_presence.visitor_session_id
      AND vs.visitor_id = current_setting('request.headers', true)::json->>'x-visitor-id'
    )
  );

CREATE POLICY "Anon can read own presence"
  ON public.visitor_presence FOR SELECT TO anon
  USING (
    EXISTS (
      SELECT 1 FROM public.visitor_sessions vs
      WHERE vs.id = visitor_presence.visitor_session_id
      AND vs.visitor_id = current_setting('request.headers', true)::json->>'x-visitor-id'
    )
  );
