-- ============================================================================
-- BILLING ENGINE V2 — PHASE D0
-- Period-bound entitlement cycles & monthly AI allowance for annual plans.
--
-- Forward-only. Migrations 113–118 are frozen and are NOT edited by this file.
--
-- CANONICAL MODEL (two related but independent concepts)
--
--   Service Period   (billing_subscription_periods)
--     The window the customer PAID for. A yearly plan buys one service period
--     of twelve months.
--
--   Entitlement Cycle (billing_entitlement_cycles, this migration)
--     The window a recurring entitlement — today: the plan AI allowance — is
--     granted for and expires with. A yearly service period contains twelve
--     monthly entitlement cycles, anchored on the period start (never on the
--     calendar month, never on a 30-day approximation).
--
-- GRANT AUTHORITY after this migration:
--     billing_entitlement_cycles.ai_allowance_irr, keyed
--     plan_allowance_cycle:<cycle_id>.
--   billing_subscription_periods.ai_allowance_irr stays for compatibility and
--   for the legacy handover, but it is NO LONGER the grantable amount of a
--   cycle-governed period. billing_period_allowance_grants keeps exactly one
--   meaning: the pre-D0 (and legacy handover) period-level grant. A DB guard
--   forbids new period-keyed grants once a period has cycles.
--
-- INVARIANTS PROVEN BY THE TESTS
--   * Annual plan: 12 cycles, ONE month of allowance at a time — never 12×.
--   * Worker downtime never creates retroactive spendable allowance: expired
--     cycles complete without a grant; only the current cycle is funded.
--   * Exactly one grant per cycle under replay and concurrency.
--   * Purchased AI credit is untouched by cycle boundaries.
-- ============================================================================

-- ─── 1. Entitlement cycles ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.billing_entitlement_cycles (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id           UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  subscription_id        UUID NOT NULL,
  subscription_period_id UUID NOT NULL REFERENCES public.billing_subscription_periods(id) ON DELETE CASCADE,

  cycle_index            INTEGER NOT NULL,
  cycle_start            TIMESTAMPTZ NOT NULL,
  cycle_end              TIMESTAMPTZ NOT NULL,

  status                 TEXT NOT NULL DEFAULT 'scheduled',

  -- The grantable amount for THIS cycle, frozen from the service period's
  -- immutable snapshot at creation time. A later super-admin plan edit can
  -- never change it.
  ai_allowance_irr       BIGINT NOT NULL DEFAULT 0,

  -- Durable, exactly-once grant marker (no second table: one authority, no
  -- semantic ambiguity).
  allowance_state        TEXT NOT NULL DEFAULT 'pending',
  allowance_lot_id       UUID,
  allowance_granted_at   TIMESTAMPTZ,
  attempt_count          INTEGER NOT NULL DEFAULT 0,
  next_attempt_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error             TEXT,

  activated_at           TIMESTAMPTZ,
  completed_at           TIMESTAMPTZ,

  billing_engine_version TEXT NOT NULL DEFAULT 'v2',
  snapshot               JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT billing_entitlement_cycles_status_check
    CHECK (status IN ('scheduled', 'active', 'completed', 'canceled')),
  CONSTRAINT billing_entitlement_cycles_allowance_state_check
    CHECK (allowance_state IN ('pending', 'granted', 'skipped', 'failed')),
  CONSTRAINT billing_entitlement_cycles_engine_check
    CHECK (billing_engine_version IN ('v1', 'v2')),
  CONSTRAINT billing_entitlement_cycles_window_check
    CHECK (cycle_end > cycle_start),
  CONSTRAINT uq_billing_entitlement_cycles_index
    UNIQUE (subscription_period_id, cycle_index),
  CONSTRAINT uq_billing_entitlement_cycles_start
    UNIQUE (subscription_period_id, cycle_start)
);

CREATE INDEX IF NOT EXISTS ix_billing_entitlement_cycles_due
  ON public.billing_entitlement_cycles (cycle_start)
  WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS ix_billing_entitlement_cycles_workspace
  ON public.billing_entitlement_cycles (workspace_id, cycle_start DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_entitlement_cycles_active_ws
  ON public.billing_entitlement_cycles (workspace_id)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS ix_billing_entitlement_cycles_grant_retry
  ON public.billing_entitlement_cycles (next_attempt_at)
  WHERE status = 'active' AND allowance_state IN ('pending', 'failed');

GRANT ALL ON public.billing_entitlement_cycles TO service_role;
ALTER TABLE public.billing_entitlement_cycles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_entitlement_cycles_service_only ON public.billing_entitlement_cycles;
CREATE POLICY billing_entitlement_cycles_service_only ON public.billing_entitlement_cycles
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.billing_entitlement_cycles IS
  'Entitlement cycle: the window a recurring entitlement (plan AI allowance) is granted for. A yearly service period holds twelve monthly cycles; the allowance is granted one cycle at a time, keyed plan_allowance_cycle:<cycle_id>, and expires at cycle_end.';
COMMENT ON COLUMN public.billing_entitlement_cycles.ai_allowance_irr IS
  'Grant authority for the plan AI allowance. Frozen from the service period snapshot at creation; immutable afterwards.';

-- Financial/entitlement immutability: a created cycle may only move through
-- its lifecycle. Its window, index, parentage and amount never change.
CREATE OR REPLACE FUNCTION public.billing_entitlement_cycle_freeze()
RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.subscription_period_id IS DISTINCT FROM OLD.subscription_period_id
     OR NEW.subscription_id IS DISTINCT FROM OLD.subscription_id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.cycle_index IS DISTINCT FROM OLD.cycle_index
     OR NEW.cycle_start IS DISTINCT FROM OLD.cycle_start
     OR NEW.cycle_end IS DISTINCT FROM OLD.cycle_end
     OR NEW.ai_allowance_irr IS DISTINCT FROM OLD.ai_allowance_irr
     OR NEW.snapshot IS DISTINCT FROM OLD.snapshot
     OR NEW.billing_engine_version IS DISTINCT FROM OLD.billing_engine_version THEN
    RAISE EXCEPTION 'billing_entitlement_cycle_immutable:%', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_billing_entitlement_cycle_freeze ON public.billing_entitlement_cycles;
CREATE TRIGGER trg_billing_entitlement_cycle_freeze
  BEFORE UPDATE ON public.billing_entitlement_cycles
  FOR EACH ROW EXECUTE FUNCTION public.billing_entitlement_cycle_freeze();

-- The cycle worker needs its own job type.
ALTER TABLE public.billing_v2_jobs DROP CONSTRAINT IF EXISTS billing_v2_jobs_type_check;
ALTER TABLE public.billing_v2_jobs ADD CONSTRAINT billing_v2_jobs_type_check
  CHECK (job_type IN ('renewal_invoice', 'wallet_autopay', 'period_activation',
                      'free_period', 'entitlement_cycle'));

-- ─── 2. Cycle planning ─────────────────────────────────────────────────────
/**
 * Monthly plan AI allowance of a service period, read from the period's
 * IMMUTABLE snapshot (never from the live plan row).
 */
CREATE OR REPLACE FUNCTION public.billing_v2_period_monthly_allowance(
  p_period public.billing_subscription_periods
) RETURNS BIGINT
LANGUAGE sql IMMUTABLE
AS $$
  SELECT GREATEST(ROUND(COALESCE(
           (p_period.limits_snapshot->>'ai_credits_per_month')::numeric,
           -- Pre-D0 fallback: a monthly period's total IS its monthly amount.
           CASE WHEN COALESCE(p_period.billing_interval, 'monthly') = 'monthly'
                THEN p_period.ai_allowance_irr ELSE p_period.ai_allowance_irr / 12.0 END,
           0))::numeric, 0)::bigint;
$$;

/**
 * Does this service period own its allowance through entitlement cycles?
 *
 * Legacy handover (Phase A/B invariant): a period that already received a
 * period-level grant, or that exists only to represent legacy state, keeps its
 * old ownership. Cycles are still recorded for it — so the read model and the
 * UI have one shape — but they never grant, so no month is funded twice.
 */
CREATE OR REPLACE FUNCTION public.billing_v2_period_cycles_grant(p_period_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path = public, pg_temp
AS $$
  SELECT NOT (
    EXISTS (SELECT 1 FROM public.billing_period_allowance_grants g
             WHERE g.period_id = p_period_id AND g.status = 'granted')
    OR EXISTS (SELECT 1 FROM public.billing_subscription_periods p
                WHERE p.id = p_period_id AND p.source = 'legacy_migration')
  );
$$;

/**
 * Creates the entitlement cycles of a service period, idempotently.
 *
 *  monthly period  → exactly ONE cycle spanning the period
 *  yearly period   → twelve monthly cycles, anchored on the period start and
 *                    stepped with the canonical calendar-safe primitive
 *                    (31 Jan → 28/29 Feb → 31 Mar …). No 30-day math.
 *
 * Immediate upgrade: the new period starts mid-cycle. Its first cycle is the
 * REMAINDER of the cycle the customer is living in, funded with the prorated
 * allowance DELTA only (the old plan already funded that month), and the grid
 * continues on the original anchor so future cycles carry the target plan's
 * full monthly allowance.
 */
CREATE OR REPLACE FUNCTION public.billing_v2_ensure_period_cycles(p_period_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_period   public.billing_subscription_periods;
  v_prev     public.billing_entitlement_cycles;
  v_monthly  BIGINT;
  v_grants   BOOLEAN;
  v_start    TIMESTAMPTZ;
  v_end      TIMESTAMPTZ;
  v_anchor   TIMESTAMPTZ;
  v_idx      INTEGER := 0;
  v_created  INTEGER := 0;
  v_amount   BIGINT;
  v_prev_m   BIGINT := 0;
  v_frac     NUMERIC;
  v_kind     TEXT;
BEGIN
  SELECT * INTO v_period FROM public.billing_subscription_periods
   WHERE id = p_period_id FOR UPDATE;
  IF v_period.id IS NULL THEN RAISE EXCEPTION 'unknown_period:%', p_period_id; END IF;
  IF v_period.status = 'canceled' THEN
    RETURN jsonb_build_object('period_id', p_period_id, 'skipped', 'period_canceled');
  END IF;

  v_monthly := public.billing_v2_period_monthly_allowance(v_period);
  v_grants  := public.billing_v2_period_cycles_grant(p_period_id);

  -- Mid-cycle start (immediate upgrade): reuse the live cycle's boundary as
  -- the grid anchor so the customer's AI month keeps its original rhythm.
  SELECT * INTO v_prev FROM public.billing_entitlement_cycles
   WHERE workspace_id = v_period.workspace_id
     AND subscription_period_id <> v_period.id
     AND cycle_start <= v_period.period_start
     AND cycle_end   >  v_period.period_start
   ORDER BY cycle_start DESC LIMIT 1;

  v_start := v_period.period_start;
  IF v_prev.id IS NOT NULL AND v_prev.cycle_end < v_period.period_end THEN
    v_anchor := v_prev.cycle_end;
    v_prev_m := COALESCE((v_prev.snapshot->>'monthly_allowance_irr')::bigint, v_prev.ai_allowance_irr);
  ELSE
    v_anchor := public.billing_v2_add_interval(v_start, 'monthly', 1);
  END IF;

  LOOP
    v_end := LEAST(v_anchor, v_period.period_end);
    EXIT WHEN v_end <= v_start;

    IF v_idx = 0 AND v_prev.id IS NOT NULL THEN
      -- Prorated DELTA for the remainder of the running cycle. Never negative:
      -- an upgrade tops up, it never claws back what was already granted.
      v_frac := GREATEST(EXTRACT(EPOCH FROM (v_end - v_start)), 0)
                / NULLIF(EXTRACT(EPOCH FROM (v_prev.cycle_end - v_prev.cycle_start)), 0);
      v_amount := GREATEST(ROUND(GREATEST(v_monthly - v_prev_m, 0) * COALESCE(v_frac, 0))::bigint, 0);
      v_kind := 'prorated_upgrade_delta';
    ELSE
      v_amount := v_monthly;
      v_kind := 'full_monthly';
    END IF;

    INSERT INTO public.billing_entitlement_cycles (
      workspace_id, subscription_id, subscription_period_id, cycle_index,
      cycle_start, cycle_end, status, ai_allowance_irr, allowance_state, snapshot
    ) VALUES (
      v_period.workspace_id, v_period.subscription_id, v_period.id, v_idx,
      v_start, v_end, 'scheduled',
      CASE WHEN v_grants THEN v_amount ELSE 0 END,
      CASE WHEN v_grants AND v_amount > 0 THEN 'pending' ELSE 'skipped' END,
      jsonb_build_object(
        'kind', v_kind,
        'monthly_allowance_irr', v_monthly,
        'plan_id', v_period.plan_id,
        'billing_interval', v_period.billing_interval,
        'limits_snapshot', COALESCE(v_period.limits_snapshot, '{}'::jsonb),
        'period_source', v_period.source,
        'grant_authority', CASE WHEN v_grants THEN 'entitlement_cycle' ELSE 'legacy_period' END
      )
    )
    ON CONFLICT (subscription_period_id, cycle_index) DO NOTHING;

    IF FOUND THEN v_created := v_created + 1; END IF;

    v_start  := v_end;
    v_anchor := public.billing_v2_add_interval(v_anchor, 'monthly', 1);
    v_idx    := v_idx + 1;
    EXIT WHEN v_start >= v_period.period_end OR v_idx > 24;  -- hard bound
  END LOOP;

  RETURN jsonb_build_object(
    'period_id', p_period_id, 'created', v_created, 'cycles', v_idx,
    'monthly_allowance_irr', v_monthly, 'grants', v_grants
  );
END;
$$;

-- ─── 3. Cycle allowance grant — exactly once ───────────────────────────────
CREATE OR REPLACE FUNCTION public.billing_v2_grant_cycle_allowance(p_cycle_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_cycle public.billing_entitlement_cycles;
  v_lot   UUID;
BEGIN
  SELECT * INTO v_cycle FROM public.billing_entitlement_cycles
   WHERE id = p_cycle_id FOR UPDATE;
  IF v_cycle.id IS NULL THEN RAISE EXCEPTION 'unknown_entitlement_cycle:%', p_cycle_id; END IF;

  IF v_cycle.allowance_state = 'granted' THEN
    INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
    VALUES (v_cycle.workspace_id, 'plan_allowance_grant_replayed', 'already_granted',
            jsonb_build_object('cycle_id', v_cycle.id, 'lot_id', v_cycle.allowance_lot_id));
    RETURN jsonb_build_object('cycle_id', v_cycle.id, 'lot_id', v_cycle.allowance_lot_id, 'replayed', true);
  END IF;

  IF v_cycle.status <> 'active' THEN
    RETURN jsonb_build_object('cycle_id', v_cycle.id, 'skipped', 'cycle_not_active');
  END IF;
  -- Downtime invariant: an already-expired cycle is never funded afterwards.
  IF v_cycle.cycle_end <= now() THEN
    UPDATE public.billing_entitlement_cycles
       SET allowance_state = 'skipped', last_error = 'cycle_expired'
     WHERE id = v_cycle.id;
    RETURN jsonb_build_object('cycle_id', v_cycle.id, 'skipped', 'cycle_expired');
  END IF;
  IF v_cycle.ai_allowance_irr <= 0 THEN
    UPDATE public.billing_entitlement_cycles
       SET allowance_state = 'skipped', allowance_granted_at = now()
     WHERE id = v_cycle.id;
    RETURN jsonb_build_object('cycle_id', v_cycle.id, 'skipped', 'no_allowance');
  END IF;

  BEGIN
    v_lot := public.ai_grant_allowance(
      v_cycle.workspace_id,
      v_cycle.ai_allowance_irr::numeric,
      'cycle:' || v_cycle.id::text,            -- billing_cycle_id (lot identity)
      'plan',
      v_cycle.cycle_end,                        -- expires with the cycle: no carry-over
      'plan_allowance_cycle:' || v_cycle.id::text
    );
  EXCEPTION WHEN OTHERS THEN
    UPDATE public.billing_entitlement_cycles
       SET allowance_state = 'failed', attempt_count = attempt_count + 1,
           last_error = left(SQLERRM, 500), next_attempt_at = now() + interval '5 minutes'
     WHERE id = v_cycle.id;
    RAISE;
  END;

  UPDATE public.billing_entitlement_cycles
     SET allowance_state = 'granted', allowance_lot_id = v_lot,
         allowance_granted_at = now(), attempt_count = attempt_count + 1, last_error = NULL
   WHERE id = v_cycle.id;

  -- Auditability of the lot's origin (source_type is PLAN_ALLOWANCE).
  UPDATE public.workspace_ai_balance_lots
     SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
           'source_reference_type', 'ENTITLEMENT_CYCLE',
           'source_reference_id', v_cycle.id,
           'subscription_period_id', v_cycle.subscription_period_id)
   WHERE id = v_lot
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'workspace_ai_balance_lots'
                    AND column_name = 'metadata');

  INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
  VALUES (v_cycle.workspace_id, 'plan_allowance_granted', 'entitlement_cycle',
          jsonb_build_object('cycle_id', v_cycle.id, 'lot_id', v_lot,
                             'period_id', v_cycle.subscription_period_id,
                             'cycle_index', v_cycle.cycle_index,
                             'allowance_irr', v_cycle.ai_allowance_irr,
                             'expires_at', v_cycle.cycle_end));

  RETURN jsonb_build_object('cycle_id', v_cycle.id, 'lot_id', v_lot,
                            'allowance_irr', v_cycle.ai_allowance_irr, 'replayed', false);
END;
$$;

-- ─── 4. Cycle lifecycle ────────────────────────────────────────────────────
/**
 * Brings a service period's cycles to the state `now` demands:
 *   * cycles that ended        → completed (NEVER funded retroactively)
 *   * the cycle containing now → active, funded exactly once
 *   * cycles in the future     → left scheduled, zero grant
 *
 * A worker that was down for two months therefore funds ONLY the current
 * cycle: allowance never stacks.
 */
CREATE OR REPLACE FUNCTION public.billing_v2_sync_period_cycles(p_period_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_period  public.billing_subscription_periods;
  v_cycle   public.billing_entitlement_cycles;
  v_grant   JSONB := NULL;
  v_expired INTEGER := 0;
BEGIN
  SELECT * INTO v_period FROM public.billing_subscription_periods WHERE id = p_period_id;
  IF v_period.id IS NULL THEN RAISE EXCEPTION 'unknown_period:%', p_period_id; END IF;
  IF v_period.status <> 'active' THEN
    RETURN jsonb_build_object('period_id', p_period_id, 'skipped', 'period_not_active');
  END IF;

  PERFORM public.billing_v2_ensure_period_cycles(p_period_id);

  -- Close everything that is over — in this period and in any earlier one.
  WITH closed AS (
    UPDATE public.billing_entitlement_cycles
       SET status = 'completed', completed_at = COALESCE(completed_at, now()),
           allowance_state = CASE WHEN allowance_state IN ('pending', 'failed')
                                  THEN 'skipped' ELSE allowance_state END
     WHERE workspace_id = v_period.workspace_id
       AND status IN ('scheduled', 'active')
       AND cycle_end <= now()
    RETURNING 1)
  SELECT count(*) INTO v_expired FROM closed;

  -- Cycles of superseded periods stop when their period does.
  UPDATE public.billing_entitlement_cycles
     SET status = 'completed', completed_at = now(),
         allowance_state = CASE WHEN allowance_state IN ('pending', 'failed')
                                THEN 'skipped' ELSE allowance_state END
   WHERE workspace_id = v_period.workspace_id
     AND subscription_period_id <> v_period.id
     AND status = 'active';

  -- The one cycle that is live right now.
  SELECT * INTO v_cycle FROM public.billing_entitlement_cycles
   WHERE subscription_period_id = v_period.id
     AND cycle_start <= now() AND cycle_end > now()
     AND status IN ('scheduled', 'active')
   ORDER BY cycle_index
   LIMIT 1;

  IF v_cycle.id IS NULL THEN
    RETURN jsonb_build_object('period_id', p_period_id, 'expired_cycles', v_expired,
                              'active_cycle_id', NULL);
  END IF;

  IF v_cycle.status = 'scheduled' THEN
    UPDATE public.billing_entitlement_cycles
       SET status = 'active', activated_at = now()
     WHERE id = v_cycle.id;
    INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
    VALUES (v_cycle.workspace_id, 'entitlement_cycle_activated', v_period.source,
            jsonb_build_object('cycle_id', v_cycle.id, 'period_id', v_period.id,
                               'cycle_index', v_cycle.cycle_index,
                               'cycle_start', v_cycle.cycle_start, 'cycle_end', v_cycle.cycle_end));
  END IF;

  v_grant := public.billing_v2_grant_cycle_allowance(v_cycle.id);

  RETURN jsonb_build_object('period_id', p_period_id, 'active_cycle_id', v_cycle.id,
                            'expired_cycles', v_expired, 'grant', v_grant);
END;
$$;

-- ─── 5. Period activation now delegates the allowance to the cycle ─────────
CREATE OR REPLACE FUNCTION public.billing_activate_period(p_period_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_period    public.billing_subscription_periods;
  v_inv       public.billing_invoices;
  v_prev_src  TEXT;
  v_sync      JSONB;
  v_retired   INTEGER := 0;
BEGIN
  SELECT * INTO v_period FROM public.billing_subscription_periods
   WHERE id = p_period_id FOR UPDATE;
  IF v_period.id IS NULL THEN
    RAISE EXCEPTION 'unknown_period:%', p_period_id;
  END IF;
  IF v_period.status = 'active' THEN
    v_sync := public.billing_v2_sync_period_cycles(v_period.id);
    RETURN jsonb_build_object('period_id', v_period.id, 'replayed', true, 'cycles', v_sync);
  END IF;
  IF v_period.status <> 'scheduled' THEN
    RAISE EXCEPTION 'period_not_activatable:%:%', v_period.id, v_period.status;
  END IF;

  -- Money first: an invoice-backed period is service the customer paid for.
  IF v_period.invoice_id IS NOT NULL THEN
    SELECT * INTO v_inv FROM public.billing_invoices WHERE id = v_period.invoice_id;
    IF v_inv.status <> 'paid' THEN
      RAISE EXCEPTION 'period_invoice_not_paid:%:%', v_period.id, v_inv.status;
    END IF;
  END IF;

  PERFORM 1 FROM public.workspace_subscriptions
   WHERE workspace_id = v_period.workspace_id FOR UPDATE;

  SELECT source INTO v_prev_src FROM public.billing_subscription_periods
   WHERE workspace_id = v_period.workspace_id AND status = 'active' AND id <> v_period.id
   LIMIT 1;

  UPDATE public.billing_subscription_periods
     SET status = 'completed', completed_at = now()
   WHERE workspace_id = v_period.workspace_id
     AND status = 'active'
     AND id <> v_period.id;

  UPDATE public.billing_subscription_periods
     SET status = 'active', activated_at = now()
   WHERE id = v_period.id;

  IF v_period.source = 'invoice' THEN
    v_retired := public.billing_retire_legacy_allowance(v_period.workspace_id);
  END IF;

  UPDATE public.workspace_subscriptions
     SET plan_id              = COALESCE(v_period.plan_id, plan_id),
         status               = 'active',
         current_period_id    = v_period.id,
         current_period_start = v_period.period_start,
         current_period_end   = v_period.period_end,
         billing_interval     = v_period.billing_interval,
         next_invoice_at      = GREATEST(COALESCE(next_invoice_at, v_period.period_end), v_period.period_end),
         past_due_since       = NULL,
         grace_period_ends_at = NULL,
         free_fallback_at     = NULL,
         pending_change_type  = NULL,
         next_plan_id         = NULL,
         billing_engine_version = 'v2',
         billing_v2_effective_at = CASE
           WHEN v_period.source = 'invoice' THEN COALESCE(billing_v2_effective_at, now())
           ELSE billing_v2_effective_at END,
         v2_allowance_effective_period_id = CASE
           WHEN v_period.source = 'invoice'
             THEN COALESCE(v2_allowance_effective_period_id, v_period.id)
           ELSE v2_allowance_effective_period_id END,
         updated_at           = now()
   WHERE workspace_id = v_period.workspace_id;

  -- D0: the AI allowance belongs to the entitlement cycle, not to the period.
  -- The period-level ledger row is closed out as 'skipped' so there is exactly
  -- one authority and no ambiguity.
  INSERT INTO public.billing_period_allowance_grants (period_id, workspace_id, allowance_irr, status, granted_at)
  VALUES (v_period.id, v_period.workspace_id, v_period.ai_allowance_irr, 'skipped', now())
  ON CONFLICT (period_id) DO NOTHING;

  v_sync := public.billing_v2_sync_period_cycles(v_period.id);

  INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
  VALUES (v_period.workspace_id, 'period_activated', v_period.source,
          jsonb_build_object('period_id', v_period.id, 'invoice_id', v_period.invoice_id,
                             'period_start', v_period.period_start,
                             'period_end', v_period.period_end,
                             'active_cycle_id', v_sync->>'active_cycle_id'));

  RETURN jsonb_build_object(
    'period_id', v_period.id,
    'lot_id', (v_sync->'grant'->>'lot_id')::uuid,
    'active_cycle_id', (v_sync->>'active_cycle_id')::uuid,
    'allowance_irr', COALESCE((v_sync->'grant'->>'allowance_irr')::bigint, 0),
    'previous_period_source', v_prev_src,
    'legacy_lots_retired', v_retired,
    'cycles', v_sync,
    'replayed', false
  );
END;
$$;

/**
 * Phase C entry point, kept for the worker and for recovery. After D0 it is a
 * delegation: the period no longer grants anything itself.
 */
CREATE OR REPLACE FUNCTION public.billing_v2_apply_period_allowance(p_period_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_period public.billing_subscription_periods;
  v_sync   JSONB;
BEGIN
  SELECT * INTO v_period FROM public.billing_subscription_periods WHERE id = p_period_id;
  IF v_period.id IS NULL THEN RAISE EXCEPTION 'unknown_period:%', p_period_id; END IF;
  IF v_period.status <> 'active' THEN
    RETURN jsonb_build_object('period_id', p_period_id, 'skipped', 'period_not_active');
  END IF;

  v_sync := public.billing_v2_sync_period_cycles(p_period_id);
  UPDATE public.billing_period_allowance_grants
     SET status = 'skipped', granted_at = COALESCE(granted_at, now()), last_error = NULL
   WHERE period_id = p_period_id AND status IN ('pending', 'failed');

  RETURN jsonb_build_object('period_id', p_period_id,
                            'lot_id', (v_sync->'grant'->>'lot_id')::uuid,
                            'cycle_id', (v_sync->>'active_cycle_id')::uuid,
                            'delegated_to', 'entitlement_cycle',
                            'replayed', COALESCE((v_sync->'grant'->>'replayed')::boolean, false));
END;
$$;

-- ─── 6. Guard: no new period-keyed grant once a period has cycles ──────────
CREATE OR REPLACE FUNCTION public.billing_v2_block_period_keyed_grant()
RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status = 'granted'
     AND COALESCE(OLD.status, '') <> 'granted'
     AND EXISTS (SELECT 1 FROM public.billing_entitlement_cycles c
                  WHERE c.subscription_period_id = NEW.period_id) THEN
    RAISE EXCEPTION 'billing_v2_period_keyed_grant_forbidden:%', NEW.period_id
      USING HINT = 'Grant the plan AI allowance through billing_entitlement_cycles (plan_allowance_cycle:<cycle_id>).';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_billing_v2_block_period_keyed_grant ON public.billing_period_allowance_grants;
CREATE TRIGGER trg_billing_v2_block_period_keyed_grant
  BEFORE INSERT OR UPDATE ON public.billing_period_allowance_grants
  FOR EACH ROW EXECUTE FUNCTION public.billing_v2_block_period_keyed_grant();

-- ─── 7. Worker D — entitlement cycles ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.billing_v2_run_entitlement_cycles(p_limit INTEGER DEFAULT 50)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  r         RECORD;
  j         public.billing_v2_jobs;
  v_res     JSONB;
  v_active  INTEGER := 0;
  v_skipped INTEGER := 0;
  v_failed  INTEGER := 0;
  v_last    TEXT;
BEGIN
  -- Every active service period that has a cycle boundary to cross, plus any
  -- active period whose current cycle never got funded (crash recovery).
  FOR r IN
    SELECT DISTINCT p.id, p.workspace_id
      FROM public.billing_subscription_periods p
     WHERE p.status = 'active'
       AND (
         NOT EXISTS (SELECT 1 FROM public.billing_entitlement_cycles c
                      WHERE c.subscription_period_id = p.id)
         OR EXISTS (SELECT 1 FROM public.billing_entitlement_cycles c
                     WHERE c.subscription_period_id = p.id
                       AND ((c.status = 'scheduled' AND c.cycle_start <= now())
                            OR (c.status = 'active' AND c.cycle_end <= now())
                            OR (c.status = 'active' AND c.allowance_state IN ('pending', 'failed')
                                AND c.next_attempt_at <= now())))
       )
     ORDER BY p.id
     LIMIT GREATEST(COALESCE(p_limit, 50), 1)
  LOOP
    PERFORM public.billing_v2_enqueue_job(
      'entitlement_cycle',
      r.id::text || ':' || to_char(date_trunc('minute', now()) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI'),
      r.workspace_id,
      jsonb_build_object('period_id', r.id)
    );
  END LOOP;

  FOR j IN SELECT * FROM public.billing_v2_claim_jobs('entitlement_cycle', p_limit, 120) LOOP
    BEGIN
      v_res := public.billing_v2_sync_period_cycles((j.payload->>'period_id')::uuid);
      IF v_res ? 'skipped' THEN v_skipped := v_skipped + 1; ELSE v_active := v_active + 1; END IF;
      PERFORM public.billing_v2_complete_job(j.id, v_res);
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      v_last := SQLERRM;
      PERFORM public.billing_v2_fail_job(j.id, SQLERRM);
      INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
      VALUES (j.workspace_id, 'entitlement_cycle_failed', left(SQLERRM, 200),
              jsonb_build_object('job_id', j.id, 'period_id', j.payload->>'period_id'));
    END;
  END LOOP;

  PERFORM public.billing_v2_note_worker_run('entitlement_cycle', v_active + v_skipped, v_failed, v_last);
  RETURN jsonb_build_object('synced', v_active, 'skipped', v_skipped, 'failed', v_failed);
END;
$$;

-- ─── 8. Read model (STRICTLY read-only: a GET never grants) ────────────────
CREATE OR REPLACE FUNCTION public.billing_v2_current_entitlement_cycle(p_workspace_id UUID)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    (SELECT jsonb_build_object(
              'cycle_id', c.id,
              'cycle_index', c.cycle_index,
              'start', c.cycle_start,
              'end', c.cycle_end,
              'allowance_irr', c.ai_allowance_irr,
              'allowance_state', c.allowance_state,
              'period_id', c.subscription_period_id,
              'lot_id', c.allowance_lot_id,
              'remaining_irr', COALESCE((
                SELECT SUM(l.remaining_amount)::bigint FROM public.workspace_ai_balance_lots l
                 WHERE l.id = c.allowance_lot_id), 0))
       FROM public.billing_entitlement_cycles c
      WHERE c.workspace_id = p_workspace_id
        AND c.cycle_start <= now() AND c.cycle_end > now()
        AND c.status IN ('active', 'scheduled')
      ORDER BY (c.status = 'active') DESC, c.cycle_start DESC
      LIMIT 1),
    'null'::jsonb);
$$;

CREATE OR REPLACE FUNCTION public.billing_v2_scheduler_health()
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'workers', COALESCE((SELECT jsonb_agg(to_jsonb(h)) FROM public.billing_v2_worker_health h), '[]'::jsonb),
    'due_invoices', (SELECT count(*) FROM public.billing_invoices
                      WHERE status IN ('open','partially_paid','past_due')
                        AND amount_due_irr > 0 AND due_at IS NOT NULL AND due_at <= now()),
    'scheduled_periods_pending', (SELECT count(*) FROM public.billing_subscription_periods
                                   WHERE status = 'scheduled' AND period_start <= now()),
    'unapplied_active_periods', (SELECT count(*) FROM public.billing_period_allowance_grants
                                  WHERE status IN ('pending','failed')),
    'due_entitlement_cycles', (SELECT count(*) FROM public.billing_entitlement_cycles
                                WHERE status = 'scheduled' AND cycle_start <= now() AND cycle_end > now()),
    'unfunded_active_cycles', (SELECT count(*) FROM public.billing_entitlement_cycles
                                WHERE status = 'active' AND allowance_state IN ('pending','failed')),
    'failed_jobs', (SELECT count(*) FROM public.billing_v2_jobs WHERE status = 'failed'),
    'checked_at', now()
  );
$$;

-- ─── 9. ACL ────────────────────────────────────────────────────────────────
DO $$
DECLARE f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.billing_v2_period_cycles_grant(uuid)',
    'public.billing_v2_ensure_period_cycles(uuid)',
    'public.billing_v2_grant_cycle_allowance(uuid)',
    'public.billing_v2_sync_period_cycles(uuid)',
    'public.billing_v2_run_entitlement_cycles(integer)',
    'public.billing_v2_current_entitlement_cycle(uuid)',
    'public.billing_v2_scheduler_health()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
    END IF;
  END LOOP;
END $$;
