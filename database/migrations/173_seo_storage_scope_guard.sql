-- 173: enforce canonical SEO scope without altering historical migrations.
CREATE OR REPLACE FUNCTION public.seo_validate_storage_scope()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.workspace_domains d WHERE d.id = NEW.site_id AND d.workspace_id = NEW.workspace_id) THEN
    RAISE EXCEPTION 'seo_storage_site_scope_mismatch';
  END IF;
  IF TG_TABLE_NAME = 'seo_urls' THEN
    IF NEW.last_successful_crawl_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.seo_crawls c WHERE c.id = NEW.last_successful_crawl_id AND c.workspace_id = NEW.workspace_id AND c.website_id = NEW.site_id) THEN
      RAISE EXCEPTION 'seo_storage_crawl_scope_mismatch';
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM public.seo_urls u WHERE u.id = NEW.url_id AND u.workspace_id = NEW.workspace_id AND u.site_id = NEW.site_id) OR NOT EXISTS (SELECT 1 FROM public.seo_crawls c WHERE c.id = NEW.crawl_id AND c.workspace_id = NEW.workspace_id AND c.website_id = NEW.site_id) THEN
      RAISE EXCEPTION 'seo_storage_crawl_url_scope_mismatch';
    END IF;
    IF TG_TABLE_NAME = 'seo_crawl_url_membership' THEN
      IF NEW.observation_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.seo_crawl_observations o WHERE o.id = NEW.observation_id AND o.url_id = NEW.url_id AND o.crawl_id = NEW.crawl_id AND o.workspace_id = NEW.workspace_id AND o.site_id = NEW.site_id) THEN
        RAISE EXCEPTION 'seo_storage_observation_scope_mismatch';
      END IF;
      IF NEW.effective_observation_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.seo_crawl_observations o WHERE o.id = NEW.effective_observation_id AND o.url_id = NEW.url_id AND o.workspace_id = NEW.workspace_id AND o.site_id = NEW.site_id) THEN
        RAISE EXCEPTION 'seo_storage_effective_observation_scope_mismatch';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.seo_validate_storage_scope() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.seo_validate_storage_scope() TO service_role;
CREATE TRIGGER seo_urls_scope_guard BEFORE INSERT OR UPDATE ON public.seo_urls FOR EACH ROW EXECUTE FUNCTION public.seo_validate_storage_scope();
CREATE TRIGGER seo_observations_scope_guard BEFORE INSERT OR UPDATE ON public.seo_crawl_observations FOR EACH ROW EXECUTE FUNCTION public.seo_validate_storage_scope();
CREATE TRIGGER seo_membership_scope_guard BEFORE INSERT OR UPDATE ON public.seo_crawl_url_membership FOR EACH ROW EXECUTE FUNCTION public.seo_validate_storage_scope();