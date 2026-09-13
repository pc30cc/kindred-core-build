-- 171_retention_post_migration_safety_fence
-- Forward-only containment. Historical 169/170 remain immutable.
CREATE OR REPLACE FUNCTION public.data_retention_delete_batch(_policy_key text, _cutoff timestamptz, _batch_size integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'retention_cleanup_not_ready: destructive execution is fenced pending production audit';
END;
$$;
CREATE OR REPLACE FUNCTION public.seo_retention_prune_crawl_details(_keep integer DEFAULT 5, _batch_size integer DEFAULT 2000, _dry_run boolean DEFAULT false)
RETURNS TABLE(crawls_matched integer, rows_matched bigint, rows_deleted bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF _dry_run IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'seo_retention_cleanup_not_ready: legacy data and current observations must be preserved';
  END IF;
  RETURN QUERY
  WITH ranked AS (
    SELECT c.id, row_number() OVER (PARTITION BY c.workspace_id,c.website_id ORDER BY c.created_at DESC,c.id DESC) AS rn
    FROM public.seo_crawls c WHERE c.status='completed'
  ), eligible AS (
    SELECT r.id FROM ranked r WHERE r.rn > GREATEST(5,COALESCE(_keep,5))
    AND NOT EXISTS (SELECT 1 FROM public.seo_crawls c JOIN public.background_jobs j ON j.id=c.job_id WHERE c.id=r.id AND j.status IN ('queued','running','processing'))
  )
  SELECT count(*)::integer,
    COALESCE(sum((SELECT count(*) FROM public.seo_crawl_observations o WHERE o.crawl_id=e.id)
      +(SELECT count(*) FROM public.seo_crawl_url_membership m WHERE m.crawl_id=e.id)),0)::bigint,
    0::bigint FROM eligible e;
END;
$$;
REVOKE ALL ON FUNCTION public.data_retention_count_expired(text,timestamptz) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.data_retention_delete_batch(text,timestamptz,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.data_retention_touch() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.seo_backfill_url_model(integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.seo_retention_prune_crawl_details(integer,integer,boolean) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.seo_storage_metrics() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.data_retention_count_expired(text,timestamptz), public.data_retention_delete_batch(text,timestamptz,integer), public.data_retention_touch(), public.seo_backfill_url_model(integer), public.seo_retention_prune_crawl_details(integer,integer,boolean), public.seo_storage_metrics() TO service_role;