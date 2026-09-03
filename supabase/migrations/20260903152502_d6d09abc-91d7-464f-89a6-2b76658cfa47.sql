CREATE TABLE IF NOT EXISTS public.billing_payment_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  purchase_type text NOT NULL CHECK (purchase_type IN ('subscription', 'ai_credit_topup')),
  plan_id uuid REFERENCES public.billing_plans(id),
  billing_interval text CHECK (billing_interval IN ('monthly', 'yearly')),
  provider_name text NOT NULL,
  amount_irr bigint NOT NULL CHECK (amount_irr > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed', 'expired', 'canceled')),
  provider_ref text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 minutes'),
  succeeded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_payment_intents_subscription_shape
    CHECK (
      (purchase_type = 'subscription' AND plan_id IS NOT NULL AND billing_interval IS NOT NULL)
      OR
      (purchase_type = 'ai_credit_topup' AND plan_id IS NULL AND billing_interval IS NULL)
    )
);

GRANT SELECT ON public.billing_payment_intents TO authenticated;
GRANT ALL ON public.billing_payment_intents TO service_role;

CREATE INDEX IF NOT EXISTS idx_billing_payment_intents_workspace ON public.billing_payment_intents(workspace_id);
CREATE INDEX IF NOT EXISTS idx_billing_payment_intents_status ON public.billing_payment_intents(status);

ALTER TABLE public.billing_payment_intents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Workspace admins can view own payment intents" ON public.billing_payment_intents;
CREATE POLICY "Workspace admins can view own payment intents" ON public.billing_payment_intents
  FOR SELECT TO authenticated
  USING (public.get_workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin'));

DROP POLICY IF EXISTS "Global admins can view all payment intents" ON public.billing_payment_intents;
CREATE POLICY "Global admins can view all payment intents" ON public.billing_payment_intents
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER update_billing_payment_intents_updated_at
  BEFORE UPDATE ON public.billing_payment_intents
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON TABLE public.billing_payment_intents IS
  'Server-created, tamper-proof record of what a checkout is FOR (plan/interval or AI credit top-up) and the exact amount_irr charged, created before the provider redirect.';