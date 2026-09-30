-- Entitlement fan-out: generation semantics, catch-up for databases that
-- never received them.
--
-- 20260803060000, 20260803070000 and 20260803080000 turned the fan-out queue
-- into a generation-aware one: new counters and generation columns on
-- entitlement_fanout_jobs, and new signatures for claim / advance / complete /
-- fail that carry `_generation`. server/services/billing/entitlementFanout.ts
-- calls only the new signatures.
--
-- A database that reached today's schema by another route than replaying this
-- chain (the hosted project was built by its own migration history) can hold
-- the AI-KB half of those three files and not the fan-out half: the old
-- columns and the old signatures without `_generation`. There advance,
-- complete and fail each fail with "function ... does not exist", so a
-- claimed job never finishes and the plan change it carries never reaches
-- every workspace.
--
-- This file is the fan-out half of the three, verbatim and in order:
--   1. 060000's columns and completed-row backfill;
--   2. 070000's cursor generation, the drop of every overload, and the final
--      definitions of all five RPCs (060000's versions are superseded by these
--      and are not repeated);
--   3. 080000's least privilege for those RPCs and the queue table.
--
-- Idempotent. On a database that already has all of it — every fresh replay
-- of this chain — the columns exist, both backfills match no row, and the five
-- functions are dropped and re-created with the same bodies and ACLs inside
-- this transaction, so nothing observable changes. Existing jobs are kept:
-- a job queued under the old functions is generation 1 with no processing
-- generation, and its next claim adopts generation 1 and its cursor.

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

-- ── Least privilege (080000 A, fan-out part) ──────────────────────────
-- Dropping a function destroys its ACL and a new function is EXECUTE-able by
-- PUBLIC. Every fan-out RPC is SECURITY DEFINER, so re-apply service_role
-- only to the current signatures.
DO $secure$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT oid::regprocedure::text AS sig
    FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace
      AND proname IN (
        'enqueue_entitlement_fanout',
        'claim_entitlement_fanout_jobs',
        'advance_entitlement_fanout',
        'complete_entitlement_fanout',
        'fail_entitlement_fanout')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', r.sig);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', r.sig);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', r.sig);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
    END IF;
  END LOOP;
END
$secure$;

-- Queue table: internal-only, no customer role may touch it directly (080000).
ALTER TABLE public.entitlement_fanout_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.entitlement_fanout_jobs FROM PUBLIC;
DO $tbl$
BEGIN
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

-- ── Verify ────────────────────────────────────────────────────────────
DO $verify$
DECLARE
  v_sig  text;
  v_n    integer;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.enqueue_entitlement_fanout(text, text, uuid)',
    'public.claim_entitlement_fanout_jobs(text, integer, integer)',
    'public.advance_entitlement_fanout(uuid, uuid, text, bigint, uuid, integer, integer, integer, integer, integer)',
    'public.complete_entitlement_fanout(uuid, uuid, text, bigint, uuid, integer, integer, integer, integer)',
    'public.fail_entitlement_fanout(uuid, uuid, text, bigint, text, integer, integer)'
  ] LOOP
    IF to_regprocedure(v_sig) IS NULL THEN
      RAISE EXCEPTION 'fan-out catch-up: % is missing', v_sig;
    END IF;
    IF has_function_privilege('public', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'fan-out catch-up: % is executable by PUBLIC', v_sig;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
       AND has_function_privilege('anon', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'fan-out catch-up: % is executable by anon', v_sig;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_n
  FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace
    AND proname IN ('claim_entitlement_fanout_jobs', 'advance_entitlement_fanout',
                    'complete_entitlement_fanout', 'fail_entitlement_fanout',
                    'enqueue_entitlement_fanout');
  IF v_n <> 5 THEN
    RAISE EXCEPTION 'fan-out catch-up: expected 5 fan-out RPCs, found % (a stale overload survived)', v_n;
  END IF;

  SELECT count(*) INTO v_n
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'entitlement_fanout_jobs'
    AND column_name IN ('requested_generation', 'processing_generation', 'completed_generation',
                        'cursor_generation', 'skipped_ineligible_count',
                        'retryable_failure_count', 'permanent_failure_count');
  IF v_n <> 7 THEN
    RAISE EXCEPTION 'fan-out catch-up: expected 7 generation columns, found %', v_n;
  END IF;
END
$verify$;
