
-- 1. Expand workspace_role enum with new values
ALTER TYPE public.workspace_role ADD VALUE IF NOT EXISTS 'team_lead';
ALTER TYPE public.workspace_role ADD VALUE IF NOT EXISTS 'sales_agent';
ALTER TYPE public.workspace_role ADD VALUE IF NOT EXISTS 'support_agent';
ALTER TYPE public.workspace_role ADD VALUE IF NOT EXISTS 'marketing_manager';
ALTER TYPE public.workspace_role ADD VALUE IF NOT EXISTS 'seo_manager';
ALTER TYPE public.workspace_role ADD VALUE IF NOT EXISTS 'analyst';
ALTER TYPE public.workspace_role ADD VALUE IF NOT EXISTS 'developer';

-- 2. Create workspace_invitations table
CREATE TABLE IF NOT EXISTS public.workspace_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  token text NOT NULL DEFAULT encode(gen_random_bytes(32), 'hex') UNIQUE,
  role workspace_role NOT NULL DEFAULT 'agent',
  max_uses integer NOT NULL DEFAULT 1,
  use_count integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.workspace_invitations ENABLE ROW LEVEL SECURITY;

-- Owners/admins can manage invitations
CREATE POLICY "ws_admins_manage_invitations" ON public.workspace_invitations
  FOR ALL TO authenticated
  USING (
    get_workspace_role(workspace_id, auth.uid()) IN ('owner'::workspace_role, 'admin'::workspace_role)
    OR has_role(auth.uid(), 'admin'::app_role)
  )
  WITH CHECK (
    get_workspace_role(workspace_id, auth.uid()) IN ('owner'::workspace_role, 'admin'::workspace_role)
    OR has_role(auth.uid(), 'admin'::app_role)
  );

-- Any authenticated user can read invitations by token (for joining)
CREATE POLICY "authenticated_read_invitations" ON public.workspace_invitations
  FOR SELECT TO authenticated
  USING (
    is_workspace_member(workspace_id, auth.uid())
    OR has_role(auth.uid(), 'admin'::app_role)
  );

-- 3. Function to accept an invitation
CREATE OR REPLACE FUNCTION public.accept_workspace_invitation(_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _inv workspace_invitations%ROWTYPE;
  _user_id uuid;
  _ws_name text;
BEGIN
  _user_id := auth.uid();
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Find invitation
  SELECT * INTO _inv FROM workspace_invitations WHERE token = _token;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid invitation token';
  END IF;

  -- Check expiry
  IF _inv.expires_at < now() THEN
    RAISE EXCEPTION 'Invitation has expired';
  END IF;

  -- Check uses
  IF _inv.max_uses > 0 AND _inv.use_count >= _inv.max_uses THEN
    RAISE EXCEPTION 'Invitation has been fully used';
  END IF;

  -- Check if already a member
  IF EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = _inv.workspace_id AND user_id = _user_id) THEN
    RAISE EXCEPTION 'Already a member of this workspace';
  END IF;

  -- Add member
  INSERT INTO workspace_members (workspace_id, user_id, role)
  VALUES (_inv.workspace_id, _user_id, _inv.role);

  -- Increment use count
  UPDATE workspace_invitations SET use_count = use_count + 1 WHERE id = _inv.id;

  -- Get workspace name for response
  SELECT name INTO _ws_name FROM workspaces WHERE id = _inv.workspace_id;

  RETURN jsonb_build_object(
    'success', true,
    'workspace_id', _inv.workspace_id,
    'workspace_name', _ws_name,
    'role', _inv.role
  );
END;
$$;

-- 4. Function to look up invitation by token (public info only)
CREATE OR REPLACE FUNCTION public.get_invitation_info(_token text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'workspace_name', w.name,
    'workspace_slug', w.slug,
    'role', wi.role,
    'expires_at', wi.expires_at,
    'expired', wi.expires_at < now(),
    'exhausted', wi.max_uses > 0 AND wi.use_count >= wi.max_uses
  ) INTO _result
  FROM workspace_invitations wi
  JOIN workspaces w ON w.id = wi.workspace_id
  WHERE wi.token = _token;

  IF _result IS NULL THEN
    RAISE EXCEPTION 'Invalid invitation';
  END IF;

  RETURN _result;
END;
$$;
