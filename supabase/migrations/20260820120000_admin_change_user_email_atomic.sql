-- 035 — Atomic admin email-change lifecycle.
--
-- PATCH /api/admin/users/:userId/profile previously let a super admin
-- change profiles.email with a bare column update — no lifecycle at all.
-- Changing the canonical login email is an identity-boundary change, not an
-- ordinary profile edit, and needs everything issued against the OLD
-- address invalidated:
--   - unused auth_reset_tokens / auth_verify_tokens for this user revoked
--     (an old reset/verify link must not silently still work for the new
--     identity)
--   - email_verified_at reset to NULL — a verified OLD address's verified
--     state must not silently carry over to an address nobody has proven
--     ownership of yet (there is already a separate, explicit
--     POST /api/admin/users/:userId/email-verification for an operator to
--     re-confirm the new one)
--   - every existing session revoked — auth_sessions.email is a snapshot
--     taken at session-creation time under the OLD address, so a live
--     session already reflects stale identity data even though the token
--     itself still validates; forcing a fresh login re-establishes a
--     session snapshot under the new email
--
-- All four effects (profile row, verification reset, token revocation,
-- session revocation) happen inside one SECURITY DEFINER call so a failure
-- partway through cannot leave the email changed with any of the old
-- identity's artifacts still live. Duplicate-email rejection reuses the
-- existing `profiles_email_normalized_unique_idx` (032) — the UPDATE
-- against profiles.email raises a real unique_violation (Postgres error
-- 23505) if the normalized new address collides with another profile,
-- which rolls back the whole function call automatically; the calling
-- route maps that error code to a clean 409.
--
-- A no-op call (new email normalizes to the same value as the current one)
-- deliberately does NOT reset verification/tokens/sessions — e.g. an
-- operator re-submitting the same address with different casing/whitespace
-- must not silently log the user out or force re-verification of an
-- address they already own.

CREATE OR REPLACE FUNCTION public.admin_change_user_email(
  _user_id uuid,
  _new_email text
)
RETURNS TABLE(changed boolean, old_email text, new_email text, sessions_revoked integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _normalized_email text := lower(btrim(_new_email));
  _current_email text;
  _revoked_count integer := 0;
BEGIN
  SELECT p.email INTO _current_email
  FROM public.profiles p
  WHERE p.id = _user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'admin_change_user_email: no profile for %', _user_id;
  END IF;

  IF lower(btrim(_current_email)) = _normalized_email THEN
    RETURN QUERY SELECT false, _current_email, _current_email, 0;
    RETURN;
  END IF;

  UPDATE public.profiles
  SET email = _normalized_email, updated_at = now()
  WHERE id = _user_id;

  INSERT INTO public.user_credentials (user_id, email_verified_at)
  VALUES (_user_id, NULL)
  ON CONFLICT (user_id) DO UPDATE
    SET email_verified_at = NULL,
        updated_at = now();

  UPDATE public.auth_reset_tokens
  SET revoked_at = now()
  WHERE user_id = _user_id
    AND used_at IS NULL
    AND revoked_at IS NULL;

  UPDATE public.auth_verify_tokens
  SET revoked_at = now()
  WHERE user_id = _user_id
    AND used_at IS NULL
    AND revoked_at IS NULL;

  UPDATE public.auth_sessions
  SET revoked_at = now(), revoke_reason = 'admin_action'
  WHERE user_id = _user_id
    AND revoked_at IS NULL;
  GET DIAGNOSTICS _revoked_count = ROW_COUNT;

  RETURN QUERY SELECT true, _current_email, _normalized_email, _revoked_count;
END;
$$;

-- ---------- lock EXECUTE to service_role only (Express is the sole gate) --
DO $$
BEGIN
  REVOKE ALL ON FUNCTION public.admin_change_user_email(uuid, text) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.admin_change_user_email(uuid, text) TO service_role;
END $$;

-- ---------- in-migration proof ----------
DO $verify$
BEGIN
  IF to_regprocedure('public.admin_change_user_email(uuid,text)') IS NULL THEN
    RAISE EXCEPTION '035: admin_change_user_email was not created';
  END IF;
  IF has_function_privilege('anon', 'public.admin_change_user_email(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION '035: anon can execute admin_change_user_email';
  END IF;
  IF has_function_privilege('authenticated', 'public.admin_change_user_email(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION '035: authenticated can execute admin_change_user_email';
  END IF;
  RAISE NOTICE '035: admin_change_user_email created, locked to service_role';
END
$verify$;
