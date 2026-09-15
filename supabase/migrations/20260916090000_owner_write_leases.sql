-- 187 — Owner write leases: closes the TOCTOU gap between a point-in-time
-- writability check and the external write it was gating.
--
-- Fourth corrective pass, P0 finding: isWorkspaceWritable()/isUserWritable()
-- (third corrective pass) are a single point-in-time read — "is this owner
-- writable right now?" — not a write BARRIER. The actual write (an S3 PUT,
-- a LiveKit StartRoomCompositeEgress call) happens strictly AFTER that read
-- returns, with no lock held in between. Deletion can begin in that gap:
--   1. producer checks isWorkspaceWritable() -> true
--   2. workspace deletion begins (enqueue_workspace_deletion flips status,
--      creates the job)
--   3. the deletion worker's quiesce/verification/listing runs and finds
--      nothing, because the producer's write hasn't landed yet
--   4. the producer's write from step 1 finally completes
--   5. db_cleanup purges the workspace row — the object from step 4 is now
--      a permanent, undiscoverable orphan under workspace/<deletedId>/...
--
-- owner_write_leases is a DB-backed, cross-process, cross-request register
-- of "a producer is currently between its writability check and the
-- completion of its actual write" for a given owner. It is deliberately
-- NOT an in-memory counter: any server process, any request, must be able
-- to see every other process's in-flight leases, exactly like
-- workspace_deletion_jobs/user_deletion_jobs' own lease_token fencing
-- (185_deletion_lease_fencing.sql) is DB-backed for the same reason.
--
-- acquire_owner_write_lease(_owner_kind, _owner_id, _purpose, _lease_seconds):
-- the ONLY way a lease is created. Atomically, in one transaction:
--   - workspace: SELECT ... FROM workspaces WHERE id = _owner_id FOR UPDATE,
--     require status = 'active', THEN insert the lease row.
--   - user: SELECT ... FROM profiles WHERE id = _owner_id FOR UPDATE,
--     require no user_deletion_jobs row in an active status for this user,
--     THEN insert the lease row.
-- enqueue_workspace_deletion() (181) and enqueue_user_deletion() (183) lock
-- these EXACT SAME rows (workspaces / profiles) FOR UPDATE before flipping
-- state. Postgres row-level FOR UPDATE locks are mutually exclusive: a
-- concurrent acquire_owner_write_lease() and enqueue_*_deletion() call
-- racing for the same owner row serialize against each other, whichever
-- commits first is authoritative, and the second sees its committed
-- result. This makes "deletion started" and "a new writer lease was
-- acquired after" structurally impossible to observe simultaneously —
-- not just unlikely under normal timing.
--
-- A lease is held by the caller (server/services/storage/writerLease.ts)
-- from BEFORE the writability check's positive result is acted on, through
-- the actual external write completing, released only in a `finally`.
-- Deletion workers (workspaceDeletion/worker.ts, userDeletion/worker.ts)
-- query this table directly (a plain SELECT, not an RPC — no state to
-- protect on a read) and refuse to trust ANY storage listing for an owner
-- while an unexpired lease for that owner still exists — see those
-- modules' own doc comments for the exact wait-then-proceed ordering.
--
-- lease_expires_at + renew_owner_write_lease(): the same crash-safety
-- model as 185's job leases. A process that dies mid-upload (before its
-- `finally` release ever runs) does not wedge deletion forever — the
-- lease simply expires and stops counting as "pre-existing" once expired.
-- A long-running write renews (heartbeats) periodically, exactly like
-- workspace/user deletion's own renew_*_lease() calls.

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

COMMENT ON TABLE public.owner_write_leases IS
  'A producer holds one row here from before its writability check is acted on until its external write (S3 PUT, LiveKit egress start) has definitively completed. Deletion workers must see zero unexpired rows for an owner before trusting any storage listing for it — see 187_owner_write_leases.sql header.';
COMMENT ON COLUMN public.owner_write_leases.purpose IS
  'Free-form producer label (e.g. "upload", "privacy_export", "livekit_recording_start") — observability only, no code branches on this value.';
COMMENT ON COLUMN public.owner_write_leases.lease_expires_at IS
  'A crashed producer''s lease simply expires — deletion workers only wait on UNEXPIRED rows, so a crash never wedges deletion forever.';

CREATE INDEX IF NOT EXISTS idx_owner_write_leases_owner
  ON public.owner_write_leases (owner_kind, owner_id, lease_expires_at);

ALTER TABLE public.owner_write_leases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.owner_write_leases FROM anon, authenticated;
GRANT SELECT ON public.owner_write_leases TO service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- acquire_owner_write_lease: atomic writability-check-and-lease.
-- ─────────────────────────────────────────────────────────────────────────
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
  -- Opportunistic cleanup of long-dead leases — bounded, cheap, avoids a
  -- separate cron sweep. Never touches a still-live lease (only rows that
  -- expired over an hour ago, long past any reasonable renewal cadence).
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

-- ─────────────────────────────────────────────────────────────────────────
-- renew_owner_write_lease: heartbeat, same fencing shape as 185's job
-- leases — extends lease_expires_at only while the caller presents the
-- CURRENT (id, lease_token) pair.
-- ─────────────────────────────────────────────────────────────────────────
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
  WHERE id = _lease_id AND lease_token = _lease_token
  RETURNING lease_expires_at INTO _new_expiry;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'lease_not_found');
  END IF;

  RETURN jsonb_build_object('ok', true, 'lease_expires_at', _new_expiry);
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- release_owner_write_lease: best-effort, idempotent. A lease that's
-- already gone (expired-and-swept, or already released) is not an error —
-- the caller's goal ("this lease no longer exists") is already true.
-- ─────────────────────────────────────────────────────────────────────────
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

REVOKE ALL ON FUNCTION public.acquire_owner_write_lease(text, uuid, text, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.renew_owner_write_lease(uuid, uuid, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_owner_write_lease(uuid, uuid) FROM PUBLIC, anon, authenticated;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.acquire_owner_write_lease(text, uuid, text, int) TO service_role;
    GRANT EXECUTE ON FUNCTION public.renew_owner_write_lease(uuid, uuid, int) TO service_role;
    GRANT EXECUTE ON FUNCTION public.release_owner_write_lease(uuid, uuid) TO service_role;
  END IF;
END $$;

DO $verify$
BEGIN
  IF to_regclass('public.owner_write_leases') IS NULL THEN
    RAISE EXCEPTION '187_owner_write_leases: owner_write_leases table missing';
  END IF;
  IF to_regprocedure('public.acquire_owner_write_lease(text, uuid, text, int)') IS NULL THEN
    RAISE EXCEPTION '187_owner_write_leases: acquire_owner_write_lease missing';
  END IF;
  IF to_regprocedure('public.renew_owner_write_lease(uuid, uuid, int)') IS NULL THEN
    RAISE EXCEPTION '187_owner_write_leases: renew_owner_write_lease missing';
  END IF;
  IF to_regprocedure('public.release_owner_write_lease(uuid, uuid)') IS NULL THEN
    RAISE EXCEPTION '187_owner_write_leases: release_owner_write_lease missing';
  END IF;
END;
$verify$;
