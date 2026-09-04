-- Billing V2 production sanity: schema, ACL, RPC, constraint, trigger.
-- RAISEs (and therefore fails the deploy) on the first real problem.
\set ON_ERROR_STOP on

DO $$
DECLARE
  t TEXT;
  f TEXT;
  v_missing TEXT[] := '{}';
  v_norls   TEXT[] := '{}';
  v_noexec  TEXT[] := '{}';
  v_bad     TEXT;
  v_count   INTEGER;
BEGIN
  -- 1. Relations -----------------------------------------------------------
  FOREACH t IN ARRAY ARRAY[
    'billing_invoices', 'billing_invoice_lines', 'billing_invoice_applications',
    'billing_invoice_collections', 'billing_subscription_periods',
    'billing_period_allowance_grants', 'billing_wallet_accounts',
    'billing_wallet_entries', 'billing_wallet_deposits',
    'billing_v2_rollout', 'billing_v2_audit', 'billing_v2_policy',
    'billing_v2_workspace_policy', 'billing_v2_jobs', 'billing_v2_worker_health',
    'billing_entitlement_cycles', 'billing_v2_notification_jobs'
  ] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      v_missing := v_missing || t;
    ELSIF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.' || t)) THEN
      v_norls := v_norls || t;
    END IF;
  END LOOP;

  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'billing_v2_sanity_missing_tables: %', v_missing;
  END IF;
  IF array_length(v_norls, 1) > 0 THEN
    RAISE EXCEPTION 'billing_v2_sanity_rls_disabled: %', v_norls;
  END IF;

  -- 2. RPC inventory + service_role EXECUTE --------------------------------
  FOREACH f IN ARRAY ARRAY[
    'public.billing_v2_state(uuid)',
    'public.billing_v2_evaluate_cutover(uuid)',
    'public.billing_v2_set_state(uuid,text,uuid,text,boolean)',
    'public.billing_v2_activate(uuid,uuid,text)',
    'public.billing_v2_policy_for(uuid)',
    'public.billing_v2_validate_policy()',
    'public.billing_v2_run_invoice_scheduler(integer)',
    'public.billing_v2_run_wallet_autopay(integer)',
    'public.billing_v2_run_period_activation(integer)',
    'public.billing_v2_run_entitlement_cycles(integer)',
    'public.billing_v2_run_dunning(integer)',
    'public.billing_v2_run_grace_expiry(integer)',
    'public.billing_v2_scheduler_health()',
    'public.billing_v2_dunning_metrics()',
    'public.billing_v2_current_entitlement_cycle(uuid)'
  ] LOOP
    BEGIN
      PERFORM f::regprocedure;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'billing_v2_sanity_missing_rpc: %', f;
    END;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role')
       AND NOT has_function_privilege('service_role', f::regprocedure, 'EXECUTE') THEN
      v_noexec := v_noexec || f;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
       AND has_function_privilege('anon', f::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'billing_v2_sanity_anon_can_execute: %', f;
    END IF;
  END LOOP;

  IF array_length(v_noexec, 1) > 0 THEN
    RAISE EXCEPTION 'billing_v2_sanity_service_role_cannot_execute: %', v_noexec;
  END IF;

  -- 3. No invalid / not-validated constraints on billing surfaces ----------
  SELECT string_agg(conrelid::regclass || '.' || conname, ', ')
    INTO v_bad
    FROM pg_constraint
   WHERE connamespace = 'public'::regnamespace
     AND NOT convalidated
     AND conrelid::regclass::text LIKE 'billing%';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'billing_v2_sanity_unvalidated_constraints: %', v_bad;
  END IF;

  -- 4. Authority-isolation triggers ---------------------------------------
  FOREACH t IN ARRAY ARRAY[
    'trg_billing_payment_intents_engine_freeze',
    'trg_billing_invoices_engine_freeze',
    'trg_billing_wallet_deposits_engine_freeze',
    'trg_billing_subscription_periods_engine_freeze',
    'trg_billing_v2_block_legacy_allowance',
    'trg_billing_v2_seed_new_workspace'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgname = t) THEN
      RAISE EXCEPTION 'billing_v2_sanity_missing_trigger: %', t;
    END IF;
  END LOOP;

  -- 5. Rollout states are all known ---------------------------------------
  SELECT count(*) INTO v_count FROM public.billing_v2_rollout
   WHERE state NOT IN ('legacy', 'shadow', 'v2_cutover_pending', 'v2_active');
  IF v_count > 0 THEN
    RAISE EXCEPTION 'billing_v2_sanity_unknown_rollout_state: %', v_count;
  END IF;

  RAISE NOTICE 'billing_v2_sanity: OK';
END $$;
