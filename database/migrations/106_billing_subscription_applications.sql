-- ============================================================
-- 106 — DURABLE SUBSCRIPTION APPLICATION IDEMPOTENCY
--
-- Before this migration the only replay guard for "this payment intent already
-- produced a subscription period" was
--   workspace_subscriptions.metadata.last_payment_intent_id
-- which remembers ONLY the most recent intent. That made this interleaving
-- possible:
--
--   intent A verified -> period applied -> crash before the payment row
--   intent B verified -> period applied -> metadata.last_payment_intent_id = B
--   intent A recovered -> marker no longer mentions A -> A applied a SECOND time
--
-- The customer paid twice but received three periods.
--
-- Fix: a durable, append-only application ledger keyed UNIQUE by payment
-- intent, written in the SAME transaction as the subscription mutation by the
-- RPC below. It is impossible for the subscription row to move without an
-- application row existing, and impossible for one intent to move it twice.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.billing_subscription_applications (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_intent_id UUID NOT NULL,
  workspace_id      UUID NOT NULL,
  plan_id           TEXT,
  action_type       TEXT NOT NULL,
  billing_interval  TEXT NOT NULL,
  period_start      TIMESTAMPTZ NOT NULL,
  period_end        TIMESTAMPTZ NOT NULL,
  stacked           BOOLEAN NOT NULL DEFAULT false,
  provider_name     TEXT,
  applied_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The idempotency key. One payment intent can never apply twice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_subscription_applications_intent
  ON public.billing_subscription_applications (payment_intent_id);

CREATE INDEX IF NOT EXISTS ix_billing_subscription_applications_workspace
  ON public.billing_subscription_applications (workspace_id, applied_at DESC);

-- Financial ledger: never exposed through the Data API. Only the server
-- (service role) reads or writes it.
GRANT ALL ON public.billing_subscription_applications TO service_role;
ALTER TABLE public.billing_subscription_applications ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'billing_subscription_applications'
      AND policyname = 'service_role_only'
  ) THEN
    CREATE POLICY service_role_only
      ON public.billing_subscription_applications
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

-- ============================================================
-- RPC — apply a verified payment to a workspace subscription, atomically.
--
--   * locks the workspace subscription row (FOR UPDATE), so two concurrent
--     finalizations cannot both stack from the same current_period_end;
--   * returns the ORIGINAL result when this intent was already applied;
--   * classifies the action (plan_new / plan_renewal / plan_upgrade /
--     plan_downgrade) from billing_plans.sort_order;
--   * computes a calendar-safe window with native interval arithmetic
--     (2024-01-31 + 1 month = 2024-02-29, never 2024-03-02);
--   * same-plan renewal of a still-running active period STACKS, so early
--     renewal never burns paid days;
--   * writes the application marker and the subscription in ONE transaction.
-- ============================================================
CREATE OR REPLACE FUNCTION public.billing_apply_subscription_payment(
  p_workspace_id      UUID,
  p_payment_intent_id UUID,
  p_plan_id           TEXT,
  p_interval          TEXT,
  p_provider_name     TEXT,
  p_now               TIMESTAMPTZ DEFAULT now()
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing        public.billing_subscription_applications%ROWTYPE;
  v_sub             RECORD;
  v_next_rank       INT;
  v_current_rank    INT;
  v_plan_name       TEXT;
  v_action          TEXT;
  v_start           TIMESTAMPTZ;
  v_end             TIMESTAMPTZ;
  v_stacked         BOOLEAN := false;
  v_step            INTERVAL;
BEGIN
  IF p_interval NOT IN ('monthly', 'yearly') THEN
    RAISE EXCEPTION 'invalid_billing_interval:%', p_interval;
  END IF;
  v_step := CASE WHEN p_interval = 'yearly' THEN INTERVAL '1 year' ELSE INTERVAL '1 month' END;

  -- Durable replay guard: same intent, same answer, no second period.
  SELECT * INTO v_existing
    FROM public.billing_subscription_applications
   WHERE payment_intent_id = p_payment_intent_id;

  IF FOUND THEN
    SELECT name INTO v_plan_name FROM public.billing_plans WHERE id = v_existing.plan_id;
    RETURN jsonb_build_object(
      'alreadyApplied', true,
      'actionType',     v_existing.action_type,
      'planId',         v_existing.plan_id,
      'planName',       v_plan_name,
      'interval',       v_existing.billing_interval,
      'periodStart',    v_existing.period_start,
      'periodEnd',      v_existing.period_end,
      'stacked',        v_existing.stacked
    );
  END IF;

  -- Serialize concurrent finalizations for this workspace.
  SELECT plan_id, status, current_period_end
    INTO v_sub
    FROM public.workspace_subscriptions
   WHERE workspace_id = p_workspace_id
   FOR UPDATE;

  SELECT sort_order, name INTO v_next_rank, v_plan_name
    FROM public.billing_plans WHERE id = p_plan_id;

  IF v_sub.plan_id IS NOT NULL THEN
    SELECT sort_order INTO v_current_rank FROM public.billing_plans WHERE id = v_sub.plan_id;
  END IF;

  IF v_sub.plan_id IS NULL THEN
    v_action := 'plan_new';
  ELSIF v_sub.plan_id = p_plan_id THEN
    v_action := CASE WHEN v_sub.status IN ('active', 'trialing') THEN 'plan_renewal' ELSE 'plan_new' END;
  ELSIF v_current_rank IS NOT NULL AND v_next_rank IS NOT NULL AND v_next_rank < v_current_rank THEN
    v_action := 'plan_downgrade';
  ELSIF v_current_rank IS NOT NULL AND v_next_rank IS NOT NULL AND v_next_rank > v_current_rank THEN
    v_action := 'plan_upgrade';
  ELSE
    v_action := 'plan_new';
  END IF;

  IF v_action = 'plan_renewal'
     AND v_sub.current_period_end IS NOT NULL
     AND v_sub.current_period_end > p_now THEN
    v_start   := v_sub.current_period_end;   -- early renewal keeps paid days
    v_stacked := true;
  ELSE
    v_start := p_now;
  END IF;
  v_end := v_start + v_step;

  -- Marker + subscription commit together. A crash rolls both back; a success
  -- makes a second application of this intent impossible (UNIQUE index).
  INSERT INTO public.billing_subscription_applications (
    payment_intent_id, workspace_id, plan_id, action_type, billing_interval,
    period_start, period_end, stacked, provider_name
  ) VALUES (
    p_payment_intent_id, p_workspace_id, p_plan_id, v_action, p_interval,
    v_start, v_end, v_stacked, p_provider_name
  );

  INSERT INTO public.workspace_subscriptions AS ws (
    workspace_id, provider_name, status, plan_id, billing_interval,
    cancel_at_period_end, current_period_start, current_period_end, metadata, updated_at
  ) VALUES (
    p_workspace_id, p_provider_name, 'active', p_plan_id, p_interval,
    false, v_start, v_end,
    jsonb_build_object(
      'last_payment_intent_id', p_payment_intent_id::text,
      'last_action_type',       v_action,
      'last_period_start',      v_start,
      'last_period_end',        v_end,
      'last_period_stacked',    v_stacked
    ),
    now()
  )
  ON CONFLICT (workspace_id) DO UPDATE SET
    provider_name        = EXCLUDED.provider_name,
    status               = 'active',
    plan_id              = EXCLUDED.plan_id,
    billing_interval     = EXCLUDED.billing_interval,
    cancel_at_period_end = false,
    current_period_start = EXCLUDED.current_period_start,
    current_period_end   = EXCLUDED.current_period_end,
    metadata             = COALESCE(ws.metadata, '{}'::jsonb) || EXCLUDED.metadata,
    updated_at           = now();

  RETURN jsonb_build_object(
    'alreadyApplied', false,
    'actionType',     v_action,
    'planId',         p_plan_id,
    'planName',       v_plan_name,
    'interval',       p_interval,
    'periodStart',    v_start,
    'periodEnd',      v_end,
    'stacked',        v_stacked
  );
END;
$$;

REVOKE ALL ON FUNCTION public.billing_apply_subscription_payment(UUID, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_apply_subscription_payment(UUID, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ) TO service_role;
