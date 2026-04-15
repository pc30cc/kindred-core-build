
-- Add new columns to workspace_invitations
ALTER TABLE public.workspace_invitations
  ADD COLUMN IF NOT EXISTS invited_email text,
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz;

-- Drop and recreate get_invitation_info with full details
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
  _is_member boolean;
BEGIN
  _user_id := auth.uid();

  -- Get user email if authenticated
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

-- Drop and recreate accept_workspace_invitation with full validation
CREATE OR REPLACE FUNCTION public.accept_workspace_invitation(_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _inv workspace_invitations%ROWTYPE;
  _user_id uuid;
  _user_email text;
  _ws_name text;
  _ws_slug text;
BEGIN
  _user_id := auth.uid();
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Get user email
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
  IF _inv.invited_email IS NOT NULL AND lower(trim(_user_email)) != lower(trim(_inv.invited_email)) THEN
    RAISE EXCEPTION 'This invitation is for a different email address';
  END IF;

  -- Check if already a member
  IF EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = _inv.workspace_id AND user_id = _user_id) THEN
    -- Return success with already_member flag instead of error
    SELECT name, slug INTO _ws_name, _ws_slug FROM workspaces WHERE id = _inv.workspace_id;
    RETURN jsonb_build_object(
      'success', true,
      'already_member', true,
      'workspace_id', _inv.workspace_id,
      'workspace_name', _ws_name,
      'workspace_slug', _ws_slug,
      'role', (SELECT role FROM workspace_members WHERE workspace_id = _inv.workspace_id AND user_id = _user_id)
    );
  END IF;

  -- Add member
  INSERT INTO workspace_members (workspace_id, user_id, role)
  VALUES (_inv.workspace_id, _user_id, _inv.role);

  -- Increment use count (keep for analytics)
  UPDATE workspace_invitations SET use_count = use_count + 1 WHERE id = _inv.id;

  -- Get workspace info
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
