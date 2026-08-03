-- ============================================================
-- Phase 6-S5-R7.3 — hardened AI-KB slug allocation
-- ============================================================
--
-- Defect fixed
-- ------------
-- `_ai_kb_apply_generated` serialized slug allocation with an advisory lock
-- keyed on (workspace, locale, BASE slug). Two concurrent applies with
-- DIFFERENT bases therefore take DIFFERENT locks while competing for the same
-- final slug:
--
--   tx A: base "pricing"    → probes "pricing" (taken) → picks "pricing-2"
--   tx B: base "pricing-2"  → probes "pricing-2" (free) → picks "pricing-2"
--
-- Both then INSERT "pricing-2". Whichever commits second either violates the
-- (workspace_id, locale, slug) uniqueness constraint and aborts the whole
-- publish transaction, or — where no such constraint exists — silently
-- produces two articles that resolve to the same public Help Center URL.
--
-- Fix
-- ---
--   1. The lock namespace is now (workspace, locale) — the exact scope the
--      slug must be unique within — so all concurrent allocations for a
--      workspace/locale are serialized regardless of their base.
--   2. The INSERT is retried on unique_violation, so an out-of-band writer
--      (an operator creating an article by hand, a second connection) cannot
--      abort a publish either.
--
-- Forward-only: this migration REPLACES the function bodies from 010. The
-- signature is unchanged, so the 010 GRANT/REVOKE ACL is preserved by
-- CREATE OR REPLACE and service_role stays the only caller.
-- ============================================================

CREATE OR REPLACE FUNCTION public._ai_kb_apply_generated(
  _generated_id     uuid,
  _workspace_id     uuid,
  _reviewer         uuid,
  _content          text,
  _article_status   text,
  _generated_status text,
  _slug_seed        text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  g            record;
  v_article_id uuid;
  v_slug_out   text;
  v_locale_out text;
  v_status_out text;
  v_base       text;
  v_slug       text;
  v_clash      uuid;
  i            integer;
  attempt      integer;
BEGIN
  -- The row lock is taken FIRST and held for the whole transaction: state
  -- validation and the KB write can never straddle a concurrent mutation.
  SELECT * INTO g
  FROM public.ai_kb_generated_articles
  WHERE id = _generated_id AND workspace_id = _workspace_id
  FOR UPDATE;

  IF g.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  IF _generated_status = 'accepted' THEN
    IF g.status NOT IN ('pending', 'accepted') THEN
      RETURN jsonb_build_object(
        'ok', false, 'error', 'invalid_state', 'current_status', g.status);
    END IF;
  ELSIF _generated_status = 'published' THEN
    IF g.status NOT IN ('pending', 'accepted', 'published') THEN
      RETURN jsonb_build_object(
        'ok', false, 'error', 'invalid_state', 'current_status', g.status);
    END IF;
  ELSE
    RETURN jsonb_build_object(
      'ok', false, 'error', 'invalid_state', 'current_status', g.status);
  END IF;

  IF g.kb_article_id IS NOT NULL THEN
    UPDATE public.knowledge_base_articles
    SET title = g.title,
        content = _content,
        excerpt = g.excerpt,
        locale = g.locale,
        status = _article_status
    WHERE id = g.kb_article_id AND workspace_id = _workspace_id
    RETURNING id, slug, locale, status
      INTO v_article_id, v_slug_out, v_locale_out, v_status_out;

    IF v_article_id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'kb_article_workspace_mismatch');
    END IF;
  ELSE
    -- Slug contract: stored slug → server title slug → deterministic id slug.
    v_base := COALESCE(
      NULLIF(g.slug, ''),
      NULLIF(_slug_seed, ''),
      'article-' || LEFT(g.id::text, 8));

    -- R7.3 — lock the (workspace, locale) SLUG NAMESPACE, not the base. The
    -- uniqueness scope is the namespace, so that is the only scope in which
    -- serialization is correct: two applies whose bases differ but whose
    -- suffixed candidates collide are now ordered against each other.
    PERFORM pg_advisory_xact_lock(
      hashtextextended('ai-kb-slug-ns:' || _workspace_id::text || ':' || g.locale, 0));

    attempt := 0;
    <<allocate>>
    LOOP
      attempt := attempt + 1;
      v_slug := v_base;
      v_clash := NULL;

      FOR i IN 0..49 LOOP
        SELECT id INTO v_clash
        FROM public.knowledge_base_articles
        WHERE workspace_id = _workspace_id AND locale = g.locale AND slug = v_slug
        LIMIT 1;
        EXIT WHEN v_clash IS NULL;
        v_slug := v_base || '-' || (i + 2)::text;
        v_clash := NULL;
      END LOOP;

      IF v_clash IS NOT NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'slug_allocation_failed');
      END IF;

      -- Defence in depth: an out-of-band writer outside this advisory lock can
      -- still take the slug between the probe and the INSERT. Retry rather
      -- than aborting the caller's publish transaction.
      BEGIN
        INSERT INTO public.knowledge_base_articles
          (workspace_id, slug, locale, title, content, excerpt, status)
        VALUES
          (_workspace_id, v_slug, g.locale, g.title, _content, g.excerpt, _article_status)
        RETURNING id, slug, locale, status
          INTO v_article_id, v_slug_out, v_locale_out, v_status_out;
        EXIT allocate;
      EXCEPTION WHEN unique_violation THEN
        IF attempt >= 5 THEN
          RETURN jsonb_build_object('ok', false, 'error', 'slug_allocation_failed');
        END IF;
        -- fall through and re-probe
      END;
    END LOOP;
  END IF;

  UPDATE public.ai_kb_generated_articles
  SET status = _generated_status,
      kb_article_id = v_article_id,
      reviewed_by = _reviewer,
      reviewed_at = now()
  WHERE id = _generated_id AND workspace_id = _workspace_id;

  RETURN jsonb_build_object(
    'ok', true,
    'kb_article_id', v_article_id,
    'status', v_status_out,
    'slug', v_slug_out,
    'locale', v_locale_out
  );
END;
$$;

-- Re-assert the security posture from 010 (idempotent, and explicit so a
-- partial replay cannot leave the function callable by PUBLIC).
REVOKE ALL ON FUNCTION public._ai_kb_apply_generated(uuid, uuid, uuid, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._ai_kb_apply_generated(uuid, uuid, uuid, text, text, text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public._ai_kb_apply_generated(uuid, uuid, uuid, text, text, text, text) TO service_role;
