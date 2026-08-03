CREATE OR REPLACE FUNCTION public.provision_account_on_signup(_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $provision_account_on_signup$
DECLARE
  _profile public.profiles%ROWTYPE;
  _account_id uuid;
  _ws_slug text;
  _ws_name text;
BEGIN
  SELECT * INTO _profile FROM public.profiles WHERE id = _user_id;
  IF NOT FOUND THEN RETURN; END IF;

  _ws_name := COALESCE(NULLIF(TRIM(_profile.company_name), ''), COALESCE(_profile.full_name, 'My Workspace'));
  _ws_slug := LOWER(REGEXP_REPLACE(REGEXP_REPLACE(_ws_name, '[^a-zA-Z0-9\s-]', '', 'g'), '\s+', '-', 'g'));
  IF _ws_slug = '' THEN _ws_slug := 'workspace'; END IF;
  _ws_slug := _ws_slug || '-' || SUBSTR(gen_random_uuid()::text, 1, 6);

  INSERT INTO public.accounts (name, slug, owner_id)
  VALUES (_ws_name, _ws_slug, _user_id)
  RETURNING id INTO _account_id;

  INSERT INTO public.account_members (account_id, user_id, role)
  VALUES (_account_id, _user_id, 'owner');

  PERFORM public.create_workspace_atomic(_account_id, _ws_name, _ws_slug, _user_id);
END;
$provision_account_on_signup$;
