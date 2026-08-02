-- 007_entitlement_fanout_jobs.sql
-- Phase 6-S5-R6 — durable entitlement fan-out queue for self-hosted installs.
-- Mirrors the managed migration so `database/migrations` stays authoritative
-- for operators who bootstrap Postgres directly. Idempotent.

-- ── Durable entitlement fan-out queue (Phase 6-S5-R6) ─────────────────
CREATE TABLE IF NOT EXISTS public.entitlement_fanout_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL CHECK (scope IN ('plan', 'platform')),
  source text NOT NULL,
  plan_id uuid,
  cursor_workspace_id uuid,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  processed_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  claim_token uuid,
  worker_id text,
  claim_expires_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

GRANT ALL ON public.entitlement_fanout_jobs TO service_role;

ALTER TABLE public.entitlement_fanout_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "entitlement_fanout_jobs_service_only" ON public.entitlement_fanout_jobs;
CREATE POLICY "entitlement_fanout_jobs_service_only"
  ON public.entitlement_fanout_jobs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- One active job per plan; one active platform-wide job.
CREATE UNIQUE INDEX IF NOT EXISTS entitlement_fanout_jobs_active_plan_uq
  ON public.entitlement_fanout_jobs (plan_id)
  WHERE status IN ('pending', 'running') AND scope = 'plan';

CREATE UNIQUE INDEX IF NOT EXISTS entitlement_fanout_jobs_active_platform_uq
  ON public.entitlement_fanout_jobs ((scope))
  WHERE status IN ('pending', 'running') AND scope = 'platform';

CREATE INDEX IF NOT EXISTS entitlement_fanout_jobs_claimable_idx
  ON public.entitlement_fanout_jobs (next_attempt_at)
  WHERE status IN ('pending', 'running');

CREATE OR REPLACE FUNCTION public.entitlement_fanout_touch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS entitlement_fanout_jobs_touch ON public.entitlement_fanout_jobs;
CREATE TRIGGER entitlement_fanout_jobs_touch
  BEFORE UPDATE ON public.entitlement_fanout_jobs
  FOR EACH ROW EXECUTE FUNCTION public.entitlement_fanout_touch();

-- ── Enqueue (idempotent per active scope) ─────────────────────────────
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
    -- Re-arm an in-flight job so a change during processing is not lost.
    UPDATE public.entitlement_fanout_jobs
    SET next_attempt_at = LEAST(next_attempt_at, now()),
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

REVOKE ALL ON FUNCTION public.enqueue_entitlement_fanout(text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_entitlement_fanout(text, text, uuid) TO service_role;

-- ── Claim with an expiring, owned lease ───────────────────────────────
CREATE OR REPLACE FUNCTION public.claim_entitlement_fanout_jobs(
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
      claim_expires_at = now() + make_interval(secs => v_lease)
  FROM candidate c
  WHERE t.id = c.id
  RETURNING t.id, t.scope, t.source, t.plan_id, t.cursor_workspace_id,
            t.attempts, t.processed_count, t.failed_count,
            t.claim_token, t.claim_expires_at;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_entitlement_fanout_jobs(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_entitlement_fanout_jobs(text, integer, integer) TO service_role;

-- ── Save progress and extend the lease (owner only) ───────────────────
CREATE OR REPLACE FUNCTION public.advance_entitlement_fanout(
  _id uuid,
  _claim_token uuid,
  _worker_id text,
  _cursor_workspace_id uuid,
  _processed integer,
  _failed integer,
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
      failed_count = failed_count + GREATEST(COALESCE(_failed, 0), 0),
      claim_expires_at = now() + make_interval(secs => GREATEST(COALESCE(_lease_seconds, 300), 30))
  WHERE id = _id
    AND status = 'running'
    AND claim_token = _claim_token
    AND worker_id = _worker_id
    AND claim_expires_at > now();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.advance_entitlement_fanout(uuid, uuid, text, uuid, integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.advance_entitlement_fanout(uuid, uuid, text, uuid, integer, integer, integer) TO service_role;

-- ── Complete (owner only) ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.complete_entitlement_fanout(
  _id uuid,
  _claim_token uuid,
  _worker_id text,
  _processed integer DEFAULT 0,
  _failed integer DEFAULT 0
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
  SET status = 'completed',
      processed_count = processed_count + GREATEST(COALESCE(_processed, 0), 0),
      failed_count = failed_count + GREATEST(COALESCE(_failed, 0), 0),
      claim_token = NULL,
      claim_expires_at = NULL,
      completed_at = now()
  WHERE id = _id
    AND status = 'running'
    AND claim_token = _claim_token
    AND worker_id = _worker_id
    AND claim_expires_at > now();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_entitlement_fanout(uuid, uuid, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_entitlement_fanout(uuid, uuid, text, integer, integer) TO service_role;

-- ── Fail / release with backoff (owner only) ──────────────────────────
CREATE OR REPLACE FUNCTION public.fail_entitlement_fanout(
  _id uuid,
  _claim_token uuid,
  _worker_id text,
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
      claim_token = NULL,
      claim_expires_at = NULL
  WHERE id = _id
    AND status = 'running'
    AND claim_token = _claim_token
    AND worker_id = _worker_id
    AND claim_expires_at > now();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.fail_entitlement_fanout(uuid, uuid, text, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_entitlement_fanout(uuid, uuid, text, text, integer, integer) TO service_role;