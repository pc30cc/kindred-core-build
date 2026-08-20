-- Workspace-provisioning security + idempotency closure (hosted chain).
--
-- Two gaps found by independent review, both in the same function family
-- 037 already partially hardened (provision_account_on_signup):
--
-- 1. create_workspace_atomic(uuid,text,text,uuid) is SECURITY DEFINER and
--    takes _account_id/_user_id as plain, caller-controlled arguments — its
--    only internal guard is is_account_member(_account_id, _user_id), which
--    does NOT prove the caller IS _user_id. It was still EXECUTE-granted to
--    `authenticated` (20260731160434_...sql, grouped there with functions
--    that "already enforce their own admin/membership check" — a
--    misclassification 037's own comment already flagged for this exact
--    function, without fixing it). Any still-valid legacy Supabase
--    Auth (GoTrue) JWT can therefore call `rpc/create_workspace_atomic`
--    directly and create a workspace inside an ARBITRARY account the
--    caller happens to already be a member of, or forge _user_id to
--    attribute workspace ownership to a different member entirely — all
--    outside server/routes/workspaces.ts's Express boundary (requireUser,
--    CSRF/origin checks, email-verification gate). The browser no longer
--    needs direct RPC access at all: POST /api/workspaces already calls
--    this exclusively through the service-role client. Locked to
--    service_role only, matching 037's own fix for provision_account_on_signup.
--
-- 2. provision_account_on_signup(uuid) creates a fresh account +
--    account_members row + workspace + workspace_members row on EVERY
--    call, with no guard against being called twice for the same user.
--    POST /api/workspaces/provision-account can be retried (double-click,
--    two tabs, a client retry-on-timeout, or two genuinely concurrent
--    requests) and would create duplicate accounts/workspaces for one
--    user. Fixed by locking the caller's own public.profiles row (`SELECT
--    ... FOR UPDATE`) before checking whether an account_members row
--    already exists for that user: two concurrent callers for the SAME
--    user serialize on that row lock (the second blocks until the first's
--    implicit transaction commits), and the second then sees the
--    first's account_members row and no-ops. Different users hold locks
--    on different profiles rows and provision independently — no
--    cross-user contention. Every side effect in the function body
--    (account, membership, workspace, and — preserved exactly, unchanged
--    — the Trial-plan auto-subscribe added by 20260624174400_...sql) now
--    runs at most once per user, no matter how many times or how
--    concurrently this is invoked. Remains service_role-only (unchanged
--    from 037) and a single atomic function call.
--
-- is_account_member(uuid,uuid) was also audited for the same "arbitrary
-- caller-supplied target user" oracle shape. `authenticated`'s EXECUTE is
-- DELIBERATELY kept (see the DO block below for the mechanical proof of
-- why): `accounts`/`account_members` RLS actually depends on it for the
-- `authenticated` role (two SELECT policies from 20260415075434_...sql),
-- and PostgreSQL requires EXECUTE on every function any applicable
-- permissive policy references to evaluate ANY of that role's SELECTs on
-- those tables — even a policy that doesn't call this function at all
-- fails closed once EXECUTE is missing from a sibling policy's function
-- (empirically reproduced: revoking EXECUTE broke the independent,
-- unrelated "Global admins can view all accounts" policy too, not just
-- the membership-check one). Revoking authenticated here would not "close
-- an oracle" so much as hard-break the entire authenticated-role read
-- surface on these two tables — a structural RLS redesign, out of scope
-- for this closure ("Do not redesign unrelated RLS").
--
-- What this migration DOES fix: `anon` (and PUBLIC generally) genuinely
-- still has EXECUTE. 20260801170211_...sql's own comment states the
-- intent — "Revoke anonymous EXECUTE on SECURITY DEFINER helpers that
-- anonymous clients never legitimately need" — but only ran
-- `REVOKE ... FROM anon`, never `FROM PUBLIC`. Postgres grants EXECUTE to
-- PUBLIC by default on CREATE FUNCTION (20260415075434_...sql never
-- narrowed it), and a privilege granted TO PUBLIC applies to every role
-- unconditionally — revoking it from one named role does not remove it,
-- since that role still holds it via PUBLIC. `anon` (no session, no
-- membership context at all) can therefore still call
-- `rpc/is_account_member` with two fully arbitrary uuids today. No RLS
-- policy on accounts/account_members grants anything `TO anon`, so
-- closing this has zero effect on any real anon-role read; it only
-- removes literally the widest form of the oracle. Re-applied here with
-- the same explicit "FROM PUBLIC, anon; TO authenticated, service_role"
-- pattern the self-host chain's 039 already used correctly for this exact
-- function from day one.

-- ---------- 1. Lock create_workspace_atomic to service_role only ----------
DO $lockdown$
DECLARE
  sig text := to_regprocedure('public.create_workspace_atomic(uuid,text,text,uuid)')::text;
BEGIN
  IF sig IS NOT NULL THEN
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', sig);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', sig);
    END IF;
  END IF;
END
$lockdown$;

-- ---------- 2. Close the PUBLIC-grant leak on is_account_member's anon access ----------
DO $anon_close$
DECLARE
  sig text := to_regprocedure('public.is_account_member(uuid,uuid)')::text;
BEGIN
  IF sig IS NOT NULL THEN
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', sig);
  END IF;
END
$anon_close$;

-- ---------- 3. Idempotent provision_account_on_signup (hosted, Trial-plan side effect preserved) ----------
CREATE OR REPLACE FUNCTION public.provision_account_on_signup(_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _profile profiles%ROWTYPE;
  _account_id uuid;
  _acc_slug text;
  _ws_slug text;
  _ws_name text;
  _ws_id uuid;
  _trial billing_plans%ROWTYPE;
  _trial_days integer;
BEGIN
  -- Serialize concurrent calls for the SAME user: a second transaction
  -- blocks here until the first commits (or rolls back), then re-reads
  -- fresh state below — it never races the first call's INSERTs.
  SELECT * INTO _profile FROM profiles WHERE id = _user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  -- Idempotency guard, evaluated under the row lock above: if this user
  -- already has an account (from an earlier call, or from the call this
  -- one just waited behind), do nothing. No duplicate account, workspace,
  -- membership, or Trial subscription is ever created.
  IF EXISTS (SELECT 1 FROM account_members WHERE user_id = _user_id) THEN
    RETURN;
  END IF;

  _ws_name := COALESCE(NULLIF(TRIM(_profile.company_name), ''), COALESCE(_profile.full_name, 'My Workspace'));
  _acc_slug := generate_short_id('acc_');
  _ws_slug := generate_short_id('ws_');

  INSERT INTO accounts (name, slug, owner_id)
  VALUES (_ws_name, _acc_slug, _user_id)
  RETURNING id INTO _account_id;

  INSERT INTO account_members (account_id, user_id, role)
  VALUES (_account_id, _user_id, 'owner');

  -- Create first workspace atomically and capture its id
  _ws_id := create_workspace_atomic(_account_id, _ws_name, _ws_slug, _user_id);

  -- Auto-subscribe to Trial plan (if it exists and is active) — byte-for-byte
  -- the same side effect 20260624174400_...sql added; only reachable once
  -- per user now, exactly like every other side effect in this function.
  SELECT * INTO _trial FROM billing_plans
    WHERE slug = 'trial' AND is_active = true
    LIMIT 1;

  IF FOUND AND _ws_id IS NOT NULL THEN
    _trial_days := COALESCE(_trial.trial_days, 14);
    IF _trial_days < 1 THEN _trial_days := 14; END IF;

    INSERT INTO workspace_subscriptions (
      workspace_id, plan_id, provider_name, status,
      current_period_start, current_period_end, trial_end, metadata
    ) VALUES (
      _ws_id, _trial.id, 'system', 'trialing',
      now(), now() + (_trial_days || ' days')::interval,
      now() + (_trial_days || ' days')::interval,
      jsonb_build_object('source', 'signup_auto_trial', 'trial_days', _trial_days)
    )
    ON CONFLICT (workspace_id) DO NOTHING;

    INSERT INTO plan_change_log (workspace_id, old_plan_id, new_plan_id, change_type, metadata)
    VALUES (_ws_id, NULL, _trial.id, 'initial', jsonb_build_object('source', 'signup_auto_trial'));
  END IF;
END;
$function$;

-- provision_account_on_signup's ACL is untouched by this migration — 037
-- already locked it to service_role only; re-asserted in the verify block
-- below purely as a regression guard against this file itself.

-- ---------- in-migration proof ----------
DO $verify$
DECLARE
  sig text;
BEGIN
  -- create_workspace_atomic is now service_role-only.
  sig := to_regprocedure('public.create_workspace_atomic(uuid,text,text,uuid)')::text;
  IF sig IS NOT NULL THEN
    IF has_function_privilege('anon', sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'anon can still execute create_workspace_atomic';
    END IF;
    IF has_function_privilege('authenticated', sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'authenticated can still execute create_workspace_atomic';
    END IF;
    IF NOT has_function_privilege('service_role', sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'service_role cannot execute create_workspace_atomic';
    END IF;
  END IF;

  -- provision_account_on_signup remains service_role-only (037's invariant,
  -- untouched by this migration's CREATE OR REPLACE of its body).
  sig := to_regprocedure('public.provision_account_on_signup(uuid)')::text;
  IF sig IS NOT NULL THEN
    IF has_function_privilege('anon', sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'anon can still execute provision_account_on_signup';
    END IF;
    IF has_function_privilege('authenticated', sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'authenticated can still execute provision_account_on_signup';
    END IF;
    IF NOT has_function_privilege('service_role', sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'service_role cannot execute provision_account_on_signup';
    END IF;
  END IF;

  -- is_account_member is DELIBERATELY unchanged: authenticated must still
  -- be able to execute it (RLS on accounts/account_members depends on it —
  -- see the top-of-file comment for the empirical proof of why revoking it
  -- would break, not narrow, that RLS surface).
  sig := to_regprocedure('public.is_account_member(uuid,uuid)')::text;
  IF sig IS NOT NULL THEN
    IF NOT has_function_privilege('authenticated', sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'authenticated cannot execute is_account_member — RLS on accounts/account_members would break';
    END IF;
    IF has_function_privilege('anon', sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'anon can still execute is_account_member';
    END IF;
    IF NOT has_function_privilege('service_role', sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'service_role cannot execute is_account_member';
    END IF;
  END IF;

  RAISE NOTICE 'workspace-provisioning security+idempotency closure applied (hosted)';
END
$verify$;
