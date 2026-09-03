CREATE TABLE IF NOT EXISTS public.billing_subscription_applications (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_intent_id UUID NOT NULL REFERENCES public.billing_payment_intents(id) ON DELETE CASCADE,
  workspace_id      UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  plan_id           UUID REFERENCES public.billing_plans(id),
  action_type       TEXT NOT NULL,
  billing_interval  TEXT NOT NULL,
  period_start      TIMESTAMPTZ NOT NULL,
  period_end        TIMESTAMPTZ NOT NULL,
  stacked           BOOLEAN NOT NULL DEFAULT false,
  provider_name     TEXT,
  applied_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_subscription_applications_intent
  ON public.billing_subscription_applications (payment_intent_id);

CREATE INDEX IF NOT EXISTS ix_billing_subscription_applications_workspace
  ON public.billing_subscription_applications (workspace_id, applied_at DESC);

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

DROP FUNCTION IF EXISTS public.billing_apply_subscription_payment(UUID, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ);

CREATE OR REPLACE FUNCTION public.billing_apply_subscription_payment(
  p_workspace_id      UUID,
  p_payment_intent_id UUID,
  p_plan_id           UUID,
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
  v_locked          BOOLEAN := false;
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

  SELECT plan_id, status, current_period_end
    INTO v_sub
    FROM public.workspace_subscriptions
   WHERE workspace_id = p_workspace_id
   FOR UPDATE;
  v_locked := FOUND;

  IF NOT v_locked THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id::text, 0));
    SELECT plan_id, status, current_period_end
      INTO v_sub
      FROM public.workspace_subscriptions
     WHERE workspace_id = p_workspace_id
     FOR UPDATE;
  END IF;

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
    v_start   := v_sub.current_period_end;
    v_stacked := true;
  ELSE
    v_start := p_now;
  END IF;
  v_end := v_start + v_step;

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

EXCEPTION
  WHEN unique_violation THEN
    SELECT * INTO v_existing
      FROM public.billing_subscription_applications
     WHERE payment_intent_id = p_payment_intent_id;
    IF NOT FOUND THEN
      RAISE;
    END IF;
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
END;
$$;

REVOKE ALL ON FUNCTION public.billing_apply_subscription_payment(UUID, UUID, UUID, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_apply_subscription_payment(UUID, UUID, UUID, TEXT, TEXT, TIMESTAMPTZ) TO service_role;