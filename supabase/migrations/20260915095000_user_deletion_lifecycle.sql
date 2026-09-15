-- User (account) deletion storage-aware lifecycle.
--
-- Corrective-pass P1 finding: DELETE /users/:userId (server/routes/
-- adminManagement.ts) bypassed the workspace deletion lifecycle entirely.
-- It manually gathered a SUBSET of storage pointers (conversation_attachments,
-- call_recordings, privacy_jobs only — never LiveKit-vs-attachment-vs-privacy
-- provider routing, never branding, never anything the 181 multi-provider
-- scope walk covers) capped at a 5000-row LIMIT per table, deleted those
-- best-effort, and only THEN called admin_delete_user, which hard-deletes
-- the DB rows for every workspace the user owns. A workspace with more than
-- 5000 attachment rows, or any object outside those three tables, is
-- silently orphaned; and because storage cleanup was best-effort and
-- unordered relative to the DB purge, a mid-failure could delete DB
-- ownership records before their storage was actually freed.
--
-- This migration adds a job table so account deletion goes through the
-- SAME multi-provider storage-aware machinery as workspace deletion
-- (server/services/workspaceDeletion/worker.ts, 181's scope-walk/dedup/
-- resumability), once per owned workspace, and only purges the user's DB
-- row after every owned workspace has been fully torn down (storage AND
-- DB) — never before, per the explicit "do not delete DB ownership
-- records before storage cleanup has completed" requirement. The global
-- users/<userId>/... prefix (e.g. the account avatar) is cleaned up by
-- the same job before the final profile purge, since that storage is not
-- owned by any workspace and 181's scopes never touch it.
--
-- Mirrors 181's shape deliberately: a leased multi-worker-safe claim RPC
-- (FOR UPDATE SKIP LOCKED + lease_expires_at), automatic bounded retry
-- with backoff, and a manual retry RPC for a terminally failed job —
-- same operational model, so an admin already familiar with workspace
-- deletion needs nothing new to operate this one.

CREATE TABLE IF NOT EXISTS public.user_deletion_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  user_email text,
  requested_by uuid NOT NULL,
  status text NOT NULL DEFAULT 'collecting_workspaces'
    CHECK (status IN ('collecting_workspaces', 'awaiting_workspace_deletions', 'purging_user', 'completed', 'failed')),
  workspace_ids uuid[] NOT NULL DEFAULT '{}',
  avatar_cleanup_done boolean NOT NULL DEFAULT false,
  purge_result jsonb,
  attempt_count integer NOT NULL DEFAULT 0,
  next_retry_at timestamptz,
  locked_by text,
  lease_expires_at timestamptz,
  error_message text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  retried_by uuid,
  retried_at timestamptz
);

COMMENT ON TABLE public.user_deletion_jobs IS
  'Storage-aware account deletion: enqueues one workspace_deletion_jobs row per owned workspace (reusing the full multi-provider scope walk), waits for all of them to complete, cleans up the users/<id>/ global prefix, then purges the user DB row via admin_delete_user. Never purges DB ownership before storage cleanup finishes.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_user_deletion_jobs_active
  ON public.user_deletion_jobs (user_id)
  WHERE status IN ('collecting_workspaces', 'awaiting_workspace_deletions', 'purging_user');

CREATE INDEX IF NOT EXISTS idx_user_deletion_jobs_claimable
  ON public.user_deletion_jobs (status, next_retry_at, lease_expires_at)
  WHERE status IN ('collecting_workspaces', 'awaiting_workspace_deletions', 'purging_user');

CREATE OR REPLACE FUNCTION public.enqueue_user_deletion(_user_id uuid, _actor_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _profile record;
  _existing record;
  _job record;
BEGIN
  IF _user_id = _actor_user_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'cannot_delete_self');
  END IF;

  SELECT id, email INTO _profile FROM public.profiles WHERE id = _user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'user_not_found');
  END IF;

  SELECT * INTO _existing FROM public.user_deletion_jobs
    WHERE user_id = _user_id AND status IN ('collecting_workspaces', 'awaiting_workspace_deletions', 'purging_user')
    ORDER BY requested_at DESC LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'started', false, 'job', to_jsonb(_existing));
  END IF;

  INSERT INTO public.user_deletion_jobs (user_id, user_email, requested_by)
    VALUES (_user_id, _profile.email, _actor_user_id)
    RETURNING * INTO _job;
  RETURN jsonb_build_object('ok', true, 'started', true, 'job', to_jsonb(_job));
END;
$$;

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
        lease_expires_at = now() + make_interval(secs => _lease_seconds),
        started_at = COALESCE(started_at, now())
    WHERE id = _job.id
    RETURNING * INTO _job;
  RETURN jsonb_build_object('ok', true, 'job', to_jsonb(_job));
END;
$$;

CREATE OR REPLACE FUNCTION public.retry_user_deletion_job(_job_id uuid, _actor_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _job record;
BEGIN
  SELECT * INTO _job FROM public.user_deletion_jobs WHERE id = _job_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'job_not_found');
  END IF;
  IF _job.status != 'failed' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'job_not_failed', 'status', _job.status);
  END IF;
  UPDATE public.user_deletion_jobs
    SET status = 'awaiting_workspace_deletions', next_retry_at = NULL, locked_by = NULL, lease_expires_at = NULL,
        error_message = NULL, retried_by = _actor_user_id, retried_at = now()
    WHERE id = _job_id;
  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_user_deletion(uuid, uuid) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_user_deletion_job(text, int) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.retry_user_deletion_job(uuid, uuid) FROM public, anon, authenticated;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.enqueue_user_deletion(uuid, uuid) TO service_role;
    GRANT EXECUTE ON FUNCTION public.claim_user_deletion_job(text, int) TO service_role;
    GRANT EXECUTE ON FUNCTION public.retry_user_deletion_job(uuid, uuid) TO service_role;
  END IF;
END $$;

DO $verify$
BEGIN
  IF to_regclass('public.user_deletion_jobs') IS NULL THEN
    RAISE EXCEPTION '183_user_deletion_lifecycle: user_deletion_jobs missing';
  END IF;
  IF to_regprocedure('public.enqueue_user_deletion(uuid, uuid)') IS NULL THEN
    RAISE EXCEPTION '183_user_deletion_lifecycle: enqueue_user_deletion missing';
  END IF;
  IF to_regprocedure('public.claim_user_deletion_job(text, int)') IS NULL THEN
    RAISE EXCEPTION '183_user_deletion_lifecycle: claim_user_deletion_job missing';
  END IF;
  IF to_regprocedure('public.retry_user_deletion_job(uuid, uuid)') IS NULL THEN
    RAISE EXCEPTION '183_user_deletion_lifecycle: retry_user_deletion_job missing';
  END IF;
END;
$verify$;
