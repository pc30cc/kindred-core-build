-- ============================================================
-- Core SECURITY DEFINER ACL lockdown (forward-only).
--
-- PostgreSQL grants EXECUTE on every new function to PUBLIC. The four core
-- helpers created by the initial core migration therefore stayed
-- PUBLIC-executable even though they are SECURITY DEFINER:
--
--   public.handle_new_user()
--   public.has_role(uuid, public.app_role)
--   public.is_workspace_member(uuid, uuid)
--   public.get_workspace_role(uuid, uuid)
--
-- This migration rebuilds the explicit caller matrix instead of relying on
-- PUBLIC as an implicit grant, and then sweeps every other PUBLIC-executable
-- SECURITY DEFINER function in `public` so the invariant
-- "PUBLIC has EXECUTE on zero SECURITY DEFINER functions" holds chain-wide.
--
-- Shipped migrations are never edited; this file is additive and idempotent.
-- ============================================================

-- ---------- 1. The four core functions, exactly ----------
DO $core_acl$
DECLARE
  sig text;
BEGIN
  -- handle_new_user(): trigger body for auth.users. No customer role may call
  -- it directly; only the owner and the trusted Supabase Auth role (when that
  -- role exists in this environment).
  sig := to_regprocedure('public.handle_new_user()')::text;
  IF sig IS NOT NULL THEN
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', sig);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', sig);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', sig);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO supabase_auth_admin', sig);
    END IF;
  END IF;

  -- RLS helpers: authenticated + service_role only.
  FOR sig IN
    SELECT s FROM unnest(ARRAY[
      to_regprocedure('public.has_role(uuid, public.app_role)')::text,
      to_regprocedure('public.is_workspace_member(uuid, uuid)')::text,
      to_regprocedure('public.get_workspace_role(uuid, uuid)')::text
    ]) AS s WHERE s IS NOT NULL
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', sig);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', sig);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', sig);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', sig);
    END IF;
  END LOOP;
END
$core_acl$;

-- ---------- 2. Chain-wide sweep ----------
-- Every remaining SECURITY DEFINER function in `public` that PUBLIC can still
-- execute loses that implicit grant. Functions that already carry an explicit
-- role grant keep exactly those callers (so service_role-only internal RPCs
-- stay service_role-only). Functions with no explicit caller get the default
-- customer matrix; trigger bodies get none, because triggers do not need a
-- direct EXECUTE grant for the invoking role.
DO $sweep$
DECLARE
  r record;
  anon_allowlist text[] := ARRAY[
    'get_invitation_info',
    'get_widget_platform_settings',
    'kb_search_articles',
    'workspace_has_knowledge_base'
  ];
  -- Internal machine-only RPCs: service_role and nobody else, ever.
  service_only text[] := ARRAY[
    'enqueue_entitlement_fanout',
    'claim_entitlement_fanout_jobs',
    'advance_entitlement_fanout',
    'complete_entitlement_fanout',
    'fail_entitlement_fanout',
    '_ai_kb_apply_generated',
    'accept_ai_kb_generated_article',
    'publish_ai_kb_generated_article',
    'reject_ai_kb_generated_article'
  ];
  has_explicit boolean;
BEGIN
  FOR r IN
    SELECT p.oid,
           p.oid::regprocedure::text AS sig,
           p.proname,
           p.prorettype = 'pg_catalog.trigger'::regtype AS is_trigger,
           p.proacl
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.prosecdef
      AND n.nspname = 'public'
      AND has_function_privilege('public', p.oid, 'EXECUTE')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', r.sig);

    IF r.is_trigger THEN
      CONTINUE;
    END IF;

    IF r.proname = ANY (service_only) THEN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', r.sig);
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', r.sig);
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
      END IF;
      CONTINUE;
    END IF;

    has_explicit := EXISTS (
      SELECT 1 FROM aclexplode(r.proacl) a
      JOIN pg_roles ro ON ro.oid = a.grantee
      WHERE ro.rolname IN ('anon', 'authenticated', 'service_role')
        AND a.privilege_type = 'EXECUTE'
    );

    IF has_explicit THEN
      CONTINUE;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', r.sig);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
    END IF;
    IF r.proname = ANY (anon_allowlist)
       AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO anon', r.sig);
    END IF;
  END LOOP;
END
$sweep$;

-- ---------- 3. Invariant proof, inside the migration itself ----------
DO $assert$
DECLARE
  n integer;
  offenders text;
BEGIN
  SELECT count(*), string_agg(p.oid::regprocedure::text, ', ')
    INTO n, offenders
  FROM pg_proc p
  JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE p.prosecdef
    AND ns.nspname = 'public'
    AND has_function_privilege('public', p.oid, 'EXECUTE');

  IF n > 0 THEN
    RAISE EXCEPTION 'PUBLIC-executable SECURITY DEFINER functions remain: % — %', n, offenders;
  END IF;
END
$assert$;
