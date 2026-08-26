-- 033 — Atomic admin-initiated password reset + full session revocation.
--
-- POST /api/admin/change-password previously upserted
-- user_credentials.password_hash, THEN separately called
-- revokeAllSessions() — two round-trips. If the password write succeeded
-- but the revocation call failed (network blip, transient DB error), an
-- attacker who stole a session before the admin reset the password would
-- keep using it indefinitely, even though the operator believes they just
-- locked the account down. Fixed the same way as 030/031: both writes
-- happen inside one SECURITY DEFINER function call, so a failure at either
-- step rolls back the whole thing — never "password changed, old sessions
-- still live".
--
-- `INSERT ... ON CONFLICT (user_id) DO UPDATE` (not a bare UPDATE) so this
-- also works for a migrated user who has no user_credentials row yet — the
-- same case the admin "change password" UI exists to handle in the first
-- place (a pre-first-party account with no password set).
--
-- Unlike change_password_and_revoke_sessions (031, self-service — verifies
-- the CALLER'S current password in Node first, and exempts the caller's
-- own session), this has no current-password check (the caller is an
-- already requirePlatformAdmin-gated route acting on someone else's
-- account) and no exempted session — every existing session for the
-- target user is revoked, full stop.

CREATE OR REPLACE FUNCTION public.admin_set_password_and_revoke_sessions(
  _user_id uuid,
  _new_password_hash text
)
RETURNS integer -- count of sessions revoked
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _revoked_count integer;
BEGIN
  INSERT INTO public.user_credentials (user_id, password_hash, password_algo, password_set_at, failed_login_count)
  VALUES (_user_id, _new_password_hash, 'argon2id', now(), 0)
  ON CONFLICT (user_id) DO UPDATE
    SET password_hash = EXCLUDED.password_hash,
        password_algo = EXCLUDED.password_algo,
        password_set_at = EXCLUDED.password_set_at,
        failed_login_count = 0,
        updated_at = now();

  UPDATE public.auth_sessions
  SET revoked_at = now(), revoke_reason = 'admin_action'
  WHERE user_id = _user_id
    AND revoked_at IS NULL;
  GET DIAGNOSTICS _revoked_count = ROW_COUNT;

  RETURN _revoked_count;
END;
$$;

-- ---------- lock EXECUTE to service_role only (Express is the sole gate) --
DO $$
BEGIN
  REVOKE ALL ON FUNCTION public.admin_set_password_and_revoke_sessions(uuid, text) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.admin_set_password_and_revoke_sessions(uuid, text) TO service_role;
END $$;

-- ---------- in-migration proof ----------
DO $verify$
BEGIN
  IF to_regprocedure('public.admin_set_password_and_revoke_sessions(uuid,text)') IS NULL THEN
    RAISE EXCEPTION '033: admin_set_password_and_revoke_sessions was not created';
  END IF;
  IF has_function_privilege('anon', 'public.admin_set_password_and_revoke_sessions(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION '033: anon can execute admin_set_password_and_revoke_sessions';
  END IF;
  IF has_function_privilege('authenticated', 'public.admin_set_password_and_revoke_sessions(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION '033: authenticated can execute admin_set_password_and_revoke_sessions';
  END IF;
  RAISE NOTICE '033: admin_set_password_and_revoke_sessions created, locked to service_role';
END
$verify$;
