-- Atomic self-service password change + other-session revocation.
--
-- POST /api/account/change-password previously updated
-- user_credentials.password_hash and stopped — a session stolen before the
-- change (e.g. via an XSS or a shared machine) stayed valid indefinitely
-- after the legitimate owner "secured" their account by changing the
-- password. Fixed the same way as password reset
-- (20260819180000_atomic_auth_token_redemption.sql): the write and the
-- revocation happen inside one SECURITY DEFINER function call, so a
-- failure partway through cannot leave the password changed with the old
-- sessions still live. Current-password verification (Argon2id) still
-- happens in Node before this is called — Postgres has no argon2 verify
-- built in — this function only performs the two writes that must be
-- atomic with each other.
--
-- `_except_session_id` lets the CALLER'S OWN current session survive the
-- sweep (matches revokeAllSessions()'s existing exceptSessionId
-- parameter/'logout everywhere but here' semantics) — the user who just
-- changed their password should not be logged out of the tab they did it
-- from.
--
-- Self-host counterpart: database/migrations/031_change_password_revoke_sessions.sql

CREATE OR REPLACE FUNCTION public.change_password_and_revoke_sessions(
  _user_id uuid,
  _new_password_hash text,
  _except_session_id uuid DEFAULT NULL
)
RETURNS integer -- count of OTHER sessions revoked
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _revoked_count integer;
BEGIN
  UPDATE public.user_credentials
  SET password_hash = _new_password_hash,
      password_algo = 'argon2id',
      password_set_at = now(),
      updated_at = now()
  WHERE user_id = _user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'change_password_and_revoke_sessions: no user_credentials row for %', _user_id;
  END IF;

  UPDATE public.auth_sessions
  SET revoked_at = now(), revoke_reason = 'password_changed'
  WHERE user_id = _user_id
    AND revoked_at IS NULL
    AND (_except_session_id IS NULL OR id <> _except_session_id);
  GET DIAGNOSTICS _revoked_count = ROW_COUNT;

  RETURN _revoked_count;
END;
$$;

-- ---------- lock EXECUTE to service_role only (Express is the sole gate) --
DO $$
BEGIN
  REVOKE ALL ON FUNCTION public.change_password_and_revoke_sessions(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.change_password_and_revoke_sessions(uuid, text, uuid) TO service_role;
END $$;

-- ---------- in-migration proof ----------
DO $verify$
BEGIN
  IF to_regprocedure('public.change_password_and_revoke_sessions(uuid,text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'change_password_and_revoke_sessions was not created';
  END IF;
  IF has_function_privilege('anon', 'public.change_password_and_revoke_sessions(uuid,text,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute change_password_and_revoke_sessions';
  END IF;
  IF has_function_privilege('authenticated', 'public.change_password_and_revoke_sessions(uuid,text,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated can execute change_password_and_revoke_sessions';
  END IF;
  RAISE NOTICE 'change_password_and_revoke_sessions created, locked to service_role';
END
$verify$;
