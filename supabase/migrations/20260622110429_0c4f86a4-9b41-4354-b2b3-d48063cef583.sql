-- ============================================================
-- Phase: Service-Role Companion RPC + Max Agents Activation
-- ============================================================
-- 1. Create a SECURITY DEFINER companion of accept_workspace_invitation
--    that takes the acting user id explicitly, so it can be called by
--    the canonical Express route via service_role without depending on
--    auth.uid() (which would force PostgREST role = authenticated and
--    make the bypass indistinguishable from the canonical path).
-- 2. Lock the companion to service_role only.
-- 3. Revoke browser-callable EXECUTE on the original RPC. service_role
--    retains EXECUTE for any legacy/internal use.
-- 4. Backfill billing_plans.limits.max_agents from the legacy
--    team_members alias so resolver activation does not regress
--    existing customer seat capacity. Legacy keys preserved.
-- ------------------------------------------------------------

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

  -- Get user email from profiles (same as original RPC)
  SELECT email INTO _user_email FROM profiles WHERE id = _user_id;

  -- Find invitation
  SELECT * INTO _inv FROM workspace_invitations WHERE token = _token;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid invitation token';
  END IF;

  -- Check revoked
  IF _inv.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation has been revoked';
  END IF;

  -- Check expiry (NULL expires_at = no expiration)
  IF _inv.expires_at IS NOT NULL AND _inv.expires_at < now() THEN
    RAISE EXCEPTION 'Invitation has expired';
  END IF;

  -- Check email match if invitation is email-bound
  IF _inv.invited_email IS NOT NULL
     AND lower(trim(_user_email)) != lower(trim(_inv.invited_email)) THEN
    RAISE EXCEPTION 'This invitation is for a different email address';
  END IF;

  -- Already a member: return success with already_member flag
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

  -- Add member
  INSERT INTO workspace_members (workspace_id, user_id, role)
  VALUES (_inv.workspace_id, _user_id, _inv.role);

  -- Increment use count (analytics parity with original RPC)
  UPDATE workspace_invitations SET use_count = use_count + 1 WHERE id = _inv.id;

  -- Workspace info
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

-- Lock the companion to service_role only.
REVOKE ALL ON FUNCTION public.accept_workspace_invitation_as(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.accept_workspace_invitation_as(text, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.accept_workspace_invitation_as(text, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.accept_workspace_invitation_as(text, uuid) TO service_role;

-- Close the browser-callable bypass on the original RPC.
-- service_role retains EXECUTE for legacy/internal callers.
REVOKE EXECUTE ON FUNCTION public.accept_workspace_invitation(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.accept_workspace_invitation(text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.accept_workspace_invitation(text) FROM authenticated;

-- Backfill max_agents from legacy team_members so resolver activation
-- preserves existing customer seat capacity. Only writes when the
-- canonical key is absent and a legacy team_members value exists.
UPDATE public.billing_plans
   SET limits = jsonb_set(limits, '{max_agents}', limits -> 'team_members', true)
 WHERE limits ? 'team_members'
   AND NOT (limits ? 'max_agents');
