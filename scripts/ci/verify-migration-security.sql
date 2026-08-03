-- ============================================================
-- Phase 6-S5-R7.5.1 §2 — post-migration database security verification.
-- Runs with ON_ERROR_STOP=1; every check RAISEs EXCEPTION on violation, so a
-- failure fails the CI job. Uses the real roles, in a real transaction.
--
-- NOTHING here is skippable: the audited RPC surface comes from the single
-- source of truth `internal-rpc-signatures.sql`, which itself RAISEs when a
-- signature is absent or when a second overload exists. A stale verifier can
-- no longer pass by silently auditing zero functions.
-- ============================================================

\ir internal-rpc-signatures.sql

-- 1. No SECURITY DEFINER function in ANY schema may be executable by PUBLIC.
DO $verify$
DECLARE
  offenders text;
  n integer;
BEGIN
  SELECT count(*), string_agg(format('%s.%s(%s)', ns.nspname, p.proname,
                                     pg_get_function_identity_arguments(p.oid)), ', ')
    INTO n, offenders
  FROM pg_proc p
  JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE p.prosecdef
    AND ns.nspname NOT IN ('pg_catalog', 'information_schema', 'extensions',
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

-- 2. The audited roles must exist. Without them every ACL assertion below
--    would be vacuous, so their absence is a hard failure rather than a skip.
DO $roles$
DECLARE missing text;
BEGIN
  SELECT string_agg(r, ', ') INTO missing
  FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'required role(s) absent, ACL verification would be vacuous: %', missing;
  END IF;
  RAISE NOTICE 'roles present: anon, authenticated, service_role';
END
$roles$;

-- 3. Internal fan-out and AI-KB RPCs: service_role only. Every signature in
--    the inventory is audited; there is no CONTINUE/skip path.
DO $rpc$
DECLARE
  fn      text;
  audited integer := 0;
  total   integer;
BEGIN
  SELECT count(*) INTO total FROM ci_internal_rpc;

  FOR fn IN SELECT sig FROM ci_internal_rpc ORDER BY sig LOOP
    audited := audited + 1;

    IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(fn)) THEN
      RAISE EXCEPTION 'internal RPC % is no longer SECURITY DEFINER', fn;
    END IF;
    IF has_function_privilege('public', fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'PUBLIC can execute internal RPC %', fn;
    END IF;
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

  IF audited <> total OR audited = 0 THEN
    RAISE EXCEPTION 'RPC ACL audit incomplete: audited % of %', audited, total;
  END IF;
  RAISE NOTICE 'internal RPCs verified: % (PUBLIC/anon/authenticated denied, service_role allowed)', audited;
END
$rpc$;

-- 4. Real-transaction denial proof: SET LOCAL ROLE and attempt an ACTUAL call
--    of EVERY audited RPC as anon AND as authenticated. Arguments are typed
--    NULLs derived from the signature itself. The block runs inside an
--    explicit transaction that is rolled back, so a hypothetical successful
--    (gate-failing) call cannot leave state behind.
BEGIN;

DO $live$
DECLARE
  fn        text;
  role_name text;
  args      text;
  denied    boolean;
  checks    integer := 0;
  expected  integer;
BEGIN
  SELECT count(*) * 2 INTO expected FROM ci_internal_rpc;

  FOR fn IN SELECT sig FROM ci_internal_rpc ORDER BY sig LOOP
    -- "public.name(a, b)" -> "NULL::a, NULL::b"
    SELECT string_agg(format('NULL::%s', btrim(t)), ', ')
      INTO args
    FROM unnest(string_to_array(rtrim(split_part(fn, '(', 2), ')'), ',')) AS t;

    FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      denied := false;
      BEGIN
        EXECUTE format('SET LOCAL ROLE %I', role_name);
        EXECUTE format('SELECT %s(%s)', split_part(fn, '(', 1), args);
      EXCEPTION
        WHEN insufficient_privilege THEN
          denied := true;
        WHEN OTHERS THEN
          -- The function BODY ran, which means EXECUTE was granted. That is
          -- exactly the escalation this proof exists to catch.
          RESET ROLE;
          RAISE EXCEPTION '% executed internal RPC % (body raised %, so EXECUTE was granted)',
            role_name, fn, SQLSTATE;
      END;
      RESET ROLE;

      IF NOT denied THEN
        RAISE EXCEPTION '% executed internal RPC % in a live transaction', role_name, fn;
      END IF;
      checks := checks + 1;
    END LOOP;
  END LOOP;

  IF checks <> expected OR checks = 0 THEN
    RAISE EXCEPTION 'live denial proof incomplete: ran % of % role/RPC combinations', checks, expected;
  END IF;
  RAISE NOTICE 'live denial confirmed for % role/RPC combinations', checks;
END
$live$;

ROLLBACK;

-- 5. The fan-out queue table itself stays internal-only.
DO $tbl$
DECLARE offenders text;
BEGIN
  IF to_regclass('public.entitlement_fanout_jobs') IS NULL THEN
    RAISE EXCEPTION 'entitlement_fanout_jobs missing — the migration chain did not apply';
  END IF;

  SELECT string_agg(format('%s:%s', g.role_name, g.priv), ', ') INTO offenders
  FROM (
    SELECT r AS role_name, p AS priv
    FROM unnest(ARRAY['anon', 'authenticated']) AS r
    CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS p
  ) AS g
  WHERE has_table_privilege(g.role_name, 'public.entitlement_fanout_jobs', g.priv);

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'customer roles can access entitlement_fanout_jobs: %', offenders;
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.entitlement_fanout_jobs'::regclass) THEN
    RAISE EXCEPTION 'RLS disabled on entitlement_fanout_jobs';
  END IF;

  RAISE NOTICE 'entitlement_fanout_jobs: RLS on, anon/authenticated hold no table privileges';
END
$tbl$;