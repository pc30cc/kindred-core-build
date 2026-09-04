-- BILLING ENGINE V2 — PHASE D: wallet deposit checkout

ALTER TABLE public.billing_payment_intents
  DROP CONSTRAINT IF EXISTS billing_payment_intents_purchase_type_check;
ALTER TABLE public.billing_payment_intents
  ADD CONSTRAINT billing_payment_intents_purchase_type_check
  CHECK (purchase_type IN ('subscription', 'ai_credit_topup', 'wallet_deposit'));

ALTER TABLE public.billing_payment_intents
  DROP CONSTRAINT IF EXISTS billing_payment_intents_action_type_check;
ALTER TABLE public.billing_payment_intents
  ADD CONSTRAINT billing_payment_intents_action_type_check
  CHECK (action_type IS NULL OR action_type IN (
    'plan_new', 'plan_renewal', 'plan_upgrade', 'plan_downgrade',
    'ai_credit_topup', 'wallet_deposit'
  ));

ALTER TABLE public.billing_payments
  DROP CONSTRAINT IF EXISTS billing_payments_action_type_check;
ALTER TABLE public.billing_payments
  ADD CONSTRAINT billing_payments_action_type_check
  CHECK (action_type IS NULL OR action_type IN (
    'plan_new', 'plan_renewal', 'plan_upgrade', 'plan_downgrade',
    'ai_credit_topup', 'wallet_deposit'
  ));

ALTER TABLE public.billing_payment_intents
  ADD COLUMN IF NOT EXISTS wallet_deposit_id UUID
    REFERENCES public.billing_wallet_deposits(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_payment_intents_wallet_deposit
  ON public.billing_payment_intents (wallet_deposit_id)
  WHERE wallet_deposit_id IS NOT NULL;

COMMENT ON COLUMN public.billing_payment_intents.wallet_deposit_id IS
  'Wallet deposit document this checkout collects. A deposit buys no service and applies no entitlement — it only converts gateway money into wallet balance.';

ALTER TABLE public.billing_v2_policy
  ADD COLUMN IF NOT EXISTS wallet_deposit_presets_irr BIGINT[]
    NOT NULL DEFAULT ARRAY[5000000, 10000000, 20000000, 50000000]::BIGINT[],
  ADD COLUMN IF NOT EXISTS wallet_deposit_allow_custom BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS wallet_deposit_min_irr BIGINT NOT NULL DEFAULT 500000,
  ADD COLUMN IF NOT EXISTS wallet_deposit_max_irr BIGINT NOT NULL DEFAULT 5000000000;

ALTER TABLE public.billing_v2_policy
  DROP CONSTRAINT IF EXISTS billing_v2_policy_deposit_sane;
ALTER TABLE public.billing_v2_policy
  ADD CONSTRAINT billing_v2_policy_deposit_sane
  CHECK (wallet_deposit_min_irr > 0 AND wallet_deposit_max_irr >= wallet_deposit_min_irr);

CREATE OR REPLACE FUNCTION public.billing_v2_wallet_deposit_config()
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'presets_irr', to_jsonb(p.wallet_deposit_presets_irr),
    'allow_custom', p.wallet_deposit_allow_custom,
    'min_irr', p.wallet_deposit_min_irr,
    'max_irr', p.wallet_deposit_max_irr
  ) FROM public.billing_v2_policy p WHERE p.id;
$$;

REVOKE ALL ON FUNCTION public.billing_v2_wallet_deposit_config() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_v2_wallet_deposit_config() TO service_role;