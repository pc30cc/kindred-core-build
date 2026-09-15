-- 185 — Real lease fencing for workspace_deletion_jobs and user_deletion_jobs.
--
-- Second corrective pass, P0 finding: 181/183's leases were `locked_by` +
-- `lease_expires_at` only. A fixed ~60s lease is not long enough for a
-- cleanup step that may list a large provider page (up to ~1000 S3 keys),
-- delete them sequentially with per-key retries, or perform a slow Bunny
-- recursive directory walk (server/services/storage/index.ts's bunnyList,
-- which has no native pagination and returns the complete recursive result
-- in one call). A worker can still be genuinely working when its lease
-- expires; at that point another worker legitimately reclaims the job, but
-- the FIRST (now-stale) worker can still be mid-loop and, without a real
-- fencing mechanism, could later persist a progress/status write that
-- silently clobbers the second worker's newer state.
--
-- `locked_by` alone cannot prevent this: it's overwritten by whoever
-- claims next, so a stale worker's write, if unconditioned, still lands.
-- `lease_token` is the fencing token: claim_*_job() mints a FRESH random
-- uuid on every successful claim (including a reclaim of an expired
-- lease). Every subsequent progress/status write from the worker holding
-- that claim must be conditioned on `id = <job> AND lease_token = <token
-- I was given>` — issued as an application-level UPDATE ... WHERE with
-- both predicates (server/services/workspaceDeletion/worker.ts,
-- server/services/userDeletion/worker.ts). Once a job is reclaimed, its
-- lease_token changes, so the stale worker's WHERE clause matches zero
-- rows; the app layer treats "zero rows updated" as a hard stop signal
-- (LeaseFencedError) and abandons all further work for that job on this
-- worker, rather than as a silent no-op.
--
-- renew_*_lease() lets a worker extend `lease_expires_at` WITHOUT
-- generating a new token, as long as it still presents the CURRENT token —
-- this is the heartbeat call made periodically during a long per-key
-- delete loop (never only between poll ticks). If another worker has
-- already reclaimed the job (different token now stored), renew fails
-- (`ok:false`) and the calling worker must stop immediately — it no longer
-- holds the lease, whether or not lease_expires_at happens to still look
-- "current" from its own stale perspective.

ALTER TABLE public.workspace_deletion_jobs ADD COLUMN IF NOT EXISTS lease_token uuid;
ALTER TABLE public.user_deletion_jobs ADD COLUMN IF NOT EXISTS lease_token uuid;

COMMENT ON COLUMN public.workspace_deletion_jobs.lease_token IS
  'Fencing token, re-minted on every successful claim (including a reclaim after expiry). Every progress/status write from a worker must be conditioned on this exact value — a mismatch (another worker has since reclaimed) means the write is rejected, not silently applied.';
COMMENT ON COLUMN public.user_deletion_jobs.lease_token IS
  'Same fencing model as workspace_deletion_jobs.lease_token — see that column comment.';

-- ─────────────────────────────────────────────────────────────────────────
-- claim_workspace_deletion_job: mint a fresh lease_token on every claim.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.claim_workspace_deletion_job(_worker_id text, _lease_seconds int DEFAULT 60)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _job record;
BEGIN
  SELECT * INTO _job FROM public.workspace_deletion_jobs
    WHERE status IN ('pending', 'storage_cleanup', 'db_cleanup')
      AND (next_retry_at IS NULL OR next_retry_at <= now())
      AND (lease_expires_at IS NULL OR lease_expires_at <= now())
    ORDER BY requested_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'job', NULL);
  END IF;

  UPDATE public.workspace_deletion_jobs
  SET locked_by = _worker_id,
      lease_token = gen_random_uuid(),
      lease_expires_at = now() + make_interval(secs => _lease_seconds),
      started_at = COALESCE(started_at, now()),
      status = CASE WHEN status = 'pending' THEN 'storage_cleanup' ELSE status END
  WHERE id = _job.id
  RETURNING * INTO _job;

  RETURN jsonb_build_object('ok', true, 'job', to_jsonb(_job));
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- renew_workspace_deletion_lease: heartbeat. Extends lease_expires_at WITHOUT
-- changing lease_token, but ONLY if the caller still presents the current
-- token — otherwise the job has already been reclaimed and this is a no-op
-- that reports failure so the stale worker stops.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.renew_workspace_deletion_lease(_job_id uuid, _lease_token uuid, _lease_seconds int DEFAULT 60)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _new_expiry timestamptz;
BEGIN
  UPDATE public.workspace_deletion_jobs
  SET lease_expires_at = now() + make_interval(secs => _lease_seconds)
  WHERE id = _job_id AND lease_token = _lease_token
  RETURNING lease_expires_at INTO _new_expiry;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'fenced_out');
  END IF;

  RETURN jsonb_build_object('ok', true, 'lease_expires_at', _new_expiry);
END;
$$;

REVOKE ALL ON FUNCTION public.claim_workspace_deletion_job(text, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_workspace_deletion_job(text, int) TO service_role;
REVOKE ALL ON FUNCTION public.renew_workspace_deletion_lease(uuid, uuid, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.renew_workspace_deletion_lease(uuid, uuid, int) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- Same model for user_deletion_jobs.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.claim_user_deletion_job(_worker_id text, _lease_seconds int DEFAULT 60)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _job record;
BEGIN
  SELECT * INTO _job FROM public.user_deletion_jobs
    WHERE status IN ('collecting_workspaces', 'awaiting_workspace_deletions', 'purging_user')
      AND (next_retry_at IS NULL OR next_retry_at <= now())
      AND (lease_expires_at IS NULL OR lease_expires_at <= now())
    ORDER BY requested_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'job', NULL);
  END IF;
  UPDATE public.user_deletion_jobs
    SET locked_by = _worker_id,
        lease_token = gen_random_uuid(),
        lease_expires_at = now() + make_interval(secs => _lease_seconds),
        started_at = COALESCE(started_at, now())
    WHERE id = _job.id
    RETURNING * INTO _job;
  RETURN jsonb_build_object('ok', true, 'job', to_jsonb(_job));
END;
$$;

CREATE OR REPLACE FUNCTION public.renew_user_deletion_lease(_job_id uuid, _lease_token uuid, _lease_seconds int DEFAULT 60)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _new_expiry timestamptz;
BEGIN
  UPDATE public.user_deletion_jobs
  SET lease_expires_at = now() + make_interval(secs => _lease_seconds)
  WHERE id = _job_id AND lease_token = _lease_token
  RETURNING lease_expires_at INTO _new_expiry;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'fenced_out');
  END IF;

  RETURN jsonb_build_object('ok', true, 'lease_expires_at', _new_expiry);
END;
$$;

REVOKE ALL ON FUNCTION public.claim_user_deletion_job(text, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_user_deletion_job(text, int) TO service_role;
REVOKE ALL ON FUNCTION public.renew_user_deletion_lease(uuid, uuid, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.renew_user_deletion_lease(uuid, uuid, int) TO service_role;

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'workspace_deletion_jobs' AND column_name = 'lease_token'
  ) THEN
    RAISE EXCEPTION '185_deletion_lease_fencing: workspace_deletion_jobs.lease_token missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'user_deletion_jobs' AND column_name = 'lease_token'
  ) THEN
    RAISE EXCEPTION '185_deletion_lease_fencing: user_deletion_jobs.lease_token missing';
  END IF;
  IF to_regprocedure('public.renew_workspace_deletion_lease(uuid, uuid, int)') IS NULL THEN
    RAISE EXCEPTION '185_deletion_lease_fencing: renew_workspace_deletion_lease missing';
  END IF;
  IF to_regprocedure('public.renew_user_deletion_lease(uuid, uuid, int)') IS NULL THEN
    RAISE EXCEPTION '185_deletion_lease_fencing: renew_user_deletion_lease missing';
  END IF;
END;
$verify$;
