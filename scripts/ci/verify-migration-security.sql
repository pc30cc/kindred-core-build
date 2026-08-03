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

-- Callers MUST declare whether the AI-KB tables are part of the chain under
-- test. `-v require_ai_kb=1` (hosted chain) makes the live AI-KB execution
-- proof mandatory; `0` (self-host chain, whose AI-KB tables ship only in
-- supabase/migrations) restricts the live proof to the fan-out lifecycle.
-- There is no implicit default that could silently skip the hosted proof.
\if :{?require_ai_kb}
\else
\echo 'FATAL: -v require_ai_kb=0|1 is required'
DO $missing_flag$ BEGIN
  RAISE EXCEPTION 'verify-migration-security.sql invoked without -v require_ai_kb=0|1';
END $missing_flag$;
\endif

-- The flag is a STRICT whitelist. Anything other than the literals `0` or `1`
-- (empty string, `true`, `no`, a typo) aborts instead of being coerced into a
-- silent "not required" — psql does not substitute variables inside
-- dollar-quoted bodies, so the value is handed to SQL through a session GUC
-- that the later AI-KB block reads back.
SELECT set_config('ci.require_ai_kb', :'require_ai_kb', false);

DO $flag$
DECLARE v text := current_setting('ci.require_ai_kb', true);
BEGIN
  IF v IS NULL OR v NOT IN ('0', '1') THEN
    RAISE EXCEPTION 'require_ai_kb must be exactly 0 or 1, got %', coalesce(quote_literal(v), 'NULL');
  END IF;
  RAISE NOTICE 'require_ai_kb = %', v;
END
$flag$;

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

-- 3b. SECURITY DEFINER posture: a definer function is only as safe as the role
--     it runs AS and the search_path it resolves through. Every audited RPC
--     must be definer-owned by a trusted (non-customer) role and must pin its
--     search_path explicitly. Additionally, no customer role — and not PUBLIC —
--     may CREATE in schema `public`, otherwise objects could be shadowed under
--     that search_path.
DO $posture$
DECLARE
  fn        text;
  o         record;
  role_name text;
  offenders text;
BEGIN
  FOR fn IN SELECT sig FROM ci_internal_rpc ORDER BY sig LOOP
    SELECT p.prosecdef,
           pg_get_userbyid(p.proowner) AS owner,
           r.rolsuper,
           (SELECT string_agg(cfg, ' ') FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) AS cfg
             WHERE cfg LIKE 'search\_path=%') AS search_path
      INTO o
    FROM pg_proc p
    JOIN pg_roles r ON r.oid = p.proowner
    WHERE p.oid = to_regprocedure(fn);

    IF NOT o.prosecdef THEN
      RAISE EXCEPTION 'internal RPC % is not SECURITY DEFINER', fn;
    END IF;
    IF o.owner IN ('anon', 'authenticated', 'service_role') THEN
      RAISE EXCEPTION 'internal RPC % is owned by the untrusted role %', fn, o.owner;
    END IF;
    IF NOT (o.rolsuper OR o.owner IN ('postgres', 'supabase_admin')) THEN
      RAISE EXCEPTION 'internal RPC % is owned by % which is not a trusted owner', fn, o.owner;
    END IF;
    IF o.search_path IS NULL THEN
      RAISE EXCEPTION 'internal RPC % has no explicit search_path', fn;
    END IF;

    RAISE NOTICE 'definer posture ok: % (owner=%, %)', fn, o.owner, o.search_path;
  END LOOP;

  -- PUBLIC is a pseudo-role, not a role has_schema_privilege() may be asked
  -- about: inspect the schema ACL directly (falling back to the built-in
  -- default ACL when nspacl is NULL).
  IF EXISTS (
    SELECT 1
    FROM pg_namespace n
    CROSS JOIN LATERAL
      aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) acl
    WHERE n.nspname = 'public'
      AND acl.grantee = 0
      AND acl.privilege_type = 'CREATE'
  ) THEN
    offenders := concat_ws(', ', offenders, 'PUBLIC');
  END IF;

  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_schema_privilege(role_name, 'public', 'CREATE') THEN
      offenders := concat_ws(', ', offenders, role_name);
    END IF;
    IF NOT has_schema_privilege(role_name, 'public', 'USAGE') THEN
      RAISE EXCEPTION '% lost USAGE on schema public — the Data API would break', role_name;
    END IF;
  END LOOP;

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'schema public is customer-writable: % hold CREATE', offenders;
  END IF;
  RAISE NOTICE 'schema public: PUBLIC/anon/authenticated cannot CREATE, USAGE intact';
END
$posture$;

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
DECLARE
  offenders text;
  missing   text;
  granted   text;
  privs     text[] := ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE',
                            'TRUNCATE', 'REFERENCES', 'TRIGGER'];
BEGIN
  IF to_regclass('public.entitlement_fanout_jobs') IS NULL THEN
    RAISE EXCEPTION 'entitlement_fanout_jobs missing — the migration chain did not apply';
  END IF;

  -- COMPLETE privilege matrix for the running server version, not just the
  -- four DML verbs: a stray TRUNCATE/REFERENCES/TRIGGER (or MAINTAIN on
  -- PostgreSQL 17+) grant is an escalation too, and PUBLIC is audited
  -- alongside the two customer roles.
  IF current_setting('server_version_num')::integer >= 170000 THEN
    privs := privs || 'MAINTAIN'::text;
  END IF;
  RAISE NOTICE 'PostgreSQL % — auditing table privileges: %',
    current_setting('server_version'), array_to_string(privs, ', ');

  SELECT string_agg(format('%s:%s', g.role_name, g.priv), ', ') INTO offenders
  FROM (
    SELECT r AS role_name, p AS priv
    FROM unnest(ARRAY['public', 'anon', 'authenticated']) AS r
    CROSS JOIN unnest(privs) AS p
  ) AS g
  WHERE has_table_privilege(g.role_name, 'public.entitlement_fanout_jobs', g.priv);

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'customer roles can access entitlement_fanout_jobs: %', offenders;
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.entitlement_fanout_jobs'::regclass) THEN
    RAISE EXCEPTION 'RLS disabled on entitlement_fanout_jobs';
  END IF;

  -- The worker needs the full DML set; a partial grant would break it in
  -- production while still passing a SELECT-only check.
  SELECT string_agg(p, ', ') INTO missing
  FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS p
  WHERE NOT has_table_privilege('service_role', 'public.entitlement_fanout_jobs', p);

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'service_role lacks % on entitlement_fanout_jobs — the worker would be broken', missing;
  END IF;

  -- Explicit, per-privilege report of what service_role actually holds, across
  -- the SAME version-aware privilege set.
  SELECT string_agg(format('%s=%s', p,
           has_table_privilege('service_role', 'public.entitlement_fanout_jobs', p)), ', ')
    INTO granted
  FROM unnest(privs) AS p;

  RAISE NOTICE 'entitlement_fanout_jobs: RLS on, PUBLIC/anon/authenticated hold no table privilege at all (privileges audited: %)',
    array_to_string(privs, ', ');
  RAISE NOTICE 'entitlement_fanout_jobs service_role privileges: %', granted;
END
$tbl$;

-- 6. Live POSITIVE proof: `service_role` must be able to actually RUN the
--    internal surface, not merely hold the privilege bit. The whole fan-out
--    lifecycle (enqueue → claim → advance → complete, plus the fail/retry
--    path) executes for real inside a transaction that is rolled back, so no
--    state survives the proof.
BEGIN;

DO $svc$
DECLARE
  v_job      uuid;
  v_job2     uuid;
  v_plan_id  uuid := gen_random_uuid();
  c          record;
  j          record;
  ok         boolean;
  outcome    text;
  steps      integer := 0;
BEGIN
  SET LOCAL ROLE service_role;

  -- enqueue
  v_job := public.enqueue_entitlement_fanout('platform', 'ci-service-role-proof', NULL);
  IF v_job IS NULL THEN
    RAISE EXCEPTION 'service_role: enqueue_entitlement_fanout returned NULL';
  END IF;
  steps := steps + 1;

  -- claim
  SELECT * INTO c FROM public.claim_entitlement_fanout_jobs('ci-worker', 5, 300)
  WHERE id = v_job;
  IF c.id IS NULL OR c.claim_token IS NULL THEN
    RAISE EXCEPTION 'service_role: claim_entitlement_fanout_jobs did not lease the enqueued job';
  END IF;

  -- Exact leased state: the RPC must have taken real ownership of the row.
  SELECT * INTO j FROM public.entitlement_fanout_jobs WHERE id = c.id;
  IF j.status IS DISTINCT FROM 'running'
     OR j.claim_token IS DISTINCT FROM c.claim_token
     OR j.worker_id IS DISTINCT FROM 'ci-worker'
     OR j.processing_generation IS DISTINCT FROM c.processing_generation
     OR j.claim_expires_at IS NULL
     OR j.claim_expires_at <= now() THEN
    RAISE EXCEPTION 'service_role: claimed row state wrong (status=%, worker=%, token=%, gen=%, expires=%)',
      j.status, j.worker_id, j.claim_token, j.processing_generation, j.claim_expires_at;
  END IF;
  steps := steps + 1;

  -- advance (cursor stamped with the processing generation)
  ok := public.advance_entitlement_fanout(
    c.id, c.claim_token, 'ci-worker', c.processing_generation, NULL, 1, 0, 0, 0, 300);
  IF NOT ok THEN
    RAISE EXCEPTION 'service_role: advance_entitlement_fanout rejected a valid lease';
  END IF;

  SELECT * INTO j FROM public.entitlement_fanout_jobs WHERE id = c.id;
  IF j.processed_count IS DISTINCT FROM 1
     OR j.cursor_workspace_id IS DISTINCT FROM NULL
     OR j.cursor_generation IS DISTINCT FROM NULL
     OR j.status IS DISTINCT FROM 'running'
     OR j.claim_token IS DISTINCT FROM c.claim_token THEN
    RAISE EXCEPTION 'service_role: advance did not stamp the expected state (processed=%, cursor_gen=%, status=%)',
      j.processed_count, j.cursor_generation, j.status;
  END IF;
  steps := steps + 1;

  -- complete
  outcome := public.complete_entitlement_fanout(
    c.id, c.claim_token, 'ci-worker', c.processing_generation, NULL, 1, 0, 0, 0);
  IF outcome <> 'completed' THEN
    RAISE EXCEPTION 'service_role: complete_entitlement_fanout returned %, expected completed', outcome;
  END IF;
  steps := steps + 1;

  -- Exact terminal state: completed, generation recorded, lease fully
  -- released and the counters carrying BOTH reported units.
  SELECT * INTO j FROM public.entitlement_fanout_jobs WHERE id = c.id;
  IF j.status IS DISTINCT FROM 'completed'
     OR j.completed_generation IS DISTINCT FROM c.processing_generation
     OR j.processing_generation IS DISTINCT FROM NULL
     OR j.claim_token IS DISTINCT FROM NULL
     OR j.worker_id IS DISTINCT FROM NULL
     OR j.claim_expires_at IS DISTINCT FROM NULL
     OR j.completed_at IS NULL
     OR j.processed_count IS DISTINCT FROM 2
     OR j.failed_count IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'service_role: terminal row state wrong (status=%, completed_gen=%, token=%, worker=%, processed=%, failed=%)',
      j.status, j.completed_generation, j.claim_token, j.worker_id, j.processed_count, j.failed_count;
  END IF;

  -- fail / retry path on a second job that is REALLY plan-scoped: a NULL plan
  -- id would not exercise the plan branch at all.
  v_job2 := public.enqueue_entitlement_fanout('plan', 'ci-service-role-proof-fail', v_plan_id);
  IF v_job2 IS NULL THEN
    RAISE EXCEPTION 'service_role: enqueue_entitlement_fanout(plan, %) returned NULL', v_plan_id;
  END IF;

  SELECT * INTO c FROM public.claim_entitlement_fanout_jobs('ci-worker-2', 5, 300)
  WHERE id = v_job2;
  IF c.id IS DISTINCT FROM v_job2 THEN
    RAISE EXCEPTION 'service_role: could not lease the plan-scoped fail-path job (claimed % expected %)',
      c.id, v_job2;
  END IF;

  -- Exact pre-fail state, including the plan scope itself.
  SELECT * INTO j FROM public.entitlement_fanout_jobs WHERE id = c.id;
  IF j.scope IS DISTINCT FROM 'plan'
     OR j.plan_id IS DISTINCT FROM v_plan_id
     OR j.processing_generation IS NULL
     OR j.claim_token IS NULL
     OR j.worker_id IS DISTINCT FROM 'ci-worker-2' THEN
    RAISE EXCEPTION 'service_role: plan-scoped leased state wrong (scope=%, plan=%, gen=%, token=%, worker=%)',
      j.scope, j.plan_id, j.processing_generation, j.claim_token, j.worker_id;
  END IF;

  outcome := public.fail_entitlement_fanout(
    c.id, c.claim_token, 'ci-worker-2', c.processing_generation, 'ci_proof', 300, 10);
  IF outcome <> 'retry_same_generation' THEN
    RAISE EXCEPTION 'service_role: fail_entitlement_fanout returned %, expected retry_same_generation', outcome;
  END IF;

  -- Exact retry state: same plan-scoped job, requeued, lease released, error
  -- recorded and backed off.
  SELECT * INTO j FROM public.entitlement_fanout_jobs WHERE id = c.id;
  IF j.id IS DISTINCT FROM v_job2
     OR j.scope IS DISTINCT FROM 'plan'
     OR j.plan_id IS DISTINCT FROM v_plan_id
     OR j.status IS DISTINCT FROM 'pending'
     OR j.last_error_code IS DISTINCT FROM 'ci_proof'
     OR j.processing_generation IS DISTINCT FROM NULL
     OR j.claim_token IS DISTINCT FROM NULL
     OR j.worker_id IS DISTINCT FROM NULL
     OR j.claim_expires_at IS DISTINCT FROM NULL
     OR j.next_attempt_at <= now() THEN
    RAISE EXCEPTION 'service_role: plan retry row state wrong (id=%, scope=%, plan=%, status=%, error=%, token=%, worker=%, next=%)',
      j.id, j.scope, j.plan_id, j.status, j.last_error_code, j.claim_token, j.worker_id, j.next_attempt_at;
  END IF;
  steps := steps + 1;

  RESET ROLE;

  IF steps <> 5 THEN
    RAISE EXCEPTION 'service_role fan-out lifecycle proof incomplete: % of 5 steps', steps;
  END IF;
  RAISE NOTICE 'service_role executed the full fan-out lifecycle live (5 RPCs)';
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE;
END
$svc$;

-- 7. Live POSITIVE proof for the four AI-KB RPCs. Called with an id that does
--    not exist: the BODY must run and report `not_found` — which is only
--    possible when service_role really can execute it.
--    `ok=false` alone is NOT accepted: a body that failed for an unrelated
--    reason would also report it, so the exact `not_found` discriminator is
--    asserted. The flag arrives through the session GUC validated at the top.
DO $kb$
DECLARE
  required boolean := (current_setting('ci.require_ai_kb', true) = '1');
  res      jsonb;
  fn       text;
  ran      integer := 0;
BEGIN
  IF to_regclass('public.ai_kb_generated_articles') IS NULL THEN
    IF required THEN
      RAISE EXCEPTION 'ai_kb_generated_articles missing but require_ai_kb=1 — chain is incomplete';
    END IF;
    RAISE NOTICE 'AI-KB tables absent (require_ai_kb=0): live AI-KB proof not applicable to this chain';
    RETURN;
  END IF;

  SET LOCAL ROLE service_role;

  FOREACH fn IN ARRAY ARRAY['accept_ai_kb_generated_article', 'publish_ai_kb_generated_article'] LOOP
    EXECUTE format(
      'SELECT public.%I($1, $2, $3, $4, $5)', fn)
      INTO res
      USING gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'ci proof', NULL::text;
    IF res IS NULL
       OR (res->>'ok')::boolean IS DISTINCT FROM false
       OR res->>'error' IS DISTINCT FROM 'not_found' THEN
      RAISE EXCEPTION 'service_role: %(…) returned %, expected {"ok":false,"error":"not_found"}', fn, res;
    END IF;
    ran := ran + 1;
  END LOOP;

  res := public.reject_ai_kb_generated_article(gen_random_uuid(), gen_random_uuid(), gen_random_uuid());
  IF res IS NULL
     OR (res->>'ok')::boolean IS DISTINCT FROM false
     OR res->>'error' IS DISTINCT FROM 'not_found' THEN
    RAISE EXCEPTION 'service_role: reject_ai_kb_generated_article returned %, expected {"ok":false,"error":"not_found"}', res;
  END IF;
  ran := ran + 1;

  res := public._ai_kb_apply_generated(
    gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'ci proof', 'draft', 'accepted', NULL);
  IF res IS NULL
     OR (res->>'ok')::boolean IS DISTINCT FROM false
     OR res->>'error' IS DISTINCT FROM 'not_found' THEN
    RAISE EXCEPTION 'service_role: _ai_kb_apply_generated returned %, expected {"ok":false,"error":"not_found"}', res;
  END IF;
  ran := ran + 1;

  RESET ROLE;

  IF ran <> 4 THEN
    RAISE EXCEPTION 'live AI-KB execution proof incomplete: % of 4 RPCs', ran;
  END IF;
  RAISE NOTICE 'service_role executed all 4 AI-KB RPCs live';
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE;
END
$kb$;

ROLLBACK;