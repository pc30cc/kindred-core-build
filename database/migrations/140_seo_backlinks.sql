-- SEO — Backlink Analysis (V1, first of three pluggable SEO data modules:
-- backlinks, keyword research, rank tracking — see docs discussion for the
-- other two, added independently later).
--
-- Follows the SAME conventions as 121_seo_audit_core.sql exactly:
--   - `background_jobs` (already defined in 121) is reused for the async
--     scan unit of work (job_type = 'seo_backlink_scan'); no new job table.
--   - `website_id` always references `workspace_domains(id)`.
--   - Backend-only ACL: every table is service-role-only RLS, no
--     auth.uid()-based policies (this app's browser session never carries a
--     Supabase Auth JWT — see 121's header comment for the same reasoning).
--   - The vendor credential table follows the EXACT singleton-row shape of
--     `platform_sms_provider_config` (see 20260801195521_*.sql): one active
--     platform-level provider, not a per-workspace setting, because the
--     platform operator pays the vendor and doles out usage via plan limits
--     (billing_plans.limits.seo_backlinks_max_per_scan etc.), not per-tenant
--     credentials.

-- ─────────────────────────────────────────────────────────────────────────
-- Platform-level backlinks data provider config (singleton, service-role only).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.platform_backlinks_provider_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton boolean NOT NULL DEFAULT true,
  provider_name text NOT NULL DEFAULT 'disabled',
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT false,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_backlinks_provider_config_singleton_chk CHECK (singleton = true),
  CONSTRAINT platform_backlinks_provider_config_singleton_uniq UNIQUE (singleton),
  CONSTRAINT platform_backlinks_provider_config_name_chk CHECK (provider_name IN ('dataforseo', 'disabled'))
);

GRANT ALL ON public.platform_backlinks_provider_config TO service_role;

ALTER TABLE public.platform_backlinks_provider_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service role only"
  ON public.platform_backlinks_provider_config
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE TRIGGER platform_backlinks_provider_config_updated_at
  BEFORE UPDATE ON public.platform_backlinks_provider_config
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ─────────────────────────────────────────────────────────────────────────
-- One row per backlink scan run (mirrors seo_crawls' shape/lifecycle).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.seo_backlink_scans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.background_jobs(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  website_id uuid NOT NULL REFERENCES public.workspace_domains(id) ON DELETE CASCADE,
  target_url text NOT NULL,
  provider text NOT NULL,
  max_backlinks integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'processing', 'completed', 'failed', 'cancelled')),
  progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  progress_stage text,
  total_backlinks integer,
  referring_domains integer,
  dofollow_count integer,
  nofollow_count integer,
  new_backlinks integer,
  lost_backlinks integer,
  cancel_requested boolean NOT NULL DEFAULT false,
  error_message text,
  error_category text,
  created_by uuid,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_seo_backlink_scans_website ON public.seo_backlink_scans (website_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_seo_backlink_scans_workspace_status ON public.seo_backlink_scans (workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_seo_backlink_scans_job ON public.seo_backlink_scans (job_id);

ALTER TABLE public.seo_backlink_scans ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.seo_backlink_scans FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.seo_backlink_scans TO service_role;

CREATE TRIGGER seo_backlink_scans_updated_at
  BEFORE UPDATE ON public.seo_backlink_scans
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON TABLE public.seo_backlink_scans IS
  'One row per backlink-data refresh run. target_url and provider are captured server-side at scan creation, never trusted from a later client request.';

-- ─────────────────────────────────────────────────────────────────────────
-- Normalized per-backlink results (the UI never reads raw vendor payloads).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.seo_backlinks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id uuid NOT NULL REFERENCES public.seo_backlink_scans(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  website_id uuid NOT NULL REFERENCES public.workspace_domains(id) ON DELETE CASCADE,
  source_url text NOT NULL,
  source_domain text NOT NULL,
  target_url text NOT NULL,
  anchor_text text,
  is_dofollow boolean NOT NULL DEFAULT true,
  is_new boolean NOT NULL DEFAULT false,
  is_lost boolean NOT NULL DEFAULT false,
  page_rank integer,
  domain_rank integer,
  spam_score integer,
  first_seen timestamptz,
  last_seen timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scan_id, source_url, target_url)
);

CREATE INDEX IF NOT EXISTS idx_seo_backlinks_scan ON public.seo_backlinks (scan_id);
CREATE INDEX IF NOT EXISTS idx_seo_backlinks_workspace ON public.seo_backlinks (workspace_id);
CREATE INDEX IF NOT EXISTS idx_seo_backlinks_scan_domain ON public.seo_backlinks (scan_id, source_domain);

ALTER TABLE public.seo_backlinks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.seo_backlinks FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.seo_backlinks TO service_role;

COMMENT ON TABLE public.seo_backlinks IS
  'Normalized backlink rows produced by the pluggable backlinks provider adapter (server/services/seo/backlinks/). One vendor response is fully replaced by one INSERT batch per scan — rows are never mutated in place, only superseded by the next scan for the same site.';
