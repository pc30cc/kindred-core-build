-- 009_fanout_cursor_generation_and_ai_kb_tx.sql
-- Phase 6-S5-R7.1 — final closure.
--
-- FORWARD-ONLY. Does not edit 007 or 008.
--
--   A) The fan-out cursor is bound to the generation that produced it.
--      `cursor_workspace_id` is meaningful ONLY for `cursor_generation`;
--      claiming a different generation resets it so no workspace is skipped.
--   B) Enqueue is concurrency-safe via a transaction-scoped advisory lock
--      keyed on (scope, plan_id): concurrent first enqueues can no longer
--      both miss the SELECT and race the INSERT.
--   C) Fail reports an explicit outcome instead of a bare boolean, and a
--      newer generation always forces a fresh scan from the beginning.
--   D) AI-KB accept / publish / reject become single atomic transactions,
--      so a KB article can never be created without its generated row being
--      linked (which previously allowed duplicates on retry).

-- ── A) Cursor generation ──────────────────────────────────────────────
ALTER TABLE public.entitlement_fanout_jobs
  ADD COLUMN IF NOT EXISTS cursor_generation bigint;

-- Rows carried over from 008 have a cursor that belongs to whatever
-- generation is currently requested (no bump has happened yet for them).
UPDATE public.entitlement_fanout_jobs
SET cursor_generation = requested_generation
WHERE cursor_workspace_id IS NOT NULL AND cursor_generation IS NULL;

-- ── Drop the signatures that change in this migration ─────────────────
DO $drop$
DECLARE r record;
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
        'fail_entitlement_fanout')
  LOOP
    EXECUTE 'DROP FUNCTION ' || r.sig;
  END LOOP;
END
$drop$;

-- ── B) Concurrency-safe enqueue ───────────────────────────────────────
CREATE FUNCTION public.enqueue_entitlement_fanout(
  _scope text,
  _source text,
  _plan_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id  uuid;
  v_key text;
BEGIN
  IF _scope NOT IN ('plan', 'platform') THEN
    RAISE EXCEPTION 'invalid scope';
  END IF;

  -- Serialize the read-then-write per scope. Transaction-scoped, so it is
  -- released on COMMIT/ROLLBACK without any explicit unlock.
  v_key := CASE
    WHEN _scope = 'platform' THEN 'entitlement-fanout:platform'
    ELSE 'entitlement-fanout:plan:' || COALESCE(_plan_id::text, 'null')
  END;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_key, 0));

  SELECT id INTO v_id
  FROM public.entitlement_fanout_jobs
  WHERE status IN ('pending', 'running')
    AND scope = _scope
    AND ((_scope = 'platform') OR plan_id IS NOT DISTINCT FROM _plan_id)
  ORDER BY created_at ASC
  LIMIT 1
  FOR UPDATE;

  IF v_id IS NOT NULL THEN
    -- A change arriving while a generation is already (partially) consumed
    -- MUST NOT be merged into it. Bumping the requested generation forces a
    -- complete new pass from the beginning.
    UPDATE public.entitlement_fanout_jobs
    SET requested_generation = requested_generation + 1,
        next_attempt_at = LEAST(next_attempt_at, now()),
        source = _source
    WHERE id = v_id;
    RETURN v_id;
  END IF;

  INSERT INTO public.entitlement_fanout_jobs (scope, source, plan_id)
  VALUES (_scope, _source, CASE WHEN _scope = 'plan' THEN _plan_id ELSE NULL END)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- ── Generation-aware claim ────────────────────────────────────────────
CREATE FUNCTION public.claim_entitlement_fanout_jobs(
  _worker_id text,
  _limit integer DEFAULT 1,
  _lease_seconds integer DEFAULT 300
)
RETURNS TABLE (
  id uuid,
  scope text,
  source text,
  plan_id uuid,
  cursor_workspace_id uuid,
  cursor_generation bigint,
  attempts integer,
  processed_count integer,
  failed_count integer,
  skipped_ineligible_count integer,
  retryable_failure_count integer,
  permanent_failure_count integer,
  requested_generation bigint,
  processing_generation bigint,
  claim_token uuid,
  claim_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_token uuid := gen_random_uuid();
  v_lease integer := GREATEST(COALESCE(_lease_seconds, 300), 30);
  v_limit integer := LEAST(GREATEST(COALESCE(_limit, 1), 1), 20);
BEGIN
  RETURN QUERY
  WITH candidate AS (
    SELECT j.id
    FROM public.entitlement_fanout_jobs j
    WHERE j.status IN ('pending', 'running')
      AND j.next_attempt_at <= now()
      AND (j.claim_expires_at IS NULL OR j.claim_expires_at <= now())
    ORDER BY j.next_attempt_at ASC, j.created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT v_limit
  )
  UPDATE public.entitlement_fanout_jobs t
  SET status = 'running',
      attempts = t.attempts + 1,
      claim_token = v_token,
      worker_id = _worker_id,
      processing_generation = t.requested_generation,
      -- The cursor survives ONLY when it was produced by the very generation
      -- now being claimed. Otherwise the pass restarts from the beginning,
      -- because workspaces behind the old cursor were decided under stale
      -- entitlements.
      cursor_workspace_id = CASE
        WHEN t.cursor_generation IS NOT NULL
         AND t.cursor_generation = t.requested_generation
        THEN t.cursor_workspace_id ELSE NULL END,
      cursor_generation = CASE
        WHEN t.cursor_generation IS NOT NULL
         AND t.cursor_generation = t.requested_generation
        THEN t.cursor_generation ELSE NULL END,
      claim_expires_at = now() + make_interval(secs => v_lease)
  FROM candidate c
  WHERE t.id = c.id
  RETURNING t.id, t.scope, t.source, t.plan_id,
            t.cursor_workspace_id, t.cursor_generation,
            t.attempts, t.processed_count, t.failed_count,
            t.skipped_ineligible_count, t.retryable_failure_count,
            t.permanent_failure_count,
            t.requested_generation, t.processing_generation,
            t.claim_token, t.claim_expires_at;
END;
$$;

-- ── Advance: stamps the cursor with its owning generation ─────────────
CREATE FUNCTION public.advance_entitlement_fanout(
  _id uuid,
  _claim_token uuid,
  _worker_id text,
  _generation bigint,
  _cursor_workspace_id uuid,
  _processed integer DEFAULT 0,
  _skipped_ineligible integer DEFAULT 0,
  _retryable_failures integer DEFAULT 0,
  _permanent_failures integer DEFAULT 0,
  _lease_seconds integer DEFAULT 300
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.entitlement_fanout_jobs
  SET cursor_workspace_id = _cursor_workspace_id,
      cursor_generation = CASE WHEN _cursor_workspace_id IS NULL THEN NULL ELSE _generation END,
      processed_count = processed_count + GREATEST(COALESCE(_processed, 0), 0),
      skipped_ineligible_count = skipped_ineligible_count + GREATEST(COALESCE(_skipped_ineligible, 0), 0),
      retryable_failure_count = retryable_failure_count + GREATEST(COALESCE(_retryable_failures, 0), 0),
      permanent_failure_count = permanent_failure_count + GREATEST(COALESCE(_permanent_failures, 0), 0),
      failed_count = failed_count + GREATEST(COALESCE(_permanent_failures, 0), 0),
      claim_expires_at = now() + make_interval(secs => GREATEST(COALESCE(_lease_seconds, 300), 30))
  WHERE id = _id
    AND status = 'running'
    AND claim_token = _claim_token
    AND worker_id = _worker_id
    AND processing_generation = _generation
    AND claim_expires_at > now();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count = 1;
END;
$$;

-- ── Complete ──────────────────────────────────────────────────────────
CREATE FUNCTION public.complete_entitlement_fanout(
  _id uuid,
  _claim_token uuid,
  _worker_id text,
  _generation bigint,
  _cursor_workspace_id uuid DEFAULT NULL,
  _processed integer DEFAULT 0,
  _skipped_ineligible integer DEFAULT 0,
  _retryable_failures integer DEFAULT 0,
  _permanent_failures integer DEFAULT 0
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_requested bigint;
BEGIN
  SELECT requested_generation INTO v_requested
  FROM public.entitlement_fanout_jobs
  WHERE id = _id
    AND status = 'running'
    AND claim_token = _claim_token
    AND worker_id = _worker_id
    AND processing_generation = _generation
    AND claim_expires_at > now()
  FOR UPDATE;

  IF v_requested IS NULL THEN
    RETURN 'lease_lost';
  END IF;

  IF v_requested > _generation THEN
    UPDATE public.entitlement_fanout_jobs
    SET status = 'pending',
        cursor_workspace_id = NULL,
        cursor_generation = NULL,
        processing_generation = NULL,
        claim_token = NULL,
        worker_id = NULL,
        claim_expires_at = NULL,
        next_attempt_at = now(),
        processed_count = processed_count + GREATEST(COALESCE(_processed, 0), 0),
        skipped_ineligible_count = skipped_ineligible_count + GREATEST(COALESCE(_skipped_ineligible, 0), 0),
        retryable_failure_count = retryable_failure_count + GREATEST(COALESCE(_retryable_failures, 0), 0),
        permanent_failure_count = permanent_failure_count + GREATEST(COALESCE(_permanent_failures, 0), 0),
        failed_count = failed_count + GREATEST(COALESCE(_permanent_failures, 0), 0)
    WHERE id = _id;
    RETURN 'requeued_new_generation';
  END IF;

  UPDATE public.entitlement_fanout_jobs
  SET status = 'completed',
      completed_generation = _generation,
      cursor_workspace_id = _cursor_workspace_id,
      cursor_generation = _generation,
      processing_generation = NULL,
      processed_count = processed_count + GREATEST(COALESCE(_processed, 0), 0),
      skipped_ineligible_count = skipped_ineligible_count + GREATEST(COALESCE(_skipped_ineligible, 0), 0),
      retryable_failure_count = retryable_failure_count + GREATEST(COALESCE(_retryable_failures, 0), 0),
      permanent_failure_count = permanent_failure_count + GREATEST(COALESCE(_permanent_failures, 0), 0),
      failed_count = failed_count + GREATEST(COALESCE(_permanent_failures, 0), 0),
      claim_token = NULL,
      worker_id = NULL,
      claim_expires_at = NULL,
      completed_at = now()
  WHERE id = _id;
  RETURN 'completed';
END;
$$;

-- ── C) Generation-aware fail / release ────────────────────────────────
CREATE FUNCTION public.fail_entitlement_fanout(
  _id uuid,
  _claim_token uuid,
  _worker_id text,
  _generation bigint,
  _error_code text,
  _retry_seconds integer DEFAULT 300,
  _max_attempts integer DEFAULT 10
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_requested bigint;
  v_attempts  integer;
BEGIN
  SELECT requested_generation, attempts INTO v_requested, v_attempts
  FROM public.entitlement_fanout_jobs
  WHERE id = _id
    AND status = 'running'
    AND claim_token = _claim_token
    AND worker_id = _worker_id
    AND processing_generation = _generation
    AND claim_expires_at > now()
  FOR UPDATE;

  IF v_requested IS NULL THEN
    RETURN 'lease_lost';
  END IF;

  IF v_requested > _generation THEN
    -- The success-boundary cursor belongs to the OLD generation and is not
    -- valid for the new one. Reset and make it immediately claimable: this
    -- is fresh work, not a punished retry, so no backoff is applied.
    UPDATE public.entitlement_fanout_jobs
    SET status = 'pending',
        last_error_code = LEFT(COALESCE(_error_code, 'unknown'), 100),
        cursor_workspace_id = NULL,
        cursor_generation = NULL,
        processing_generation = NULL,
        claim_token = NULL,
        worker_id = NULL,
        claim_expires_at = NULL,
        next_attempt_at = now()
    WHERE id = _id;
    RETURN 'requeued_new_generation';
  END IF;

  IF v_attempts >= GREATEST(COALESCE(_max_attempts, 10), 1) THEN
    UPDATE public.entitlement_fanout_jobs
    SET status = 'failed',
        last_error_code = LEFT(COALESCE(_error_code, 'unknown'), 100),
        next_attempt_at = now() + make_interval(secs => GREATEST(COALESCE(_retry_seconds, 300), 5)),
        processing_generation = NULL,
        claim_token = NULL,
        worker_id = NULL,
        claim_expires_at = NULL
    WHERE id = _id;
    RETURN 'dead_lettered';
  END IF;

  UPDATE public.entitlement_fanout_jobs
  SET status = 'pending',
      last_error_code = LEFT(COALESCE(_error_code, 'unknown'), 100),
      next_attempt_at = now() + make_interval(secs => GREATEST(COALESCE(_retry_seconds, 300), 5)),
      -- Same generation: the success boundary is still authoritative.
      cursor_generation = CASE WHEN cursor_workspace_id IS NULL THEN NULL ELSE _generation END,
      processing_generation = NULL,
      claim_token = NULL,
      worker_id = NULL,
      claim_expires_at = NULL
  WHERE id = _id;
  RETURN 'retry_same_generation';
END;
$$;

-- ── D) Transactional AI-KB draft mutations ────────────────────────────
-- accept / publish previously ran as two independent statements: insert the
-- KB article, then link it back. A failure in between orphaned the article
-- and a retry created a duplicate. These run as ONE transaction and are the
-- only supported write path.

CREATE OR REPLACE FUNCTION public._ai_kb_apply_generated(
  _generated_id uuid,
  _workspace_id uuid,
  _reviewer uuid,
  _content text,
  _article_status text,
  _generated_status text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  g          record;
  v_article  record;
  v_base     text;
  v_slug     text;
  v_clash    uuid;
  i          integer;
BEGIN
  SELECT * INTO g
  FROM public.ai_kb_generated_articles
  WHERE id = _generated_id AND workspace_id = _workspace_id
  FOR UPDATE;

  IF g.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  IF g.kb_article_id IS NOT NULL THEN
    UPDATE public.knowledge_base_articles
    SET title = g.title,
        content = _content,
        excerpt = g.excerpt,
        locale = g.locale,
        status = _article_status
    WHERE id = g.kb_article_id AND workspace_id = _workspace_id
    RETURNING id, workspace_id, slug, locale, status INTO v_article;

    IF v_article.id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'kb_article_workspace_mismatch');
    END IF;
  ELSE
    v_base := COALESCE(NULLIF(g.slug, ''), 'article-' || LEFT(g.id::text, 8));
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

    INSERT INTO public.knowledge_base_articles
      (workspace_id, slug, locale, title, content, excerpt, status)
    VALUES
      (_workspace_id, v_slug, g.locale, g.title, _content, g.excerpt, _article_status)
    RETURNING id, workspace_id, slug, locale, status INTO v_article;
  END IF;

  UPDATE public.ai_kb_generated_articles
  SET status = _generated_status,
      kb_article_id = v_article.id,
      reviewed_by = _reviewer,
      reviewed_at = now()
  WHERE id = _generated_id AND workspace_id = _workspace_id;

  RETURN jsonb_build_object(
    'ok', true,
    'kb_article_id', v_article.id,
    'status', v_article.status,
    'slug', v_article.slug,
    'locale', v_article.locale
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.accept_ai_kb_generated_article(
  _generated_id uuid, _workspace_id uuid, _reviewer uuid, _content text
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public._ai_kb_apply_generated(
    _generated_id, _workspace_id, _reviewer, _content, 'draft', 'accepted');
$$;

CREATE OR REPLACE FUNCTION public.publish_ai_kb_generated_article(
  _generated_id uuid, _workspace_id uuid, _reviewer uuid, _content text
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public._ai_kb_apply_generated(
    _generated_id, _workspace_id, _reviewer, _content, 'published', 'published');
$$;

CREATE OR REPLACE FUNCTION public.reject_ai_kb_generated_article(
  _generated_id uuid, _workspace_id uuid, _reviewer uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_count integer;
BEGIN
  UPDATE public.ai_kb_generated_articles
  SET status = 'rejected', reviewed_by = _reviewer, reviewed_at = now()
  WHERE id = _generated_id AND workspace_id = _workspace_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- These are service-role/edge-free server paths only; no anon or
-- authenticated execute grant is issued.
REVOKE ALL ON FUNCTION public._ai_kb_apply_generated(uuid, uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.accept_ai_kb_generated_article(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.publish_ai_kb_generated_article(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reject_ai_kb_generated_article(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._ai_kb_apply_generated(uuid, uuid, uuid, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.accept_ai_kb_generated_article(uuid, uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.publish_ai_kb_generated_article(uuid, uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.reject_ai_kb_generated_article(uuid, uuid, uuid) TO service_role;
