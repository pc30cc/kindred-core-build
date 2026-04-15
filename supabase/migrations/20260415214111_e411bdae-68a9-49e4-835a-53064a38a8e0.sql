
-- workspace_subscriptions: links a workspace to a billing plan
CREATE TABLE IF NOT EXISTS public.workspace_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL UNIQUE,
  plan_id uuid REFERENCES public.billing_plans(id) ON DELETE SET NULL,
  provider_name text NOT NULL DEFAULT 'manual',
  provider_subscription_id text,
  provider_customer_id text,
  status text NOT NULL DEFAULT 'active',
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  current_period_start timestamptz DEFAULT now(),
  current_period_end timestamptz,
  trial_start timestamptz,
  trial_end timestamptz,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_ws_subs_plan ON public.workspace_subscriptions(plan_id);
CREATE INDEX IF NOT EXISTS idx_ws_subs_status ON public.workspace_subscriptions(status);

-- RLS
ALTER TABLE public.workspace_subscriptions ENABLE ROW LEVEL SECURITY;

-- Workspace owners/admins can view their subscription
CREATE POLICY "Workspace admins can view subscription"
  ON public.workspace_subscriptions
  FOR SELECT
  TO authenticated
  USING (
    get_workspace_role(workspace_id, auth.uid()) IN ('owner'::workspace_role, 'admin'::workspace_role)
  );

-- Global admins full access
CREATE POLICY "Global admins can manage all subscriptions"
  ON public.workspace_subscriptions
  FOR ALL
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- Billing role can view
CREATE POLICY "Billing role can view subscription"
  ON public.workspace_subscriptions
  FOR SELECT
  TO authenticated
  USING (
    get_workspace_role(workspace_id, auth.uid()) = 'billing'::workspace_role
  );

-- Auto-update updated_at
CREATE OR REPLACE TRIGGER update_workspace_subscriptions_updated_at
  BEFORE UPDATE ON public.workspace_subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION public.update_workspace_provider_settings_updated_at();

-- Function: check workspace entitlement (used by backend gating)
CREATE OR REPLACE FUNCTION public.check_workspace_entitlement(
  _workspace_id uuid,
  _feature text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
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
      -- No plans defined = everything allowed
      RETURN jsonb_build_object('allowed', true, 'plan', 'none');
    END IF;
  ELSE
    SELECT * INTO _plan FROM billing_plans WHERE id = _sub.plan_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('allowed', true, 'plan', 'unknown');
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

  -- Feature not mentioned = allowed by default
  RETURN jsonb_build_object('allowed', true, 'plan', _plan.slug);
END;
$$;

-- Also update admin_delete_workspace to handle workspace_subscriptions
-- (it already tries to delete from workspace_subscriptions but that table didn't exist)
