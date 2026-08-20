-- 039 — Self-host workspace-provisioning schema parity (self-host chain
-- ONLY — no hosted mirror; see the note below and
-- migrationMirrorParity.test.ts's own asymmetric-migrations comment).
--
-- server/routes/workspaces.ts's runtime contract (POST /provision-account,
-- POST /, GET /account) calls public.provision_account_on_signup(uuid),
-- public.create_workspace_atomic(uuid,text,text,uuid), and reads
-- public.accounts / public.account_members — all of which have existed on
-- the HOSTED chain since 2026-04-15 (supabase/migrations/20260415075434_*,
-- 20260415075435_*, 20260415075436_*), but were NEVER added to the
-- self-host chain (database/migrations). A self-hosted deployment
-- therefore could not complete first-run workspace bootstrap at all —
-- POST /api/workspaces/provision-account would fail outright (no such
-- table/function), and GET /api/workspaces/account would always 404.
--
-- This ports the MINIMUM current runtime contract, not the historical
-- hosted migrations verbatim:
--   - accounts / account_members: same shape as the hosted chain's
--     CURRENT (final) definition, except owner_id/user_id gain an
--     explicit FOREIGN KEY to public.profiles(id) — the hosted chain
--     never added one (NOT NULL only), but every other self-host
--     identity-referencing column already FKs to profiles per 026's own
--     "profiles is the identity root" convention, and the app never
--     writes anything but a real profiles.id here, so this is strictly
--     safer, not a divergence any runtime behavior depends on.
--   - workspaces.account_id: the hosted chain added this column via
--     `ALTER TABLE workspaces ADD COLUMN account_id ...` in the same
--     2026-04-15 migration; ported the same way here.
--   - is_account_member / create_workspace_atomic: ported verbatim from
--     the hosted chain's CURRENT (final, after its 2026-04-15 "safe
--     slugs" revision) definitions — no functional changes.
--   - provision_account_on_signup: ported WITHOUT the hosted chain's
--     later (2026-06-24) auto-subscribe-to-Trial-plan side effect. That
--     block depends on billing_plans / workspace_subscriptions /
--     plan_change_log, none of which exist anywhere in the self-host
--     chain — porting a whole billing subsystem is out of scope for
--     workspace-runtime parity and was never asked for. The function
--     still does exactly what the runtime contract in
--     server/routes/workspaces.ts needs: create the account, the
--     owner's account_members row, and the first workspace (with its
--     default branding/widget_settings rows, via create_workspace_atomic)
--     — atomically, as one function call. Locked to service_role from
--     the moment it's created (037 already established this is the
--     correct final ACL; self-host never had the hosted chain's
--     historical authenticated-EXECUTE window to begin with, so there is
--     nothing to "fix" here — it ships already closed).
--
-- No existing self-host data is touched: no existing workspace, profile,
-- or membership row is renamed, deleted, or regenerated. A workspace
-- created before this migration simply has account_id = NULL (nullable —
-- see below) until an operator/owner explicitly provisions or is
-- otherwise associated with an account; nothing in this migration
-- retroactively invents an account for a pre-existing workspace, since
-- doing so deterministically (whose account? which owner?) is exactly
-- the kind of "fake/remapped" data construction the task instructions
-- explicitly forbid. auth.users is not read, written, or depended on
-- anywhere in this file.

-- ---------- accounts ----------
CREATE TABLE IF NOT EXISTS public.accounts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  owner_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;
-- No policies, matching the hosted chain's actual current state exactly:
-- every route touching this table runs on service_role (which bypasses
-- RLS), so RLS-with-zero-policies is a correct deny-all for every other
-- role, not an oversight.

-- ---------- account_members ----------
CREATE TABLE IF NOT EXISTS public.account_members (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE (account_id, user_id)
);
ALTER TABLE public.account_members ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_account_members_user_id ON public.account_members(user_id);
CREATE INDEX IF NOT EXISTS idx_account_members_account_id ON public.account_members(account_id);

-- ---------- workspaces.account_id ----------
ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES public.accounts(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_workspaces_account_id ON public.workspaces(account_id);

-- ---------- generate_short_id ----------
-- Not SECURITY DEFINER, no sensitive data, no grant changes needed —
-- matches the hosted chain, which has never restricted it either.
CREATE OR REPLACE FUNCTION public.generate_short_id(prefix text DEFAULT '')
RETURNS text
LANGUAGE sql
VOLATILE
SET search_path TO 'public'
AS $$
  SELECT prefix || LOWER(SUBSTR(REPLACE(gen_random_uuid()::text, '-', ''), 1, 8))
$$;

-- ---------- is_account_member ----------
CREATE OR REPLACE FUNCTION public.is_account_member(_account_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.account_members WHERE account_id = _account_id AND user_id = _user_id)
$$;

-- ---------- create_workspace_atomic ----------
-- Verbatim port of the hosted chain's current (2026-04-15 "safe slugs")
-- definition — internal is_account_member(_account_id, _user_id) check
-- retained exactly: a caller who isn't a member of _account_id is
-- rejected by the function itself, regardless of what the Express layer
-- already checked.
CREATE OR REPLACE FUNCTION public.create_workspace_atomic(_account_id uuid, _name text, _slug text, _user_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _ws_id uuid;
  _safe_slug text;
BEGIN
  IF NOT public.is_account_member(_account_id, _user_id) THEN
    RAISE EXCEPTION 'Not an account member';
  END IF;

  IF _slug IS NOT NULL AND _slug LIKE 'ws_%' AND _slug ~ '^ws_[a-z0-9]+$' THEN
    _safe_slug := _slug;
  ELSE
    _safe_slug := public.generate_short_id('ws_');
  END IF;

  INSERT INTO public.workspaces (name, slug, owner_id, account_id)
  VALUES (_name, _safe_slug, _user_id, _account_id)
  RETURNING id INTO _ws_id;

  INSERT INTO public.workspace_members (workspace_id, user_id, role)
  VALUES (_ws_id, _user_id, 'owner');

  INSERT INTO public.workspace_branding (workspace_id) VALUES (_ws_id);
  INSERT INTO public.widget_settings (workspace_id) VALUES (_ws_id);

  RETURN _ws_id;
END;
$function$;

-- ---------- provision_account_on_signup ----------
-- See the top-of-file note: same account+membership+workspace creation as
-- the hosted chain's current function, WITHOUT the billing-plan
-- auto-subscribe block (no billing schema exists in this chain).
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
  SELECT * INTO _profile FROM public.profiles WHERE id = _user_id;
  IF NOT FOUND THEN RETURN; END IF;

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

-- ---------- ACL ----------
DO $acl$
BEGIN
  REVOKE ALL ON FUNCTION public.is_account_member(uuid, uuid) FROM PUBLIC, anon;
  GRANT EXECUTE ON FUNCTION public.is_account_member(uuid, uuid) TO authenticated, service_role;

  REVOKE ALL ON FUNCTION public.create_workspace_atomic(uuid, text, text, uuid) FROM PUBLIC, anon;
  GRANT EXECUTE ON FUNCTION public.create_workspace_atomic(uuid, text, text, uuid) TO authenticated, service_role;

  -- Unlike the hosted chain's historical window, this ships already
  -- locked to service_role only — matching 037's own final invariant for
  -- this exact function, just enforced from the moment the function
  -- exists on this chain rather than needing a later fix.
  REVOKE ALL ON FUNCTION public.provision_account_on_signup(uuid) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.provision_account_on_signup(uuid) TO service_role;
END
$acl$;

-- ---------- in-migration proof ----------
DO $verify$
DECLARE
  sig text;
BEGIN
  IF to_regclass('public.accounts') IS NULL THEN
    RAISE EXCEPTION '039: public.accounts was not created';
  END IF;
  IF to_regclass('public.account_members') IS NULL THEN
    RAISE EXCEPTION '039: public.account_members was not created';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'workspaces' AND column_name = 'account_id'
  ) THEN
    RAISE EXCEPTION '039: workspaces.account_id was not added';
  END IF;

  sig := to_regprocedure('public.provision_account_on_signup(uuid)')::text;
  IF sig IS NULL THEN
    RAISE EXCEPTION '039: provision_account_on_signup was not created';
  END IF;
  IF has_function_privilege('anon', sig, 'EXECUTE') THEN
    RAISE EXCEPTION '039: anon can execute provision_account_on_signup';
  END IF;
  IF has_function_privilege('authenticated', sig, 'EXECUTE') THEN
    RAISE EXCEPTION '039: authenticated can execute provision_account_on_signup';
  END IF;
  IF NOT has_function_privilege('service_role', sig, 'EXECUTE') THEN
    RAISE EXCEPTION '039: service_role cannot execute provision_account_on_signup';
  END IF;

  IF to_regprocedure('public.create_workspace_atomic(uuid,text,text,uuid)') IS NULL THEN
    RAISE EXCEPTION '039: create_workspace_atomic was not created';
  END IF;
  IF to_regprocedure('public.is_account_member(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION '039: is_account_member was not created';
  END IF;

  RAISE NOTICE '039: self-host account/workspace provisioning schema parity established';
END
$verify$;
