-- 010_fanout_rpc_security_and_kb_state_machine.sql
-- Phase 6-S5-R7.2 — security closure + generated-article state machine.
--
-- FORWARD-ONLY. Does not edit 007, 008 or 009. Safe to re-run.
--
--   A) Migration 009 DROPped and re-CREATEd the fan-out RPCs. Dropping a
--      function destroys its ACL, and a freshly created function is
--      EXECUTE-able by PUBLIC by default. Every fan-out RPC is
--      SECURITY DEFINER, so PUBLIC execute is a privilege escalation:
--      RLS on entitlement_fanout_jobs does not protect it. Re-apply least
--      privilege to the CURRENT signatures.
--   B) The generated-article mutations become a real state machine, validated
--      under a row lock in the same transaction as the KB article write, so
--      concurrent publish/reject can never produce contradictory state.
--   C) The title-derived slug seed computed by the server is actually passed
--      to the transaction (`_slug_seed`), and slug allocation is serialized
--      per (workspace, locale, base) so a concurrent apply cannot duplicate.

-- ══ A) Fan-out RPC lockdown ═══════════════════════════════════════════
DO $secure$
DECLARE
  r      record;
  v_sig  text;
BEGIN
  FOR r IN
    SELECT oid::regprocedure AS sig
    FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace
      AND proname IN (
        'enqueue_entitlement_fanout',
        'claim_entitlement_fanout_jobs',
        'advance_entitlement_fanout',
        'complete_entitlement_fanout',
        'fail_entitlement_fanout',
        '_ai_kb_apply_generated',
        'accept_ai_kb_generated_article',
        'publish_ai_kb_generated_article',
        'reject_ai_kb_generated_article')
  LOOP
    v_sig := r.sig::text;
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_sig);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', v_sig);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', v_sig);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_sig);
    END IF;
  END LOOP;
END
$secure$;

-- Queue table: internal-only, no customer role may touch it directly.
DO $tbl$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE relname = 'entitlement_fanout_jobs'
      AND relnamespace = 'public'::regnamespace
  ) THEN
    RETURN;
  END IF;
  EXECUTE 'ALTER TABLE public.entitlement_fanout_jobs ENABLE ROW LEVEL SECURITY';
  EXECUTE 'REVOKE ALL ON TABLE public.entitlement_fanout_jobs FROM PUBLIC';
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.entitlement_fanout_jobs FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.entitlement_fanout_jobs FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT ALL ON TABLE public.entitlement_fanout_jobs TO service_role';
  END IF;
END
$tbl$;

-- ══ B/C) Generated-article state machine ══════════════════════════════
-- Signatures change (they gain `_slug_seed`), so the old ones are dropped.
DO $drop$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT oid::regprocedure AS sig
    FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace
      AND proname IN (
        '_ai_kb_apply_generated',
        'accept_ai_kb_generated_article',
        'publish_ai_kb_generated_article',
        'reject_ai_kb_generated_article')
  LOOP
    EXECUTE 'DROP FUNCTION ' || r.sig;
  END LOOP;
END
$drop$;

/*
 * Allowed transitions (everything else → invalid_state):
 *   pending   → accepted            accepted  → accepted   (idempotent)
 *   pending   → published           accepted  → published
 *                                   published → published  (idempotent)
 *   pending   → rejected            rejected  → rejected    (idempotent)
 *
 * Explicitly refused: published→accepted, published→rejected,
 * rejected→accepted, rejected→published, accepted→rejected.
 */
CREATE FUNCTION public._ai_kb_apply_generated(
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

    -- Serialize slug allocation for this (workspace, locale, base). Two
    -- concurrent applies therefore cannot both observe the same free slug.
    PERFORM pg_advisory_xact_lock(
      hashtextextended('ai-kb-slug:' || _workspace_id::text || ':' || g.locale || ':' || v_base, 0));

    v_slug := v_base;
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

    INSERT INTO public.knowledge_base_articles
      (workspace_id, slug, locale, title, content, excerpt, status)
    VALUES
      (_workspace_id, v_slug, g.locale, g.title, _content, g.excerpt, _article_status)
    RETURNING id, slug, locale, status
      INTO v_article_id, v_slug_out, v_locale_out, v_status_out;
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

CREATE FUNCTION public.accept_ai_kb_generated_article(
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

CREATE FUNCTION public.publish_ai_kb_generated_article(
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

-- Reject is state-validated under the SAME row lock. A draft that was already
-- accepted or published owns a KB article; rejecting it would leave a live
-- article linked to a rejected row.
CREATE FUNCTION public.reject_ai_kb_generated_article(
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

-- New signatures need the same least-privilege treatment.
DO $grants$
DECLARE
  v_sigs text[] := ARRAY[
    'public._ai_kb_apply_generated(uuid, uuid, uuid, text, text, text, text)',
    'public.accept_ai_kb_generated_article(uuid, uuid, uuid, text, text)',
    'public.publish_ai_kb_generated_article(uuid, uuid, uuid, text, text)',
    'public.reject_ai_kb_generated_article(uuid, uuid, uuid)'
  ];
  v_sig text;
BEGIN
  FOREACH v_sig IN ARRAY v_sigs LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_sig);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', v_sig);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', v_sig);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_sig);
    END IF;
  END LOOP;
END
$grants$;
