-- 174: expand phase — canonical references alongside legacy seo_pages references.

ALTER TABLE public.seo_issue_pages ADD COLUMN IF NOT EXISTS url_id uuid REFERENCES public.seo_urls(id) ON DELETE SET NULL;
ALTER TABLE public.seo_performance_results ADD COLUMN IF NOT EXISTS url_id uuid REFERENCES public.seo_urls(id) ON DELETE SET NULL;
ALTER TABLE public.seo_links ADD COLUMN IF NOT EXISTS source_url_id uuid REFERENCES public.seo_urls(id) ON DELETE CASCADE;
ALTER TABLE public.seo_links ADD COLUMN IF NOT EXISTS target_url_id uuid REFERENCES public.seo_urls(id) ON DELETE SET NULL;
ALTER TABLE public.seo_urls ADD COLUMN IF NOT EXISTS current_observation_id uuid REFERENCES public.seo_crawl_observations(id) ON DELETE SET NULL;

-- contract prerequisite: legacy page reference must become optional so the
-- crawler can persist links without first inserting a duplicate seo_pages row.
ALTER TABLE public.seo_links ALTER COLUMN source_page_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS seo_issue_pages_url_id_idx ON public.seo_issue_pages(url_id);
CREATE INDEX IF NOT EXISTS seo_performance_results_url_id_idx ON public.seo_performance_results(url_id);
CREATE INDEX IF NOT EXISTS seo_links_source_url_id_idx ON public.seo_links(source_url_id);
CREATE INDEX IF NOT EXISTS seo_links_target_url_id_idx ON public.seo_links(target_url_id);
CREATE INDEX IF NOT EXISTS seo_urls_current_observation_idx ON public.seo_urls(current_observation_id);
CREATE INDEX IF NOT EXISTS seo_urls_site_active_idx ON public.seo_urls(workspace_id, site_id, is_active);
CREATE INDEX IF NOT EXISTS seo_urls_site_last_seen_idx ON public.seo_urls(workspace_id, site_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS seo_membership_crawl_changed_idx ON public.seo_crawl_url_membership(crawl_id, changed);
CREATE INDEX IF NOT EXISTS seo_observations_url_observed_idx ON public.seo_crawl_observations(url_id, observed_at DESC);

-- compact CURRENT link graph: one row per (site, source, target), reused across
-- crawls instead of re-inserting the whole unchanged edge set every crawl.
CREATE TABLE IF NOT EXISTS public.seo_link_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  site_id uuid NOT NULL,
  source_url_id uuid NOT NULL REFERENCES public.seo_urls(id) ON DELETE CASCADE,
  target_url_id uuid REFERENCES public.seo_urls(id) ON DELETE SET NULL,
  target_key text NOT NULL,
  target_url text NOT NULL,
  target_normalized_url text,
  is_external boolean NOT NULL DEFAULT false,
  anchor_text text,
  rel text,
  http_status integer,
  is_broken boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  first_seen_crawl_id uuid REFERENCES public.seo_crawls(id) ON DELETE SET NULL,
  last_seen_crawl_id uuid REFERENCES public.seo_crawls(id) ON DELETE SET NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS seo_link_edges_identity_idx ON public.seo_link_edges(workspace_id, site_id, source_url_id, target_key);
CREATE INDEX IF NOT EXISTS seo_link_edges_last_crawl_idx ON public.seo_link_edges(last_seen_crawl_id);
CREATE INDEX IF NOT EXISTS seo_link_edges_target_idx ON public.seo_link_edges(target_url_id);
GRANT ALL ON public.seo_link_edges TO service_role;
ALTER TABLE public.seo_link_edges ENABLE ROW LEVEL SECURITY;

-- compact per-crawl summary, survives detail pruning.
CREATE TABLE IF NOT EXISTS public.seo_crawl_summaries (
  crawl_id uuid PRIMARY KEY REFERENCES public.seo_crawls(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  site_id uuid NOT NULL,
  urls_discovered integer NOT NULL DEFAULT 0,
  urls_crawled integer NOT NULL DEFAULT 0,
  urls_failed integer NOT NULL DEFAULT 0,
  urls_new integer NOT NULL DEFAULT 0,
  urls_changed integer NOT NULL DEFAULT 0,
  urls_unchanged integer NOT NULL DEFAULT 0,
  urls_removed integer NOT NULL DEFAULT 0,
  urls_restored integer NOT NULL DEFAULT 0,
  internal_links integer NOT NULL DEFAULT 0,
  external_links integer NOT NULL DEFAULT 0,
  status_distribution jsonb NOT NULL DEFAULT '{}'::jsonb,
  indexability jsonb NOT NULL DEFAULT '{}'::jsonb,
  issue_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS seo_crawl_summaries_site_idx ON public.seo_crawl_summaries(workspace_id, site_id, created_at DESC);
GRANT ALL ON public.seo_crawl_summaries TO service_role;
ALTER TABLE public.seo_crawl_summaries ENABLE ROW LEVEL SECURITY;