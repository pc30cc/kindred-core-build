-- ============================================================
-- Phase 6-S5-R7.5 §2 — self-host full-chain structural proof.
-- Runs after psql applied database/migrations/000 → 012 in filename order,
-- with ON_ERROR_STOP=1, against a pristine database.
-- ============================================================

-- Exact RPC signature inventory (single source of truth). This RAISEs when a
-- signature is missing or an un-audited overload exists.
\ir internal-rpc-signatures.sql

DO $chain$
DECLARE
  missing text;
  r record;
  auth_migrations integer;
BEGIN
  -- Official Supabase Auth (GoTrue) bootstrap must be REAL, not mocked:
  -- the auth schema, its helper functions and its own migration ledger.
  IF to_regprocedure('auth.uid()') IS NULL OR to_regprocedure('auth.jwt()') IS NULL THEN
    RAISE EXCEPTION 'auth.uid()/auth.jwt() unavailable — not a Supabase-compatible database';
  END IF;

  IF to_regclass('auth.users') IS NULL THEN
    RAISE EXCEPTION 'auth.users missing — the official Auth migrations did not run';
  END IF;

  IF to_regclass('auth.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'auth.schema_migrations missing — auth tables were not produced by GoTrue';
  END IF;

  EXECUTE 'SELECT count(*) FROM auth.schema_migrations' INTO auth_migrations;
  IF auth_migrations = 0 THEN
    RAISE EXCEPTION 'auth.schema_migrations is empty — no official Auth migration was applied';
  END IF;
  RAISE NOTICE 'official Auth migrations applied: %', auth_migrations;

  -- Role bootstrap (000): three least-privileged, no-login roles.
  FOR r IN
    SELECT rolname, rolcanlogin, rolsuper FROM pg_roles
    WHERE rolname IN ('anon', 'authenticated', 'service_role')
  LOOP
    IF r.rolcanlogin OR r.rolsuper THEN
      RAISE EXCEPTION 'role % is not least-privileged', r.rolname;
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')) <> 3 THEN
    RAISE EXCEPTION 'self-host role bootstrap incomplete';
  END IF;

  SELECT string_agg(t, ', ') INTO missing
  FROM unnest(ARRAY[
    'profiles', 'workspaces', 'workspace_members',
    'knowledge_base_articles', 'knowledge_base_categories',
    'entitlement_fanout_jobs'
  ]) AS t
  WHERE to_regclass('public.' || t) IS NULL;

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'missing tables after self-host chain: %', missing;
  END IF;

  RAISE NOTICE 'self-host full-chain structural verification passed';
END
$chain$;