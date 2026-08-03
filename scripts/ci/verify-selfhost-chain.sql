-- ============================================================
-- Phase 6-S5-R7.5 §2 — self-host full-chain structural proof.
-- Runs after psql applied database/migrations/000 → 012 in filename order,
-- with ON_ERROR_STOP=1, against a pristine database.
-- ============================================================

DO $chain$
DECLARE
  missing text;
  r record;
BEGIN
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

  SELECT string_agg(f, ', ') INTO missing
  FROM unnest(ARRAY[
    'public._ai_kb_apply_generated(uuid, uuid, uuid, text, text, text, text)',
    'public.enqueue_entitlement_fanout(uuid, text, jsonb)'
  ]) AS f
  WHERE to_regprocedure(f) IS NULL;

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'missing self-host RPC signatures: %', missing;
  END IF;

  RAISE NOTICE 'self-host full-chain structural verification passed';
END
$chain$;