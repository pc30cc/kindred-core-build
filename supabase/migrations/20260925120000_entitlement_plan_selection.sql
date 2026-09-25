-- Which plan server-side enforcement uses — the same rule as the plan the
-- apps are shown (server/services/billing/planSelection.ts). Change them
-- together.
--
-- check_workspace_entitlement only honoured an 'active' or unexpired
-- 'trialing' subscription, so:
--   * a workspace in its Billing V2 grace period ('past_due', no free
--     fallback recorded yet) was enforced as Free from the first day, while
--     the product keeps the paid plan until the dunning worker falls it back;
--   * a subscription canceled at period end lost its paid plan at once,
--     although current_period_end had not been reached;
--   * a subscription whose plan row no longer exists denied everything
--     ('plan_not_found') instead of getting Free, as the apps show it.
-- Everything else — body, return shape, reasons, limit override order — is
-- unchanged from 20260624174400.
--
-- Hosted chain only: the self-host chain (database/migrations) never had this
-- function; self-host installs rely on its absence (SELF_HOST_BILLING_MODE).

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

  IF FOUND AND _sub.plan_id IS NOT NULL THEN
    IF _sub.status = 'active' THEN
      _sub_valid := true;
    ELSIF _sub.status = 'past_due' AND _sub.free_fallback_at IS NULL THEN
      _sub_valid := true;
    ELSIF _sub.status = 'trialing' AND (_sub.trial_end IS NULL OR _sub.trial_end > now()) THEN
      _sub_valid := true;
    ELSIF _sub.status IN ('canceled', 'cancelled')
      AND _sub.cancel_at_period_end IS TRUE
      AND _sub.current_period_end > now() THEN
      _sub_valid := true;
    END IF;
  END IF;

  IF _sub_valid THEN
    SELECT * INTO _plan FROM billing_plans WHERE id = _sub.plan_id;
    _sub_valid := FOUND;
  END IF;

  IF NOT _sub_valid THEN
    SELECT * INTO _plan FROM billing_plans WHERE slug = 'free' AND is_active = true LIMIT 1;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('allowed', false, 'plan', 'none', 'reason', 'no_plan_found');
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

-- CREATE OR REPLACE keeps the existing grants; restated so this file alone
-- describes who may call it (20260731160434 section 5c).
REVOKE ALL ON FUNCTION public.check_workspace_entitlement(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_workspace_entitlement(uuid, text) TO authenticated, service_role;
