-- 125_billing_v2_bootstrap_cycle_nullable_subscription.sql
--
-- Production cutover blocker found while validating `billing_v2_activate()`
-- for a Free workspace that has NO row in public.workspace_subscriptions.
--
-- In that case migration 117 bootstraps the first billing period with
-- subscription_id = NULL (there is no legacy subscription to bind to, and the
-- authority-isolation trigger from 117 forbids writing workspace_subscriptions
-- directly under v2). billing_v2_ensure_period_cycles() then copies that NULL
-- into public.billing_entitlement_cycles.subscription_id, which was declared
-- NOT NULL in migration 119 -> activation aborts.
--
-- The subscription_period is the authority for a cycle (UNIQUE
-- (subscription_period_id, cycle_index)); subscription_id is only a
-- denormalised convenience column. Relaxing it to NULL is the correct,
-- non-destructive fix and mirrors billing_subscription_periods, where
-- subscription_id is already nullable.
--
-- Idempotent. No data is rewritten.

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
