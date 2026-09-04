-- ============================================================
-- BILLING ENGINE V2 — PHASE B: RUNTIME CUTOVER & AUTHORITY ISOLATION
-- ============================================================

-- ─── 1. Audit sink ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.billing_v2_audit (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID REFERENCES public.workspaces(id) ON DELETE CASCADE,
  event         TEXT NOT NULL,
  actor_id      UUID,
  reason        TEXT,
  details       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT ALL ON public.billing_v2_audit TO service_role;
ALTER TABLE public.billing_v2_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_v2_audit_service_only ON public.billing_v2_audit;
CREATE POLICY billing_v2_audit_service_only ON public.billing_v2_audit
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS ix_billing_v2_audit_workspace
  ON public.billing_v2_audit (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_billing_v2_audit_event
  ON public.billing_v2_audit (event, created_at DESC);

COMMENT ON TABLE public.billing_v2_audit IS
  'Rollout and authority-isolation audit trail: shadow enablement, cutover blocks, activations, replays, drained legacy intents and rejected legacy financial paths.';

-- ─── 2. Canonical per-workspace rollout state ─────────────────────────────
CREATE TABLE IF NOT EXISTS public.billing_v2_rollout (
  workspace_id      UUID PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE CASCADE,
  state             TEXT NOT NULL DEFAULT 'legacy',
  region            TEXT,
  shadow_enabled_at TIMESTAMPTZ,
  cutover_pending_at TIMESTAMPTZ,
  activated_at      TIMESTAMPTZ,
  activated_by      UUID,
  last_blockers     JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.billing_v2_rollout DROP CONSTRAINT IF EXISTS billing_v2_rollout_state_check;
ALTER TABLE public.billing_v2_rollout ADD CONSTRAINT billing_v2_rollout_state_check
  CHECK (state IN ('legacy', 'shadow', 'v2_cutover_pending', 'v2_active'));

GRANT ALL ON public.billing_v2_rollout TO service_role;
ALTER TABLE public.billing_v2_rollout ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_v2_rollout_service_only ON public.billing_v2_rollout;
CREATE POLICY billing_v2_rollout_service_only ON public.billing_v2_rollout
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.billing_v2_rollout IS
  'Server-authoritative billing engine rollout state per workspace. Never client-writable. legacy = V1 is authority; shadow = V1 authority, V2 computes only (no financial side effect); v2_cutover_pending = activation in preparation; v2_active = the invoice is the only commercial authority.';

-- ─── 3. Immutable engine stamp on financial objects ───────────────────────
ALTER TABLE public.billing_payment_intents
  ADD COLUMN IF NOT EXISTS billing_engine_version TEXT NOT NULL DEFAULT 'v1';
ALTER TABLE public.billing_invoices
  ADD COLUMN IF NOT EXISTS billing_engine_version TEXT NOT NULL DEFAULT 'v2';
ALTER TABLE public.billing_wallet_deposits
  ADD COLUMN IF NOT EXISTS billing_engine_version TEXT NOT NULL DEFAULT 'v2';
ALTER TABLE public.billing_subscription_periods
  ADD COLUMN IF NOT EXISTS billing_engine_version TEXT NOT NULL DEFAULT 'v2';

UPDATE public.billing_subscription_periods
   SET billing_engine_version = 'v1'
 WHERE source = 'legacy_migration' AND billing_engine_version <> 'v1';

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'billing_payment_intents', 'billing_invoices',
    'billing_wallet_deposits', 'billing_subscription_periods'
  ] LOOP
    EXECUTE format(
      'ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I',
      t, t || '_engine_version_check');
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (billing_engine_version IN (''v1'',''v2''))',
      t, t || '_engine_version_check');
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.billing_engine_version_freeze()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.billing_engine_version IS DISTINCT FROM OLD.billing_engine_version THEN
    RAISE EXCEPTION 'billing_engine_version_immutable:%:%',
      TG_TABLE_NAME, OLD.billing_engine_version;
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'billing_payment_intents', 'billing_invoices',
    'billing_wallet_deposits', 'billing_subscription_periods'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_engine_freeze ON public.%I', t, t);
    EXECUTE format(
      'CREATE TRIGGER trg_%s_engine_freeze BEFORE UPDATE ON public.%I
         FOR EACH ROW EXECUTE FUNCTION public.billing_engine_version_freeze()', t, t);
  END LOOP;
END $$;

-- ─── 4. Rollout state reader ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.billing_v2_state(p_workspace_id UUID)
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    (SELECT state FROM public.billing_v2_rollout WHERE workspace_id = p_workspace_id),
    'legacy');
$$;

-- ─── 5. DB-LEVEL GUARD: no direct legacy subscription mutation ────────────
CREATE OR REPLACE FUNCTION public.billing_v2_block_direct_subscription_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_consistent BOOLEAN;
BEGIN
  IF public.billing_v2_state(NEW.workspace_id) <> 'v2_active' THEN
    RETURN NEW;
  END IF;

  IF NEW.plan_id IS NOT DISTINCT FROM OLD.plan_id
     AND NEW.current_period_start IS NOT DISTINCT FROM OLD.current_period_start
     AND NEW.current_period_end IS NOT DISTINCT FROM OLD.current_period_end
     AND NEW.billing_interval IS NOT DISTINCT FROM OLD.billing_interval THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.billing_subscription_periods p
     WHERE p.id = NEW.current_period_id
       AND p.workspace_id = NEW.workspace_id
       AND p.status = 'active'
       AND p.period_start = NEW.current_period_start
       AND p.period_end   = NEW.current_period_end
       AND COALESCE(p.plan_id, NEW.plan_id) IS NOT DISTINCT FROM NEW.plan_id
  ) INTO v_consistent;

  IF NOT v_consistent THEN
    INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
    VALUES (NEW.workspace_id, 'billing_v2_legacy_path_rejected',
            'direct_subscription_mutation',
            jsonb_build_object(
              'old_plan_id', OLD.plan_id, 'new_plan_id', NEW.plan_id,
              'old_period_end', OLD.current_period_end,
              'new_period_end', NEW.current_period_end));
    RAISE EXCEPTION 'billing_v2_direct_subscription_mutation_forbidden:%', NEW.workspace_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_billing_v2_block_direct_subscription
  ON public.workspace_subscriptions;
CREATE TRIGGER trg_billing_v2_block_direct_subscription
  BEFORE UPDATE ON public.workspace_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.billing_v2_block_direct_subscription_mutation();

-- ─── 6. DB-LEVEL GUARD: no legacy calendar AI allowance after handover ────
CREATE OR REPLACE FUNCTION public.billing_v2_block_legacy_allowance_grant()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_owned BOOLEAN;
BEGIN
  IF NEW.source_type <> 'PLAN_ALLOWANCE' THEN RETURN NEW; END IF;
  IF NEW.billing_cycle_id LIKE 'period:%' THEN RETURN NEW; END IF;

  SELECT (v2_allowance_effective_period_id IS NOT NULL) INTO v_owned
    FROM public.workspace_subscriptions
   WHERE workspace_id = NEW.workspace_id;

  IF COALESCE(v_owned, false) THEN
    INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
    VALUES (NEW.workspace_id, 'billing_v2_legacy_path_rejected',
            'legacy_calendar_allowance_grant',
            jsonb_build_object('billing_cycle_id', NEW.billing_cycle_id));
    RAISE EXCEPTION 'billing_v2_legacy_allowance_grant_forbidden:%', NEW.workspace_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_billing_v2_block_legacy_allowance
  ON public.workspace_ai_balance_lots;
CREATE TRIGGER trg_billing_v2_block_legacy_allowance
  BEFORE INSERT ON public.workspace_ai_balance_lots
  FOR EACH ROW EXECUTE FUNCTION public.billing_v2_block_legacy_allowance_grant();

-- ─── 7. Readiness evaluator (fail closed) ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.billing_v2_evaluate_cutover(p_workspace_id UUID)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_sub            public.workspace_subscriptions;
  v_blockers       JSONB := '[]'::jsonb;
  v_classification TEXT  := 'paid_active';
  v_plan_free      BOOLEAN := false;
  v_count          INTEGER;
  v_unbound        INTEGER := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.workspaces WHERE id = p_workspace_id) THEN
    RETURN jsonb_build_object('ready', false, 'blockers',
      jsonb_build_array(jsonb_build_object('code', 'unknown_workspace')));
  END IF;

  SELECT * INTO v_sub FROM public.workspace_subscriptions
   WHERE workspace_id = p_workspace_id;

  IF v_sub.workspace_id IS NULL THEN
    v_classification := 'free_no_subscription';
  ELSE
    SELECT COALESCE(is_free, false) INTO v_plan_free
      FROM public.billing_plans WHERE id = v_sub.plan_id;
    v_plan_free := COALESCE(v_plan_free, true);

    IF v_sub.status = 'trialing' THEN
      v_classification := 'trial';
    ELSIF v_plan_free THEN
      v_classification := 'free';
    END IF;

    IF NOT v_plan_free
       AND v_sub.current_period_end IS NOT NULL
       AND v_sub.current_period_end < now() THEN
      v_classification := 'expired_paid_period';
      v_blockers := v_blockers || jsonb_build_object(
        'code', 'subscription_period_expired',
        'detail', v_sub.current_period_end);
    END IF;

    IF v_sub.pending_change_type IS NOT NULL THEN
      v_blockers := v_blockers || jsonb_build_object(
        'code', 'pending_plan_change',
        'detail', v_sub.pending_change_type);
    END IF;

    IF NOT v_plan_free AND v_sub.status IN ('active', 'past_due')
       AND NOT EXISTS (
         SELECT 1 FROM public.billing_subscription_periods
          WHERE workspace_id = p_workspace_id AND status = 'active') THEN
      v_blockers := v_blockers || jsonb_build_object('code', 'missing_legacy_migration_period');
    END IF;

    IF v_sub.v2_allowance_effective_period_id IS NOT NULL
       AND public.billing_v2_state(p_workspace_id) <> 'v2_active' THEN
      v_blockers := v_blockers || jsonb_build_object('code', 'allowance_handover_inconsistent');
    END IF;
  END IF;

  SELECT count(*) INTO v_count FROM public.billing_payment_intents
   WHERE workspace_id = p_workspace_id
     AND billing_engine_version = 'v1'
     AND status = 'processing';
  IF v_count > 0 THEN
    v_blockers := v_blockers || jsonb_build_object('code', 'legacy_intent_processing', 'count', v_count);
  END IF;

  SELECT count(*) INTO v_count FROM public.billing_payment_intents
   WHERE workspace_id = p_workspace_id
     AND billing_engine_version = 'v1'
     AND status = 'pending'
     AND provider_ref IS NOT NULL;
  IF v_count > 0 THEN
    v_blockers := v_blockers || jsonb_build_object('code', 'legacy_intent_bound', 'count', v_count);
  END IF;

  SELECT count(*) INTO v_unbound FROM public.billing_payment_intents
   WHERE workspace_id = p_workspace_id
     AND billing_engine_version = 'v1'
     AND status = 'pending'
     AND provider_ref IS NULL;

  SELECT count(*) INTO v_count FROM public.billing_payments
   WHERE workspace_id = p_workspace_id AND reconciliation_state = 'unapplied';
  IF v_count > 0 THEN
    v_blockers := v_blockers || jsonb_build_object('code', 'unreconciled_payment', 'count', v_count);
  END IF;

  SELECT count(*) INTO v_count FROM public.billing_invoices i
   WHERE i.workspace_id = p_workspace_id
     AND (i.status = 'partially_paid'
          OR (i.status = 'paid' AND NOT EXISTS (
                SELECT 1 FROM public.billing_invoice_applications a
                 WHERE a.invoice_id = i.id AND a.application_status = 'applied')));
  IF v_count > 0 THEN
    v_blockers := v_blockers || jsonb_build_object('code', 'unapplied_invoice_effects', 'count', v_count);
  END IF;

  SELECT count(*) INTO v_count FROM public.billing_invoice_collections
   WHERE workspace_id = p_workspace_id AND status = 'active' AND expires_at > now();
  IF v_count > 0 THEN
    v_blockers := v_blockers || jsonb_build_object('code', 'gateway_collection_in_flight', 'count', v_count);
  END IF;

  RETURN jsonb_build_object(
    'ready', jsonb_array_length(v_blockers) = 0,
    'blockers', v_blockers,
    'classification', v_classification,
    'state', public.billing_v2_state(p_workspace_id),
    'drainable_unbound_intents', v_unbound,
    'wallet_account', EXISTS (
      SELECT 1 FROM public.billing_wallet_accounts WHERE workspace_id = p_workspace_id)
  );
END;
$$;

-- ─── 8. Monotonic state transition ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.billing_v2_set_state(
  p_workspace_id UUID,
  p_state        TEXT,
  p_actor_id     UUID  DEFAULT NULL,
  p_reason       TEXT  DEFAULT NULL,
  p_break_glass  BOOLEAN DEFAULT false
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_current TEXT;
  v_rank    JSONB := '{"legacy":0,"shadow":1,"v2_cutover_pending":2,"v2_active":3}'::jsonb;
BEGIN
  IF p_state NOT IN ('legacy', 'shadow', 'v2_cutover_pending', 'v2_active') THEN
    RAISE EXCEPTION 'billing_v2_unknown_state:%', p_state;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('billing_v2_rollout:' || p_workspace_id::text, 0));

  SELECT state INTO v_current FROM public.billing_v2_rollout
   WHERE workspace_id = p_workspace_id FOR UPDATE;
  v_current := COALESCE(v_current, 'legacy');

  IF v_current = p_state THEN
    RETURN jsonb_build_object('state', v_current, 'changed', false, 'replayed', true);
  END IF;

  IF (v_rank ->> p_state)::int < (v_rank ->> v_current)::int AND NOT p_break_glass THEN
    RAISE EXCEPTION 'billing_v2_rollback_forbidden:%:%', v_current, p_state;
  END IF;

  INSERT INTO public.billing_v2_rollout AS r (workspace_id, state, shadow_enabled_at,
                                              cutover_pending_at, activated_at, activated_by)
  VALUES (
    p_workspace_id, p_state,
    CASE WHEN p_state = 'shadow' THEN now() END,
    CASE WHEN p_state = 'v2_cutover_pending' THEN now() END,
    CASE WHEN p_state = 'v2_active' THEN now() END,
    CASE WHEN p_state = 'v2_active' THEN p_actor_id END)
  ON CONFLICT (workspace_id) DO UPDATE
     SET state = EXCLUDED.state,
         shadow_enabled_at  = COALESCE(r.shadow_enabled_at, EXCLUDED.shadow_enabled_at),
         cutover_pending_at = COALESCE(r.cutover_pending_at, EXCLUDED.cutover_pending_at),
         activated_at       = CASE WHEN EXCLUDED.state = 'v2_active'
                                   THEN COALESCE(r.activated_at, now()) ELSE r.activated_at END,
         activated_by       = COALESCE(EXCLUDED.activated_by, r.activated_by),
         updated_at         = now();

  INSERT INTO public.billing_v2_audit (workspace_id, event, actor_id, reason, details)
  VALUES (p_workspace_id,
          CASE WHEN p_state = 'shadow' THEN 'billing_v2_shadow_enabled'
               WHEN p_break_glass THEN 'billing_v2_break_glass_rollback'
               ELSE 'billing_v2_state_changed' END,
          p_actor_id, p_reason,
          jsonb_build_object('from', v_current, 'to', p_state, 'break_glass', p_break_glass));

  RETURN jsonb_build_object('state', p_state, 'changed', true, 'from', v_current);
END;
$$;

-- ─── 9. Atomic activation ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.billing_v2_activate(
  p_workspace_id UUID,
  p_actor_id     UUID DEFAULT NULL,
  p_reason       TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_state      TEXT;
  v_readiness  JSONB;
  v_sub        public.workspace_subscriptions;
  v_plan       public.billing_plans;
  v_period     UUID;
  v_drained    INTEGER := 0;
  v_created    BOOLEAN := false;
  v_allowance  BIGINT := 0;
  v_source     TEXT;
  v_interval   TEXT;
  v_start      TIMESTAMPTZ;
  v_end        TIMESTAMPTZ;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('billing_v2_rollout:' || p_workspace_id::text, 0));

  SELECT state INTO v_state FROM public.billing_v2_rollout
   WHERE workspace_id = p_workspace_id FOR UPDATE;
  v_state := COALESCE(v_state, 'legacy');

  IF v_state = 'v2_active' THEN
    INSERT INTO public.billing_v2_audit (workspace_id, event, actor_id, reason)
    VALUES (p_workspace_id, 'billing_v2_activation_replayed', p_actor_id, p_reason);
    RETURN jsonb_build_object('state', 'v2_active', 'activated', false, 'replayed', true);
  END IF;

  SELECT * INTO v_sub FROM public.workspace_subscriptions
   WHERE workspace_id = p_workspace_id FOR UPDATE;

  v_readiness := public.billing_v2_evaluate_cutover(p_workspace_id);
  IF NOT (v_readiness ->> 'ready')::boolean THEN
    INSERT INTO public.billing_v2_audit (workspace_id, event, actor_id, reason, details)
    VALUES (p_workspace_id, 'billing_v2_cutover_blocked', p_actor_id, p_reason, v_readiness);
    RAISE EXCEPTION 'billing_v2_cutover_blocked:%', v_readiness::text;
  END IF;

  WITH drained AS (
    UPDATE public.billing_payment_intents
       SET status = 'canceled',
           failure_reason = 'billing_v2_cutover_drain',
           updated_at = now()
     WHERE workspace_id = p_workspace_id
       AND billing_engine_version = 'v1'
       AND status = 'pending'
       AND provider_ref IS NULL
     RETURNING id)
  SELECT count(*) INTO v_drained FROM drained;

  IF v_drained > 0 THEN
    INSERT INTO public.billing_v2_audit (workspace_id, event, actor_id, reason, details)
    VALUES (p_workspace_id, 'billing_v2_legacy_intent_drained', p_actor_id, p_reason,
            jsonb_build_object('canceled_unbound_intents', v_drained));
  END IF;

  INSERT INTO public.billing_wallet_accounts (workspace_id)
  VALUES (p_workspace_id) ON CONFLICT (workspace_id) DO NOTHING;

  SELECT id INTO v_period FROM public.billing_subscription_periods
   WHERE workspace_id = p_workspace_id AND status = 'active' LIMIT 1;

  IF v_period IS NULL THEN
    SELECT * INTO v_plan FROM public.billing_plans
     WHERE id = v_sub.plan_id;
    IF v_plan.id IS NULL THEN
      SELECT * INTO v_plan FROM public.billing_plans
       WHERE is_free = true AND is_active = true ORDER BY sort_order LIMIT 1;
    END IF;

    v_source   := CASE WHEN COALESCE(v_sub.status, '') = 'trialing' THEN 'trial' ELSE 'free_plan' END;
    v_interval := COALESCE(v_sub.billing_interval, 'monthly');
    v_start    := COALESCE(
                    CASE WHEN v_source = 'trial' THEN v_sub.trial_start ELSE NULL END,
                    v_sub.current_period_start, now());
    v_end      := COALESCE(
                    CASE WHEN v_source = 'trial' THEN v_sub.trial_end ELSE NULL END,
                    NULLIF(GREATEST(COALESCE(v_sub.current_period_end, now()), now() + interval '1 second'), NULL));
    IF v_end <= now() OR v_source = 'free_plan' THEN
      v_start := now();
      v_end   := now() + interval '1 month';
    END IF;

    v_allowance := GREATEST(COALESCE(
      (v_plan.limits ->> 'included_ai_allowance_irr')::BIGINT,
      (v_plan.limits ->> 'ai_credits_per_month')::BIGINT, 0), 0);

    INSERT INTO public.billing_subscription_periods (
      workspace_id, subscription_id, plan_id, invoice_id, billing_interval,
      period_start, period_end, status, source,
      plan_snapshot, limits_snapshot, ai_allowance_irr, billing_engine_version)
    VALUES (
      p_workspace_id, v_sub.id, v_plan.id, NULL, v_interval,
      v_start, v_end, 'scheduled', v_source,
      COALESCE(to_jsonb(v_plan), '{}'::jsonb), COALESCE(v_plan.limits, '{}'::jsonb),
      v_allowance, 'v2')
    RETURNING id INTO v_period;

    PERFORM public.billing_activate_period(v_period);
    v_created := true;
  END IF;

  PERFORM public.billing_v2_set_state(p_workspace_id, 'v2_active', p_actor_id, p_reason);

  UPDATE public.billing_v2_rollout
     SET last_blockers = '[]'::jsonb, updated_at = now()
   WHERE workspace_id = p_workspace_id;

  INSERT INTO public.billing_v2_audit (workspace_id, event, actor_id, reason, details)
  VALUES (p_workspace_id, 'billing_v2_activated', p_actor_id, p_reason,
          jsonb_build_object(
            'from_state', v_state,
            'classification', v_readiness ->> 'classification',
            'period_id', v_period,
            'period_created', v_created,
            'drained_unbound_intents', v_drained));

  RETURN jsonb_build_object(
    'state', 'v2_active', 'activated', true, 'replayed', false,
    'from_state', v_state,
    'period_id', v_period, 'period_created', v_created,
    'drained_unbound_intents', v_drained,
    'classification', v_readiness ->> 'classification');
END;
$$;

-- ─── 10. ACL: rollout authority is server-only ────────────────────────────
DO $$
DECLARE fn TEXT;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure::text
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN (
         'billing_v2_state', 'billing_v2_evaluate_cutover',
         'billing_v2_set_state', 'billing_v2_activate')
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