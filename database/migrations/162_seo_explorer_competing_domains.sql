-- Migration: 162_seo_explorer_competing_domains.sql
--
-- SEO Site Explorer — Competing Domains. Distinct from Organic Keywords
-- (seo_explorer_keywords, "what keywords does this domain rank for") and
-- from Backlinks (seo_explorer_backlinks, "who links to this domain"): this
-- is "which OTHER domains rank for a meaningful share of the target's own
-- keywords", via DataForSEO Labs' Competitors Domain endpoint
-- (dataforseo_labs/google/competitors_domain/live) — reuses the SAME
-- platform Keywords provider config as Organic Keywords (Site Explorer has
-- no credential of its own, per server/routes/adminSeoExplorerProvider.ts's
-- header comment), so this needed no new admin config, only a new adapter
-- method (see server/services/seo/keywords/providers/dataforseo.ts). Mirrors
-- seo_explorer_keyword_scans / seo_explorer_keywords (144_seo_site_explorer.sql)
-- exactly, including the job/scan lifecycle.

CREATE TABLE IF NOT EXISTS public.seo_explorer_competitor_scans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.background_jobs(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  target_domain text NOT NULL,
  provider text NOT NULL,
  max_domains integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'processing', 'completed', 'failed', 'cancelled')),
  progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  progress_stage text,
  total_domains integer,
  cancel_requested boolean NOT NULL DEFAULT false,
  error_message text,
  error_category text,
  created_by uuid,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_seo_explorer_competitor_scans_domain ON public.seo_explorer_competitor_scans (workspace_id, target_domain, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_seo_explorer_competitor_scans_workspace_status ON public.seo_explorer_competitor_scans (workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_seo_explorer_competitor_scans_job ON public.seo_explorer_competitor_scans (job_id);

ALTER TABLE public.seo_explorer_competitor_scans ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.seo_explorer_competitor_scans FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.seo_explorer_competitor_scans TO service_role;

CREATE TRIGGER seo_explorer_competitor_scans_updated_at
  BEFORE UPDATE ON public.seo_explorer_competitor_scans
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ─────────────────────────────────────────────────────────────────────────
-- Competing domains — normalized per-domain results.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.seo_explorer_competitors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id uuid NOT NULL REFERENCES public.seo_explorer_competitor_scans(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  domain text NOT NULL,
  avg_position numeric(6,2),
  intersections integer,
  traffic_estimate integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scan_id, domain)
);

CREATE INDEX IF NOT EXISTS idx_seo_explorer_competitors_scan ON public.seo_explorer_competitors (scan_id);
CREATE INDEX IF NOT EXISTS idx_seo_explorer_competitors_workspace ON public.seo_explorer_competitors (workspace_id);

ALTER TABLE public.seo_explorer_competitors ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.seo_explorer_competitors FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.seo_explorer_competitors TO service_role;
