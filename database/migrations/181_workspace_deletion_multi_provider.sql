-- 181 — Workspace deletion: multi-provider scopes, atomic enqueue, retry,
-- multi-worker-safe leased claiming.
--
-- Corrective pass on 180_workspace_deletion_lifecycle.sql. That migration's
-- worker enumerated only the workspace's ordinary attachment storage
-- provider — insufficient, because canonical object-key ownership
-- (workspace/<id>/...) does NOT imply a single physical provider. At least
-- three workspace-owned categories can live in separate physical accounts:
-- ordinary attachments (resolveStorageConfigForOwner), LiveKit recordings
-- (server/services/calls/recordingStorageResolver.ts's
-- recording_storage), and privacy exports
-- (resolvePrivacyStoragePolicy). server/services/storage/workspaceScopes.ts
-- is the shared list of these; server/services/workspaceDeletion/worker.ts
-- now walks all of them before ever reaching db_cleanup.
--
-- storage_scopes (jsonb): per-scope progress — status/cursor/counts/error/
-- fingerprint per scope name, keyed by workspaceScopes.ts's scope names.
-- Replaces the single top-level storage_cursor/storage_cleanup_error/
-- storage_objects_found/storage_objects_deleted columns from 180 for new
-- writes (those columns are kept, unused by new code, rather than dropped
-- — forward-only migrations never remove a shipped column).
--
-- attempt_count/next_retry_at: automatic bounded retry with backoff for
-- transient failures (a listing error, a delete that keeps failing, a
-- db_cleanup RPC error) — a job is only terminally 'failed' (requiring
-- manual retry_workspace_deletion_job) after MAX_JOB_ATTEMPTS. Progress
-- already recorded in storage_scopes is never redone: a scope already
-- 'done' is skipped on every subsequent attempt.
--
-- locked_by/lease_expires_at: multi-worker-safe claiming. Postgres
-- FOR UPDATE SKIP LOCKED in claim_workspace_deletion_job() lets any number
-- of concurrent worker processes race for the same claimable job without
-- double-processing it; a lease that isn't renewed (worker crashed) simply
-- expires and the job becomes claimable again — no separate stuck-job
-- sweep needed, unlike server/services/privacy/worker.ts's
-- STUCK_AFTER_MS pattern.
--
-- enqueue_workspace_deletion(): replaces the two-step, non-atomic
-- "UPDATE workspaces SET status='deleting'" + "INSERT workspace_deletion_jobs"
-- previously done as separate statements in server/routes/adminManagement.ts.
-- Now one SECURITY DEFINER function, one transaction: verifies active
-- state, flips it, creates (or idempotently returns) the job. If job
-- creation fails for any reason the whole transaction rolls back and the
-- workspace status reverts to 'active' — it can never be left 'deleting'
-- with no corresponding job. A workspace stuck 'deleting' with no active
-- job (all attempts exhausted and terminally failed) returns a distinct
-- error rather than silently creating a fresh job that would discard
-- prior progress, or a false-success response with job: null.
--
-- The partial unique index enforces "one active job per workspace" as a
-- hard DB invariant, not just applicaton-level idempotency — even two
-- concurrent enqueue_workspace_deletion() calls racing past the
-- application layer cannot create two.

ALTER TABLE public.workspace_deletion_jobs
  ADD COLUMN IF NOT EXISTS storage_scopes jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_retry_at timestamptz,
  ADD COLUMN IF NOT EXISTS locked_by text,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

COMMENT ON COLUMN public.workspace_deletion_jobs.storage_scopes IS
  'Per-physical-scope progress: {"<scopeName>": {status, cursor, objects_found, objects_deleted, error, fingerprint, dedup_of}}. Scope names from server/services/storage/workspaceScopes.ts. The job may only advance to db_cleanup once every scope is "done" or "skipped_not_configured".';
COMMENT ON COLUMN public.workspace_deletion_jobs.attempt_count IS
  'Bumped on every automatic retry after a transient failure. Terminal failure (status=failed) only after MAX_JOB_ATTEMPTS (server/services/workspaceDeletion/worker.ts) — manual retry via retry_workspace_deletion_job() thereafter.';
COMMENT ON COLUMN public.workspace_deletion_jobs.next_retry_at IS
  'NULL or in the past = claimable now. Set to a backoff-delayed future time after a transient failure so claim_workspace_deletion_job() skips it until then.';
COMMENT ON COLUMN public.workspace_deletion_jobs.locked_by IS
  'Opaque worker-process id holding the current lease — see claim_workspace_deletion_job(). Cleared once the job reaches a terminal state or the lease expires.';
COMMENT ON COLUMN public.workspace_deletion_jobs.lease_expires_at IS
  'A job whose lease has expired (worker crashed mid-run) is claimable again by any worker — self-healing, no separate stuck-job sweep needed.';

-- One active (non-terminal) job per workspace, enforced at the DB level —
-- not just by application-level idempotency in the enqueue route/RPC.
CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_deletion_jobs_active
  ON public.workspace_deletion_jobs (workspace_id)
  WHERE status IN ('pending', 'storage_cleanup', 'db_cleanup');

CREATE INDEX IF NOT EXISTS idx_workspace_deletion_jobs_claimable
  ON public.workspace_deletion_jobs (status, next_retry_at, lease_expires_at)
  WHERE status IN ('pending', 'storage_cleanup', 'db_cleanup');

-- ─────────────────────────────────────────────────────────────────────────
-- Atomic enqueue — replaces the two-step status-update + insert.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.enqueue_workspace_deletion(_workspace_id uuid, _actor_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _ws record;
  _existing record;
  _job record;
BEGIN
  SELECT id, slug, name, status INTO _ws FROM public.workspaces WHERE id = _workspace_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'workspace_not_found');
  END IF;

  IF _ws.status = 'deleting' THEN
    SELECT * INTO _existing FROM public.workspace_deletion_jobs
      WHERE workspace_id = _workspace_id AND status IN ('pending', 'storage_cleanup', 'db_cleanup')
      ORDER BY requested_at DESC LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object('ok', true, 'started', false, 'job', to_jsonb(_existing));
    END IF;
    -- Deleting, but every prior job attempt is terminal (failed and
    -- abandoned) — never silently start a fresh job here, that would
    -- discard whatever progress storage_scopes already recorded. The
    -- caller must go through retry_workspace_deletion_job() instead.
    RETURN jsonb_build_object('ok', false, 'error', 'workspace_stuck_no_active_job', 'hint', 'retry_workspace_deletion_job');
  END IF;

  IF _ws.status != 'active' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'workspace_not_active', 'status', _ws.status);
  END IF;

  UPDATE public.workspaces SET status = 'deleting' WHERE id = _workspace_id;

  INSERT INTO public.workspace_deletion_jobs (workspace_id, workspace_slug, workspace_name, requested_by)
  VALUES (_workspace_id, _ws.slug, _ws.name, _actor_user_id)
  RETURNING * INTO _job;

  RETURN jsonb_build_object('ok', true, 'started', true, 'job', to_jsonb(_job));
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_workspace_deletion(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_workspace_deletion(uuid, uuid) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- Manual retry — resets a terminally-failed job back to storage_cleanup
-- (the worker's own scope-skip logic resumes correctly from there whether
-- storage cleanup or db_cleanup was the failing step; no need to track
-- exactly which phase failed).
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.retry_workspace_deletion_job(_job_id uuid, _actor_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _job record;
BEGIN
  SELECT * INTO _job FROM public.workspace_deletion_jobs WHERE id = _job_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'job_not_found');
  END IF;
  IF _job.status != 'failed' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'job_not_failed', 'status', _job.status);
  END IF;

  UPDATE public.workspace_deletion_jobs
  SET status = 'storage_cleanup',
      next_retry_at = NULL,
      locked_by = NULL,
      lease_expires_at = NULL,
      error_message = NULL,
      retried_by = _actor_user_id,
      retried_at = now()
  WHERE id = _job_id;

  RETURN jsonb_build_object('ok', true);
END;
$$;

ALTER TABLE public.workspace_deletion_jobs
  ADD COLUMN IF NOT EXISTS retried_by uuid,
  ADD COLUMN IF NOT EXISTS retried_at timestamptz;

REVOKE ALL ON FUNCTION public.retry_workspace_deletion_job(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.retry_workspace_deletion_job(uuid, uuid) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- Multi-worker-safe leased claim. FOR UPDATE SKIP LOCKED means N concurrent
-- worker processes calling this concurrently never claim the same row —
-- Postgres itself arbitrates, no application-level mutex needed.
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
      lease_expires_at = now() + make_interval(secs => _lease_seconds),
      started_at = COALESCE(started_at, now()),
      status = CASE WHEN status = 'pending' THEN 'storage_cleanup' ELSE status END
  WHERE id = _job.id
  RETURNING * INTO _job;

  RETURN jsonb_build_object('ok', true, 'job', to_jsonb(_job));
END;
$$;

REVOKE ALL ON FUNCTION public.claim_workspace_deletion_job(text, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_workspace_deletion_job(text, int) TO service_role;

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'workspace_deletion_jobs' AND column_name = 'storage_scopes'
  ) THEN
    RAISE EXCEPTION 'workspace_deletion_jobs.storage_scopes column missing after migration';
  END IF;
  IF to_regprocedure('public.enqueue_workspace_deletion(uuid, uuid)') IS NULL THEN
    RAISE EXCEPTION 'enqueue_workspace_deletion() missing after migration';
  END IF;
  IF to_regprocedure('public.retry_workspace_deletion_job(uuid, uuid)') IS NULL THEN
    RAISE EXCEPTION 'retry_workspace_deletion_job() missing after migration';
  END IF;
  IF to_regprocedure('public.claim_workspace_deletion_job(text, int)') IS NULL THEN
    RAISE EXCEPTION 'claim_workspace_deletion_job() missing after migration';
  END IF;
END
$verify$;
