-- KB search infrastructure: pg_trgm + GIN indexes + search RPC

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Trigram indexes on knowledge_base_articles for ILIKE/similarity queries.
-- These accelerate fuzzy search across title/excerpt/content, including
-- locales (e.g. fa) where Postgres ships no native dictionary.
CREATE INDEX IF NOT EXISTS idx_kb_articles_title_trgm
  ON public.knowledge_base_articles USING gin (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_kb_articles_excerpt_trgm
  ON public.knowledge_base_articles USING gin (excerpt gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_kb_articles_content_trgm
  ON public.knowledge_base_articles USING gin (content gin_trgm_ops);

-- Composite index that almost every public query will hit.
CREATE INDEX IF NOT EXISTS idx_kb_articles_ws_locale_status
  ON public.knowledge_base_articles (workspace_id, locale, status);

CREATE INDEX IF NOT EXISTS idx_kb_categories_ws_locale
  ON public.knowledge_base_categories (workspace_id, locale);

-- Search RPC: lowercase + trim normalization, scored by best of
-- (title similarity, excerpt similarity, content similarity, ILIKE in title).
-- Workspace + locale + published filter applied here so the public/widget
-- callers cannot bypass scoping by accident.
CREATE OR REPLACE FUNCTION public.kb_search_articles(
  p_workspace_id uuid,
  p_locale text,
  p_query text,
  p_limit int DEFAULT 8
)
RETURNS TABLE (
  id uuid,
  title text,
  slug text,
  excerpt text,
  category_id uuid,
  category_slug text,
  category_name text,
  score real
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH q AS (
    SELECT trim(lower(coalesce(p_query, ''))) AS qtext
  )
  SELECT
    a.id,
    a.title,
    a.slug,
    a.excerpt,
    a.category_id,
    c.slug AS category_slug,
    c.name AS category_name,
    GREATEST(
      similarity(lower(a.title), (SELECT qtext FROM q)),
      similarity(lower(coalesce(a.excerpt, '')), (SELECT qtext FROM q)) * 0.7,
      similarity(lower(coalesce(a.content, '')), (SELECT qtext FROM q)) * 0.4,
      CASE WHEN lower(a.title) ILIKE '%' || (SELECT qtext FROM q) || '%' THEN 0.5 ELSE 0 END
    )::real AS score
  FROM public.knowledge_base_articles a
  LEFT JOIN public.knowledge_base_categories c ON c.id = a.category_id
  WHERE a.workspace_id = p_workspace_id
    AND a.locale = p_locale
    AND a.status = 'published'
    AND (SELECT length(qtext) FROM q) >= 2
    AND (
      lower(a.title)             ILIKE '%' || (SELECT qtext FROM q) || '%'
      OR lower(coalesce(a.excerpt, '')) ILIKE '%' || (SELECT qtext FROM q) || '%'
      OR lower(coalesce(a.content, '')) ILIKE '%' || (SELECT qtext FROM q) || '%'
      OR similarity(lower(a.title), (SELECT qtext FROM q)) > 0.2
    )
  ORDER BY score DESC, a.sort_order ASC NULLS LAST, a.updated_at DESC
  LIMIT GREATEST(1, LEAST(coalesce(p_limit, 8), 50));
$$;

REVOKE ALL ON FUNCTION public.kb_search_articles(uuid, text, text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kb_search_articles(uuid, text, text, int) TO anon, authenticated, service_role;