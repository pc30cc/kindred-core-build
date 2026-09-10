-- 151 — Recover partially provisioned accounts and make workspace defaults
-- replay-safe. This is the self-host equivalent of the hosted migration
-- applied on 2026-09-10.

CREATE OR REPLACE FUNCTION public.create_workspace_atomic(
  _account_id uuid,
  _name text,
  _slug text,
  _user_id uuid
)
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
  VALUES (_ws_id, _user_id, 'owner')
  ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role;

  INSERT INTO public.workspace_branding (workspace_id)
  VALUES (_ws_id)
  ON CONFLICT (workspace_id) DO NOTHING;

  INSERT INTO public.widget_settings (workspace_id)
  VALUES (_ws_id)
  ON CONFLICT (workspace_id) DO NOTHING;

  RETURN _ws_id;
END;
$function$;

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
  _ws_id uuid;
BEGIN
  SELECT * INTO _profile
  FROM public.profiles
  WHERE id = _user_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  _ws_name := COALESCE(NULLIF(TRIM(_profile.company_name), ''), COALESCE(_profile.full_name, 'My Workspace'));

  SELECT am.account_id INTO _account_id
  FROM public.account_members am
  WHERE am.user_id = _user_id
  ORDER BY am.created_at, am.id
  LIMIT 1;

  IF _account_id IS NULL THEN
    _acc_slug := public.generate_short_id('acc_');
    INSERT INTO public.accounts (name, slug, owner_id)
    VALUES (_ws_name, _acc_slug, _user_id)
    RETURNING id INTO _account_id;

    INSERT INTO public.account_members (account_id, user_id, role)
    VALUES (_account_id, _user_id, 'owner')
    ON CONFLICT (account_id, user_id) DO UPDATE SET role = EXCLUDED.role;
  END IF;

  SELECT w.id INTO _ws_id
  FROM public.workspaces w
  WHERE w.account_id = _account_id
  ORDER BY (w.owner_id = _user_id) DESC, w.created_at, w.id
  LIMIT 1;

  IF _ws_id IS NULL THEN
    _ws_slug := public.generate_short_id('ws_');
    PERFORM public.create_workspace_atomic(_account_id, _ws_name, _ws_slug, _user_id);
  ELSE
    INSERT INTO public.workspace_members (workspace_id, user_id, role)
    VALUES (_ws_id, _user_id, 'owner')
    ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role;

    INSERT INTO public.workspace_branding (workspace_id)
    VALUES (_ws_id)
    ON CONFLICT (workspace_id) DO NOTHING;

    INSERT INTO public.widget_settings (workspace_id)
    VALUES (_ws_id)
    ON CONFLICT (workspace_id) DO NOTHING;
  END IF;
END;
$function$;

DO $verify$
DECLARE
  sig text;
BEGIN
  sig := to_regprocedure('public.create_workspace_atomic(uuid,text,text,uuid)')::text;
  IF sig IS NULL THEN RAISE EXCEPTION '151: create_workspace_atomic missing'; END IF;
  IF has_function_privilege('anon', sig, 'EXECUTE') OR has_function_privilege('authenticated', sig, 'EXECUTE') THEN
    RAISE EXCEPTION '151: create_workspace_atomic has unsafe client execution privilege';
  END IF;
  IF NOT has_function_privilege('service_role', sig, 'EXECUTE') THEN
    RAISE EXCEPTION '151: service_role cannot execute create_workspace_atomic';
  END IF;

  sig := to_regprocedure('public.provision_account_on_signup(uuid)')::text;
  IF sig IS NULL THEN RAISE EXCEPTION '151: provision_account_on_signup missing'; END IF;
  IF has_function_privilege('anon', sig, 'EXECUTE') OR has_function_privilege('authenticated', sig, 'EXECUTE') THEN
    RAISE EXCEPTION '151: provision_account_on_signup has unsafe client execution privilege';
  END IF;
  IF NOT has_function_privilege('service_role', sig, 'EXECUTE') THEN
    RAISE EXCEPTION '151: service_role cannot execute provision_account_on_signup';
  END IF;
END;
$verify$;