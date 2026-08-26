-- 034 — Atomic admin block/unblock + session revocation.
--
-- POST /api/admin/block-user previously upserted
-- user_credentials.status = 'disabled', THEN separately called
-- revokeAllSessions() — the same two-round-trip shape as password reset
-- (033). If the status write succeeded but revocation failed, the account
-- would show as "disabled" in the admin UI while every session issued
-- before the block kept working. Fixed the same way: one SECURITY DEFINER
-- call, so a failure at either step rolls back both.
--
-- `INSERT ... ON CONFLICT (user_id) DO UPDATE` also covers a migrated user
-- with no user_credentials row yet (defaults to 'active' per the table's
-- own default, so a block on such a user still needs to actually insert a
-- 'disabled' row rather than silently no-op against a row that never
-- existed).
--
-- Unblocking (`_blocked = false`) does NOT revoke sessions — there are none
-- left to revoke by the time an operator unblocks (blocking already swept
-- them), and re-enabling access is not itself a security event that should
-- force every device to re-authenticate.

CREATE OR REPLACE FUNCTION public.admin_set_user_block_status(
  _user_id uuid,
  _blocked boolean
)
RETURNS integer -- count of sessions revoked (always 0 when unblocking)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _revoked_count integer := 0;
BEGIN
  INSERT INTO public.user_credentials (user_id, status)
  VALUES (_user_id, CASE WHEN _blocked THEN 'disabled' ELSE 'active' END)
  ON CONFLICT (user_id) DO UPDATE
    SET status = EXCLUDED.status,
        updated_at = now();

  IF _blocked THEN
    UPDATE public.auth_sessions
    SET revoked_at = now(), revoke_reason = 'admin_action'
    WHERE user_id = _user_id
      AND revoked_at IS NULL;
    GET DIAGNOSTICS _revoked_count = ROW_COUNT;
  END IF;

  RETURN _revoked_count;
END;
$$;

-- ---------- lock EXECUTE to service_role only (Express is the sole gate) --
DO $$
BEGIN
  REVOKE ALL ON FUNCTION public.admin_set_user_block_status(uuid, boolean) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.admin_set_user_block_status(uuid, boolean) TO service_role;
END $$;

-- ---------- in-migration proof ----------
DO $verify$
BEGIN
  IF to_regprocedure('public.admin_set_user_block_status(uuid,boolean)') IS NULL THEN
    RAISE EXCEPTION '034: admin_set_user_block_status was not created';
  END IF;
  IF has_function_privilege('anon', 'public.admin_set_user_block_status(uuid,boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION '034: anon can execute admin_set_user_block_status';
  END IF;
  IF has_function_privilege('authenticated', 'public.admin_set_user_block_status(uuid,boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION '034: authenticated can execute admin_set_user_block_status';
  END IF;
  RAISE NOTICE '034: admin_set_user_block_status created, locked to service_role';
END
$verify$;
