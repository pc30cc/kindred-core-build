CREATE OR REPLACE FUNCTION public.billing_purge_active()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF coalesce(current_setting('app.billing_purge', true), '') <> 'on' THEN
    RETURN false;
  END IF;
  RETURN current_user IN ('postgres', 'supabase_admin', 'service_role')
      OR pg_has_role(current_user, 'postgres', 'member');
END;
$fn$;

REVOKE ALL ON FUNCTION public.billing_purge_active() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.billing_purge_active() TO service_role;
  END IF;
END $$;

DO $$
DECLARE
  v_name text;
  v_def  text;
  v_new  text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'billing_period_freeze',
    'billing_invoice_freeze',
    'billing_invoice_line_freeze',
    'billing_invoice_application_block_mutation',
    'billing_allocation_block_mutation',
    'billing_entitlement_cycle_freeze',
    'billing_engine_version_freeze',
    'billing_v2_block_direct_subscription_mutation',
    'billing_v2_block_legacy_allowance_grant',
    'billing_v2_block_period_keyed_grant',
    'billing_v2_freeze_invoice_dunning',
    'billing_wallet_ledger_block_mutation',
    'ai_billing_block_mutation',
    'ai_billing_block_pricing_mutation'
  ]
  LOOP
    SELECT pg_get_functiondef(p.oid) INTO v_def
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_name
     LIMIT 1;

    CONTINUE WHEN v_def IS NULL;
    CONTINUE WHEN position('billing_purge_active' IN v_def) > 0;

    v_new := regexp_replace(
      v_def,
      E'\nBEGIN\n',
      E'\nBEGIN\n  IF public.billing_purge_active() THEN RETURN COALESCE(NEW, OLD); END IF;\n',
      ''
    );

    IF v_new = v_def THEN
      RAISE EXCEPTION 'purge_guard_injection_failed:%', v_name;
    END IF;

    EXECUTE v_new;
  END LOOP;
END $$;

DO $$
DECLARE
  v_name text;
  v_def  text;
  v_new  text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['admin_delete_user', 'admin_delete_workspace']
  LOOP
    SELECT pg_get_functiondef(p.oid) INTO v_def
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_name
     LIMIT 1;

    CONTINUE WHEN v_def IS NULL;
    CONTINUE WHEN position('app.billing_purge' IN v_def) > 0;

    v_new := regexp_replace(
      v_def,
      E'\nBEGIN\n',
      E'\nBEGIN\n  PERFORM set_config(''app.billing_purge'', ''on'', true);\n',
      ''
    );

    IF v_new = v_def THEN
      RAISE EXCEPTION 'purge_flag_injection_failed:%', v_name;
    END IF;

    EXECUTE v_new;
  END LOOP;
END $$;