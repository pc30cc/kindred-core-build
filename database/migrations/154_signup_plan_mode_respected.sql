-- 154 — provision_account_on_signup honours the operator's signup plan choice.
--
-- Previously the function always created a `trialing` subscription on the
-- `trial` plan for every brand-new workspace, ignoring
-- platform_settings.signup_default_plan_mode (migration 153). Now:
--   mode = 'trial' -> create the trial subscription (length from the plan's
--                     own trial_days card).
--   mode = 'free'  -> create no subscription at all; the workspace falls back
--                     to the free plan.
-- Existing workspaces are never touched.

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
  _trial public.billing_plans%ROWTYPE;
  _trial_days integer;
  _mode text;
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
    _ws_id := public.create_workspace_atomic(_account_id, _ws_name, _ws_slug, _user_id);
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

  -- Operator choice (Super Admin -> Core settings -> Signup): 'free' | 'trial'
  SELECT COALESCE(ps.signup_default_plan_mode, 'free') INTO _mode
  FROM public.platform_settings ps
  LIMIT 1;
  IF _mode IS DISTINCT FROM 'trial' THEN
    RETURN;
  END IF;

  SELECT * INTO _trial
  FROM public.billing_plans
  WHERE slug = 'trial' AND is_active = true
  LIMIT 1;

  IF FOUND AND _ws_id IS NOT NULL THEN
    _trial_days := COALESCE(_trial.trial_days, 14);
    IF _trial_days < 1 THEN _trial_days := 14; END IF;

    INSERT INTO public.workspace_subscriptions (
      workspace_id, plan_id, provider_name, status,
      current_period_start, current_period_end, trial_end, metadata
    ) VALUES (
      _ws_id, _trial.id, 'system', 'trialing',
      now(), now() + (_trial_days || ' days')::interval,
      now() + (_trial_days || ' days')::interval,
      jsonb_build_object('source', 'signup_auto_trial', 'trial_days', _trial_days)
    )
    ON CONFLICT (workspace_id) DO NOTHING;

    IF NOT EXISTS (
      SELECT 1 FROM public.plan_change_log pcl
      WHERE pcl.workspace_id = _ws_id
        AND pcl.change_type = 'initial'
    ) THEN
      INSERT INTO public.plan_change_log (
        workspace_id, old_plan_id, new_plan_id, change_type, metadata
      ) VALUES (
        _ws_id, NULL, _trial.id, 'initial',
        jsonb_build_object('source', 'signup_auto_trial')
      );
    END IF;
  END IF;
END;
$function$;
