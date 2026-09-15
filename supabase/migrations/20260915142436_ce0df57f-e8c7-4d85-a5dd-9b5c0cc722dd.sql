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
  retried_at timestamptz,
  storage_scopes jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_user_deletion_jobs_active
  ON public.user_deletion_jobs (user_id)
  WHERE status IN ('collecting_workspaces', 'awaiting_workspace_deletions', 'purging_user');

CREATE INDEX IF NOT EXISTS idx_user_deletion_jobs_claimable
  ON public.user_deletion_jobs (status, next_retry_at, lease_expires_at)
  WHERE status IN ('collecting_workspaces', 'awaiting_workspace_deletions', 'purging_user');

ALTER TABLE public.user_deletion_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.user_deletion_jobs FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.user_deletion_jobs TO service_role;

CREATE TABLE IF NOT EXISTS public.owner_write_leases (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_token       uuid NOT NULL DEFAULT gen_random_uuid(),
  owner_kind        text NOT NULL,
  owner_id          uuid NOT NULL,
  purpose           text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  lease_expires_at  timestamptz NOT NULL,
  heartbeat_at      timestamptz,
  CONSTRAINT owner_write_leases_owner_kind_check CHECK (owner_kind IN ('workspace', 'user'))
);

CREATE INDEX IF NOT EXISTS idx_owner_write_leases_owner
  ON public.owner_write_leases (owner_kind, owner_id, lease_expires_at);

ALTER TABLE public.owner_write_leases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.owner_write_leases FROM anon, authenticated;
GRANT SELECT ON public.owner_write_leases TO service_role;

CREATE OR REPLACE FUNCTION public.acquire_owner_write_lease(
  _owner_kind text, _owner_id uuid, _purpose text, _lease_seconds int DEFAULT 60
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _ws_status text;
  _profile_id uuid;
  _active_job_id uuid;
  _lease record;
BEGIN
  DELETE FROM public.owner_write_leases WHERE lease_expires_at < now() - interval '1 hour';

  IF _owner_kind = 'workspace' THEN
    SELECT status INTO _ws_status FROM public.workspaces WHERE id = _owner_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'error', 'workspace_not_found');
    END IF;
    IF _ws_status IS DISTINCT FROM 'active' THEN
      RETURN jsonb_build_object('ok', false, 'error', 'workspace_not_writable', 'status', _ws_status);
    END IF;
  ELSIF _owner_kind = 'user' THEN
    SELECT id INTO _profile_id FROM public.profiles WHERE id = _owner_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'error', 'user_not_found');
    END IF;
    SELECT id INTO _active_job_id FROM public.user_deletion_jobs
      WHERE user_id = _owner_id
        AND status IN ('collecting_workspaces', 'awaiting_workspace_deletions', 'purging_user')
      LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object('ok', false, 'error', 'user_not_writable');
    END IF;
  ELSE
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_owner_kind');
  END IF;

  INSERT INTO public.owner_write_leases (owner_kind, owner_id, purpose, lease_expires_at)
  VALUES (_owner_kind, _owner_id, _purpose, now() + make_interval(secs => _lease_seconds))
  RETURNING * INTO _lease;

  RETURN jsonb_build_object(
    'ok', true,
    'lease_id', _lease.id,
    'lease_token', _lease.lease_token,
    'lease_expires_at', _lease.lease_expires_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.renew_owner_write_lease(_lease_id uuid, _lease_token uuid, _lease_seconds int DEFAULT 60)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _new_expiry timestamptz;
BEGIN
  UPDATE public.owner_write_leases
  SET lease_expires_at = now() + make_interval(secs => _lease_seconds),
      heartbeat_at = now()
  WHERE id = _lease_id AND lease_token = _lease_token AND lease_expires_at > now()
  RETURNING lease_expires_at INTO _new_expiry;

  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.owner_write_leases WHERE id = _lease_id AND lease_token = _lease_token) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'lease_expired');
    END IF;
    RETURN jsonb_build_object('ok', false, 'error', 'lease_not_found');
  END IF;

  RETURN jsonb_build_object('ok', true, 'lease_expires_at', _new_expiry);
END;
$$;

CREATE OR REPLACE FUNCTION public.release_owner_write_lease(_lease_id uuid, _lease_token uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.owner_write_leases WHERE id = _lease_id AND lease_token = _lease_token;
  RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.has_active_owner_write_leases(
  _owner_kind text, _owner_id uuid, _reconciliation_grace_seconds int DEFAULT 600
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _found boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.owner_write_leases
    WHERE owner_kind = _owner_kind
      AND owner_id = _owner_id
      AND lease_expires_at + make_interval(secs => _reconciliation_grace_seconds) > now()
  ) INTO _found;

  RETURN jsonb_build_object('ok', true, 'active', _found);
END;
$$;

REVOKE ALL ON FUNCTION public.acquire_owner_write_lease(text, uuid, text, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.renew_owner_write_lease(uuid, uuid, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_owner_write_lease(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.has_active_owner_write_leases(text, uuid, int) FROM PUBLIC, anon, authenticated;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.acquire_owner_write_lease(text, uuid, text, int) TO service_role;
    GRANT EXECUTE ON FUNCTION public.renew_owner_write_lease(uuid, uuid, int) TO service_role;
    GRANT EXECUTE ON FUNCTION public.release_owner_write_lease(uuid, uuid) TO service_role;
    GRANT EXECUTE ON FUNCTION public.has_active_owner_write_leases(text, uuid, int) TO service_role;
  END IF;
END $$;