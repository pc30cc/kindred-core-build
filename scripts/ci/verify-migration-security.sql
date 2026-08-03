-- ============================================================
-- Phase 6-S5-R7.5 §9 — post-migration database security verification.
-- Runs with ON_ERROR_STOP=1; every check RAISEs EXCEPTION on violation, so a
-- failure fails the CI job. Uses the real roles, in a real transaction.
-- ============================================================

-- 1. No SECURITY DEFINER function in ANY schema may be executable by PUBLIC.
DO $verify$
DECLARE
  offenders text;
  n integer;
BEGIN
  SELECT count(*), string_agg(format('%s.%s(%s)', n.nspname, p.proname,
                                     pg_get_function_identity_arguments(p.oid)), ', ')
    INTO n, offenders
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.prosecdef
    AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'extensions',
                          'graphql', 'graphql_public', 'pgbouncer', 'vault',
                          'pgsodium', 'pgsodium_masks', 'realtime', 'storage',
                          'supabase_functions', 'supabase_migrations', 'auth', 'cron', 'net')
    AND has_function_privilege('public', p.oid, 'EXECUTE');

  IF n > 0 THEN
    RAISE EXCEPTION 'PUBLIC-executable SECURITY DEFINER functions: % — %', n, offenders;
  END IF;
  RAISE NOTICE 'PUBLIC-executable SECURITY DEFINER functions: 0';
END
$verify$;

-- 2. Internal fan-out and AI-KB RPCs: service_role only.
DO $rpc$
DECLARE
  fn text;
  sigs text[] := ARRAY[
    'public._ai_kb_apply_generated(uuid, uuid, uuid, text, text, text, text)',
    'public.accept_ai_kb_generated_article(uuid, uuid, uuid)',
    'public.publish_ai_kb_generated_article(uuid, uuid, uuid)',
    'public.reject_ai_kb_generated_article(uuid, uuid, uuid)',
    'public.enqueue_entitlement_fanout(uuid, text, jsonb)',
    'public.claim_entitlement_fanout_jobs(integer, integer, text)',
    'public.advance_entitlement_fanout(uuid, text, jsonb)',
    'public.complete_entitlement_fanout(uuid, text)',
    'public.fail_entitlement_fanout(uuid, text, text)'
  ];
  present integer := 0;
BEGIN
  FOREACH fn IN ARRAY sigs LOOP
    CONTINUE WHEN to_regprocedure(fn) IS NULL;
    present := present + 1;

    IF has_function_privilege('anon', fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'anon can execute internal RPC %', fn;
    END IF;
    IF has_function_privilege('authenticated', fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'authenticated can execute internal RPC %', fn;
    END IF;
    IF NOT has_function_privilege('service_role', fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'service_role CANNOT execute required internal RPC %', fn;
    END IF;
  END LOOP;

  IF present = 0 THEN
    RAISE EXCEPTION 'no internal RPC found — the migration chain did not apply';
  END IF;
  RAISE NOTICE 'internal RPCs verified: % (anon denied, authenticated denied, service_role allowed)', present;
END
$rpc$;

-- 3. Real-transaction denial proof: SET ROLE and attempt an actual call.
DO $live$
DECLARE
  denied boolean := false;
BEGIN
  IF to_regprocedure('public.claim_entitlement_fanout_jobs(integer, integer, text)') IS NULL THEN
    RAISE NOTICE 'fan-out claim RPC absent — live denial check skipped for this chain';
    RETURN;
  END IF;

  BEGIN
    SET LOCAL ROLE anon;
    PERFORM public.claim_entitlement_fanout_jobs(1, 60, 'ci-probe');
  EXCEPTION WHEN insufficient_privilege THEN
    denied := true;
  END;
  RESET ROLE;

  IF NOT denied THEN
    RAISE EXCEPTION 'anon executed claim_entitlement_fanout_jobs in a live transaction';
  END IF;
  RAISE NOTICE 'live anon denial confirmed';
END
$live$;