-- ============================================================
-- FIVE SECURITY DEFINER FUNCTIONS THIS CHAIN LEFT EXECUTABLE BY ANYONE
--
-- PostgreSQL grants EXECUTE on a new function to PUBLIC unless told
-- otherwise, and PUBLIC includes `anon` -- the role an unauthenticated
-- browser reaches PostgREST with. A SECURITY DEFINER function runs as its
-- owner, so a PUBLIC-executable one is a way to do the owner's work without
-- being the owner.
--
-- scripts/ci/verify-migration-security.sql fails the build over any such
-- function and has been raising this the whole time. Nobody saw it because
-- the chain died at 282 of 401 long before the script ran, and the job it
-- runs in has never had a runner. With the chain replaying, it reports:
--
--   billing_enroll_workspace()                trigger    20260904112112
--   billing_notify_subscription_lifecycle()   trigger    20260910165754
--   billing_notify_payment_recorded()         trigger    20260910165754
--   billing_activate_period(uuid)             callable   service_role RPC
--   billing_apply_invoice_effects(uuid)       callable   service_role RPC
--
-- The three trigger functions need nothing back. A trigger fires as the
-- table's owner and PostgreSQL does not consult the session user's EXECUTE
-- privilege to do it, so taking PUBLIC away costs them nothing.
--
-- The two callable ones are invoked over RPC by the server through
-- getServiceClient, which is service_role: billing_apply_invoice_effects
-- from services/billing/invoice/settle.ts and billing_activate_period from
-- services/billing/adminGrant.ts. Revoking without granting those back would
-- turn settlement and admin grants into "permission denied for function".
--
-- This is the hosted counterpart of database/migrations/200, which did the
-- same for the eight the self-host chain had missed.
-- ============================================================

-- ---------- the three trigger functions ----------
REVOKE ALL ON FUNCTION public.billing_enroll_workspace()              FROM PUBLIC;
REVOKE ALL ON FUNCTION public.billing_notify_subscription_lifecycle() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.billing_notify_payment_recorded()       FROM PUBLIC;

-- ---------- the two service_role RPCs ----------
REVOKE ALL ON FUNCTION public.billing_activate_period(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_activate_period(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.billing_apply_invoice_effects(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_apply_invoice_effects(uuid) TO service_role;

-- ---------- in-migration proof ----------
DO $verify$
DECLARE
  n int;
  offenders text;
BEGIN
  -- The same question scripts/ci/verify-migration-security.sql asks, with the
  -- same schema exclusions, asked here so the chain answers it rather than a
  -- later step finding out.
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
    RAISE EXCEPTION '% SECURITY DEFINER functions are still PUBLIC-executable — %', n, offenders;
  END IF;

  -- And the grants the server depends on, without which settlement and admin
  -- grants fail with a function-permission error instead of doing their work.
  IF NOT has_function_privilege('service_role', 'public.billing_activate_period(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.billing_apply_invoice_effects(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role lost EXECUTE on the billing RPCs the server calls';
  END IF;

  RAISE NOTICE 'no SECURITY DEFINER function this chain owns is executable by PUBLIC';
END
$verify$;
