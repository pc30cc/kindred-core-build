-- SEO — Web Analytics (Phase 4 of the Ahrefs-style SEO rebuild).
--
-- Deliberately NOT a new tracking pixel: this reuses the visitor-tracking
-- pipeline that already runs on every page load of the chat widget's
-- installed snippet (public/widget/loader.js -> POST /api/widget/track ->
-- `visitor_sessions` + `visitor_page_views`, server/routes/widget.ts). That
-- pipeline already captures referrer, browser/device/os, and MaxMind geo
-- (country/city) per session — see 003_visitors_kb_config.sql for the base
-- self-host tables. Building a second, parallel tracking pipeline just for
-- Web Analytics would duplicate exactly the kind of thing already flagged
-- as a problem in this app; this migration only adds what that pipeline is
-- missing:
--   - UTM + language columns on `visitor_sessions` (first-touch, set once
--     at session creation — standard attribution practice).
--   - `visitor_page_views` itself, which exists on the hosted project
--     already (added ad hoc, never mirrored into the self-host chain) but
--     is genuinely missing here — CREATE ... IF NOT EXISTS closes that gap
--     for self-host without touching the hosted copy.
--   - Two new tables Web Analytics actually needs that nothing else has:
--     custom event tracking and saved funnel definitions.
--
-- Same backend-only ACL convention as the SEO modules: the new tables are
-- service-role-only RLS — every write goes through Express
-- (server/routes/webAnalytics.ts), not a direct browser-to-Supabase call.

-- ─────────────────────────────────────────────────────────────────────────
-- First-touch attribution + language on the existing session table.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE public.visitor_sessions
  ADD COLUMN IF NOT EXISTS utm_source text,
  ADD COLUMN IF NOT EXISTS utm_medium text,
  ADD COLUMN IF NOT EXISTS utm_campaign text,
  ADD COLUMN IF NOT EXISTS utm_term text,
  ADD COLUMN IF NOT EXISTS utm_content text,
  ADD COLUMN IF NOT EXISTS language text;

-- ─────────────────────────────────────────────────────────────────────────
-- Page views — closes the self-host/hosted drift gap (see header comment).
-- Column shape matches the existing hosted table exactly.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.visitor_page_views (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  visitor_session_id uuid NOT NULL REFERENCES public.visitor_sessions(id) ON DELETE CASCADE,
  url text NOT NULL,
  title text,
  viewed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_visitor_page_views_workspace_time ON public.visitor_page_views (workspace_id, viewed_at DESC);
CREATE INDEX IF NOT EXISTS idx_visitor_page_views_session ON public.visitor_page_views (visitor_session_id, viewed_at);

ALTER TABLE public.visitor_page_views ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'visitor_page_views' AND policyname = 'service role only'
  ) THEN
    CREATE POLICY "service role only" ON public.visitor_page_views FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;
GRANT ALL ON public.visitor_page_views TO service_role;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relkind = 'S' AND relname = 'visitor_page_views_id_seq') THEN
    GRANT USAGE, SELECT ON SEQUENCE public.visitor_page_views_id_seq TO service_role;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- Custom events — "Tracked events" / "Event properties" / funnel steps.
-- One row per event firing (window.gsAnalytics.track(name, properties) in
-- the loader snippet -> POST /api/widget/event).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.web_analytics_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  visitor_session_id uuid REFERENCES public.visitor_sessions(id) ON DELETE SET NULL,
  event_name text NOT NULL,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  page_url text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_web_analytics_events_workspace_time ON public.web_analytics_events (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_web_analytics_events_workspace_name_time ON public.web_analytics_events (workspace_id, event_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_web_analytics_events_session ON public.web_analytics_events (visitor_session_id, created_at);

ALTER TABLE public.web_analytics_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.web_analytics_events FROM anon, authenticated;
GRANT SELECT, INSERT ON public.web_analytics_events TO service_role;

DROP POLICY IF EXISTS "service role only" ON public.web_analytics_events;
CREATE POLICY "service role only"
  ON public.web_analytics_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ─────────────────────────────────────────────────────────────────────────
-- Saved funnel definitions — an ordered list of steps (pageview path match
-- or event name match). Funnel *results* are computed on demand from
-- visitor_page_views/web_analytics_events, never materialized, so there is
-- no results table — a funnel definition is cheap, a full re-aggregation
-- per view is not, but at analytics-dashboard read volume it's the right
-- tradeoff over a second table to keep in sync.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.web_analytics_funnels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  steps jsonb NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_web_analytics_funnels_workspace ON public.web_analytics_funnels (workspace_id, created_at DESC);

ALTER TABLE public.web_analytics_funnels ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.web_analytics_funnels FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.web_analytics_funnels TO service_role;

DROP POLICY IF EXISTS "service role only" ON public.web_analytics_funnels;
CREATE POLICY "service role only"
  ON public.web_analytics_funnels
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP TRIGGER IF EXISTS web_analytics_funnels_updated_at ON public.web_analytics_funnels;
CREATE TRIGGER web_analytics_funnels_updated_at
  BEFORE UPDATE ON public.web_analytics_funnels
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
