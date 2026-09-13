-- Canonical SEO storage backfill (data-only, NOT a schema migration).
--
-- Converts legacy seo_pages / seo_links into the canonical model
-- (seo_urls, seo_crawl_observations, seo_crawl_url_membership,
--  seo_link_edges, seo_crawl_summaries) and points seo_issue_pages /
--  seo_performance_results at the canonical url_id.
--
-- Properties: read-only over legacy tables (nothing is deleted or updated
-- there), idempotent (every write is ON CONFLICT DO NOTHING on a natural
-- key), and safe to re-run until seo_backfill_state reports every crawl
-- 'completed'. Equivalent to server/services/seo/backfillService.ts; this
-- file is the SQL path used when no service-role runtime is available.
--
-- NOTE on hashing: observation_hash here is sha256 over the page row's
-- jsonb minus the volatile fields (id, crawl_id, workspace_id, created_at,
-- updated_at, crawled_at, response_time_ms, response_bytes,
-- html_size_bytes, depth, discovered_via, incoming_internal_links_count),
-- mirroring VOLATILE_PAGE_FIELDS in urlRepository.ts. Its serialization is
-- Postgres jsonb, not the JS serializer, so the FIRST live crawl after a
-- backfill writes one fresh observation per URL; every crawl after that
-- deduplicates normally.

-- 1. Canonical URL identities
INSERT INTO public.seo_urls (workspace_id, site_id, normalized_url, url_hash, first_seen_at, last_seen_at, is_active)
SELECT c.workspace_id, c.website_id, COALESCE(p.normalized_url, p.url), md5(COALESCE(p.normalized_url, p.url)),
       MIN(COALESCE(p.created_at, c.created_at)), MAX(COALESCE(p.created_at, c.created_at)), true
FROM public.seo_pages p
JOIN public.seo_crawls c ON c.id = p.crawl_id
WHERE COALESCE(p.normalized_url, p.url) IS NOT NULL
GROUP BY 1, 2, 3
ON CONFLICT (workspace_id, site_id, url_hash) DO NOTHING;

-- 2. Delta observations (only when the content hash actually changes)
WITH pg AS (
  SELECT p.id AS page_id, p.crawl_id, c.workspace_id, c.website_id AS site_id, u.id AS url_id,
         COALESCE(p.created_at, c.created_at) AS observed_at, c.created_at AS crawl_created,
         p.http_status, p.title, p.meta_description, p.canonical_status,
         COALESCE(p.is_indexable, true) AS is_indexable,
         COALESCE(p.internal_links_count, 0) AS il, COALESCE(p.external_links_count, 0) AS el,
         COALESCE(p.incoming_internal_links_count, 0) AS iil,
         jsonb_build_object('fetchError', p.fetch_error, 'hasMixedContent', p.has_mixed_content IS TRUE, 'h1Count', COALESCE(p.h1_count, 0)) AS issue_flags,
         to_jsonb(p) AS payload,
         encode(sha256(convert_to(((to_jsonb(p) - 'id' - 'crawl_id' - 'workspace_id' - 'created_at' - 'updated_at' - 'crawled_at' - 'response_time_ms' - 'response_bytes' - 'html_size_bytes' - 'depth' - 'discovered_via' - 'incoming_internal_links_count')::text), 'UTF8')), 'hex') AS h
  FROM public.seo_pages p
  JOIN public.seo_crawls c ON c.id = p.crawl_id
  JOIN public.seo_urls u ON u.workspace_id = c.workspace_id AND u.site_id = c.website_id AND u.url_hash = md5(COALESCE(p.normalized_url, p.url))
), seq AS (
  SELECT pg.*, lag(h) OVER w AS prev_h, row_number() OVER w AS rn
  FROM pg WINDOW w AS (PARTITION BY url_id ORDER BY crawl_created, observed_at)
)
INSERT INTO public.seo_crawl_observations (crawl_id, url_id, workspace_id, site_id, observed_at, status_code, title, meta_description, canonical_status, is_indexable, internal_links_count, external_links_count, incoming_internal_links_count, issue_flags, observation_hash, changed, change_type, payload)
SELECT crawl_id, url_id, workspace_id, site_id, observed_at, http_status, title, meta_description, canonical_status, is_indexable, il, el, iil, issue_flags, h, (rn > 1), CASE WHEN rn = 1 THEN 'new' ELSE 'changed' END, payload
FROM seq
WHERE rn = 1 OR prev_h IS DISTINCT FROM h
ON CONFLICT (crawl_id, url_id) DO NOTHING;

-- 3. Compact membership rows (one per crawled URL per crawl)
WITH pg AS (
  SELECT p.crawl_id, c.workspace_id, c.website_id AS site_id, u.id AS url_id,
         COALESCE(p.created_at, c.created_at) AS observed_at, p.http_status
  FROM public.seo_pages p
  JOIN public.seo_crawls c ON c.id = p.crawl_id
  JOIN public.seo_urls u ON u.workspace_id = c.workspace_id AND u.site_id = c.website_id AND u.url_hash = md5(COALESCE(p.normalized_url, p.url))
), eff AS (
  SELECT pg.*, o.id AS own_obs,
         (SELECT o2.id FROM public.seo_crawl_observations o2
           WHERE o2.url_id = pg.url_id AND o2.observed_at <= pg.observed_at
           ORDER BY o2.observed_at DESC LIMIT 1) AS effective_obs
  FROM pg LEFT JOIN public.seo_crawl_observations o ON o.crawl_id = pg.crawl_id AND o.url_id = pg.url_id
)
INSERT INTO public.seo_crawl_url_membership (crawl_id, url_id, workspace_id, site_id, state, changed, status_code, observation_id, effective_observation_id, observed_at)
SELECT crawl_id, url_id, workspace_id, site_id,
       CASE WHEN own_obs IS NULL THEN 'unchanged' ELSE (SELECT change_type FROM public.seo_crawl_observations o3 WHERE o3.id = own_obs) END,
       own_obs IS NOT NULL, http_status, own_obs, effective_obs, observed_at
FROM eff
ON CONFLICT (crawl_id, url_id) DO NOTHING;

-- 4. Current-state reference per canonical URL
UPDATE public.seo_urls u
SET current_observation_id = latest.obs_id, last_successful_crawl_id = latest.crawl_id,
    last_seen_at = latest.observed_at, updated_at = now()
FROM (
  SELECT DISTINCT ON (m.url_id) m.url_id, m.effective_observation_id AS obs_id, m.crawl_id, m.observed_at
  FROM public.seo_crawl_url_membership m ORDER BY m.url_id, m.observed_at DESC
) latest
WHERE u.id = latest.url_id;

-- 5. Compact CURRENT link graph (one row per source URL + target key)
WITH e AS (
  SELECT DISTINCT ON (c.workspace_id, c.website_id, su.id, (CASE WHEN l.is_external THEN 'e' ELSE 'i' END || '|' || COALESCE(l.target_normalized_url, l.target_url)))
    c.workspace_id, c.website_id AS site_id, su.id AS source_url_id,
    (CASE WHEN l.is_external THEN 'e' ELSE 'i' END || '|' || COALESCE(l.target_normalized_url, l.target_url)) AS target_key,
    l.target_url, l.target_normalized_url, COALESCE(l.is_external, false) AS is_external, l.anchor_text, l.rel,
    tu.id AS target_url_id, l.http_status, COALESCE(l.is_broken, false) AS is_broken, l.crawl_id AS seen_crawl, c.created_at AS seen_at
  FROM public.seo_links l
  JOIN public.seo_crawls c ON c.id = l.crawl_id
  JOIN public.seo_pages sp ON sp.id = l.source_page_id
  JOIN public.seo_urls su ON su.workspace_id = c.workspace_id AND su.site_id = c.website_id AND su.url_hash = md5(COALESCE(sp.normalized_url, sp.url))
  LEFT JOIN public.seo_urls tu ON tu.workspace_id = c.workspace_id AND tu.site_id = c.website_id AND tu.url_hash = md5(COALESCE(l.target_normalized_url, l.target_url))
  ORDER BY 1, 2, 3, 4, c.created_at DESC
)
INSERT INTO public.seo_link_edges (workspace_id, site_id, source_url_id, target_url_id, target_key, target_url, target_normalized_url, is_external, anchor_text, rel, http_status, is_broken, is_active, first_seen_crawl_id, last_seen_crawl_id, first_seen_at, last_seen_at)
SELECT workspace_id, site_id, source_url_id, target_url_id, target_key, target_url, target_normalized_url, is_external, anchor_text, rel, http_status, is_broken, true, seen_crawl, seen_crawl, seen_at, seen_at
FROM e
ON CONFLICT (workspace_id, site_id, source_url_id, target_key) DO NOTHING;

-- 6. Canonical references on legacy-keyed issue / performance rows
UPDATE public.seo_issue_pages ip SET url_id = u.id
FROM public.seo_pages p
JOIN public.seo_crawls c ON c.id = p.crawl_id
JOIN public.seo_urls u ON u.workspace_id = c.workspace_id AND u.site_id = c.website_id AND u.url_hash = md5(COALESCE(p.normalized_url, p.url))
WHERE ip.page_id = p.id AND ip.url_id IS NULL;

UPDATE public.seo_performance_results pr SET url_id = u.id
FROM public.seo_pages p
JOIN public.seo_crawls c ON c.id = p.crawl_id
JOIN public.seo_urls u ON u.workspace_id = c.workspace_id AND u.site_id = c.website_id AND u.url_hash = md5(COALESCE(p.normalized_url, p.url))
WHERE pr.page_id = p.id AND pr.url_id IS NULL;

-- 7. Per-crawl summaries and backfill ledger
INSERT INTO public.seo_crawl_summaries (crawl_id, workspace_id, site_id, urls_discovered, urls_crawled, urls_failed, urls_new, urls_changed, urls_unchanged, urls_removed, urls_restored, internal_links, external_links)
SELECT c.id, c.workspace_id, c.website_id,
  COALESCE(c.pages_discovered, 0), COALESCE(c.pages_crawled, 0), COALESCE(c.pages_failed, 0),
  count(*) FILTER (WHERE m.state = 'new'), count(*) FILTER (WHERE m.state = 'changed'),
  count(*) FILTER (WHERE m.state = 'unchanged'), count(*) FILTER (WHERE m.state = 'removed'),
  count(*) FILTER (WHERE m.state = 'restored'),
  (SELECT count(*) FROM public.seo_links l WHERE l.crawl_id = c.id AND l.is_external IS NOT TRUE),
  (SELECT count(*) FROM public.seo_links l WHERE l.crawl_id = c.id AND l.is_external IS TRUE)
FROM public.seo_crawls c
LEFT JOIN public.seo_crawl_url_membership m ON m.crawl_id = c.id
GROUP BY c.id, c.workspace_id, c.website_id, c.pages_discovered, c.pages_crawled, c.pages_failed
ON CONFLICT (crawl_id) DO NOTHING;

INSERT INTO public.seo_backfill_state (crawl_id, workspace_id, site_id, status, cursor_offset, pages_processed, memberships_created, observations_created, link_edges_created, duplicates_avoided, started_at, finished_at, updated_at)
SELECT c.id, c.workspace_id, c.website_id, 'completed',
  (SELECT count(*) FROM public.seo_pages p WHERE p.crawl_id = c.id),
  (SELECT count(*) FROM public.seo_pages p WHERE p.crawl_id = c.id),
  (SELECT count(*) FROM public.seo_crawl_url_membership m WHERE m.crawl_id = c.id),
  (SELECT count(*) FROM public.seo_crawl_observations o WHERE o.crawl_id = c.id),
  (SELECT count(*) FROM public.seo_link_edges e WHERE e.last_seen_crawl_id = c.id),
  (SELECT count(*) FROM public.seo_crawl_url_membership m WHERE m.crawl_id = c.id AND m.observation_id IS NULL),
  now(), now(), now()
FROM public.seo_crawls c
ON CONFLICT (crawl_id) DO UPDATE SET status = 'completed', finished_at = now(), updated_at = now(), error = NULL;
