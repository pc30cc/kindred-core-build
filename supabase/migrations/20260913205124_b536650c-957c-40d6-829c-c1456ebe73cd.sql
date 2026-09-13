CREATE TABLE IF NOT EXISTS public.seo_urls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES public.workspace_domains(id) ON DELETE CASCADE,
  normalized_url text NOT NULL,
  url_hash text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_successful_crawl_id uuid REFERENCES public.seo_crawls(id) ON DELETE SET NULL,
  disappeared_at timestamptz,
  is_active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT seo_urls_workspace_site_hash_key UNIQUE (workspace_id, site_id, url_hash)
);
CREATE INDEX IF NOT EXISTS idx_seo_urls_workspace_last_seen ON public.seo_urls (workspace_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_seo_urls_site_active ON public.seo_urls (site_id, is_active);

ALTER TABLE public.seo_urls ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.seo_urls FROM anon, authenticated;
GRANT ALL ON public.seo_urls TO service_role;

COMMENT ON TABLE public.seo_urls IS
  'Canonical SEO URL entity — created once per (workspace, site, url_hash) and never duplicated across crawls.';

CREATE TABLE IF NOT EXISTS public.seo_crawl_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  crawl_id uuid NOT NULL REFERENCES public.seo_crawls(id) ON DELETE CASCADE,
  url_id uuid NOT NULL REFERENCES public.seo_urls(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES public.workspace_domains(id) ON DELETE CASCADE,
  observed_at timestamptz NOT NULL DEFAULT now(),
  status_code integer,
  title text,
  meta_description text,
  canonical_status text,
  is_indexable boolean,
  internal_links_count integer NOT NULL DEFAULT 0,
  external_links_count integer NOT NULL DEFAULT 0,
  incoming_internal_links_count integer NOT NULL DEFAULT 0,
  issue_flags jsonb NOT NULL DEFAULT '{}'::jsonb,
  observation_hash text NOT NULL,
  changed boolean NOT NULL DEFAULT true,
  change_type text NOT NULL DEFAULT 'new'
    CHECK (change_type IN ('new', 'changed', 'unchanged', 'removed', 'restored')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT seo_crawl_observations_crawl_url_key UNIQUE (crawl_id, url_id)
);
CREATE INDEX IF NOT EXISTS idx_seo_obs_crawl ON public.seo_crawl_observations (crawl_id);
CREATE INDEX IF NOT EXISTS idx_seo_obs_url_time ON public.seo_crawl_observations (url_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_seo_obs_workspace_time ON public.seo_crawl_observations (workspace_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_seo_obs_crawl_changed ON public.seo_crawl_observations (crawl_id, changed);
CREATE INDEX IF NOT EXISTS idx_seo_obs_crawl_status ON public.seo_crawl_observations (crawl_id, status_code);

ALTER TABLE public.seo_crawl_observations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.seo_crawl_observations FROM anon, authenticated;
GRANT ALL ON public.seo_crawl_observations TO service_role;

CREATE TABLE IF NOT EXISTS public.seo_crawl_url_membership (
  crawl_id uuid NOT NULL REFERENCES public.seo_crawls(id) ON DELETE CASCADE,
  url_id uuid NOT NULL REFERENCES public.seo_urls(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES public.workspace_domains(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'unchanged'
    CHECK (state IN ('new', 'changed', 'unchanged', 'removed', 'restored')),
  changed boolean NOT NULL DEFAULT false,
  status_code integer,
  observation_id uuid REFERENCES public.seo_crawl_observations(id) ON DELETE SET NULL,
  effective_observation_id uuid REFERENCES public.seo_crawl_observations(id) ON DELETE SET NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (crawl_id, url_id)
);
CREATE INDEX IF NOT EXISTS idx_seo_membership_url ON public.seo_crawl_url_membership (url_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_seo_membership_crawl_changed ON public.seo_crawl_url_membership (crawl_id, changed);
CREATE INDEX IF NOT EXISTS idx_seo_membership_workspace ON public.seo_crawl_url_membership (workspace_id);

ALTER TABLE public.seo_crawl_url_membership ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.seo_crawl_url_membership FROM anon, authenticated;
GRANT ALL ON public.seo_crawl_url_membership TO service_role;

CREATE OR REPLACE FUNCTION public.seo_backfill_url_model(_max_crawls integer DEFAULT 25)
RETURNS TABLE (crawls_processed integer, urls_created bigint, memberships_created bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c record;
  n_crawls integer := 0;
  n_urls bigint := 0;
  n_mem bigint := 0;
  tmp bigint;
BEGIN
  FOR c IN
    SELECT cr.id, cr.workspace_id, cr.website_id, cr.created_at
    FROM public.seo_crawls cr
    WHERE EXISTS (SELECT 1 FROM public.seo_pages p WHERE p.crawl_id = cr.id)
      AND NOT EXISTS (SELECT 1 FROM public.seo_crawl_url_membership m WHERE m.crawl_id = cr.id)
    ORDER BY cr.created_at ASC
    LIMIT GREATEST(1, _max_crawls)
  LOOP
    WITH ins AS (
      INSERT INTO public.seo_urls (workspace_id, site_id, normalized_url, url_hash, first_seen_at, last_seen_at)
      SELECT DISTINCT ON (md5(p.normalized_url))
             c.workspace_id, c.website_id, p.normalized_url, md5(p.normalized_url),
             COALESCE(p.crawled_at, c.created_at), COALESCE(p.crawled_at, c.created_at)
      FROM public.seo_pages p
      WHERE p.crawl_id = c.id
      ON CONFLICT (workspace_id, site_id, url_hash) DO UPDATE
        SET last_seen_at = GREATEST(public.seo_urls.last_seen_at, EXCLUDED.last_seen_at),
            first_seen_at = LEAST(public.seo_urls.first_seen_at, EXCLUDED.first_seen_at),
            updated_at = now()
      RETURNING (xmax = 0) AS inserted
    )
    SELECT count(*) FILTER (WHERE inserted) INTO tmp FROM ins;
    n_urls := n_urls + COALESCE(tmp, 0);

    WITH ins AS (
      INSERT INTO public.seo_crawl_url_membership
        (crawl_id, url_id, workspace_id, site_id, state, changed, status_code, observed_at)
      SELECT c.id, u.id, c.workspace_id, c.website_id, 'unchanged', false, p.http_status,
             COALESCE(p.crawled_at, c.created_at)
      FROM public.seo_pages p
      JOIN public.seo_urls u
        ON u.workspace_id = c.workspace_id
       AND u.site_id = c.website_id
       AND u.url_hash = md5(p.normalized_url)
      WHERE p.crawl_id = c.id
      ON CONFLICT (crawl_id, url_id) DO NOTHING
      RETURNING 1
    )
    SELECT count(*) INTO tmp FROM ins;
    n_mem := n_mem + COALESCE(tmp, 0);

    n_crawls := n_crawls + 1;
  END LOOP;

  RETURN QUERY SELECT n_crawls, n_urls, n_mem;
END;
$$;

REVOKE ALL ON FUNCTION public.seo_backfill_url_model(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.seo_backfill_url_model(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.seo_retention_prune_crawl_details(
  _keep integer DEFAULT 5,
  _batch_size integer DEFAULT 2000,
  _dry_run boolean DEFAULT false
) RETURNS TABLE (crawls_matched integer, rows_matched bigint, rows_deleted bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  keep integer := GREATEST(1, _keep);
  batch integer := GREATEST(100, LEAST(_batch_size, 50000));
  victim uuid;
  n_crawls integer := 0;
  n_matched bigint := 0;
  n_deleted bigint := 0;
  d bigint;
BEGIN
  FOR victim IN
    SELECT id FROM (
      SELECT cr.id,
             row_number() OVER (PARTITION BY cr.workspace_id, cr.website_id ORDER BY cr.created_at DESC) AS rn
      FROM public.seo_crawls cr
      WHERE cr.status = 'completed'
    ) ranked
    WHERE ranked.rn > keep
      AND EXISTS (SELECT 1 FROM public.seo_pages p WHERE p.crawl_id = ranked.id)
      AND NOT EXISTS (
        SELECT 1 FROM public.background_jobs j
        JOIN public.seo_crawls c2 ON c2.job_id = j.id AND c2.id = ranked.id
        WHERE j.status IN ('queued', 'running', 'processing')
      )
    ORDER BY 1
    LIMIT 200
  LOOP
    n_crawls := n_crawls + 1;

    SELECT count(*) INTO d FROM public.seo_pages WHERE crawl_id = victim;
    n_matched := n_matched + COALESCE(d, 0);
    SELECT count(*) INTO d FROM public.seo_links WHERE crawl_id = victim;
    n_matched := n_matched + COALESCE(d, 0);

    IF _dry_run THEN CONTINUE; END IF;

    LOOP
      WITH victims AS (SELECT ctid FROM public.seo_links WHERE crawl_id = victim LIMIT batch)
      DELETE FROM public.seo_links t USING victims v WHERE t.ctid = v.ctid;
      GET DIAGNOSTICS d = ROW_COUNT;
      n_deleted := n_deleted + d;
      EXIT WHEN d = 0;
    END LOOP;

    LOOP
      WITH victims AS (SELECT ctid FROM public.seo_pages WHERE crawl_id = victim LIMIT batch)
      DELETE FROM public.seo_pages t USING victims v WHERE t.ctid = v.ctid;
      GET DIAGNOSTICS d = ROW_COUNT;
      n_deleted := n_deleted + d;
      EXIT WHEN d = 0;
    END LOOP;

    LOOP
      WITH victims AS (SELECT ctid FROM public.seo_crawl_observations WHERE crawl_id = victim AND change_type = 'unchanged' LIMIT batch)
      DELETE FROM public.seo_crawl_observations t USING victims v WHERE t.ctid = v.ctid;
      GET DIAGNOSTICS d = ROW_COUNT;
      n_deleted := n_deleted + d;
      EXIT WHEN d = 0;
    END LOOP;
  END LOOP;

  RETURN QUERY SELECT n_crawls, n_matched, n_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.seo_retention_prune_crawl_details(integer, integer, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.seo_retention_prune_crawl_details(integer, integer, boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.seo_storage_metrics()
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'unique_urls',             (SELECT count(*) FROM public.seo_urls),
    'active_urls',             (SELECT count(*) FROM public.seo_urls WHERE is_active),
    'crawl_memberships',       (SELECT count(*) FROM public.seo_crawl_url_membership),
    'full_observations',       (SELECT count(*) FROM public.seo_crawl_observations),
    'changed_observations',    (SELECT count(*) FROM public.seo_crawl_observations WHERE changed),
    'unchanged_memberships',   (SELECT count(*) FROM public.seo_crawl_url_membership WHERE NOT changed),
    'legacy_seo_pages',        (SELECT count(*) FROM public.seo_pages),
    'legacy_seo_links',        (SELECT count(*) FROM public.seo_links),
    'rows_avoided',            GREATEST(0,
                                 (SELECT count(*) FROM public.seo_crawl_url_membership)
                                 - (SELECT count(*) FROM public.seo_crawl_observations)),
    'deduplication_ratio',     CASE
                                 WHEN (SELECT count(*) FROM public.seo_crawl_url_membership) = 0 THEN 0
                                 ELSE round(
                                   1 - ((SELECT count(*)::numeric FROM public.seo_crawl_observations)
                                        / (SELECT count(*)::numeric FROM public.seo_crawl_url_membership)), 4)
                               END,
    'seo_urls_bytes',          pg_total_relation_size('public.seo_urls'),
    'observations_bytes',      pg_total_relation_size('public.seo_crawl_observations'),
    'membership_bytes',        pg_total_relation_size('public.seo_crawl_url_membership'),
    'legacy_pages_bytes',      pg_total_relation_size('public.seo_pages'),
    'legacy_links_bytes',      pg_total_relation_size('public.seo_links')
  );
$$;

REVOKE ALL ON FUNCTION public.seo_storage_metrics() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.seo_storage_metrics() TO service_role;

DROP TRIGGER IF EXISTS trg_seo_urls_touch ON public.seo_urls;
CREATE TRIGGER trg_seo_urls_touch
  BEFORE UPDATE ON public.seo_urls
  FOR EACH ROW EXECUTE FUNCTION public.data_retention_touch();