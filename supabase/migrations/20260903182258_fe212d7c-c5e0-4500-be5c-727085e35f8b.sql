DO $$
DECLARE
  fn text;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure::text
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prosecdef
       AND p.proname IN (
         'billing_apply_subscription_payment',
         'ai_purchase_credit',
         'ai_grant_allowance',
         'ai_adjust_balance',
         'ai_refund_run',
         'ai_settle_run',
         'ai_reserve',
         'ai_release_reservation',
         'ai_topup_reservation',
         'ai_begin_run',
         'ai_open_step',
         'ai_expire_lots',
         'ai_reconcile_wallet',
         'ai_ingest_usage_event',
         'ai_publish_rate_card',
         'ai_publish_sell_policy',
         'ai_publish_exchange_rate'
       )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', fn);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', fn);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    END IF;
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO postgres', fn);
  END LOOP;
END $$;