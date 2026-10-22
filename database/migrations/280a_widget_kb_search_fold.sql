-- 280a — The help search finds an article whatever keyboard the visitor
-- typed on: «پيگيري» (Arabic yeh and kaf) finds «پیگیری», «میخواهم» finds
-- «می‌خواهم», «۲۰۲۶» and «٢٠٢٦» find «2026», in either direction.
--
-- 1. public.kb_search_fold(text): the text with the Arabic-keyboard letters
--    made Persian (ي ى → ی, ك → ک), «ۀ» made «ه», Persian and Arabic-Indic
--    digits made ASCII, and the joiners (ZWNJ, ZWJ), the tatweel and the
--    Arabic marks (tanween, harakat, the hamza above, the superscript alef)
--    taken out. Case is left alone:
--    the search compares with ILIKE, which folds it as it always did. The
--    server folds the visitor's words the same way
--    (server/services/knowledge-base/widgetSuggest.ts kbFold; the pg test
--    widgetKbFold280a runs both on one fixture set).
-- 2. public.kb_search_folded(workspace, terms, with_content, widget_only):
--    the workspace's published articles that any of `terms` matches, folded
--    on both sides, in the title, the summary or (with_content) the text;
--    with widget_only, only articles shown in the widget. Each term is one
--    substring (LIKE's own characters in it are escaped). The newest first.
--    It returns whole rows (SETOF knowledge_base_articles) so the caller
--    selects its columns and adds its own filters (the plan's KB lock, the
--    limit), as it does on the table. Used by the widget's help search (word
--    by word and as one phrase), its instant answers and the help center's
--    search page; without this file they keep their plain ILIKE (the server
--    falls back on 42883/PGRST202).
--
-- No index: the fold runs over one workspace's published articles (the
-- workspace index narrows the rows first), which is what the ILIKE over
-- three columns read before. An expression index would tie the function's
-- definition to the index for good.
--
-- SECURITY INVOKER, search_path pinned; executable by service_role only.
-- Locks: none on any table (two functions created or replaced). Re-runnable.
-- Dry run: the file inside BEGIN … ROLLBACK. Drops nothing; touches no
-- archive schema or table.

SET lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.kb_search_fold(p_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT translate(
    regexp_replace(coalesce(p_text, ''), U&'[\200C\200D\0640\064B-\065F\0670]', '', 'g'),
    U&'\064A\0649\0643\06C0\0660\0661\0662\0663\0664\0665\0666\0667\0668\0669\06F0\06F1\06F2\06F3\06F4\06F5\06F6\06F7\06F8\06F9',
    U&'\06CC\06CC\06A9\064701234567890123456789'
  )
$$;

COMMENT ON FUNCTION public.kb_search_fold(text) IS
  'The help search''s fold: Arabic yeh/kaf made Persian, heh with yeh above made heh, Persian and Arabic-Indic digits made ASCII, joiners, tatweel and Arabic marks removed; case kept (compared with ILIKE). Mirrors kbFold in server/services/knowledge-base/widgetSuggest.ts. Migration 280a.';

CREATE OR REPLACE FUNCTION public.kb_search_folded(
  p_workspace_id uuid,
  p_terms text[],
  p_with_content boolean DEFAULT true,
  p_widget_only boolean DEFAULT false
)
RETURNS SETOF public.knowledge_base_articles
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
  WITH t AS (
    SELECT DISTINCT
      '%' || replace(replace(replace(public.kb_search_fold(term), '\', '\\'), '%', '\%'), '_', '\_') || '%' AS pat
    FROM unnest(coalesce(p_terms, ARRAY[]::text[])) AS term
    WHERE btrim(public.kb_search_fold(term)) <> ''
  )
  SELECT a.*
  FROM public.knowledge_base_articles a
  CROSS JOIN LATERAL (
    -- Each column folded once per row, whatever the number of terms.
    SELECT public.kb_search_fold(a.title) AS ft,
           public.kb_search_fold(a.excerpt) AS fe,
           CASE WHEN p_with_content THEN public.kb_search_fold(a.content) END AS fc
    OFFSET 0
  ) f
  WHERE a.workspace_id = p_workspace_id
    AND a.status = 'published'
    AND (NOT p_widget_only OR a.visible_in_widget)
    AND EXISTS (
      SELECT 1 FROM t
      WHERE f.ft ILIKE t.pat OR f.fe ILIKE t.pat OR (p_with_content AND f.fc ILIKE t.pat)
    )
  ORDER BY a.updated_at DESC NULLS LAST, a.id
$$;

COMMENT ON FUNCTION public.kb_search_folded(uuid, text[], boolean, boolean) IS
  'The published articles of a workspace any term matches, folded on both sides (kb_search_fold) in title, excerpt and, with p_with_content, content; p_widget_only keeps visible_in_widget articles. Newest first. Migration 280a.';

DO $acl$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.kb_search_fold(text)',
    'public.kb_search_folded(uuid, text[], boolean, boolean)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', f);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', f);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
    END IF;
  END LOOP;
END $acl$;

RESET lock_timeout;
