-- A wallet top-up checkout is plan-less, exactly like an AI credit top-up.
ALTER TABLE public.billing_payment_intents
  DROP CONSTRAINT IF EXISTS billing_payment_intents_subscription_shape;
ALTER TABLE public.billing_payment_intents
  ADD CONSTRAINT billing_payment_intents_subscription_shape
  CHECK (
    (purchase_type = 'subscription' AND plan_id IS NOT NULL AND billing_interval IS NOT NULL)
    OR (purchase_type IN ('ai_credit_topup', 'wallet_deposit') AND plan_id IS NULL AND billing_interval IS NULL)
  );
