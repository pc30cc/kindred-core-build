-- ============================================================
-- 200 — EIGHT SECURITY DEFINER FUNCTIONS THAT ANYONE COULD EXECUTE
--
-- PostgreSQL grants EXECUTE on a new function to PUBLIC unless told
-- otherwise, and PUBLIC includes `anon` — the role an unauthenticated
-- browser reaches PostgREST with. A SECURITY DEFINER function runs as its
-- owner, so a PUBLIC-executable one is a way to do the owner's work without
-- being the owner.
--
-- This chain knows that: 86 of its migrations revoke EXECUTE from PUBLIC on
-- the functions they create, and `scripts/ci/verify-migration-security.sql`
-- fails the build over any that do not. Eight were missed:
--
--   016a  workspace_owner_phone_verified(uuid)      callable
--   016a  tg_call_sessions_bill_minutes()           trigger
--   122   billing_v2_invoice_notification_sync()    trigger
--   122   billing_v2_dunning_snapshot(uuid)         callable
--   122   billing_v2_invoice_arm_dunning()          trigger
--   126   billing_enroll_workspace()                trigger
--   156   billing_notify_payment_recorded()         trigger
--   156   billing_notify_subscription_lifecycle()   trigger
--
-- The verification script has been raising this the whole time. Nobody saw
-- it because the chain stopped at 101 long before the script ran, and the
-- script runs in a CI job this account has never had a runner for.
--
-- WHAT EACH ONE STILL NEEDS, because revoking blindly breaks things:
--
--   * The six trigger functions need nothing. A trigger fires as the table's
--     owner and PostgreSQL does not consult the session user's EXECUTE
--     privilege to do it, so taking PUBLIC away costs them nothing.
--
--   * `workspace_owner_phone_verified` is different, and this is the one to
--     get right: 084 uses it inside an RLS policy's USING and WITH CHECK.
--     A policy expression is evaluated as the querying role, so `authenticated`
--     genuinely needs EXECUTE — revoke it and every owner/admin write to that
--     table fails with "permission denied for function" instead of a clean
--     policy denial. It is also called over RPC by
--     server/services/phoneVerification, which is service_role.
--
--   * `billing_v2_dunning_snapshot` is called from inside another SECURITY
--     DEFINER function, where it runs as that function's owner and needs no
--     caller grant, and over RPC as service_role, where it does.
--
-- A new migration rather than eight edits: the functions are defined across
-- four historical files, and a deployed database that already ran them needs
-- the ACL corrected, not the definition rewritten.
-- ============================================================

-- ---------- the six trigger functions ----------
REVOKE ALL ON FUNCTION public.tg_call_sessions_bill_minutes()          FROM PUBLIC;
REVOKE ALL ON FUNCTION public.billing_v2_invoice_notification_sync()   FROM PUBLIC;
REVOKE ALL ON FUNCTION public.billing_v2_invoice_arm_dunning()         FROM PUBLIC;
REVOKE ALL ON FUNCTION public.billing_enroll_workspace()               FROM PUBLIC;
REVOKE ALL ON FUNCTION public.billing_notify_payment_recorded()        FROM PUBLIC;
REVOKE ALL ON FUNCTION public.billing_notify_subscription_lifecycle()  FROM PUBLIC;

-- ---------- the two callable ones ----------
REVOKE ALL ON FUNCTION public.workspace_owner_phone_verified(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.workspace_owner_phone_verified(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.workspace_owner_phone_verified(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.billing_v2_dunning_snapshot(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_v2_dunning_snapshot(uuid) TO service_role;

-- ---------- in-migration proof ----------
DO $verify$
DECLARE
  n int;
  offenders text;
BEGIN
  -- The same question scripts/ci/verify-migration-security.sql asks, asked
  -- here so the chain answers it rather than the job finding out later.
  -- Same exclusion list too: those schemas belong to the platform, not to
  -- this chain, and their ACLs are not ours to hold an opinion about. Every
  -- function these migrations create lands in public, so today this is the
  -- narrower question written the wider way -- which is the point. A
  -- migration that later puts one somewhere else is caught here instead of
  -- three steps downstream.
  SELECT count(*), string_agg(p.oid::regprocedure::text, ', ')
    INTO n, offenders
    FROM pg_proc p
    JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE p.prosecdef
     AND ns.nspname NOT IN ('pg_catalog', 'information_schema', 'extensions',
                            'graphql', 'graphql_public', 'pgbouncer', 'vault',
                            'pgsodium', 'pgsodium_masks', 'realtime', 'storage',
                            'supabase_functions', 'supabase_migrations', 'auth',
                            'cron', 'net')
     AND has_function_privilege('public', p.oid, 'EXECUTE');

  IF n > 0 THEN
    RAISE EXCEPTION '200: % SECURITY DEFINER functions are still PUBLIC-executable — %', n, offenders;
  END IF;

  -- And the grant the RLS policy in 084 depends on. Without it the revoke
  -- above turns an owner/admin write into a function-permission error.
  IF NOT has_function_privilege(
       'authenticated', 'public.workspace_owner_phone_verified(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '200: authenticated cannot execute workspace_owner_phone_verified — '
                    '084''s policy will fail closed for every owner and admin';
  END IF;

  RAISE NOTICE '200: no SECURITY DEFINER function this chain owns is executable by PUBLIC';
END
$verify$;
