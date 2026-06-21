
CREATE TABLE IF NOT EXISTS public.workspace_limit_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  limit_key text NOT NULL,
  limit_value integer NOT NULL,
  admin_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, limit_key)
);

GRANT SELECT ON public.workspace_limit_overrides TO authenticated;
GRANT ALL ON public.workspace_limit_overrides TO service_role;

ALTER TABLE public.workspace_limit_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace admins can view own limit overrides"
  ON public.workspace_limit_overrides FOR SELECT TO authenticated
  USING (get_workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin'));

CREATE POLICY "Global admins can manage limit overrides"
  ON public.workspace_limit_overrides FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE INDEX IF NOT EXISTS idx_workspace_limit_overrides_workspace
  ON public.workspace_limit_overrides(workspace_id);

-- ─────────────────────────────────────────────────────────────
-- Augment check_workspace_entitlement to honor limit overrides.
-- Behavior preserved for boolean entitlements; for numeric limits,
-- a workspace override (if present) takes precedence over the plan
-- limit. -1 unlimited sentinel preserved. Fail-closed paths unchanged.
-- ─────────────────────────────────────────────────────────────
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
BEGIN
  SELECT * INTO _sub FROM workspace_subscriptions
    WHERE workspace_id = _workspace_id;

  IF NOT FOUND OR _sub.status NOT IN ('active', 'trialing') THEN
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
    RETURN jsonb_build_object(
      'allowed', (_entitlements->>_feature)::boolean,
      'plan', _plan.slug
    );
  END IF;

  -- Check workspace-level limit override BEFORE plan limit.
  SELECT limit_value INTO _override_value
    FROM workspace_limit_overrides
    WHERE workspace_id = _workspace_id AND limit_key = _feature;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'allowed', true,
      'limit', _override_value,
      'plan', _plan.slug,
      'source', 'override'
    );
  END IF;

  IF _limits ? _feature THEN
    RETURN jsonb_build_object(
      'allowed', true,
      'limit', (_limits->>_feature)::int,
      'plan', _plan.slug,
      'source', 'plan'
    );
  END IF;

  RETURN jsonb_build_object('allowed', false, 'plan', _plan.slug, 'reason', 'feature_not_in_plan');
END;
$function$;
