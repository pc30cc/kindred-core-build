-- 041 — Workspace-provisioning security + idempotency closure (self-host
-- chain). Mirrors the hosted fix in
-- supabase/migrations/20260820160000_lock_create_workspace_atomic_and_idempotent_provisioning.sql
-- for the same two functions 039 ported.
--
-- 1. create_workspace_atomic(uuid,text,text,uuid): 039 shipped it granted
--    to `authenticated, service_role`, matching the hosted chain's own
--    pre-fix state at the time — but on THIS chain there is no GoTrue/
--    PostgREST endpoint deployed at all for a self-host install unless the
--    operator wires one up themselves, so the concrete "legacy JWT"
--    exposure is narrower here than on hosted. It is still SECURITY
--    DEFINER, still takes caller-controlled _account_id/_user_id with only
--    an internal is_account_member() check (not a match against the real
--    caller), and the app never needs anything but service_role to call it
--    (server/routes/workspaces.ts's POST /api/workspaces is the only
--    caller). Locked to service_role only, for the same reason and via the
--    same pattern as the hosted fix and as 037's provision_account_on_signup
--    lockdown.
--
-- 2. provision_account_on_signup(uuid): same idempotency gap as hosted —
--    creates a fresh account/membership/workspace on every call. Fixed
--    identically: lock the caller's own profiles row (SELECT ... FOR
--    UPDATE), then no-op if an account_members row already exists for
--    that user. This chain's version never had the hosted chain's
--    Trial-plan block (039 already documented why — no billing schema
--    here), so there is no extra side effect to gate; the guard applies to
--    exactly the same account/membership/workspace creation 039 shipped.
--
-- is_account_member(uuid,uuid): DELIBERATELY unchanged. Unlike hosted,
-- this chain's accounts/account_members tables ship with RLS enabled and
-- ZERO policies (039's own comment: every real caller is service_role,
-- which bypasses RLS, so "RLS enabled, no policies" is already a correct
-- deny-all for every other role) — there is no RLS policy on this chain
-- that references is_account_member at all, so unlike hosted there is no
-- structural RLS dependency forcing the grant to stay. It is left as-is
-- anyway, for consistency with the hosted chain's function-family ACL and
-- because nothing on this chain currently calls it with `authenticated`
-- privileges either way (server always uses service_role); narrowing it
-- further is not part of this closure's two named blockers and would be
-- scope creep beyond what was asked.

-- ---------- 1. Lock create_workspace_atomic to service_role only ----------
DO $lockdown$
DECLARE
  sig text := to_regprocedure('public.create_workspace_atomic(uuid,text,text,uuid)')::text;
BEGIN
  IF sig IS NULL THEN
    RAISE EXCEPTION '041: create_workspace_atomic must exist before this migration (see 039)';
  END IF;
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', sig);
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', sig);
  END IF;
END
$lockdown$;

-- ---------- 2. Idempotent provision_account_on_signup (self-host, no billing side effects) ----------
CREATE OR REPLACE FUNCTION public.provision_account_on_signup(_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _profile public.profiles%ROWTYPE;
  _account_id uuid;
  _acc_slug text;
  _ws_slug text;
  _ws_name text;
BEGIN
  -- Serialize concurrent calls for the SAME user: a second transaction
  -- blocks here until the first commits (or rolls back).
  SELECT * INTO _profile FROM public.profiles WHERE id = _user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  -- Idempotency guard, evaluated under the row lock above.
  IF EXISTS (SELECT 1 FROM public.account_members WHERE user_id = _user_id) THEN
    RETURN;
  END IF;

  _ws_name := COALESCE(NULLIF(TRIM(_profile.company_name), ''), COALESCE(_profile.full_name, 'My Workspace'));
  _acc_slug := public.generate_short_id('acc_');
  _ws_slug := public.generate_short_id('ws_');

  INSERT INTO public.accounts (name, slug, owner_id)
  VALUES (_ws_name, _acc_slug, _user_id)
  RETURNING id INTO _account_id;

  INSERT INTO public.account_members (account_id, user_id, role)
  VALUES (_account_id, _user_id, 'owner');

  PERFORM public.create_workspace_atomic(_account_id, _ws_name, _ws_slug, _user_id);
END;
$function$;

-- provision_account_on_signup's ACL is untouched by this migration — 037
-- already locked it to service_role only on this chain too; re-asserted
-- below purely as a regression guard.

-- ---------- in-migration proof ----------
DO $verify$
DECLARE
  sig text;
BEGIN
  sig := to_regprocedure('public.create_workspace_atomic(uuid,text,text,uuid)')::text;
  IF sig IS NULL THEN
    RAISE EXCEPTION '041: create_workspace_atomic missing';
  END IF;
  IF has_function_privilege('anon', sig, 'EXECUTE') THEN
    RAISE EXCEPTION '041: anon can still execute create_workspace_atomic';
  END IF;
  IF has_function_privilege('authenticated', sig, 'EXECUTE') THEN
    RAISE EXCEPTION '041: authenticated can still execute create_workspace_atomic';
  END IF;
  IF NOT has_function_privilege('service_role', sig, 'EXECUTE') THEN
    RAISE EXCEPTION '041: service_role cannot execute create_workspace_atomic';
  END IF;

  sig := to_regprocedure('public.provision_account_on_signup(uuid)')::text;
  IF sig IS NULL THEN
    RAISE EXCEPTION '041: provision_account_on_signup missing';
  END IF;
  IF has_function_privilege('anon', sig, 'EXECUTE') THEN
    RAISE EXCEPTION '041: anon can still execute provision_account_on_signup';
  END IF;
  IF has_function_privilege('authenticated', sig, 'EXECUTE') THEN
    RAISE EXCEPTION '041: authenticated can still execute provision_account_on_signup';
  END IF;
  IF NOT has_function_privilege('service_role', sig, 'EXECUTE') THEN
    RAISE EXCEPTION '041: service_role cannot execute provision_account_on_signup';
  END IF;

  RAISE NOTICE '041: workspace-provisioning security+idempotency closure applied (self-host)';
END
$verify$;
