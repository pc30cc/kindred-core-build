-- 037 — Retire the legacy auth.users signup trigger; lock down
-- provision_account_on_signup to service_role only.
--
-- While GoTrue/auth.users remains physically present during the controlled
-- cutover window (029 still legitimately reads it at migration time, and
-- rollback safety during cutover depends on not dropping it), it must no
-- longer be an ALTERNATIVE application identity/provisioning path. Two
-- things currently make it one:
--
-- 1. `on_auth_user_created` (001_core_tables.sql) still fires
--    handle_new_user() AFTER INSERT ON auth.users, which — on the hosted
--    chain (20260415075437_update_handle_new_user.sql) — both inserts a
--    public.profiles row AND calls provision_account_on_signup(), i.e. a
--    raw INSERT into auth.users (a legacy GoTrue signup, bypassing every
--    Express-layer check this migration chain has built — captcha,
--    brute-force, the email-verification gate on workspace provisioning,
--    the account-takeover fix) auto-creates a profile, account, AND
--    workspace as a side effect. This is a live provisioning path parallel
--    to, and unguarded by, POST /api/auth/signup.
--
-- 2. `provision_account_on_signup(uuid)` — on the hosted chain — is
--    EXECUTE-granted to `authenticated`
--    (20260731160434_20d5ab8b-...sql, misclassified there alongside
--    functions that "already enforce their own admin/membership check";
--    this one does not — it takes `_user_id` with no check that it
--    matches the caller, as server/routes/workspaces.ts's own comment on
--    POST /api/workspaces/provision-account already documents). Any
--    GoTrue-authenticated PostgREST caller can therefore call
--    `rpc/provision_account_on_signup` directly today and provision an
--    account+workspace for an ARBITRARY target user id, entirely outside
--    the Express boundary (and its email-verification gate).
--
-- This migration does NOT drop auth.users, the auth schema, or any
-- existing user — only the trigger (and, on chains where it exists, the
-- function's PUBLIC-callable privilege). handle_new_user() itself is left
-- in place, inert, rather than dropped: no active trigger may call it, and
-- keeping the function body (rather than deleting it) avoids complicating
-- migration history / rollback during cutover.
--
-- Applied identically to BOTH migration chains. provision_account_on_signup
-- only exists on the hosted (supabase/migrations) chain — every step
-- touching it is guarded with `to_regprocedure(...) IS NOT NULL` so this
-- same file is a safe no-op for that part on the self-host chain.

-- ---------- 1. Drop the trigger — auth.users INSERT loses ALL app side effects ----------
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

-- ---------- 2. Lock provision_account_on_signup to service_role only (where it exists) ----------
DO $lockdown$
DECLARE
  sig text := to_regprocedure('public.provision_account_on_signup(uuid)')::text;
BEGIN
  IF sig IS NOT NULL THEN
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', sig);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', sig);
    END IF;
  END IF;
END
$lockdown$;

-- ---------- in-migration proof ----------
DO $verify$
DECLARE
  n integer;
  sig text;
BEGIN
  -- No on_auth_user_created trigger remains on auth.users, under any name
  -- variant, regardless of which function it points to.
  SELECT count(*) INTO n
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n2 ON n2.oid = c.relnamespace
  WHERE n2.nspname = 'auth' AND c.relname = 'users'
    AND t.tgname = 'on_auth_user_created'
    AND NOT t.tgisinternal;
  IF n > 0 THEN
    RAISE EXCEPTION '037: on_auth_user_created trigger still present on auth.users';
  END IF;

  -- auth.users itself, and the auth schema, must still exist — this
  -- migration removes a provisioning SIDE EFFECT, not the table/schema.
  IF to_regclass('auth.users') IS NULL THEN
    RAISE EXCEPTION '037: auth.users was unexpectedly dropped — this migration must never drop it';
  END IF;

  -- provision_account_on_signup, where present, is service_role-only.
  sig := to_regprocedure('public.provision_account_on_signup(uuid)')::text;
  IF sig IS NOT NULL THEN
    IF has_function_privilege('anon', sig, 'EXECUTE') THEN
      RAISE EXCEPTION '037: anon can still execute provision_account_on_signup';
    END IF;
    IF has_function_privilege('authenticated', sig, 'EXECUTE') THEN
      RAISE EXCEPTION '037: authenticated can still execute provision_account_on_signup';
    END IF;
    IF NOT has_function_privilege('service_role', sig, 'EXECUTE') THEN
      RAISE EXCEPTION '037: service_role cannot execute provision_account_on_signup';
    END IF;
  END IF;

  RAISE NOTICE '037: legacy auth.users signup trigger retired; provision_account_on_signup locked to service_role';
END
$verify$;
