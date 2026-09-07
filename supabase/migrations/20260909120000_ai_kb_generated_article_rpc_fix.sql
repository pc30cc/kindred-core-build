-- Fix AI-KB generated-article RPCs: never successfully deployed, and buggy
-- even where they were.
--
-- Two independent problems, discovered together while investigating
-- "Knowledge base temporarily unavailable" on every accept/publish/reject
-- click in the AI website-scan builder:
--
--   1. `_ai_kb_apply_generated`, `accept_ai_kb_generated_article`,
--      `publish_ai_kb_generated_article` and `reject_ai_kb_generated_article`
--      (introduced across 009-011) did not exist on the live database at
--      all — confirmed via pg_proc lookup. Every accept/publish/reject call
--      failed transport-level (function does not exist), which the route
--      layer correctly reports as a 503 retryable error — exactly the
--      symptom seen.
--
--   2. `_ai_kb_apply_generated`'s body (as shipped in 010/011) assigns a
--      plain `text` PL/pgSQL variable directly to `knowledge_base_articles
--      .status` (article_status enum) and `ai_kb_generated_articles.status`
--      (ai_kb_generated_status enum). PostgreSQL has no implicit assignment
--      cast from a *variable* of declared type text to a user-defined enum
--      (unlike an untyped string literal, which is inferred at parse time),
--      so every call — even after the function exists — fails with
--      "column is of type ... but expression is of type text". This means
--      009-011 were never actually exercised against a real Postgres
--      instance before shipping.
--
-- Forward-only: 009-011 are frozen and not edited. This CREATE OR REPLACEs
-- the same four functions with explicit `::article_status` /
-- `::ai_kb_generated_status` casts, so it both installs them fresh (a
-- self-host that never got 009-011 applied) and repairs an existing but
-- broken install. Signatures, ACL and business logic are otherwise
-- unchanged from 011 (state machine) / 010 (grants).

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
        status = _article_status::public.article_status
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

    -- Lock the (workspace, locale) SLUG NAMESPACE — the exact scope the slug
    -- must be unique within — so concurrent allocations for the same
    -- namespace are serialized regardless of their base (R7.3 fix from 011).
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

      -- Defence in depth: an out-of-band writer outside this advisory lock
      -- can still take the slug between the probe and the INSERT. Retry
      -- rather than aborting the caller's publish transaction.
      BEGIN
        INSERT INTO public.knowledge_base_articles
          (workspace_id, slug, locale, title, content, excerpt, status)
        VALUES
          (_workspace_id, v_slug, g.locale, g.title, _content, g.excerpt, _article_status::public.article_status)
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
  SET status = _generated_status::public.ai_kb_generated_status,
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

CREATE OR REPLACE FUNCTION public.accept_ai_kb_generated_article(
  _generated_id uuid, _workspace_id uuid, _reviewer uuid, _content text,
  _slug_seed text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public._ai_kb_apply_generated(
    _generated_id, _workspace_id, _reviewer, _content, 'draft', 'accepted', _slug_seed);
$$;

CREATE OR REPLACE FUNCTION public.publish_ai_kb_generated_article(
  _generated_id uuid, _workspace_id uuid, _reviewer uuid, _content text,
  _slug_seed text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public._ai_kb_apply_generated(
    _generated_id, _workspace_id, _reviewer, _content, 'published', 'published', _slug_seed);
$$;

-- Reject is state-validated under the SAME row lock. A draft that was
-- already accepted or published owns a KB article; rejecting it would
-- leave a live article linked to a rejected row.
CREATE OR REPLACE FUNCTION public.reject_ai_kb_generated_article(
  _generated_id uuid, _workspace_id uuid, _reviewer uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE g record;
BEGIN
  SELECT * INTO g
  FROM public.ai_kb_generated_articles
  WHERE id = _generated_id AND workspace_id = _workspace_id
  FOR UPDATE;

  IF g.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  IF g.status NOT IN ('pending', 'rejected') THEN
    RETURN jsonb_build_object(
      'ok', false, 'error', 'invalid_state', 'current_status', g.status);
  END IF;

  UPDATE public.ai_kb_generated_articles
  SET status = 'rejected', reviewed_by = _reviewer, reviewed_at = now()
  WHERE id = _generated_id AND workspace_id = _workspace_id;

  RETURN jsonb_build_object('ok', true, 'status', 'rejected');
END;
$$;

-- Same least-privilege ACL as 010/012/014: service_role only.
DO $acl$
DECLARE
  fn text;
  sigs text[] := ARRAY[
    'public._ai_kb_apply_generated(uuid, uuid, uuid, text, text, text, text)',
    'public.accept_ai_kb_generated_article(uuid, uuid, uuid, text, text)',
    'public.publish_ai_kb_generated_article(uuid, uuid, uuid, text, text)',
    'public.reject_ai_kb_generated_article(uuid, uuid, uuid)'
  ];
BEGIN
  FOREACH fn IN ARRAY sigs LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', fn);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', fn);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    END IF;
  END LOOP;
END
$acl$;
