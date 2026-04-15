
-- Helper function to generate a short alphanumeric ID (8 chars)
CREATE OR REPLACE FUNCTION public.generate_short_id(prefix text DEFAULT '')
RETURNS text
LANGUAGE sql
VOLATILE
SET search_path TO 'public'
AS $$
  SELECT prefix || LOWER(SUBSTR(REPLACE(gen_random_uuid()::text, '-', ''), 1, 8))
$$;

-- Update provision_account_on_signup to use safe slugs
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
BEGIN
  SELECT * INTO _profile FROM profiles WHERE id = _user_id;
  IF NOT FOUND THEN RETURN; END IF;

  -- Determine workspace display name (user-facing only, NOT used for slug)
  _ws_name := COALESCE(NULLIF(TRIM(_profile.company_name), ''), COALESCE(_profile.full_name, 'My Workspace'));

  -- Generate safe ASCII-only slugs
  _acc_slug := generate_short_id('acc_');
  _ws_slug := generate_short_id('ws_');

  -- Create account
  INSERT INTO accounts (name, slug, owner_id)
  VALUES (_ws_name, _acc_slug, _user_id)
  RETURNING id INTO _account_id;

  -- Add user as account owner
  INSERT INTO account_members (account_id, user_id, role)
  VALUES (_account_id, _user_id, 'owner');

  -- Create first workspace atomically
  PERFORM create_workspace_atomic(_account_id, _ws_name, _ws_slug, _user_id);
END;
$function$;

-- Update create_workspace_atomic to accept slug or auto-generate
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
  -- Verify user is account member
  IF NOT is_account_member(_account_id, _user_id) THEN
    RAISE EXCEPTION 'Not an account member';
  END IF;

  -- If slug is provided and starts with ws_, use it; otherwise generate a safe one
  IF _slug IS NOT NULL AND _slug LIKE 'ws_%' AND _slug ~ '^ws_[a-z0-9]+$' THEN
    _safe_slug := _slug;
  ELSE
    _safe_slug := generate_short_id('ws_');
  END IF;

  -- Create workspace
  INSERT INTO workspaces (name, slug, owner_id, account_id)
  VALUES (_name, _safe_slug, _user_id, _account_id)
  RETURNING id INTO _ws_id;

  -- Add owner as workspace member
  INSERT INTO workspace_members (workspace_id, user_id, role)
  VALUES (_ws_id, _user_id, 'owner');

  -- Create default branding
  INSERT INTO workspace_branding (workspace_id) VALUES (_ws_id);

  -- Create default widget settings
  INSERT INTO widget_settings (workspace_id) VALUES (_ws_id);

  RETURN _ws_id;
END;
$function$;
