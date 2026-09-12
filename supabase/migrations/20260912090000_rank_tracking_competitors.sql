-- Migration: 148_rank_tracking_competitors.sql
--
-- SEO Rank Tracking — Competitors. The DataForSEO SERP response
-- (server/services/seo/rankTracking/providers/dataforseo.ts::checkRank)
-- already returns every organic result for a tracked keyword's check, not
-- just the tracked site's own row — until now everything but that one row
-- was discarded. This table persists the top N other organic domains per
-- check (cap enforced in code, not here) so Rank Tracker's Competitors tab
-- can show which domains most often outrank the tracked site across its
-- watchlist, without any new provider call — same request, fuller parsing.
--
-- One row per (rank_check, competitor domain). Cascades with its parent
-- seo_rank_checks row; never written to directly by a client (service-role
-- only), same as seo_rank_checks itself.

CREATE TABLE IF NOT EXISTS public.seo_rank_check_competitors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rank_check_id uuid NOT NULL REFERENCES public.seo_rank_checks(id) ON DELETE CASCADE,
  tracked_keyword_id uuid NOT NULL REFERENCES public.seo_tracked_keywords(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  website_id uuid NOT NULL REFERENCES public.workspace_domains(id) ON DELETE CASCADE,
  domain text NOT NULL,
  url text,
  position integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_seo_rank_check_competitors_check ON public.seo_rank_check_competitors (rank_check_id);
CREATE INDEX IF NOT EXISTS idx_seo_rank_check_competitors_keyword ON public.seo_rank_check_competitors (tracked_keyword_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_seo_rank_check_competitors_website ON public.seo_rank_check_competitors (website_id, created_at DESC);

ALTER TABLE public.seo_rank_check_competitors ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.seo_rank_check_competitors FROM anon, authenticated;
GRANT SELECT, INSERT ON public.seo_rank_check_competitors TO service_role;

COMMENT ON TABLE public.seo_rank_check_competitors IS
  'Other organic-SERP domains captured alongside a seo_rank_checks row (top N per check, cap enforced in rankTrackingTicker.ts) — lets Rank Tracker show which domains outrank the tracked site for its own tracked keywords.';
