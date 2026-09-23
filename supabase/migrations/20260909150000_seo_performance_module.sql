-- SEO — Performance Auditing (V1, the fourth pluggable SEO data module;
-- backlinks/keywords/rank-tracking shipped in 140/141). Turns the
-- schema-only `seo_performance_results` table from 121_seo_audit_core.sql
-- into a real, provider-backed feature.
--
-- Same conventions as 140/141 exactly:
--   - `background_jobs` carries the async unit of work
--     (job_type = 'seo_performance_audit'), dispatched through the SAME
--     unified seo-crawler worker as the other three job types.
--   - Own singleton platform-provider-config table
--     (platform_performance_provider_config), because the Performance
--     vendor is independently swappable from the other three modules.
--   - Backend-only ACL: every table is service-role-only RLS, no
--     auth.uid()-based policies.
--
-- Unlike Backlinks/Keywords (one vendor call = one result), a Performance
-- audit fetches Core Web Vitals for potentially several pages of a site in
-- one run, so it gets its own run-tracking table
-- (seo_performance_audits, mirroring seo_backlink_scans) in addition to
-- the pre-existing per-page results table.

-- ─────────────────────────────────────────────────────────────────────────
-- Performance — platform provider config (singleton).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.platform_performance_provider_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton boolean NOT NULL DEFAULT true,
  provider_name text NOT NULL DEFAULT 'disabled',
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT false,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_performance_provider_config_singleton_chk CHECK (singleton = true),
  CONSTRAINT platform_performance_provider_config_singleton_uniq UNIQUE (singleton),
  CONSTRAINT platform_performance_provider_config_name_chk CHECK (provider_name IN ('pagespeed', 'disabled'))
);

GRANT ALL ON public.platform_performance_provider_config TO service_role;
ALTER TABLE public.platform_performance_provider_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service role only" ON public.platform_performance_provider_config;
CREATE POLICY "service role only"
  ON public.platform_performance_provider_config
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP TRIGGER IF EXISTS platform_performance_provider_config_updated_at ON public.platform_performance_provider_config;
CREATE TRIGGER platform_performance_provider_config_updated_at
  BEFORE UPDATE ON public.platform_performance_provider_config
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ─────────────────────────────────────────────────────────────────────────
-- Performance — one row per audit run (mirrors seo_backlink_scans).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.seo_performance_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.background_jobs(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  website_id uuid NOT NULL REFERENCES public.workspace_domains(id) ON DELETE CASCADE,
  crawl_id uuid NOT NULL REFERENCES public.seo_crawls(id) ON DELETE CASCADE,
  provider text NOT NULL,
  max_pages integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'processing', 'completed', 'failed', 'cancelled')),
  progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  progress_stage text,
  pages_audited integer,
  cancel_requested boolean NOT NULL DEFAULT false,
  error_message text,
  error_category text,
  created_by uuid,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_seo_performance_audits_crawl ON public.seo_performance_audits (crawl_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_seo_performance_audits_workspace_status ON public.seo_performance_audits (workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_seo_performance_audits_job ON public.seo_performance_audits (job_id);

ALTER TABLE public.seo_performance_audits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.seo_performance_audits FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.seo_performance_audits TO service_role;

DROP TRIGGER IF EXISTS seo_performance_audits_updated_at ON public.seo_performance_audits;
CREATE TRIGGER seo_performance_audits_updated_at
  BEFORE UPDATE ON public.seo_performance_audits
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ─────────────────────────────────────────────────────────────────────────
-- Scope seo_performance_results (121_seo_audit_core.sql) rows to the audit
-- run that created them, so two audits on the same crawl never contend
-- over which "pending" rows belong to which run.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE public.seo_performance_results
  ADD COLUMN IF NOT EXISTS audit_id uuid REFERENCES public.seo_performance_audits(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_seo_performance_results_audit ON public.seo_performance_results (audit_id);
