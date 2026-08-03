CREATE OR REPLACE FUNCTION public.create_workspace_atomic(
  _account_id uuid,
  _name text,
  _slug text,
  _user_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $create_workspace_atomic$
DECLARE
  _ws_id uuid;
BEGIN
  IF NOT public.is_account_member(_account_id, _user_id) THEN
    RAISE EXCEPTION 'Not an account member';
  END IF;

  INSERT INTO public.workspaces (name, slug, owner_id, account_id)
  VALUES (_name, _slug, _user_id, _account_id)
  RETURNING id INTO _ws_id;

  INSERT INTO public.workspace_members (workspace_id, user_id, role)
  VALUES (_ws_id, _user_id, 'owner');

  INSERT INTO public.workspace_branding (workspace_id)
  VALUES (_ws_id);

  INSERT INTO public.widget_settings (workspace_id)
  VALUES (_ws_id);

  RETURN _ws_id;
END;
$create_workspace_atomic$;
