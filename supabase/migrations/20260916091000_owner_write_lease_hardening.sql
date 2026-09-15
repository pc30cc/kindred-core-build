-- 188 — Owner write lease hardening: DB-time safety decisions, no
-- resurrecting an expired lease, and a reconciliation grace period that
-- outlives the longest a provider write can still be in flight.
--
-- Fifth corrective pass, P0 finding: 187's model still had two gaps.
--
-- 1. renew_owner_write_lease() would extend `lease_expires_at` for ANY
--    row matching (id, lease_token), even one that had already expired.
--    A producer whose heartbeat call was merely DELAYED (a slow tick, GC
--    pause, brief network hiccup) past the nominal expiry could still
--    successfully "resurrect" a lease a deletion worker had already
--    started treating as gone. Fixed: the UPDATE's WHERE clause now also
--    requires `lease_expires_at > now()` — a renewal arriving after
--    expiry returns `lease_expired`, never re-extends.
--
-- 2. hasActiveOwnerWriteLeases() (server/services/storage/writerLease.ts)
--    compared the DB-generated `lease_expires_at` against
--    `new Date().toISOString()` computed on the APPLICATION server — a
--    safety decision that should never depend on app-server/Postgres
--    clock synchronization. has_active_owner_write_leases() moves that
--    comparison entirely into SQL, using Postgres's own `now()`.
--
--    More importantly: an EXPIRED lease is not proof the underlying
--    external write has stopped — only that the PRODUCER stopped
--    successfully renewing it (DB connectivity loss, a crashed process,
--    a GC pause). The write itself (an S3/Bunny PUT already in flight)
--    is independent of the lease's DB-side bookkeeping and could still
--    be landing bytes. Treating "lease_expires_at <= now()" as
--    "definitely safe to trust storage" reopens exactly the TOCTOU gap
--    187 was meant to close.
--
--    has_active_owner_write_leases() instead treats a lease as still
--    blocking deletion until `lease_expires_at + reconciliation_grace`
--    has passed — a reconciliation grace period that MUST exceed the
--    longest any provider write call can still be running for. Server-
--    side, server/services/storage/index.ts now enforces a hard
--    PROVIDER_UPLOAD_TIMEOUT_MS ceiling on every network provider call
--    (s3Upload/bunnyUpload), so "longest a write can still be running"
--    is a real, provable bound, not an assumption — see that module's
--    doc comment. The default grace (600s) is comfortably larger than
--    that bound plus the heartbeat interval (30s) and normal network
--    retry/latency margin. Only once the grace period has elapsed can a
--    deletion worker conclude the write is GUARANTEED to have completed
--    or been aborted by its own hard timeout — never merely "probably
--    done by now".

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
    -- Distinguish "this exact (id, token) exists but is already past its
    -- nominal expiry" (lease_expired — the renewal arrived too late) from
    -- "no such lease at all" (lease_not_found — wrong token, already
    -- released, or already swept) purely for caller-side observability;
    -- both cases mean the same thing to the caller: it no longer holds a
    -- live lease and must not trust the write it thought it was covering.
    IF EXISTS (SELECT 1 FROM public.owner_write_leases WHERE id = _lease_id AND lease_token = _lease_token) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'lease_expired');
    END IF;
    RETURN jsonb_build_object('ok', false, 'error', 'lease_not_found');
  END IF;

  RETURN jsonb_build_object('ok', true, 'lease_expires_at', _new_expiry);
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- has_active_owner_write_leases: the ONLY correct way to ask "must
-- deletion still wait on writers for this owner?" — a plain SELECT
-- comparing lease_expires_at against an app-server timestamp is no longer
-- used anywhere for this decision (server/services/storage/writerLease.ts's
-- hasActiveOwnerWriteLeases() now calls this RPC exclusively).
-- ─────────────────────────────────────────────────────────────────────────
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

REVOKE ALL ON FUNCTION public.has_active_owner_write_leases(text, uuid, int) FROM PUBLIC, anon, authenticated;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.has_active_owner_write_leases(text, uuid, int) TO service_role;
  END IF;
END $$;

DO $verify$
BEGIN
  IF to_regprocedure('public.has_active_owner_write_leases(text, uuid, int)') IS NULL THEN
    RAISE EXCEPTION '188_owner_write_lease_hardening: has_active_owner_write_leases missing';
  END IF;
  IF to_regprocedure('public.renew_owner_write_lease(uuid, uuid, int)') IS NULL THEN
    RAISE EXCEPTION '188_owner_write_lease_hardening: renew_owner_write_lease missing';
  END IF;
END;
$verify$;
