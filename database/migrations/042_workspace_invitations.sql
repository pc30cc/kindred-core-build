-- 042 — Self-host workspace invitation schema (Owner -> invite -> accept).
--
-- server/routes/workspaceMembers.ts — the canonical, already-shipped
-- server-owned seat-creation boundary — depends on public.workspace_invitations
-- and public.accept_workspace_invitation_as(text, uuid), and
-- src/pages/auth/InvitePage.tsx (the invite-preview page a recipient sees
-- before logging in) depends on public.get_invitation_info(text) directly
-- via the browser Supabase client. None of the three exist anywhere in
-- database/migrations/ — Owner -> invite -> user accepts -> workspace
-- membership, a core first-party Auth/workspace lifecycle, has therefore
-- never worked on any self-host install.
--
-- Ported below is the MINIMUM current-effective hosted contract these
-- three already-shipped call sites actually need — traced through every
-- hosted migration that ever touched workspace_invitations or these two
-- functions (20260415090315, 20260415091618, 20260415100153,
-- 20260415100717, 20260622110429, 20260803150000) — not a new invitation
-- architecture, and not the legacy auth.uid()-based
-- accept_workspace_invitation(text) RPC, which nothing in the current
-- runtime calls (its own browser EXECUTE was already revoked on hosted;
-- porting a dead, superseded entry point is out of scope).
--
-- Trust boundary (unchanged from what workspaceMembers.ts already
-- enforces — this migration only supplies the schema underneath it):
--   Browser -> gs_session -> Express workspaceMembersRouter -> requireUser
--   -> invitation lookup + invited_email match -> email_verified gate for
--   NEW membership (idempotent re-accept of an EXISTING membership is
--   exempt) -> max_agents seat-limit gate -> service_role ->
--   accept_workspace_invitation_as(_token, _user_id) with _user_id taken
--   from the verified gs_session, never from auth.uid() and never from a
--   client-supplied value.
--
-- get_invitation_info(text) is the one browser-callable, PostgREST-style
-- RPC ported here — it is read-only (STABLE, no INSERT/UPDATE/DELETE
-- anywhere in its body), used only to render the pre-login invite-preview
-- page, and is not a seat-creation path. Its ACL below (anon +
-- authenticated + service_role) matches 20260803150000's own final sweep
-- state on hosted exactly — it was already deliberately anon-allowlisted
-- there specifically so an unauthenticated visitor can see "you've been
-- invited to X" before logging in.
--
-- accept_workspace_invitation_as(text, uuid) is the ONLY seat-creation
-- path ported. It ships locked to service_role from the moment it exists
-- on this chain (matching hosted's final state after 20260622110429,
-- and the same "no historical vulnerable window" pattern already used by
-- 039's provision_account_on_signup) — anon/authenticated/PUBLIC never
-- have EXECUTE at any point in this chain's history.

-- ---------- 1. workspace_role enum: widen to the CURRENT hosted value set ----------
-- Self-host's 001_core_tables.sql shipped only ('owner','admin','agent',
-- 'viewer'). workspaceMembers.ts's own workspaceRoleSchema (already
-- shipped, unrelated to this migration) validates invitations/role-changes
-- against all 12 hosted role values — creating or accepting an invitation
-- with any of the other 8 would fail at the DB layer with an invalid-enum
-- error even though the Express-layer Zod schema accepts it. Widening an
-- existing enum is additive and non-destructive: no existing
-- workspace_members/workspace_invitations row's role changes meaning.
ALTER TYPE public.workspace_role ADD VALUE IF NOT EXISTS 'team_lead';
ALTER TYPE public.workspace_role ADD VALUE IF NOT EXISTS 'sales_agent';
ALTER TYPE public.workspace_role ADD VALUE IF NOT EXISTS 'support_agent';
ALTER TYPE public.workspace_role ADD VALUE IF NOT EXISTS 'marketing_manager';
ALTER TYPE public.workspace_role ADD VALUE IF NOT EXISTS 'seo_manager';
ALTER TYPE public.workspace_role ADD VALUE IF NOT EXISTS 'analyst';
ALTER TYPE public.workspace_role ADD VALUE IF NOT EXISTS 'developer';
ALTER TYPE public.workspace_role ADD VALUE IF NOT EXISTS 'billing';

-- ---------- 2. workspace_invitations ----------
-- Current-final hosted shape (20260415090315's CREATE TABLE, plus
-- 20260415100153's invited_email/revoked_at columns, plus
-- 20260415100717's expires_at nullability change) — every column
-- workspaceMembers.ts's resolveInvitationContext/GET/POST/PATCH/DELETE
-- routes and get_invitation_info/accept_workspace_invitation_as actually
-- read or write.
CREATE TABLE IF NOT EXISTS public.workspace_invitations (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  token text NOT NULL DEFAULT encode(gen_random_bytes(32), 'hex') UNIQUE,
  role public.workspace_role NOT NULL DEFAULT 'agent',
  max_uses integer NOT NULL DEFAULT 1,
  use_count integer NOT NULL DEFAULT 0,
  expires_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  invited_email text,
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_workspace_invitations_workspace_id ON public.workspace_invitations(workspace_id);

-- RLS enabled, no policies — matching 039's own established self-host
-- precedent for account_members/accounts: every real caller in the
-- current architecture is service_role (which bypasses RLS as table
-- owner/BYPASSRLS), and unlike the pre-Express-boundary hosted history
-- (see this file's own top comment — TeamPage.tsx/StaffAccessPage.tsx
-- used to query workspace_invitations directly), nothing in the current
-- self-host-relevant runtime queries this table via a browser/authenticated
-- PostgREST connection at all — RLS-enabled-with-zero-policies is already
-- a correct deny-all for every other role, not an oversight.
ALTER TABLE public.workspace_invitations ENABLE ROW LEVEL SECURITY;

-- ---------- 3. get_invitation_info(text) — browser-callable, read-only ----------
-- Verbatim current-final hosted body (20260415100153's version — the last
-- one to CREATE OR REPLACE this function on the hosted chain). Backs
-- InvitePage.tsx's pre-login invite-preview screen. email_match/
-- already_member depend on auth.uid(), which is NULL for this app's
-- browser Supabase client under first-party Auth (no GoTrue session is
-- ever established) — this is a faithful, unmodified port of hosted's own
-- current behavior (same degradation exists there under the same
-- first-party-Auth architecture), not a new self-host-only gap: the real,
-- security-relevant email/verification checks happen server-side in
-- resolveInvitationContext and accept_workspace_invitation_as, using the
-- verified gs_session identity, not this RPC's degraded auth.uid() reads.
CREATE OR REPLACE FUNCTION public.get_invitation_info(_token text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _result jsonb;
  _user_id uuid;
  _user_email text;
BEGIN
  _user_id := auth.uid();

  IF _user_id IS NOT NULL THEN
    SELECT email INTO _user_email FROM profiles WHERE id = _user_id;
  END IF;

  SELECT jsonb_build_object(
    'workspace_name', w.name,
    'workspace_slug', w.slug,
    'workspace_id', w.id,
    'role', wi.role,
    'expires_at', wi.expires_at,
    'expired', (wi.expires_at IS NOT NULL AND wi.expires_at < now()),
    'revoked', wi.revoked_at IS NOT NULL,
    'invited_email', wi.invited_email,
    'inviter_name', COALESCE(p.full_name, ''),
    'inviter_email', COALESCE(p.email, ''),
    'created_at', wi.created_at,
    'email_match', CASE
      WHEN wi.invited_email IS NULL THEN true
      WHEN _user_email IS NULL THEN null
      ELSE lower(trim(_user_email)) = lower(trim(wi.invited_email))
    END,
    'already_member', CASE
      WHEN _user_id IS NULL THEN false
      ELSE EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = w.id AND user_id = _user_id)
    END
  ) INTO _result
  FROM workspace_invitations wi
  JOIN workspaces w ON w.id = wi.workspace_id
  LEFT JOIN profiles p ON p.id = wi.created_by
  WHERE wi.token = _token;

  IF _result IS NULL THEN
    RAISE EXCEPTION 'Invalid invitation';
  END IF;

  RETURN _result;
END;
$function$;

-- ---------- 4. accept_workspace_invitation_as(text, uuid) — service_role-only seat creation ----------
-- Verbatim current-final hosted body (20260622110429). _user_id is a
-- plain argument the caller (server/routes/workspaceMembers.ts) supplies
-- from the verified gs_session — this function itself does not read
-- auth.uid() anywhere, so there is nothing for a legacy/forged JWT to
-- spoof even if it could reach this function, which it cannot (see ACL
-- below).
CREATE OR REPLACE FUNCTION public.accept_workspace_invitation_as(
  _token text,
  _user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _inv workspace_invitations%ROWTYPE;
  _user_email text;
  _ws_name text;
  _ws_slug text;
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT email INTO _user_email FROM profiles WHERE id = _user_id;

  SELECT * INTO _inv FROM workspace_invitations WHERE token = _token;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid invitation token';
  END IF;

  IF _inv.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation has been revoked';
  END IF;

  IF _inv.expires_at IS NOT NULL AND _inv.expires_at < now() THEN
    RAISE EXCEPTION 'Invitation has expired';
  END IF;

  IF _inv.invited_email IS NOT NULL
     AND lower(trim(_user_email)) != lower(trim(_inv.invited_email)) THEN
    RAISE EXCEPTION 'This invitation is for a different email address';
  END IF;

  IF EXISTS (
    SELECT 1 FROM workspace_members
    WHERE workspace_id = _inv.workspace_id AND user_id = _user_id
  ) THEN
    SELECT name, slug INTO _ws_name, _ws_slug
    FROM workspaces WHERE id = _inv.workspace_id;
    RETURN jsonb_build_object(
      'success', true,
      'already_member', true,
      'workspace_id', _inv.workspace_id,
      'workspace_name', _ws_name,
      'workspace_slug', _ws_slug,
      'role', (
        SELECT role FROM workspace_members
        WHERE workspace_id = _inv.workspace_id AND user_id = _user_id
      )
    );
  END IF;

  INSERT INTO workspace_members (workspace_id, user_id, role)
  VALUES (_inv.workspace_id, _user_id, _inv.role);

  UPDATE workspace_invitations SET use_count = use_count + 1 WHERE id = _inv.id;

  SELECT name, slug INTO _ws_name, _ws_slug FROM workspaces WHERE id = _inv.workspace_id;

  RETURN jsonb_build_object(
    'success', true,
    'already_member', false,
    'workspace_id', _inv.workspace_id,
    'workspace_name', _ws_name,
    'workspace_slug', _ws_slug,
    'role', _inv.role
  );
END;
$function$;

-- ---------- 5. ACL ----------
DO $acl$
BEGIN
  REVOKE ALL ON FUNCTION public.accept_workspace_invitation_as(text, uuid) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.accept_workspace_invitation_as(text, uuid) TO service_role;

  -- Read-only, pre-login invite-preview lookup — anon must be able to call
  -- it (a not-yet-logged-in recipient sees the invite screen before
  -- authenticating), matching hosted's own deliberate anon-allowlist entry
  -- for this exact function (20260803150000_core_security_definer_acl_lockdown.sql).
  REVOKE ALL ON FUNCTION public.get_invitation_info(text) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.get_invitation_info(text) TO anon, authenticated, service_role;
END
$acl$;

-- ---------- in-migration proof ----------
DO $verify$
DECLARE
  sig text;
  missing text;
BEGIN
  IF to_regclass('public.workspace_invitations') IS NULL THEN
    RAISE EXCEPTION '042: public.workspace_invitations was not created';
  END IF;

  SELECT string_agg(col, ', ') INTO missing
  FROM unnest(ARRAY['id','workspace_id','token','role','max_uses','use_count','expires_at','created_by','created_at','invited_email','revoked_at']) AS col
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'workspace_invitations' AND column_name = col
  );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '042: workspace_invitations is missing column(s): %', missing;
  END IF;

  SELECT string_agg(v, ', ') INTO missing
  FROM unnest(ARRAY['team_lead','sales_agent','support_agent','marketing_manager','seo_manager','analyst','developer','billing']) AS v
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'workspace_role' AND e.enumlabel = v
  );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '042: workspace_role is missing enum value(s): %', missing;
  END IF;

  sig := to_regprocedure('public.accept_workspace_invitation_as(text,uuid)')::text;
  IF sig IS NULL THEN
    RAISE EXCEPTION '042: accept_workspace_invitation_as was not created';
  END IF;
  IF has_function_privilege('anon', sig, 'EXECUTE') THEN
    RAISE EXCEPTION '042: anon can execute accept_workspace_invitation_as';
  END IF;
  IF has_function_privilege('authenticated', sig, 'EXECUTE') THEN
    RAISE EXCEPTION '042: authenticated can execute accept_workspace_invitation_as';
  END IF;
  IF NOT has_function_privilege('service_role', sig, 'EXECUTE') THEN
    RAISE EXCEPTION '042: service_role cannot execute accept_workspace_invitation_as';
  END IF;

  sig := to_regprocedure('public.get_invitation_info(text)')::text;
  IF sig IS NULL THEN
    RAISE EXCEPTION '042: get_invitation_info was not created';
  END IF;
  IF NOT has_function_privilege('anon', sig, 'EXECUTE') THEN
    RAISE EXCEPTION '042: anon cannot execute get_invitation_info (breaks the pre-login invite-preview page)';
  END IF;
  IF NOT has_function_privilege('authenticated', sig, 'EXECUTE') THEN
    RAISE EXCEPTION '042: authenticated cannot execute get_invitation_info';
  END IF;
  IF NOT has_function_privilege('service_role', sig, 'EXECUTE') THEN
    RAISE EXCEPTION '042: service_role cannot execute get_invitation_info';
  END IF;

  RAISE NOTICE '042: self-host workspace invitation schema established';
END
$verify$;
