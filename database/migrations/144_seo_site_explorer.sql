-- SEO — Site Explorer arbitrary-domain lookups (Phase 3 of the Ahrefs-style
-- SEO rebuild). Site Audit/Rank Tracker/Backlinks/Keywords all operate on a
-- website the workspace REGISTERED (workspace_domains). Site Explorer is
-- deliberately different: a workspace types ANY domain — its own or a
-- competitor's — and gets a backlink profile + organic keywords report for
-- it, with no prior registration required.
--
-- That is exactly why this is its own schema instead of reusing
-- seo_backlink_scans/seo_keyword_research_runs: those tables key everything
-- off `website_id uuid NOT NULL REFERENCES workspace_domains(id)`, which is
-- the correct authorization boundary for "audit MY site" but the wrong shape
-- for "look up ANY domain" — loosening that FK would let Site Explorer rows
-- leak into every other feature that lists workspace_domains (Site Audit's
-- site picker, Rank Tracker, ...). Same conventions otherwise as
-- 140_seo_backlinks.sql / 141_seo_keywords_and_rank_tracking.sql:
--   - `background_jobs` reused for the async scan unit of work
--     (job_type = 'seo_explorer_backlink_scan' / 'seo_explorer_keyword_scan').
--   - Reuses the EXISTING platform_backlinks_provider_config /
--     platform_keywords_provider_config credentials (same DataForSEO
--     account, same vendor calls, just a different consumer) — no new
--     provider-config table.
--   - Backend-only ACL: every table is service-role-only RLS, no
--     auth.uid()-based policies.
--   - `target_domain` is the normalized (lowercased, www-stripped) host —
--     the only per-workspace grouping key; there is no "explorer site"
--     entity table, the scan history IS the domain history.

-- ─────────────────────────────────────────────────────────────────────────
-- Backlinks-by-domain — one row per scan run.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.seo_explorer_backlink_scans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.background_jobs(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  target_domain text NOT NULL,
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

CREATE INDEX IF NOT EXISTS idx_seo_explorer_backlink_scans_domain ON public.seo_explorer_backlink_scans (workspace_id, target_domain, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_seo_explorer_backlink_scans_workspace_status ON public.seo_explorer_backlink_scans (workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_seo_explorer_backlink_scans_job ON public.seo_explorer_backlink_scans (job_id);

ALTER TABLE public.seo_explorer_backlink_scans ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.seo_explorer_backlink_scans FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.seo_explorer_backlink_scans TO service_role;

CREATE TRIGGER seo_explorer_backlink_scans_updated_at
  BEFORE UPDATE ON public.seo_explorer_backlink_scans
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ─────────────────────────────────────────────────────────────────────────
-- Backlinks-by-domain — normalized per-backlink results.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.seo_explorer_backlinks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id uuid NOT NULL REFERENCES public.seo_explorer_backlink_scans(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
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

CREATE INDEX IF NOT EXISTS idx_seo_explorer_backlinks_scan ON public.seo_explorer_backlinks (scan_id);
CREATE INDEX IF NOT EXISTS idx_seo_explorer_backlinks_workspace ON public.seo_explorer_backlinks (workspace_id);

ALTER TABLE public.seo_explorer_backlinks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.seo_explorer_backlinks FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.seo_explorer_backlinks TO service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- Organic keywords-by-domain — one row per scan run. Distinct from Keyword
-- Research (seo_keyword_research_runs, seed-keyword volume lookup): this is
-- "what keywords does this domain actually rank for", via DataForSEO Labs'
-- Ranked Keywords endpoint, not the Keywords Data search-volume endpoint.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.seo_explorer_keyword_scans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.background_jobs(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  target_domain text NOT NULL,
  provider text NOT NULL,
  max_keywords integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'processing', 'completed', 'failed', 'cancelled')),
  progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  progress_stage text,
  total_keywords integer,
  total_traffic_estimate integer,
  cancel_requested boolean NOT NULL DEFAULT false,
  error_message text,
  error_category text,
  created_by uuid,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_seo_explorer_keyword_scans_domain ON public.seo_explorer_keyword_scans (workspace_id, target_domain, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_seo_explorer_keyword_scans_workspace_status ON public.seo_explorer_keyword_scans (workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_seo_explorer_keyword_scans_job ON public.seo_explorer_keyword_scans (job_id);

ALTER TABLE public.seo_explorer_keyword_scans ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.seo_explorer_keyword_scans FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.seo_explorer_keyword_scans TO service_role;

CREATE TRIGGER seo_explorer_keyword_scans_updated_at
  BEFORE UPDATE ON public.seo_explorer_keyword_scans
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ─────────────────────────────────────────────────────────────────────────
-- Organic keywords-by-domain — normalized per-keyword results.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.seo_explorer_keywords (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id uuid NOT NULL REFERENCES public.seo_explorer_keyword_scans(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  keyword text NOT NULL,
  search_volume integer,
  cpc numeric(10,2),
  competition numeric(4,3),
  position integer,
  ranking_url text,
  traffic_estimate integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scan_id, keyword, ranking_url)
);

CREATE INDEX IF NOT EXISTS idx_seo_explorer_keywords_scan ON public.seo_explorer_keywords (scan_id);
CREATE INDEX IF NOT EXISTS idx_seo_explorer_keywords_workspace ON public.seo_explorer_keywords (workspace_id);

ALTER TABLE public.seo_explorer_keywords ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.seo_explorer_keywords FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.seo_explorer_keywords TO service_role;
