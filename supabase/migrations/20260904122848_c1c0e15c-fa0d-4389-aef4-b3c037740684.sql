CREATE OR REPLACE FUNCTION public.admin_reset_billing_data(p_confirm text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tables text[] := ARRAY[
    'billing_notification_jobs',
    'billing_retention_signals',
    'billing_invoice_applications',
    'billing_subscription_applications',
    'billing_invoice_collections',
    'billing_payment_allocations',
    'billing_payments',
    'billing_payment_intents',
    'billing_invoice_lines',
    'billing_invoices',
    'billing_coupon_redemptions',
    'billing_period_allowance_grants',
    'billing_entitlement_cycles',
    'billing_subscription_periods',
    'billing_wallet_ledger',
    'billing_wallet_deposits',
    'billing_wallet_accounts',
    'billing_v2_jobs',
    'billing_v2_audit',
    'billing_events',
    'plan_change_log',
    'ai_billing_adjustments',
    'ai_billing_audit_log',
    'ai_billing_commands',
    'ai_usage_event_conflicts',
    'ai_usage_events',
    'ai_run_settlements',
    'ai_run_steps',
    'ai_runs',
    'ai_usage_logs',
    'workspace_subscriptions'
  ];
  v_present text[] := ARRAY[]::text[];
  v_name text;
BEGIN
  IF p_confirm IS DISTINCT FROM 'RESET-BILLING' THEN
    RAISE EXCEPTION 'confirmation_required';
  END IF;

  FOREACH v_name IN ARRAY v_tables LOOP
    IF to_regclass('public.' || v_name) IS NOT NULL THEN
      v_present := v_present || ('public.' || v_name);
    END IF;
  END LOOP;

  IF array_length(v_present, 1) IS NULL THEN
    RETURN jsonb_build_object('cleared', ARRAY[]::text[]);
  END IF;

  -- TRUNCATE bypasses the append-only row triggers that (correctly) protect
  -- financial history during normal operation. This entry point exists only
  -- for an explicit operator-initiated full reset.
  EXECUTE 'TRUNCATE TABLE ' || array_to_string(v_present, ', ') || ' RESTART IDENTITY CASCADE';

  RETURN jsonb_build_object('cleared', v_present, 'cleared_at', now());
END;
$$;

REVOKE ALL ON FUNCTION public.admin_reset_billing_data(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_reset_billing_data(text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_reset_billing_data(text) TO service_role;