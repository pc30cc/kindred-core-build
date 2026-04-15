
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
BEGIN
  -- Get subscription
  SELECT * INTO _sub FROM workspace_subscriptions
    WHERE workspace_id = _workspace_id;

  -- If no subscription or inactive, check free plan
  IF NOT FOUND OR _sub.status NOT IN ('active', 'trialing') THEN
    SELECT * INTO _plan FROM billing_plans WHERE slug = 'free' AND is_active = true LIMIT 1;
    IF NOT FOUND THEN
      -- FAIL-CLOSED: No plans defined = deny all gated features
      RETURN jsonb_build_object('allowed', false, 'plan', 'none', 'reason', 'no_plan_found');
    END IF;
  ELSE
    SELECT * INTO _plan FROM billing_plans WHERE id = _sub.plan_id;
    IF NOT FOUND THEN
      -- FAIL-CLOSED: Subscription references missing plan = deny
      RETURN jsonb_build_object('allowed', false, 'plan', 'unknown', 'reason', 'plan_not_found');
    END IF;
  END IF;

  _entitlements := COALESCE(_plan.entitlements, '{}'::jsonb);
  _limits := COALESCE(_plan.limits, '{}'::jsonb);

  -- Check entitlements (boolean features)
  IF _entitlements ? _feature THEN
    RETURN jsonb_build_object(
      'allowed', (_entitlements->>_feature)::boolean,
      'plan', _plan.slug
    );
  END IF;

  -- Check limits (numeric features)
  IF _limits ? _feature THEN
    RETURN jsonb_build_object(
      'allowed', true,
      'limit', (_limits->>_feature)::int,
      'plan', _plan.slug
    );
  END IF;

  -- FAIL-CLOSED: Feature not mentioned in plan = denied
  RETURN jsonb_build_object('allowed', false, 'plan', _plan.slug, 'reason', 'feature_not_in_plan');
END;
$function$;
