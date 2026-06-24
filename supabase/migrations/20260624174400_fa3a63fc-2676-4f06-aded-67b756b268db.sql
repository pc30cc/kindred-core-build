
-- 1. Add is_hidden flag to billing_plans (hides plan from end-user listings)
ALTER TABLE public.billing_plans
  ADD COLUMN IF NOT EXISTS is_hidden boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.billing_plans.is_hidden IS
  'When true, plan is excluded from user-facing plan listings (still usable by admin/system, e.g. Trial plan).';

-- 2. Rebuild public view to exclude hidden plans and expose is_hidden for admin clients
CREATE OR REPLACE VIEW public.billing_plans_public AS
  SELECT id, name, slug, description, prices, default_currency, is_free, trial_days, sort_order, limits, entitlements
  FROM public.billing_plans
  WHERE is_active = true AND is_hidden = false;

GRANT SELECT ON public.billing_plans_public TO anon;

-- 3. Seed the Trial plan (hidden, 14 days, every module/feature enabled, generous limits).
--    Only inserted if a plan with slug 'trial' does not exist yet, so re-running is safe.
INSERT INTO public.billing_plans (
  name, slug, description, sort_order, is_free, is_active, is_hidden, trial_days,
  prices, default_currency, entitlements, limits, localized
) VALUES (
  'Trial', 'trial',
  'Auto-assigned trial plan with full access for new workspaces. Hidden from end-users.',
  -1, false, true, true, 14,
  '{"USD":{"monthly":0,"yearly":0},"EUR":{"monthly":0,"yearly":0},"IRR":{"monthly":0,"yearly":0},"TRY":{"monthly":0,"yearly":0}}'::jsonb,
  'USD',
  '{
    "ai_enabled": true,
    "custom_branding": true,
    "advanced_analytics": true,
    "priority_support": true,
    "sso": true,
    "audit_logs": true,
    "api_access": true,
    "chat": true,
    "knowledge_base": true,
    "ai_assistant": true,
    "visitor_tracking": true,
    "email_campaigns": true,
    "automation": true,
    "analytics": true,
    "omnichannel": true,
    "voice_video": true,
    "help_center": true,
    "call_center": true,
    "chat_widget": true,
    "email": true,
    "whatsapp": true,
    "sms": true,
    "instagram": true,
    "telegram": true,
    "voice": true,
    "video": true
  }'::jsonb,
  '{
    "team_members": -1,
    "ai_requests_monthly": -1,
    "storage_mb": 50000,
    "kb_articles": -1,
    "contacts": -1,
    "conversations_monthly": -1
  }'::jsonb,
  '{
    "fa": {"name": "دوره آزمایشی", "description": "پلن آزمایشی با دسترسی کامل برای کاربران جدید."},
    "en": {"name": "Trial", "description": "Full-access trial plan auto-assigned to new workspaces."},
    "tr": {"name": "Deneme", "description": "Yeni çalışma alanları için tam erişimli deneme planı."}
  }'::jsonb
)
ON CONFLICT (slug) DO NOTHING;

-- 4. Update provision_account_on_signup to auto-subscribe the new workspace to the Trial plan.
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
  _ws_id uuid;
  _trial billing_plans%ROWTYPE;
  _trial_days integer;
BEGIN
  SELECT * INTO _profile FROM profiles WHERE id = _user_id;
  IF NOT FOUND THEN RETURN; END IF;

  _ws_name := COALESCE(NULLIF(TRIM(_profile.company_name), ''), COALESCE(_profile.full_name, 'My Workspace'));
  _acc_slug := generate_short_id('acc_');
  _ws_slug := generate_short_id('ws_');

  INSERT INTO accounts (name, slug, owner_id)
  VALUES (_ws_name, _acc_slug, _user_id)
  RETURNING id INTO _account_id;

  INSERT INTO account_members (account_id, user_id, role)
  VALUES (_account_id, _user_id, 'owner');

  -- Create first workspace atomically and capture its id
  _ws_id := create_workspace_atomic(_account_id, _ws_name, _ws_slug, _user_id);

  -- Auto-subscribe to Trial plan (if it exists and is active)
  SELECT * INTO _trial FROM billing_plans
    WHERE slug = 'trial' AND is_active = true
    LIMIT 1;

  IF FOUND AND _ws_id IS NOT NULL THEN
    _trial_days := COALESCE(_trial.trial_days, 14);
    IF _trial_days < 1 THEN _trial_days := 14; END IF;

    INSERT INTO workspace_subscriptions (
      workspace_id, plan_id, provider_name, status,
      current_period_start, current_period_end, trial_end, metadata
    ) VALUES (
      _ws_id, _trial.id, 'system', 'trialing',
      now(), now() + (_trial_days || ' days')::interval,
      now() + (_trial_days || ' days')::interval,
      jsonb_build_object('source', 'signup_auto_trial', 'trial_days', _trial_days)
    )
    ON CONFLICT (workspace_id) DO NOTHING;

    -- Log initial plan assignment
    INSERT INTO plan_change_log (workspace_id, old_plan_id, new_plan_id, change_type, metadata)
    VALUES (_ws_id, NULL, _trial.id, 'initial', jsonb_build_object('source', 'signup_auto_trial'));
  END IF;
END;
$function$;

-- 5. Function to expire stale trials so the entitlement check falls back to Free.
CREATE OR REPLACE FUNCTION public.expire_stale_trials()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _count integer := 0;
BEGIN
  WITH updated AS (
    UPDATE workspace_subscriptions
       SET status = 'expired',
           updated_at = now()
     WHERE status = 'trialing'
       AND trial_end IS NOT NULL
       AND trial_end < now()
    RETURNING 1
  )
  SELECT count(*) INTO _count FROM updated;
  RETURN _count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.expire_stale_trials() TO service_role;

-- 6. Make check_workspace_entitlement treat expired trials as no-sub (fallback to Free).
CREATE OR REPLACE FUNCTION public.check_workspace_entitlement(_workspace_id uuid, _feature text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _sub workspace_subscriptions%ROWTYPE;
  _plan billing_plans%ROWTYPE;
  _entitlements jsonb;
  _limits jsonb;
  _override_value integer;
  _sub_valid boolean := false;
BEGIN
  SELECT * INTO _sub FROM workspace_subscriptions
    WHERE workspace_id = _workspace_id;

  IF FOUND THEN
    IF _sub.status = 'active' THEN
      _sub_valid := true;
    ELSIF _sub.status = 'trialing' AND (_sub.trial_end IS NULL OR _sub.trial_end > now()) THEN
      _sub_valid := true;
    END IF;
  END IF;

  IF NOT _sub_valid THEN
    SELECT * INTO _plan FROM billing_plans WHERE slug = 'free' AND is_active = true LIMIT 1;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('allowed', false, 'plan', 'none', 'reason', 'no_plan_found');
    END IF;
  ELSE
    SELECT * INTO _plan FROM billing_plans WHERE id = _sub.plan_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('allowed', false, 'plan', 'unknown', 'reason', 'plan_not_found');
    END IF;
  END IF;

  _entitlements := COALESCE(_plan.entitlements, '{}'::jsonb);
  _limits := COALESCE(_plan.limits, '{}'::jsonb);

  IF _entitlements ? _feature THEN
    RETURN jsonb_build_object('allowed', (_entitlements->>_feature)::boolean, 'plan', _plan.slug);
  END IF;

  SELECT limit_value INTO _override_value
    FROM workspace_limit_overrides
    WHERE workspace_id = _workspace_id AND limit_key = _feature;

  IF FOUND THEN
    RETURN jsonb_build_object('allowed', true, 'limit', _override_value, 'plan', _plan.slug, 'source', 'override');
  END IF;

  IF _limits ? _feature THEN
    RETURN jsonb_build_object('allowed', true, 'limit', (_limits->>_feature)::int, 'plan', _plan.slug, 'source', 'plan');
  END IF;

  RETURN jsonb_build_object('allowed', false, 'plan', _plan.slug, 'reason', 'feature_not_in_plan');
END;
$function$;
