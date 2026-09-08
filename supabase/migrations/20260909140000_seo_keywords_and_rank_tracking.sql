-- SEO — Keyword Research + Rank Tracking (V1, second and third of the three
-- pluggable SEO data modules; backlinks shipped in 140_seo_backlinks.sql).
--
-- Same conventions as 140_seo_backlinks.sql exactly:
--   - `background_jobs` is reused for Keyword Research's async lookup unit
--     of work (job_type = 'seo_keyword_research'). Rank Tracking does NOT
--     use background_jobs at all — a rank check is a lightweight recurring
--     background task (server/services/seo/rankTrackingTicker.ts, run from
--     the API process like every other observability ticker), not a
--     user-triggered job the UI polls for completion.
--   - Each module gets its OWN singleton platform-provider-config table
--     (same shape as platform_sms_provider_config /
--     platform_backlinks_provider_config), because "which vendor answers
--     this" is independently swappable per module — Keyword Research and
--     Rank Tracking may end up on different vendors even though both ship
--     with only a DataForSEO adapter today.
--   - Backend-only ACL: every table is service-role-only RLS, no
--     auth.uid()-based policies (see 121_seo_audit_core.sql's header
--     comment for the same reasoning).

-- ─────────────────────────────────────────────────────────────────────────
-- Keyword Research — platform provider config (singleton).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.platform_keywords_provider_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton boolean NOT NULL DEFAULT true,
  provider_name text NOT NULL DEFAULT 'disabled',
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT false,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_keywords_provider_config_singleton_chk CHECK (singleton = true),
  CONSTRAINT platform_keywords_provider_config_singleton_uniq UNIQUE (singleton),
  CONSTRAINT platform_keywords_provider_config_name_chk CHECK (provider_name IN ('dataforseo', 'disabled'))
);

GRANT ALL ON public.platform_keywords_provider_config TO service_role;
ALTER TABLE public.platform_keywords_provider_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service role only"
  ON public.platform_keywords_provider_config
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TRIGGER platform_keywords_provider_config_updated_at
  BEFORE UPDATE ON public.platform_keywords_provider_config
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ─────────────────────────────────────────────────────────────────────────
-- Keyword Research — one row per lookup run (mirrors seo_backlink_scans).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.seo_keyword_research_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.background_jobs(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  website_id uuid NOT NULL REFERENCES public.workspace_domains(id) ON DELETE CASCADE,
  seed_keywords text[] NOT NULL,
  provider text NOT NULL,
  max_keywords integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'processing', 'completed', 'failed', 'cancelled')),
  progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  progress_stage text,
  total_keywords integer,
  cancel_requested boolean NOT NULL DEFAULT false,
  error_message text,
  error_category text,
  created_by uuid,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_seo_keyword_runs_website ON public.seo_keyword_research_runs (website_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_seo_keyword_runs_workspace_status ON public.seo_keyword_research_runs (workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_seo_keyword_runs_job ON public.seo_keyword_research_runs (job_id);

ALTER TABLE public.seo_keyword_research_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.seo_keyword_research_runs FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.seo_keyword_research_runs TO service_role;

CREATE TRIGGER seo_keyword_research_runs_updated_at
  BEFORE UPDATE ON public.seo_keyword_research_runs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ─────────────────────────────────────────────────────────────────────────
-- Keyword Research — normalized per-keyword results.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.seo_keyword_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.seo_keyword_research_runs(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  website_id uuid NOT NULL REFERENCES public.workspace_domains(id) ON DELETE CASCADE,
  keyword text NOT NULL,
  search_volume integer,
  cpc numeric(10,2),
  competition numeric(4,3),
  competition_level text CHECK (competition_level IS NULL OR competition_level IN ('low', 'medium', 'high')),
  difficulty integer,
  is_seed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, keyword)
);

CREATE INDEX IF NOT EXISTS idx_seo_keyword_results_run ON public.seo_keyword_results (run_id);
CREATE INDEX IF NOT EXISTS idx_seo_keyword_results_workspace ON public.seo_keyword_results (workspace_id);

ALTER TABLE public.seo_keyword_results ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.seo_keyword_results FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.seo_keyword_results TO service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- Rank Tracking — platform provider config (singleton).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.platform_rank_tracking_provider_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton boolean NOT NULL DEFAULT true,
  provider_name text NOT NULL DEFAULT 'disabled',
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT false,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_rank_tracking_provider_config_singleton_chk CHECK (singleton = true),
  CONSTRAINT platform_rank_tracking_provider_config_singleton_uniq UNIQUE (singleton),
  CONSTRAINT platform_rank_tracking_provider_config_name_chk CHECK (provider_name IN ('dataforseo', 'disabled'))
);

GRANT ALL ON public.platform_rank_tracking_provider_config TO service_role;
ALTER TABLE public.platform_rank_tracking_provider_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service role only"
  ON public.platform_rank_tracking_provider_config
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TRIGGER platform_rank_tracking_provider_config_updated_at
  BEFORE UPDATE ON public.platform_rank_tracking_provider_config
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ─────────────────────────────────────────────────────────────────────────
-- Rank Tracking — persistent list of tracked keywords per site.
-- `next_check_at` is what server/services/seo/rankTrackingTicker.ts polls;
-- bumped forward by the plan's check-frequency after every check.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.seo_tracked_keywords (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  website_id uuid NOT NULL REFERENCES public.workspace_domains(id) ON DELETE CASCADE,
  keyword text NOT NULL,
  device text NOT NULL DEFAULT 'desktop' CHECK (device IN ('desktop', 'mobile')),
  location_code integer,
  is_active boolean NOT NULL DEFAULT true,
  last_position integer,
  last_ranking_url text,
  last_checked_at timestamptz,
  next_check_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (website_id, keyword, device)
);

CREATE INDEX IF NOT EXISTS idx_seo_tracked_keywords_website ON public.seo_tracked_keywords (website_id);
CREATE INDEX IF NOT EXISTS idx_seo_tracked_keywords_due ON public.seo_tracked_keywords (next_check_at) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_seo_tracked_keywords_workspace ON public.seo_tracked_keywords (workspace_id);

ALTER TABLE public.seo_tracked_keywords ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.seo_tracked_keywords FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.seo_tracked_keywords TO service_role;

CREATE TRIGGER seo_tracked_keywords_updated_at
  BEFORE UPDATE ON public.seo_tracked_keywords
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON TABLE public.seo_tracked_keywords IS
  'Persistent per-site keyword watchlist for rank tracking. One row per (website_id, keyword, device). rankTrackingTicker.ts is the only writer of next_check_at/last_position/last_checked_at.';

-- ─────────────────────────────────────────────────────────────────────────
-- Rank Tracking — one row per historical position check.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.seo_rank_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tracked_keyword_id uuid NOT NULL REFERENCES public.seo_tracked_keywords(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  website_id uuid NOT NULL REFERENCES public.workspace_domains(id) ON DELETE CASCADE,
  position integer,
  ranking_url text,
  provider text NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_seo_rank_checks_keyword ON public.seo_rank_checks (tracked_keyword_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_seo_rank_checks_website ON public.seo_rank_checks (website_id, checked_at DESC);

ALTER TABLE public.seo_rank_checks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.seo_rank_checks FROM anon, authenticated;
GRANT SELECT, INSERT ON public.seo_rank_checks TO service_role;

COMMENT ON TABLE public.seo_rank_checks IS
  'Append-only rank history. A row with position IS NULL means the tracked domain was not found within the providers result window for that check.';
