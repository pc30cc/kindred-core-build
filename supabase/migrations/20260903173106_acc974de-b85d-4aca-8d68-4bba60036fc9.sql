-- Iran billing hardening — payment intent state machine + customer-facing
-- payment records.

-- ─── 1. Payment intents: processing state + purchase action ───────────────
ALTER TABLE public.billing_payment_intents
  DROP CONSTRAINT IF EXISTS billing_payment_intents_status_check;

ALTER TABLE public.billing_payment_intents
  ADD CONSTRAINT billing_payment_intents_status_check
  CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'expired', 'canceled'));

ALTER TABLE public.billing_payment_intents
  ADD COLUMN IF NOT EXISTS action_type text,
  ADD COLUMN IF NOT EXISTS processing_at timestamptz,
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS failure_reason text;

ALTER TABLE public.billing_payment_intents
  DROP CONSTRAINT IF EXISTS billing_payment_intents_action_type_check;

ALTER TABLE public.billing_payment_intents
  ADD CONSTRAINT billing_payment_intents_action_type_check
  CHECK (action_type IS NULL OR action_type IN (
    'plan_new', 'plan_renewal', 'plan_upgrade', 'plan_downgrade', 'ai_credit_topup'
  ));

COMMENT ON COLUMN public.billing_payment_intents.action_type IS
  'What this checkout is FOR, recorded at creation time: plan_new / plan_renewal / plan_upgrade / plan_downgrade / ai_credit_topup. Snapshotted onto billing_payments so history never has to guess from the current plan.';
COMMENT ON COLUMN public.billing_payment_intents.processing_at IS
  'Set when the intent is atomically claimed (pending -> processing) after the gateway verified the payment but BEFORE the financial side effect is applied. A row stuck here is recoverable: the side effects are idempotent and a retry can safely re-run them.';

-- ─── 2. billing_payments: customer-facing financial transactions ──────────
ALTER TABLE public.billing_payments
  ALTER COLUMN amount TYPE bigint,
  ALTER COLUMN refund_amount TYPE bigint;

ALTER TABLE public.billing_payments
  ADD COLUMN IF NOT EXISTS payment_intent_id uuid REFERENCES public.billing_payment_intents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS purchase_type text,
  ADD COLUMN IF NOT EXISTS action_type text,
  ADD COLUMN IF NOT EXISTS plan_id uuid REFERENCES public.billing_plans(id),
  ADD COLUMN IF NOT EXISTS plan_name_snapshot text,
  ADD COLUMN IF NOT EXISTS billing_interval text,
  ADD COLUMN IF NOT EXISTS paid_at timestamptz;

ALTER TABLE public.billing_payments
  DROP CONSTRAINT IF EXISTS billing_payments_action_type_check;
ALTER TABLE public.billing_payments
  ADD CONSTRAINT billing_payments_action_type_check
  CHECK (action_type IS NULL OR action_type IN (
    'plan_new', 'plan_renewal', 'plan_upgrade', 'plan_downgrade', 'ai_credit_topup'
  ));

ALTER TABLE public.billing_payments
  DROP CONSTRAINT IF EXISTS billing_payments_billing_interval_check;
ALTER TABLE public.billing_payments
  ADD CONSTRAINT billing_payments_billing_interval_check
  CHECK (billing_interval IS NULL OR billing_interval IN ('monthly', 'yearly'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_payments_intent
  ON public.billing_payments(payment_intent_id)
  WHERE payment_intent_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_payments_provider_ref
  ON public.billing_payments(provider_name, provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_billing_payments_workspace_created
  ON public.billing_payments(workspace_id, created_at DESC);

COMMENT ON TABLE public.billing_payments IS
  'Customer-facing financial transactions (plan purchases/renewals/upgrades and AI credit top-ups). billing_events stays operational/audit only. Rows are replay-safe via uq_billing_payments_intent / uq_billing_payments_provider_ref and carry a snapshot of what was bought at the time of payment.';

-- ─── 3. Subscription knows the purchased interval ─────────────────────────
ALTER TABLE public.workspace_subscriptions
  ADD COLUMN IF NOT EXISTS billing_interval text;

ALTER TABLE public.workspace_subscriptions
  DROP CONSTRAINT IF EXISTS workspace_subscriptions_billing_interval_check;
ALTER TABLE public.workspace_subscriptions
  ADD CONSTRAINT workspace_subscriptions_billing_interval_check
  CHECK (billing_interval IS NULL OR billing_interval IN ('monthly', 'yearly'));

COMMENT ON COLUMN public.workspace_subscriptions.billing_interval IS
  'Interval actually purchased (monthly/yearly). The UI must price the plan with THIS interval instead of defaulting to the monthly price.';

-- ─── 4. Grants (unchanged privilege model, restated for clarity) ──────────
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT ALL ON public.billing_payments TO service_role;
    GRANT ALL ON public.billing_payment_intents TO service_role;
    GRANT ALL ON public.workspace_subscriptions TO service_role;
  END IF;
END $$;