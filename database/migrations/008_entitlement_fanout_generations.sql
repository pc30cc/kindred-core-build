-- 008_entitlement_fanout_generations.sql
-- Phase 6-S5-R7 — lossless fan-out: generation semantics, success-boundary
-- cursor accounting and explicit outcome counters.
--
-- FORWARD-ONLY. Does not edit 007. Preserves every existing job row:
-- active jobs keep their cursor and become generation 1, completed jobs are
-- backfilled to completed_generation = 1. No job is deleted.

-- ── Columns ───────────────────────────────────────────────────────────
ALTER TABLE public.entitlement_fanout_jobs
  ADD COLUMN IF NOT EXISTS requested_generation  bigint  NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS processing_generation bigint,
  ADD COLUMN IF NOT EXISTS completed_generation  bigint  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS skipped_ineligible_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS retryable_failure_count  integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS permanent_failure_count  integer NOT NULL DEFAULT 0;

-- Historical completed rows finished exactly one generation of work.
UPDATE public.entitlement_fanout_jobs
SET completed_generation = 1
WHERE status = 'completed' AND completed_generation = 0;

-- An active job claimed under the R6 RPCs has no processing_generation yet.
-- Leave it NULL: the next claim adopts requested_generation (=1) and the
-- preserved cursor, so in-flight work resumes rather than restarting.

-- ── Enqueue: bump the generation instead of silently merging ──────────
CREATE OR REPLACE FUNCTION public.enqueue_entitlement_fanout(
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
  v_id uuid;
BEGIN
  IF _scope NOT IN ('plan', 'platform') THEN
    RAISE EXCEPTION 'invalid scope';
  END IF;

  SELECT id INTO v_id
  FROM public.entitlement_fanout_jobs
  WHERE status IN ('pending', 'running')
    AND scope = _scope
    AND ((_scope = 'platform') OR plan_id IS NOT DISTINCT FROM _plan_id)
  LIMIT 1;

  IF v_id IS NOT NULL THEN
    -- A change arriving while a generation is already (partially) consumed
    -- MUST NOT be merged into it: the in-flight pass may already be past
    -- workspaces that the new change affects. Bumping the requested
    -- generation forces a complete new pass from the beginning.
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

-- ── Claim a SPECIFIC generation ───────────────────────────────────────
DROP FUNCTION IF EXISTS public.claim_entitlement_fanout_jobs(text, integer, integer);
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
      -- The worker owns exactly this generation for the whole pass.
      processing_generation = t.requested_generation,
      claim_expires_at = now() + make_interval(secs => v_lease)
  FROM candidate c
  WHERE t.id = c.id
  RETURNING t.id, t.scope, t.source, t.plan_id, t.cursor_workspace_id,
            t.attempts, t.processed_count, t.failed_count,
            t.skipped_ineligible_count, t.retryable_failure_count,
            t.permanent_failure_count,
            t.requested_generation, t.processing_generation,
            t.claim_token, t.claim_expires_at;
END;
$$;

-- ── Advance: owner + generation gated, explicit counters ──────────────
DROP FUNCTION IF EXISTS public.advance_entitlement_fanout(uuid, uuid, text, uuid, integer, integer, integer);
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

-- ── Complete: detects a newer generation and requeues instead ─────────
DROP FUNCTION IF EXISTS public.complete_entitlement_fanout(uuid, uuid, text, integer, integer);
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
  -- Lock the row so the requested/processing comparison is atomic against a
  -- concurrent enqueue.
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
    -- A relevant change was recorded while this generation was running.
    -- The pass that just finished began BEFORE that change, so it cannot
    -- acknowledge it. Reset to a clean pending state: the next worker
    -- rescans the whole scope for the newer generation.
    UPDATE public.entitlement_fanout_jobs
    SET status = 'pending',
        cursor_workspace_id = NULL,
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

-- ── Fail / release with backoff (owner + generation gated) ────────────
DROP FUNCTION IF EXISTS public.fail_entitlement_fanout(uuid, uuid, text, text, integer, integer);
CREATE FUNCTION public.fail_entitlement_fanout(
  _id uuid,
  _claim_token uuid,
  _worker_id text,
  _generation bigint,
  _error_code text,
  _retry_seconds integer DEFAULT 300,
  _max_attempts integer DEFAULT 10
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
  SET status = CASE
        WHEN attempts >= GREATEST(COALESCE(_max_attempts, 10), 1) THEN 'failed'
        ELSE 'pending'
      END,
      last_error_code = LEFT(COALESCE(_error_code, 'unknown'), 100),
      next_attempt_at = now() + make_interval(secs => GREATEST(COALESCE(_retry_seconds, 300), 5)),
      processing_generation = NULL,
      claim_token = NULL,
      worker_id = NULL,
      claim_expires_at = NULL
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

-- ── Least privilege for every (re)defined function ────────────────────
DO $do$
DECLARE
  v_sig text;
  v_sigs text[] := ARRAY[
    'public.enqueue_entitlement_fanout(text, text, uuid)',
    'public.claim_entitlement_fanout_jobs(text, integer, integer)',
    'public.advance_entitlement_fanout(uuid, uuid, text, bigint, uuid, integer, integer, integer, integer, integer)',
    'public.complete_entitlement_fanout(uuid, uuid, text, bigint, uuid, integer, integer, integer, integer)',
    'public.fail_entitlement_fanout(uuid, uuid, text, bigint, text, integer, integer)'
  ];
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
$do$;
