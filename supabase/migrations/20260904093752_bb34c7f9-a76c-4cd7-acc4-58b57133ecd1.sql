-- ============================================================================
-- BILLING ENGINE V2 — PHASE C: schedulers
-- ============================================================================

-- ─── 1. Billing policy ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.billing_v2_policy (
  id                       BOOLEAN PRIMARY KEY DEFAULT true,
  invoice_lead_time_days   INTEGER NOT NULL DEFAULT 10,
  invoice_due_offset_days  INTEGER NOT NULL DEFAULT 0,
  wallet_auto_pay_default  BOOLEAN NOT NULL DEFAULT true,
  collection_ttl_seconds   INTEGER NOT NULL DEFAULT 300,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT billing_v2_policy_singleton CHECK (id),
  CONSTRAINT billing_v2_policy_sane CHECK (
    invoice_lead_time_days BETWEEN 0 AND 60
    AND invoice_due_offset_days BETWEEN -60 AND 60
    AND collection_ttl_seconds BETWEEN 30 AND 3600
  )
);

INSERT INTO public.billing_v2_policy (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

GRANT ALL ON public.billing_v2_policy TO service_role;
ALTER TABLE public.billing_v2_policy ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_v2_policy_service_only ON public.billing_v2_policy;
CREATE POLICY billing_v2_policy_service_only ON public.billing_v2_policy
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.billing_v2_policy IS
  'Canonical billing scheduling policy. The invoice lead time lives HERE and nowhere else — no module may hardcode 10 days.';

CREATE TABLE IF NOT EXISTS public.billing_v2_workspace_policy (
  workspace_id            UUID PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE CASCADE,
  invoice_lead_time_days  INTEGER,
  wallet_auto_pay_enabled BOOLEAN,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT billing_v2_workspace_policy_sane
    CHECK (invoice_lead_time_days IS NULL OR invoice_lead_time_days BETWEEN 0 AND 60)
);

GRANT ALL ON public.billing_v2_workspace_policy TO service_role;
ALTER TABLE public.billing_v2_workspace_policy ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_v2_workspace_policy_service_only ON public.billing_v2_workspace_policy;
CREATE POLICY billing_v2_workspace_policy_service_only ON public.billing_v2_workspace_policy
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.billing_v2_policy_for(p_workspace_id UUID)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_pol public.billing_v2_policy;
  v_ws  public.billing_v2_workspace_policy;
  v_wal BOOLEAN;
BEGIN
  SELECT * INTO v_pol FROM public.billing_v2_policy WHERE id;
  SELECT * INTO v_ws FROM public.billing_v2_workspace_policy WHERE workspace_id = p_workspace_id;
  SELECT auto_pay_enabled INTO v_wal FROM public.billing_wallet_accounts
   WHERE workspace_id = p_workspace_id;

  RETURN jsonb_build_object(
    'invoice_lead_time_days',
      COALESCE(v_ws.invoice_lead_time_days, v_pol.invoice_lead_time_days, 10),
    'invoice_due_offset_days', COALESCE(v_pol.invoice_due_offset_days, 0),
    'wallet_auto_pay',
      COALESCE(v_ws.wallet_auto_pay_enabled, v_wal, v_pol.wallet_auto_pay_default, true),
    'collection_ttl_seconds', COALESCE(v_pol.collection_ttl_seconds, 300)
  );
END;
$$;

-- ─── 2. Durable job substrate ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.billing_v2_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type        TEXT NOT NULL,
  dedupe_key      TEXT NOT NULL,
  workspace_id    UUID REFERENCES public.workspaces(id) ON DELETE CASCADE,
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  status          TEXT NOT NULL DEFAULT 'pending',
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 8,
  lease_until     TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error      TEXT,
  result          JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT billing_v2_jobs_type_check
    CHECK (job_type IN ('renewal_invoice', 'wallet_autopay', 'period_activation', 'free_period')),
  CONSTRAINT billing_v2_jobs_status_check
    CHECK (status IN ('pending', 'processing', 'succeeded', 'failed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_v2_jobs_dedupe
  ON public.billing_v2_jobs (job_type, dedupe_key);
CREATE INDEX IF NOT EXISTS ix_billing_v2_jobs_claimable
  ON public.billing_v2_jobs (job_type, next_attempt_at)
  WHERE status IN ('pending', 'processing');

GRANT ALL ON public.billing_v2_jobs TO service_role;
ALTER TABLE public.billing_v2_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_v2_jobs_service_only ON public.billing_v2_jobs;
CREATE POLICY billing_v2_jobs_service_only ON public.billing_v2_jobs
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.billing_v2_jobs IS
  'Durable work items for the V2 schedulers. A job survives a crash; a lease keeps a second instance from running the same item.';

CREATE OR REPLACE FUNCTION public.billing_v2_enqueue_job(
  p_job_type     TEXT,
  p_dedupe_key   TEXT,
  p_workspace_id UUID,
  p_payload      JSONB DEFAULT '{}'::jsonb
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_id UUID;
BEGIN
  INSERT INTO public.billing_v2_jobs (job_type, dedupe_key, workspace_id, payload)
  VALUES (p_job_type, p_dedupe_key, p_workspace_id, COALESCE(p_payload, '{}'::jsonb))
  ON CONFLICT (job_type, dedupe_key) DO UPDATE
    SET updated_at = now()
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_v2_claim_jobs(
  p_job_type      TEXT,
  p_limit         INTEGER DEFAULT 25,
  p_lease_seconds INTEGER DEFAULT 120
) RETURNS SETOF public.billing_v2_jobs
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  UPDATE public.billing_v2_jobs j
     SET status = 'processing',
         attempt_count = j.attempt_count + 1,
         lease_until = now() + make_interval(secs => GREATEST(COALESCE(p_lease_seconds, 120), 30)),
         updated_at = now()
   WHERE j.id IN (
     SELECT c.id FROM public.billing_v2_jobs c
      WHERE c.job_type = p_job_type
        AND c.status IN ('pending', 'processing')
        AND c.next_attempt_at <= now()
        AND (c.lease_until IS NULL OR c.lease_until <= now())
      ORDER BY c.next_attempt_at
      FOR UPDATE SKIP LOCKED
      LIMIT GREATEST(COALESCE(p_limit, 25), 1)
   )
  RETURNING j.*;
$$;

CREATE OR REPLACE FUNCTION public.billing_v2_complete_job(
  p_job_id UUID,
  p_result JSONB DEFAULT '{}'::jsonb
) RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  UPDATE public.billing_v2_jobs
     SET status = 'succeeded', lease_until = NULL, last_error = NULL,
         result = COALESCE(p_result, '{}'::jsonb), updated_at = now()
   WHERE id = p_job_id;
$$;

CREATE OR REPLACE FUNCTION public.billing_v2_fail_job(
  p_job_id UUID,
  p_error  TEXT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_job public.billing_v2_jobs;
BEGIN
  SELECT * INTO v_job FROM public.billing_v2_jobs WHERE id = p_job_id;
  IF v_job.id IS NULL THEN RETURN; END IF;

  UPDATE public.billing_v2_jobs
     SET status = CASE WHEN v_job.attempt_count >= v_job.max_attempts THEN 'failed' ELSE 'pending' END,
         lease_until = NULL,
         last_error = left(COALESCE(p_error, 'unknown'), 500),
         next_attempt_at = now() + LEAST(
           make_interval(mins => GREATEST(v_job.attempt_count, 1) * 5),
           interval '1 hour'
         ),
         updated_at = now()
   WHERE id = p_job_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_v2_defer_job(
  p_job_id UUID,
  p_reason TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  UPDATE public.billing_v2_jobs
     SET status = 'pending',
         attempt_count = GREATEST(attempt_count - 1, 0),
         lease_until = NULL,
         next_attempt_at = now(),
         last_error = left(p_reason, 500),
         updated_at = now()
   WHERE id = p_job_id;
$$;

CREATE TABLE IF NOT EXISTS public.billing_v2_worker_health (
  worker           TEXT PRIMARY KEY,
  last_run_at      TIMESTAMPTZ,
  last_success_at  TIMESTAMPTZ,
  last_failure_at  TIMESTAMPTZ,
  last_error       TEXT,
  last_batch_size  INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT ALL ON public.billing_v2_worker_health TO service_role;
ALTER TABLE public.billing_v2_worker_health ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_v2_worker_health_service_only ON public.billing_v2_worker_health;
CREATE POLICY billing_v2_worker_health_service_only ON public.billing_v2_worker_health
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.billing_v2_note_worker_run(
  p_worker   TEXT,
  p_batch    INTEGER,
  p_failures INTEGER,
  p_error    TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  INSERT INTO public.billing_v2_worker_health AS h (
    worker, last_run_at, last_success_at, last_failure_at, last_error,
    last_batch_size, consecutive_failures, updated_at
  ) VALUES (
    p_worker, now(),
    CASE WHEN COALESCE(p_failures, 0) = 0 THEN now() END,
    CASE WHEN COALESCE(p_failures, 0) > 0 THEN now() END,
    left(p_error, 500), COALESCE(p_batch, 0),
    CASE WHEN COALESCE(p_failures, 0) > 0 THEN 1 ELSE 0 END, now()
  )
  ON CONFLICT (worker) DO UPDATE SET
    last_run_at = now(),
    last_success_at = CASE WHEN COALESCE(p_failures, 0) = 0 THEN now() ELSE h.last_success_at END,
    last_failure_at = CASE WHEN COALESCE(p_failures, 0) > 0 THEN now() ELSE h.last_failure_at END,
    last_error = CASE WHEN COALESCE(p_failures, 0) > 0 THEN left(p_error, 500) ELSE NULL END,
    last_batch_size = COALESCE(p_batch, 0),
    consecutive_failures = CASE WHEN COALESCE(p_failures, 0) > 0
                                THEN h.consecutive_failures + 1 ELSE 0 END,
    updated_at = now();
$$;

-- ─── 3. Allowance application ledger ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.billing_period_allowance_grants (
  period_id       UUID PRIMARY KEY REFERENCES public.billing_subscription_periods(id) ON DELETE CASCADE,
  workspace_id    UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  allowance_irr   BIGINT NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending',
  lot_id          UUID,
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error      TEXT,
  granted_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT billing_period_allowance_status_check
    CHECK (status IN ('pending', 'granted', 'skipped', 'failed'))
);

CREATE INDEX IF NOT EXISTS ix_billing_period_allowance_pending
  ON public.billing_period_allowance_grants (next_attempt_at)
  WHERE status IN ('pending', 'failed');

GRANT ALL ON public.billing_period_allowance_grants TO service_role;
ALTER TABLE public.billing_period_allowance_grants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_period_allowance_service_only ON public.billing_period_allowance_grants;
CREATE POLICY billing_period_allowance_service_only ON public.billing_period_allowance_grants
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.billing_period_allowance_grants IS
  'One row per service period. The plan AI allowance is granted exactly once per period (command key plan_allowance:<period_id>) from the period''s IMMUTABLE snapshot, never from the live plan row.';

-- ─── 4. At most ONE scheduled (future) period per workspace ────────────────
CREATE OR REPLACE FUNCTION public.billing_v2_assert_single_scheduled_period()
RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE v_ws UUID; v_count INTEGER;
BEGIN
  v_ws := COALESCE(NEW.workspace_id, OLD.workspace_id);
  SELECT count(*) INTO v_count FROM public.billing_subscription_periods
   WHERE workspace_id = v_ws AND status = 'scheduled';
  IF v_count > 1 THEN
    RAISE EXCEPTION 'multiple_scheduled_periods:%:%', v_ws, v_count;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_billing_v2_single_scheduled_period ON public.billing_subscription_periods;
CREATE CONSTRAINT TRIGGER trg_billing_v2_single_scheduled_period
  AFTER INSERT OR UPDATE ON public.billing_subscription_periods
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.billing_v2_assert_single_scheduled_period();

-- ─── 5. Calendar-safe helpers and DB-side document numbers ─────────────────
CREATE OR REPLACE FUNCTION public.billing_v2_add_interval(
  p_ts       TIMESTAMPTZ,
  p_interval TEXT,
  p_count    INTEGER DEFAULT 1
) RETURNS TIMESTAMPTZ
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE WHEN p_interval = 'yearly'
              THEN p_ts + make_interval(years => GREATEST(COALESCE(p_count, 1), 1))
              ELSE p_ts + make_interval(months => GREATEST(COALESCE(p_count, 1), 1))
         END;
$$;

CREATE OR REPLACE FUNCTION public.billing_v2_document_number()
RETURNS TEXT
LANGUAGE plpgsql VOLATILE SET search_path = public, pg_temp
AS $$
DECLARE
  letters TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  out     TEXT := '';
  i       INTEGER;
BEGIN
  FOR i IN 1..2 LOOP
    out := out || substr(letters, 1 + (get_byte(gen_random_bytes(1), 0) % length(letters)), 1);
  END LOOP;
  FOR i IN 1..8 LOOP
    out := out || (get_byte(gen_random_bytes(1), 0) % 10)::text;
  END LOOP;
  RETURN out;
END;
$$;

-- ─── 6. Worker A — renewal invoice issuance ────────────────────────────────
CREATE OR REPLACE FUNCTION public.billing_v2_issue_renewal_invoice(
  p_workspace_id UUID,
  p_force        BOOLEAN DEFAULT false
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_sub       public.workspace_subscriptions;
  v_state     TEXT;
  v_policy    JSONB;
  v_lead      INTEGER;
  v_plan      public.billing_plans;
  v_target    UUID;
  v_interval  TEXT;
  v_start     TIMESTAMPTZ;
  v_end       TIMESTAMPTZ;
  v_price     BIGINT;
  v_allowance BIGINT;
  v_existing  public.billing_invoices;
  v_inv       public.billing_invoices;
  v_num       TEXT;
  v_tries     INTEGER := 0;
  v_snapshot  JSONB;
BEGIN
  SELECT * INTO v_sub FROM public.workspace_subscriptions
   WHERE workspace_id = p_workspace_id FOR UPDATE;
  IF v_sub.id IS NULL THEN
    RETURN jsonb_build_object('skipped', 'no_subscription');
  END IF;

  SELECT state INTO v_state FROM public.billing_v2_rollout WHERE workspace_id = p_workspace_id;
  IF COALESCE(v_state, 'legacy') <> 'v2_active' THEN
    RETURN jsonb_build_object('skipped', 'not_v2_active');
  END IF;

  IF v_sub.status = 'trialing' THEN
    RETURN jsonb_build_object('skipped', 'trial');
  END IF;
  IF v_sub.status NOT IN ('active', 'past_due') THEN
    RETURN jsonb_build_object('skipped', 'subscription_status:' || v_sub.status);
  END IF;
  IF v_sub.cancel_at_period_end OR v_sub.pending_change_type = 'cancel' THEN
    RETURN jsonb_build_object('skipped', 'canceling');
  END IF;

  v_target := CASE
    WHEN v_sub.pending_change_type IN ('upgrade', 'downgrade') AND v_sub.next_plan_id IS NOT NULL
      THEN v_sub.next_plan_id
    ELSE v_sub.plan_id END;
  IF v_target IS NULL THEN
    RETURN jsonb_build_object('skipped', 'no_plan');
  END IF;

  SELECT * INTO v_plan FROM public.billing_plans WHERE id = v_target;
  IF v_plan.id IS NULL THEN
    RETURN jsonb_build_object('skipped', 'unknown_plan');
  END IF;

  v_interval := COALESCE(v_sub.billing_interval, 'monthly');
  v_start := COALESCE(v_sub.next_invoice_at, v_sub.current_period_end);
  IF v_start IS NULL THEN
    RETURN jsonb_build_object('skipped', 'no_anchor');
  END IF;
  v_end := public.billing_v2_add_interval(v_start, v_interval, 1);

  v_price := GREATEST(ROUND(COALESCE(
    (v_plan.prices->'IRR'->>v_interval)::numeric, 0))::bigint, 0);

  IF v_price = 0 THEN
    RETURN public.billing_v2_ensure_free_period(p_workspace_id);
  END IF;

  v_policy := public.billing_v2_policy_for(p_workspace_id);
  v_lead := (v_policy->>'invoice_lead_time_days')::int;
  IF NOT p_force AND now() < v_start - make_interval(days => v_lead) THEN
    RETURN jsonb_build_object('skipped', 'not_yet_eligible', 'eligible_at', v_start - make_interval(days => v_lead));
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.billing_subscription_periods
     WHERE workspace_id = p_workspace_id
       AND status IN ('scheduled', 'active')
       AND period_start = v_start
  ) THEN
    RETURN jsonb_build_object('skipped', 'period_exists');
  END IF;

  SELECT * INTO v_existing FROM public.billing_invoices
   WHERE subscription_id = v_sub.id
     AND invoice_type = 'subscription_renewal'
     AND period_start = v_start
     AND status NOT IN ('void', 'expired')
   ORDER BY created_at DESC LIMIT 1;

  IF v_existing.id IS NOT NULL THEN
    IF v_existing.status = 'paid'
       OR v_existing.amount_paid_irr > 0
       OR COALESCE((v_existing.effect_snapshot->>'target_plan_id')::uuid, v_existing.plan_id) = v_target
    THEN
      INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
      VALUES (p_workspace_id, 'renewal_invoice_issue_replayed', 'already_issued',
              jsonb_build_object('invoice_id', v_existing.id, 'period_start', v_start));
      RETURN jsonb_build_object('invoice_id', v_existing.id, 'replayed', true);
    END IF;

    IF EXISTS (SELECT 1 FROM public.billing_invoice_collections
                WHERE invoice_id = v_existing.id AND status = 'active') THEN
      RETURN jsonb_build_object('skipped', 'collection_active', 'invoice_id', v_existing.id);
    END IF;
    UPDATE public.billing_invoices
       SET status = 'void', voided_at = now(),
           metadata = metadata || jsonb_build_object('void_reason', 'plan_change_before_payment')
     WHERE id = v_existing.id;
    INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
    VALUES (p_workspace_id, 'renewal_invoice_voided', 'plan_change_before_payment',
            jsonb_build_object('invoice_id', v_existing.id));
  END IF;

  v_allowance := GREATEST(ROUND(COALESCE((v_plan.limits->>'ai_credits_per_month')::numeric, 0))::bigint, 0);
  IF v_interval = 'yearly' THEN
    v_allowance := v_allowance * 12;
  END IF;

  v_snapshot := jsonb_build_object(
    'action_type', CASE WHEN v_target = v_sub.plan_id THEN 'plan_renewal'
                        WHEN v_sub.pending_change_type = 'upgrade' THEN 'plan_upgrade'
                        ELSE 'plan_downgrade' END,
    'source_plan_id', v_sub.plan_id,
    'target_plan_id', v_target,
    'billing_interval', v_interval,
    'effective_at', v_start,
    'period_start', v_start,
    'period_end', v_end,
    'plan_snapshot', to_jsonb(v_plan),
    'limits_snapshot', COALESCE(v_plan.limits, '{}'::jsonb),
    'ai_allowance_irr', v_allowance,
    'proration', NULL
  );

  LOOP
    v_tries := v_tries + 1;
    v_num := public.billing_v2_document_number();
    BEGIN
      INSERT INTO public.billing_invoices (
        workspace_id, subscription_id, invoice_number, invoice_type, status,
        subtotal_irr, total_irr, amount_due_irr,
        plan_id, plan_name_snapshot, billing_interval,
        period_start, period_end, effect_snapshot, due_at, metadata
      ) VALUES (
        p_workspace_id, v_sub.id, v_num, 'subscription_renewal', 'draft',
        v_price, v_price, v_price,
        v_target, v_plan.name, v_interval,
        v_start, v_end, v_snapshot,
        v_start + make_interval(days => (v_policy->>'invoice_due_offset_days')::int),
        jsonb_build_object('source', 'renewal_scheduler')
      )
      RETURNING * INTO v_inv;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      IF v_tries >= 5 THEN RAISE; END IF;
    END;
  END LOOP;

  INSERT INTO public.billing_invoice_lines (
    invoice_id, line_type, description, quantity, unit_amount_irr, amount_irr, plan_id, sort_order
  ) VALUES (
    v_inv.id, 'plan',
    v_plan.name || ' — ' || CASE WHEN v_interval = 'yearly' THEN 'سالانه' ELSE 'ماهانه' END,
    1, v_price, v_price, v_target, 0
  );

  UPDATE public.billing_invoices
     SET status = 'open', issued_at = now()
   WHERE id = v_inv.id AND status = 'draft'
  RETURNING * INTO v_inv;

  UPDATE public.workspace_subscriptions
     SET next_invoice_at = v_end, updated_at = now()
   WHERE id = v_sub.id;

  INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
  VALUES (p_workspace_id, 'renewal_invoice_issued', 'scheduler',
          jsonb_build_object('invoice_id', v_inv.id, 'period_start', v_start,
                             'period_end', v_end, 'plan_id', v_target,
                             'interval', v_interval, 'amount_irr', v_price));

  RETURN jsonb_build_object(
    'invoice_id', v_inv.id, 'period_start', v_start, 'period_end', v_end,
    'amount_irr', v_price, 'replayed', false
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_v2_ensure_free_period(p_workspace_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_sub    public.workspace_subscriptions;
  v_plan   public.billing_plans;
  v_start  TIMESTAMPTZ;
  v_end    TIMESTAMPTZ;
  v_period public.billing_subscription_periods;
  v_allow  BIGINT;
BEGIN
  SELECT * INTO v_sub FROM public.workspace_subscriptions
   WHERE workspace_id = p_workspace_id FOR UPDATE;
  IF v_sub.id IS NULL OR v_sub.plan_id IS NULL THEN
    RETURN jsonb_build_object('skipped', 'no_subscription');
  END IF;

  SELECT * INTO v_plan FROM public.billing_plans WHERE id = v_sub.plan_id;
  IF v_plan.id IS NULL THEN RETURN jsonb_build_object('skipped', 'unknown_plan'); END IF;

  v_start := COALESCE(v_sub.next_invoice_at, v_sub.current_period_end, now());
  IF v_start > now() THEN
    RETURN jsonb_build_object('skipped', 'not_yet_due', 'next_at', v_start);
  END IF;
  v_end := public.billing_v2_add_interval(v_start, COALESCE(v_sub.billing_interval, 'monthly'), 1);

  IF EXISTS (SELECT 1 FROM public.billing_subscription_periods
              WHERE workspace_id = p_workspace_id
                AND status IN ('scheduled', 'active')
                AND period_start = v_start) THEN
    RETURN jsonb_build_object('skipped', 'period_exists');
  END IF;

  v_allow := GREATEST(ROUND(COALESCE((v_plan.limits->>'ai_credits_per_month')::numeric, 0))::bigint, 0);

  INSERT INTO public.billing_subscription_periods (
    workspace_id, subscription_id, plan_id, invoice_id, billing_interval,
    period_start, period_end, status, source, plan_snapshot, limits_snapshot, ai_allowance_irr
  ) VALUES (
    p_workspace_id, v_sub.id, v_plan.id, NULL, COALESCE(v_sub.billing_interval, 'monthly'),
    v_start, v_end, 'scheduled', 'free_plan',
    to_jsonb(v_plan), COALESCE(v_plan.limits, '{}'::jsonb), v_allow
  ) RETURNING * INTO v_period;

  UPDATE public.workspace_subscriptions
     SET next_invoice_at = v_end, updated_at = now() WHERE id = v_sub.id;

  PERFORM public.billing_activate_period(v_period.id);

  INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
  VALUES (p_workspace_id, 'free_period_activated', 'scheduler',
          jsonb_build_object('period_id', v_period.id, 'period_start', v_start, 'period_end', v_end));

  RETURN jsonb_build_object('period_id', v_period.id, 'free', true, 'replayed', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_v2_run_invoice_scheduler(p_limit INTEGER DEFAULT 50)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  r        RECORD;
  j        public.billing_v2_jobs;
  v_res    JSONB;
  v_issued INTEGER := 0;
  v_skipped INTEGER := 0;
  v_failed INTEGER := 0;
  v_last   TEXT;
BEGIN
  FOR r IN
    SELECT s.workspace_id, s.id AS sub_id, COALESCE(s.next_invoice_at, s.current_period_end) AS anchor
      FROM public.workspace_subscriptions s
      JOIN public.billing_v2_rollout ro ON ro.workspace_id = s.workspace_id AND ro.state = 'v2_active'
     WHERE s.status IN ('active', 'past_due')
       AND COALESCE(s.next_invoice_at, s.current_period_end) IS NOT NULL
       AND COALESCE(s.next_invoice_at, s.current_period_end)
           - make_interval(days => (public.billing_v2_policy_for(s.workspace_id)->>'invoice_lead_time_days')::int)
           <= now()
     ORDER BY COALESCE(s.next_invoice_at, s.current_period_end)
     LIMIT GREATEST(COALESCE(p_limit, 50), 1)
  LOOP
    PERFORM public.billing_v2_enqueue_job(
      'renewal_invoice',
      r.sub_id::text || ':' || to_char(r.anchor AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS'),
      r.workspace_id,
      jsonb_build_object('subscription_id', r.sub_id, 'anchor', r.anchor)
    );
  END LOOP;

  FOR j IN SELECT * FROM public.billing_v2_claim_jobs('renewal_invoice', p_limit, 120) LOOP
    BEGIN
      v_res := public.billing_v2_issue_renewal_invoice(j.workspace_id, false);
      IF v_res ? 'skipped' THEN
        v_skipped := v_skipped + 1;
        IF split_part(v_res->>'skipped', ':', 1) IN
             ('not_yet_eligible', 'collection_active', 'period_exists', 'not_yet_due') THEN
          PERFORM public.billing_v2_defer_job(j.id, v_res->>'skipped');
        ELSE
          PERFORM public.billing_v2_complete_job(j.id, v_res);
        END IF;
      ELSE
        v_issued := v_issued + 1;
        PERFORM public.billing_v2_complete_job(j.id, v_res);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      v_last := SQLERRM;
      PERFORM public.billing_v2_fail_job(j.id, SQLERRM);
      INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
      VALUES (j.workspace_id, 'renewal_invoice_failed', left(SQLERRM, 200),
              jsonb_build_object('job_id', j.id));
    END;
  END LOOP;

  PERFORM public.billing_v2_note_worker_run('renewal_invoice', v_issued + v_skipped, v_failed, v_last);
  RETURN jsonb_build_object('issued', v_issued, 'skipped', v_skipped, 'failed', v_failed);
END;
$$;

-- ─── 7. Worker B — wallet auto-pay ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.billing_v2_wallet_autopay_invoice(p_invoice_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_inv     public.billing_invoices;
  v_policy  JSONB;
  v_balance BIGINT;
  v_res     JSONB;
BEGIN
  PERFORM public.billing_expire_stale_collections(p_invoice_id);

  SELECT * INTO v_inv FROM public.billing_invoices WHERE id = p_invoice_id;
  IF v_inv.id IS NULL THEN RETURN jsonb_build_object('skipped', 'unknown_invoice'); END IF;
  IF v_inv.status NOT IN ('open', 'partially_paid', 'past_due') THEN
    RETURN jsonb_build_object('skipped', 'not_payable:' || v_inv.status);
  END IF;
  IF v_inv.amount_due_irr <= 0 THEN RETURN jsonb_build_object('skipped', 'nothing_due'); END IF;
  IF v_inv.due_at IS NULL OR v_inv.due_at > now() THEN
    RETURN jsonb_build_object('skipped', 'not_due');
  END IF;

  v_policy := public.billing_v2_policy_for(v_inv.workspace_id);
  IF NOT (v_policy->>'wallet_auto_pay')::boolean THEN
    RETURN jsonb_build_object('skipped', 'auto_pay_disabled');
  END IF;

  IF EXISTS (SELECT 1 FROM public.billing_invoice_collections
              WHERE invoice_id = v_inv.id AND status = 'active') THEN
    INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
    VALUES (v_inv.workspace_id, 'wallet_autopay_skipped_collection_active', 'collection_active',
            jsonb_build_object('invoice_id', v_inv.id));
    RETURN jsonb_build_object('skipped', 'collection_active');
  END IF;

  PERFORM public.billing_wallet_lock(v_inv.workspace_id);
  SELECT available_balance_irr INTO v_balance FROM public.billing_wallet_accounts
   WHERE workspace_id = v_inv.workspace_id;

  IF COALESCE(v_balance, 0) < v_inv.amount_due_irr THEN
    INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
    VALUES (v_inv.workspace_id, 'wallet_autopay_skipped_insufficient', 'insufficient_balance',
            jsonb_build_object('invoice_id', v_inv.id, 'due_irr', v_inv.amount_due_irr,
                               'balance_irr', COALESCE(v_balance, 0)));
    RETURN jsonb_build_object('skipped', 'insufficient_balance');
  END IF;

  v_res := public.billing_wallet_pay_invoice(v_inv.id, NULL);

  INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
  VALUES (v_inv.workspace_id, 'wallet_autopay_succeeded', 'scheduler',
          jsonb_build_object('invoice_id', v_inv.id, 'amount_irr', v_inv.amount_due_irr));

  RETURN v_res || jsonb_build_object('paid', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_v2_run_wallet_autopay(p_limit INTEGER DEFAULT 50)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  r         RECORD;
  j         public.billing_v2_jobs;
  v_res     JSONB;
  v_paid    INTEGER := 0;
  v_skipped INTEGER := 0;
  v_failed  INTEGER := 0;
  v_last    TEXT;
BEGIN
  PERFORM public.billing_expire_stale_collections(NULL);

  FOR r IN
    SELECT i.id, i.workspace_id, i.amount_paid_irr
      FROM public.billing_invoices i
      JOIN public.billing_v2_rollout ro ON ro.workspace_id = i.workspace_id AND ro.state = 'v2_active'
     WHERE i.status IN ('open', 'partially_paid', 'past_due')
       AND i.amount_due_irr > 0
       AND i.due_at IS NOT NULL
       AND i.due_at <= now()
     ORDER BY i.due_at
     LIMIT GREATEST(COALESCE(p_limit, 50), 1)
  LOOP
    PERFORM public.billing_v2_enqueue_job(
      'wallet_autopay',
      r.id::text || ':' || r.amount_paid_irr::text,
      r.workspace_id,
      jsonb_build_object('invoice_id', r.id)
    );
  END LOOP;

  FOR j IN SELECT * FROM public.billing_v2_claim_jobs('wallet_autopay', p_limit, 120) LOOP
    BEGIN
      v_res := public.billing_v2_wallet_autopay_invoice((j.payload->>'invoice_id')::uuid);
      IF v_res ? 'skipped' THEN
        v_skipped := v_skipped + 1;
        IF split_part(v_res->>'skipped', ':', 1) IN
             ('collection_active', 'insufficient_balance', 'not_due') THEN
          PERFORM public.billing_v2_defer_job(j.id, v_res->>'skipped');
        ELSE
          PERFORM public.billing_v2_complete_job(j.id, v_res);
        END IF;
      ELSE
        v_paid := v_paid + 1;
        PERFORM public.billing_v2_complete_job(j.id, v_res);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      v_last := SQLERRM;
      PERFORM public.billing_v2_fail_job(j.id, SQLERRM);
      INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
      VALUES (j.workspace_id, 'wallet_autopay_failed', left(SQLERRM, 200),
              jsonb_build_object('job_id', j.id, 'invoice_id', j.payload->>'invoice_id'));
    END;
  END LOOP;

  PERFORM public.billing_v2_note_worker_run('wallet_autopay', v_paid + v_skipped, v_failed, v_last);
  RETURN jsonb_build_object('paid', v_paid, 'skipped', v_skipped, 'failed', v_failed);
END;
$$;

-- ─── 8. Worker C — period activation ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.billing_activate_period(p_period_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_period    public.billing_subscription_periods;
  v_inv       public.billing_invoices;
  v_prev_src  TEXT;
  v_lot       UUID;
  v_retired   INTEGER := 0;
BEGIN
  SELECT * INTO v_period FROM public.billing_subscription_periods
   WHERE id = p_period_id FOR UPDATE;
  IF v_period.id IS NULL THEN
    RAISE EXCEPTION 'unknown_period:%', p_period_id;
  END IF;
  IF v_period.status = 'active' THEN
    PERFORM public.billing_v2_apply_period_allowance(v_period.id);
    RETURN jsonb_build_object('period_id', v_period.id, 'replayed', true);
  END IF;
  IF v_period.status <> 'scheduled' THEN
    RAISE EXCEPTION 'period_not_activatable:%:%', v_period.id, v_period.status;
  END IF;

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

  INSERT INTO public.billing_period_allowance_grants (period_id, workspace_id, allowance_irr, status)
  VALUES (v_period.id, v_period.workspace_id, v_period.ai_allowance_irr,
          CASE WHEN v_period.ai_allowance_irr > 0 THEN 'pending' ELSE 'skipped' END)
  ON CONFLICT (period_id) DO NOTHING;

  v_lot := (public.billing_v2_apply_period_allowance(v_period.id)->>'lot_id')::uuid;

  INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
  VALUES (v_period.workspace_id, 'period_activated', v_period.source,
          jsonb_build_object('period_id', v_period.id, 'invoice_id', v_period.invoice_id,
                             'period_start', v_period.period_start,
                             'period_end', v_period.period_end,
                             'allowance_irr', v_period.ai_allowance_irr));

  RETURN jsonb_build_object(
    'period_id', v_period.id, 'lot_id', v_lot,
    'allowance_irr', v_period.ai_allowance_irr,
    'previous_period_source', v_prev_src,
    'legacy_lots_retired', v_retired,
    'replayed', false
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_v2_apply_period_allowance(p_period_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_period public.billing_subscription_periods;
  v_grant  public.billing_period_allowance_grants;
  v_lot    UUID;
BEGIN
  SELECT * INTO v_period FROM public.billing_subscription_periods WHERE id = p_period_id;
  IF v_period.id IS NULL THEN RAISE EXCEPTION 'unknown_period:%', p_period_id; END IF;
  IF v_period.status <> 'active' THEN
    RETURN jsonb_build_object('period_id', p_period_id, 'skipped', 'period_not_active');
  END IF;

  INSERT INTO public.billing_period_allowance_grants (period_id, workspace_id, allowance_irr, status)
  VALUES (v_period.id, v_period.workspace_id, v_period.ai_allowance_irr,
          CASE WHEN v_period.ai_allowance_irr > 0 THEN 'pending' ELSE 'skipped' END)
  ON CONFLICT (period_id) DO NOTHING;

  SELECT * INTO v_grant FROM public.billing_period_allowance_grants
   WHERE period_id = v_period.id FOR UPDATE;

  IF v_grant.status = 'granted' THEN
    INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
    VALUES (v_period.workspace_id, 'plan_allowance_grant_replayed', 'already_granted',
            jsonb_build_object('period_id', v_period.id, 'lot_id', v_grant.lot_id));
    RETURN jsonb_build_object('period_id', v_period.id, 'lot_id', v_grant.lot_id, 'replayed', true);
  END IF;
  IF v_period.ai_allowance_irr <= 0 THEN
    UPDATE public.billing_period_allowance_grants
       SET status = 'skipped', granted_at = now() WHERE period_id = v_period.id;
    RETURN jsonb_build_object('period_id', v_period.id, 'lot_id', NULL, 'skipped', 'no_allowance');
  END IF;

  BEGIN
    v_lot := public.ai_grant_allowance(
      v_period.workspace_id,
      v_period.ai_allowance_irr::numeric,
      'period:' || v_period.id::text,
      'plan',
      v_period.period_end,
      'plan_allowance:' || v_period.id::text
    );
  EXCEPTION WHEN OTHERS THEN
    UPDATE public.billing_period_allowance_grants
       SET status = 'failed', attempt_count = attempt_count + 1,
           last_error = left(SQLERRM, 500), next_attempt_at = now() + interval '5 minutes'
     WHERE period_id = v_period.id;
    RAISE;
  END;

  UPDATE public.billing_period_allowance_grants
     SET status = 'granted', lot_id = v_lot, granted_at = now(),
         attempt_count = attempt_count + 1, last_error = NULL
   WHERE period_id = v_period.id;

  INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
  VALUES (v_period.workspace_id, 'plan_allowance_granted', 'period_activation',
          jsonb_build_object('period_id', v_period.id, 'lot_id', v_lot,
                             'allowance_irr', v_period.ai_allowance_irr));

  RETURN jsonb_build_object('period_id', v_period.id, 'lot_id', v_lot, 'replayed', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_v2_run_period_activation(p_limit INTEGER DEFAULT 50)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  r          RECORD;
  j          public.billing_v2_jobs;
  v_active   INTEGER := 0;
  v_skipped  INTEGER := 0;
  v_failed   INTEGER := 0;
  v_last     TEXT;
BEGIN
  FOR r IN
    SELECT p.id, p.workspace_id
      FROM public.billing_subscription_periods p
      LEFT JOIN public.billing_invoices i ON i.id = p.invoice_id
     WHERE p.status = 'scheduled'
       AND p.period_start <= now()
       AND (p.invoice_id IS NULL OR i.status = 'paid')
     ORDER BY p.period_start
     LIMIT GREATEST(COALESCE(p_limit, 50), 1)
  LOOP
    PERFORM public.billing_v2_enqueue_job(
      'period_activation', r.id::text, r.workspace_id,
      jsonb_build_object('period_id', r.id)
    );
  END LOOP;

  FOR r IN
    SELECT g.period_id AS id, g.workspace_id
      FROM public.billing_period_allowance_grants g
     WHERE g.status IN ('pending', 'failed') AND g.next_attempt_at <= now()
     LIMIT GREATEST(COALESCE(p_limit, 50), 1)
  LOOP
    PERFORM public.billing_v2_enqueue_job(
      'period_activation', r.id::text, r.workspace_id,
      jsonb_build_object('period_id', r.id)
    );
  END LOOP;

  FOR j IN SELECT * FROM public.billing_v2_claim_jobs('period_activation', p_limit, 120) LOOP
    BEGIN
      IF EXISTS (SELECT 1 FROM public.billing_subscription_periods
                  WHERE id = (j.payload->>'period_id')::uuid AND status = 'scheduled') THEN
        PERFORM public.billing_activate_period((j.payload->>'period_id')::uuid);
        v_active := v_active + 1;
      ELSE
        PERFORM public.billing_v2_apply_period_allowance((j.payload->>'period_id')::uuid);
        v_skipped := v_skipped + 1;
      END IF;
      PERFORM public.billing_v2_complete_job(j.id, jsonb_build_object('period_id', j.payload->>'period_id'));
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      v_last := SQLERRM;
      PERFORM public.billing_v2_fail_job(j.id, SQLERRM);
      INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
      VALUES (j.workspace_id, 'period_activation_failed', left(SQLERRM, 200),
              jsonb_build_object('job_id', j.id, 'period_id', j.payload->>'period_id'));
    END;
  END LOOP;

  PERFORM public.billing_v2_note_worker_run('period_activation', v_active + v_skipped, v_failed, v_last);
  RETURN jsonb_build_object('activated', v_active, 'skipped', v_skipped, 'failed', v_failed);
END;
$$;

-- ─── 9. Scheduler health / metrics ─────────────────────────────────────────
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
    'failed_jobs', (SELECT count(*) FROM public.billing_v2_jobs WHERE status = 'failed'),
    'checked_at', now()
  );
$$;

-- ─── 10. ACL ───────────────────────────────────────────────────────────────
DO $$
DECLARE f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.billing_v2_policy_for(uuid)',
    'public.billing_v2_enqueue_job(text, text, uuid, jsonb)',
    'public.billing_v2_claim_jobs(text, integer, integer)',
    'public.billing_v2_complete_job(uuid, jsonb)',
    'public.billing_v2_fail_job(uuid, text)',
    'public.billing_v2_defer_job(uuid, text)',
    'public.billing_v2_note_worker_run(text, integer, integer, text)',
    'public.billing_v2_issue_renewal_invoice(uuid, boolean)',
    'public.billing_v2_ensure_free_period(uuid)',
    'public.billing_v2_run_invoice_scheduler(integer)',
    'public.billing_v2_wallet_autopay_invoice(uuid)',
    'public.billing_v2_run_wallet_autopay(integer)',
    'public.billing_v2_apply_period_allowance(uuid)',
    'public.billing_v2_run_period_activation(integer)',
    'public.billing_v2_scheduler_health()',
    'public.billing_v2_document_number()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
    END IF;
  END LOOP;
END $$;