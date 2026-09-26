-- ============================================================
-- SECURITY DEFINER FUNCTIONS: NO EXECUTE FOR anon / authenticated
-- EXCEPT AN AUDITED ALLOW-LIST
--
-- 217 -- self-host mirror of the hosted
-- supabase/migrations/20260926090000_definer_execute_customer_role_lockdown.sql
-- (functionally identical; registered in
-- src/test/integration/migrationMirrorParity.test.ts). On this chain 000
-- already revoked the image's default grants, so steps 1 and 3 are expected
-- to find nothing to take away; they run here so both chains assert the
-- same end state and a self-hoster's database that drifted is corrected.
--
-- THE HOLE
--
-- Hosted Supabase ships
--
--     ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--       GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role
--
-- (and the same for supabase_admin). Default privileges attach at CREATE
-- time, so every function the hosted chain creates arrives with an EXPLICIT
-- EXECUTE grant to `anon` -- the role anyone holding the anon key (which the
-- browser bundle ships) reaches PostgREST with -- and to `authenticated`.
-- `REVOKE ALL ... FROM PUBLIC` does not touch those grants: PUBLIC is a
-- different grantee. The self-host chain never had the problem because
-- database/migrations/000_selfhost_roles_bootstrap.sql revokes those
-- defaults before anything is created; the hosted chain never did.
--
-- Replaying the hosted chain against a Supabase-shaped database left 73
-- SECURITY DEFINER functions executable by anon and 91 by authenticated,
-- among them the whole billing/wallet engine from
-- 20260921090000_billing_engine_constraints_and_functions.sql
-- (billing_wallet_admin_adjust, billing_wallet_append, billing_wallet_refund,
-- billing_wallet_pay_invoice, billing_settle_invoice, billing_v2_activate,
-- billing_v2_set_state, billing_v2_run_*, billing_v2_apply_free_fallback, ...)
-- and admin_delete_user(uuid, uuid), which trusts its caller-supplied
-- _actor_user_id. None of them checks who is calling: they were written to
-- be reached only by the server through getServiceClient (service_role).
--
-- WHO REALLY CALLS WHAT
--
--   * The dashboard browser client (src/integrations/supabase/client.ts)
--     runs with Supabase Auth OFF: it is an anon-key transport only. Its one
--     RPC is get_widget_platform_settings (src/realtime/providers/centrifugo.ts).
--   * The widget (public/widget/**) and the native apps make no PostgREST
--     RPC calls; they talk to the server API. The widget's Supabase Realtime
--     path uses broadcast channels only.
--   * The server, workers and channel runtimes call every other RPC through
--     service_role clients (getServiceClient / createClient(url,
--     serviceRoleKey)). This migration does not touch service_role.
--   * `authenticated` is never used by the product (no GoTrue session is
--     ever created), but a GoTrue signup against the hosted project can mint
--     one, so it is treated as attacker-reachable. It keeps EXECUTE only on
--     the predicates RLS policies call: a policy expression is evaluated as
--     the querying role, and PostgreSQL checks EXECUTE on every function in
--     it, so revoking those would turn clean policy denials into errors.
--
-- THE ALLOW-LIST (the only SECURITY DEFINER functions in `public` that anon
-- or authenticated may still execute after this migration)
--
--   get_widget_platform_settings()          anon + authenticated
--       Browser realtime hardening read. Returns a sanitized
--       jsonb_build_object of non-secret tuning knobs only (guarded by
--       src/test/security/widgetPlatformSettingsExposure.test.ts). No writes.
--   has_role(uuid, app_role)                authenticated
--   is_workspace_member(uuid, uuid)         authenticated
--   get_workspace_role(uuid, uuid)          authenticated
--   is_account_member(uuid, uuid)           authenticated
--   get_account_role(uuid, uuid)            authenticated (hosted chain only)
--   workspace_owner_phone_verified(uuid)    authenticated
--       Read-only STABLE predicates used inside RLS policies that apply to
--       `authenticated`. They answer a yes/no or role question about ids the
--       caller already supplies and write nothing. anon is already denied on
--       all of them (014 / 20260803150000) and stays denied.
--
-- Everything else -- trigger functions included -- loses anon and
-- authenticated. Trigger functions need no caller EXECUTE: PostgreSQL does
-- not check it when a trigger fires. SECURITY DEFINER functions called from
-- inside other SECURITY DEFINER functions run as the owner and are not
-- affected either.
--
-- Nothing is GRANTed here. Revocation only narrows; the allow-list entries
-- keep whatever the chain already granted them, and the proof at the bottom
-- fails the migration if the browser's getter lost its grant.
--
-- DEFAULT PRIVILEGES
--
-- Future functions must not inherit the hole, so the anon/authenticated
-- EXECUTE defaults are revoked in schema public for every grantor that has
-- them (same approach as 000, which reads pg_default_acl instead of naming
-- roles). A grantor the migration role is not a member of -- supabase_admin
-- on hosted -- is reported and skipped: migrations run as postgres, so the
-- postgres defaults are the ones that apply to this chain's functions.
--
-- PUBLIC is deliberately NOT in the default-privilege revoke. Per-schema
-- default privileges can only add to the global defaults, so
-- `... IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC` is a no-op,
-- and the global form would silently change every future function in every
-- schema (including the invoker functions the self-host server reaches via
-- PUBLIC). PUBLIC on SECURITY DEFINER functions stays covered by the
-- per-function REVOKE below and by step 1 of
-- scripts/ci/verify-migration-security.sql.
--
-- This allow-list is repeated verbatim in scripts/ci/verify-migration-
-- security.sql; src/test/ci/definerExecuteAllowList.test.ts fails if the
-- two copies (or the two chains) drift.
-- ============================================================

-- ---------- 1. default privileges for future functions ----------
DO $default_acl$
DECLARE
  grantor text;
BEGIN
  FOR grantor IN
    SELECT DISTINCT pg_get_userbyid(d.defaclrole)
      FROM pg_default_acl d
     WHERE d.defaclnamespace = 'public'::regnamespace
       AND d.defaclobjtype = 'f'
  LOOP
    BEGIN
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public '
        'REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated', grantor);
      RAISE NOTICE 'definer ACL: revoked default function EXECUTE for anon/authenticated granted by %', grantor;
    EXCEPTION
      WHEN insufficient_privilege THEN
        RAISE NOTICE 'definer ACL: cannot alter default privileges for % -- skipped', grantor;
    END;
  END LOOP;
END
$default_acl$;

-- ---------- 2. admin_delete_user: service_role only ----------
-- It takes the acting admin as a caller-supplied argument and performs an
-- irreversible purge, so it can only be safe behind the server, which
-- resolves the actor from its own session first
-- (server/services/userDeletion/worker.ts). Same ACL as its siblings.
REVOKE ALL ON FUNCTION public.admin_delete_user(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_user(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.admin_delete_workspace(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_workspace(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.admin_purge_workspaces(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_purge_workspaces(uuid[]) TO service_role;

-- ---------- 3. every other SECURITY DEFINER function in public ----------
DO $definer_acl$
DECLARE
  r       record;
  revoked integer := 0;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS fn,
           pg_get_userbyid(p.proowner) AS owner,
           pg_has_role(current_user, p.proowner, 'MEMBER') AS manageable,
           coalesce(a.anon_ok, false) AS anon_ok,
           coalesce(a.auth_ok, false) AS auth_ok
      FROM pg_proc p
      LEFT JOIN (VALUES
        ('public.get_widget_platform_settings()',        true,  true),
        ('public.has_role(uuid, public.app_role)',       false, true),
        ('public.is_workspace_member(uuid, uuid)',       false, true),
        ('public.get_workspace_role(uuid, uuid)',        false, true),
        ('public.is_account_member(uuid, uuid)',         false, true),
        ('public.get_account_role(uuid, uuid)',          false, true),
        ('public.workspace_owner_phone_verified(uuid)',  false, true)
      ) AS a(sig, anon_ok, auth_ok)
        ON to_regprocedure(a.sig) = p.oid
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.prosecdef
       -- Extension-owned objects belong to the extension, not this chain.
       AND NOT EXISTS (
         SELECT 1 FROM pg_depend e
          WHERE e.classid = 'pg_proc'::regclass
            AND e.objid = p.oid
            AND e.deptype = 'e')
     ORDER BY p.oid::regprocedure::text
  LOOP
    -- A function this role cannot manage is left alone when it is already
    -- closed, and named (with its owner) when it is not, instead of failing
    -- on an anonymous "permission denied" halfway through the loop.
    IF NOT r.manageable THEN
      IF has_function_privilege('public', r.fn, 'EXECUTE')
         OR (NOT r.anon_ok AND has_function_privilege('anon', r.fn, 'EXECUTE'))
         OR (NOT r.auth_ok AND has_function_privilege('authenticated', r.fn, 'EXECUTE')) THEN
        RAISE EXCEPTION 'definer ACL: % is customer-executable but owned by %, which % cannot manage',
          r.fn, r.owner, current_user;
      END IF;
      RAISE NOTICE 'definer ACL: % (owner %) already closed -- not managed here', r.fn, r.owner;
      CONTINUE;
    END IF;

    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', r.fn);
    IF NOT r.anon_ok THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', r.fn);
    END IF;
    IF NOT r.auth_ok THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM authenticated', r.fn);
    END IF;
    revoked := revoked + 1;
  END LOOP;

  RAISE NOTICE 'definer ACL: % SECURITY DEFINER functions in public brought to the allow-list', revoked;
END
$definer_acl$;

-- ---------- in-migration proof ----------
DO $verify$
DECLARE
  n         integer;
  offenders text;
BEGIN
  SELECT count(*), string_agg(format('%s[%s]', p.oid::regprocedure, g.role_name), ', ')
    INTO n, offenders
    FROM pg_proc p
   CROSS JOIN unnest(ARRAY['anon', 'authenticated']) AS g(role_name)
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.prosecdef
     AND has_function_privilege(g.role_name, p.oid, 'EXECUTE')
     AND NOT EXISTS (
       SELECT 1
         FROM (VALUES
           ('public.get_widget_platform_settings()',        true,  true),
           ('public.has_role(uuid, public.app_role)',       false, true),
           ('public.is_workspace_member(uuid, uuid)',       false, true),
           ('public.get_workspace_role(uuid, uuid)',        false, true),
           ('public.is_account_member(uuid, uuid)',         false, true),
           ('public.get_account_role(uuid, uuid)',          false, true),
           ('public.workspace_owner_phone_verified(uuid)',  false, true)
         ) AS a(sig, anon_ok, auth_ok)
        WHERE to_regprocedure(a.sig) = p.oid
          AND CASE g.role_name WHEN 'anon' THEN a.anon_ok ELSE a.auth_ok END);

  IF n > 0 THEN
    RAISE EXCEPTION 'definer ACL: % customer-role EXECUTE grants outside the allow-list remain -- %', n, offenders;
  END IF;

  IF has_function_privilege('anon', 'public.admin_delete_user(uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.admin_delete_user(uuid, uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.admin_delete_user(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'definer ACL: admin_delete_user is not service_role-only';
  END IF;

  -- The browser's one RPC. Losing it would silently fall back to defaults
  -- in the realtime client, so it is checked rather than assumed.
  IF NOT has_function_privilege('anon', 'public.get_widget_platform_settings()', 'EXECUTE') THEN
    RAISE EXCEPTION 'definer ACL: anon lost EXECUTE on get_widget_platform_settings()';
  END IF;

  -- No default grant this migration could remove may survive.
  SELECT string_agg(pg_get_userbyid(d.defaclrole), ', ')
    INTO offenders
    FROM pg_default_acl d
   CROSS JOIN LATERAL aclexplode(d.defaclacl) x
   WHERE d.defaclnamespace = 'public'::regnamespace
     AND d.defaclobjtype = 'f'
     AND x.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ('anon', 'authenticated'))
     AND pg_has_role(current_user, d.defaclrole, 'MEMBER');

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'definer ACL: default function EXECUTE for anon/authenticated still granted by %', offenders;
  END IF;

  RAISE NOTICE 'definer ACL: anon/authenticated hold EXECUTE only on the audited allow-list';
END
$verify$;
