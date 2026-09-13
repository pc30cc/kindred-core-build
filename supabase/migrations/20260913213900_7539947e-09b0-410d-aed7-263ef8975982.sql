CREATE TABLE IF NOT EXISTS public.seo_backfill_state (
  crawl_id uuid PRIMARY KEY REFERENCES public.seo_crawls(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  site_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  cursor_offset integer NOT NULL DEFAULT 0,
  pages_processed integer NOT NULL DEFAULT 0,
  urls_created integer NOT NULL DEFAULT 0,
  observations_created integer NOT NULL DEFAULT 0,
  memberships_created integer NOT NULL DEFAULT 0,
  link_edges_created integer NOT NULL DEFAULT 0,
  issue_refs_linked integer NOT NULL DEFAULT 0,
  performance_refs_linked integer NOT NULL DEFAULT 0,
  duplicates_avoided integer NOT NULL DEFAULT 0,
  error text,
  started_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT seo_backfill_state_status_check CHECK (status IN ('pending','running','completed','failed'))
);
CREATE INDEX IF NOT EXISTS seo_backfill_state_status_idx ON public.seo_backfill_state(status, updated_at);
GRANT ALL ON public.seo_backfill_state TO service_role;
ALTER TABLE public.seo_backfill_state ENABLE ROW LEVEL SECURITY;