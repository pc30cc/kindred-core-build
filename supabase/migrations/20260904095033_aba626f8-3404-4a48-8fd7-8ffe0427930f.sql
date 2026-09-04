-- 124 — BILLING V2 AS THE DEFAULT PATH FOR NEW WORKSPACES + POLICY VALIDATOR

ALTER TABLE public.billing_v2_policy
  ADD COLUMN IF NOT EXISTS new_workspace_default_state  TEXT NOT NULL DEFAULT 'v2_active',
  ADD COLUMN IF NOT EXISTS new_workspace_default_region TEXT;

ALTER TABLE public.billing_v2_policy
  DROP CONSTRAINT IF EXISTS billing_v2_policy_new_workspace_state_check;
ALTER TABLE public.billing_v2_policy
  ADD CONSTRAINT billing_v2_policy_new_workspace_state_check CHECK (
    new_workspace_default_state IN ('legacy', 'shadow', 'v2_cutover_pending', 'v2_active')
  );

COMMENT ON COLUMN public.billing_v2_policy.new_workspace_default_state IS
  'Rollout state seeded for workspaces created from now on. Does NOT affect existing workspaces — those only move through billing_v2_activate.';

CREATE OR REPLACE FUNCTION public.billing_v2_seed_new_workspace_rollout()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_state  TEXT;
  v_region TEXT;
BEGIN
  SELECT new_workspace_default_state, new_workspace_default_region
    INTO v_state, v_region
    FROM public.billing_v2_policy WHERE id;

  IF v_state IS NULL OR v_state = 'legacy' THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.billing_v2_rollout (workspace_id, state, region,
                                         shadow_enabled_at, cutover_pending_at, activated_at)
  VALUES (
    NEW.id, v_state, v_region,
    CASE WHEN v_state <> 'legacy' THEN now() END,
    CASE WHEN v_state IN ('v2_cutover_pending', 'v2_active') THEN now() END,
    CASE WHEN v_state = 'v2_active' THEN now() END)
  ON CONFLICT (workspace_id) DO NOTHING;

  INSERT INTO public.billing_wallet_accounts (workspace_id)
  VALUES (NEW.id) ON CONFLICT (workspace_id) DO NOTHING;

  INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
  VALUES (NEW.id, 'billing_v2_new_workspace_default', 'policy_default',
          jsonb_build_object('state', v_state, 'region', v_region));

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_billing_v2_seed_new_workspace ON public.workspaces;
CREATE TRIGGER trg_billing_v2_seed_new_workspace
  AFTER INSERT ON public.workspaces
  FOR EACH ROW EXECUTE FUNCTION public.billing_v2_seed_new_workspace_rollout();

CREATE OR REPLACE FUNCTION public.billing_v2_validate_policy()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_pol      public.billing_v2_policy;
  v_errors   JSONB := '[]'::jsonb;
  v_warnings JSONB := '[]'::jsonb;
  v_plan     public.billing_plans;
  v_free     INTEGER;
BEGIN
  SELECT * INTO v_pol FROM public.billing_v2_policy WHERE id;
  IF v_pol.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'errors',
      jsonb_build_array(jsonb_build_object('code', 'policy_row_missing')),
      'warnings', '[]'::jsonb, 'policy', 'null'::jsonb);
  END IF;

  SELECT count(*) INTO v_free
    FROM public.billing_plans WHERE is_free = true AND is_active = true;

  IF v_pol.fallback_plan_id IS NULL THEN
    IF v_free = 0 THEN
      v_errors := v_errors || jsonb_build_object('code', 'no_active_free_plan_for_fallback');
    ELSE
      v_warnings := v_warnings || jsonb_build_object(
        'code', 'fallback_plan_id_implicit', 'detail', v_free);
    END IF;
  ELSE
    SELECT * INTO v_plan FROM public.billing_plans WHERE id = v_pol.fallback_plan_id;
    IF v_plan.id IS NULL THEN
      v_errors := v_errors || jsonb_build_object(
        'code', 'fallback_plan_missing', 'detail', v_pol.fallback_plan_id);
    ELSE
      IF NOT COALESCE(v_plan.is_free, false) THEN
        v_errors := v_errors || jsonb_build_object(
          'code', 'fallback_plan_not_free', 'detail', v_plan.id);
      END IF;
      IF NOT COALESCE(v_plan.is_active, false) THEN
        v_errors := v_errors || jsonb_build_object(
          'code', 'fallback_plan_inactive', 'detail', v_plan.id);
      END IF;
    END IF;
  END IF;

  IF v_pol.invoice_lead_time_days IS NULL OR v_pol.invoice_lead_time_days < 1 THEN
    v_warnings := v_warnings || jsonb_build_object(
      'code', 'invoice_lead_time_zero', 'detail', v_pol.invoice_lead_time_days);
  END IF;

  IF COALESCE(array_length(v_pol.reminder_days_before_due, 1), 0) = 0 THEN
    v_warnings := v_warnings || jsonb_build_object('code', 'no_invoice_reminders');
  END IF;

  IF v_pol.grace_period_days IS NULL THEN
    v_errors := v_errors || jsonb_build_object('code', 'grace_period_days_null');
  END IF;

  IF v_pol.new_workspace_default_state NOT IN
       ('legacy', 'shadow', 'v2_cutover_pending', 'v2_active') THEN
    v_errors := v_errors || jsonb_build_object(
      'code', 'invalid_new_workspace_default_state',
      'detail', v_pol.new_workspace_default_state);
  END IF;

  RETURN jsonb_build_object(
    'ok', jsonb_array_length(v_errors) = 0,
    'errors', v_errors,
    'warnings', v_warnings,
    'policy', jsonb_build_object(
      'invoice_lead_time_days', v_pol.invoice_lead_time_days,
      'invoice_due_offset_days', v_pol.invoice_due_offset_days,
      'grace_period_days', v_pol.grace_period_days,
      'reminder_days_before_due', to_jsonb(v_pol.reminder_days_before_due),
      'wallet_auto_pay_default', v_pol.wallet_auto_pay_default,
      'fallback_plan_id', v_pol.fallback_plan_id,
      'new_workspace_default_state', v_pol.new_workspace_default_state,
      'new_workspace_default_region', v_pol.new_workspace_default_region,
      'active_free_plans', v_free));
END;
$$;

DO $$
DECLARE f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.billing_v2_seed_new_workspace_rollout()',
    'public.billing_v2_validate_policy()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
    END IF;
  END LOOP;
END $$;

-- 125 — bootstrap cycle: subscription_id nullable
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'billing_entitlement_cycles'
       AND column_name = 'subscription_id'
       AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE public.billing_entitlement_cycles
      ALTER COLUMN subscription_id DROP NOT NULL;
  END IF;
END $$;