-- BILLING ENGINE V2 — 123: DUNNING HARDENING

-- ─── 1. Frozen dunning snapshot ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.billing_v2_dunning_snapshot(p_invoice_id UUID)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_inv  public.billing_invoices;
  v_snap JSONB;
BEGIN
  SELECT * INTO v_inv FROM public.billing_invoices WHERE id = p_invoice_id;
  IF v_inv.id IS NULL THEN RETURN NULL; END IF;
  v_snap := COALESCE(v_inv.metadata, '{}'::jsonb) -> 'dunning';
  IF v_snap IS NULL OR jsonb_typeof(v_snap) <> 'object' THEN
    v_snap := public.billing_v2_policy_for(v_inv.workspace_id)
              || jsonb_build_object('frozen', false);
  END IF;
  RETURN v_snap;
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_v2_freeze_invoice_dunning()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_policy JSONB;
BEGIN
  IF NEW.status NOT IN ('open', 'partially_paid') THEN RETURN NEW; END IF;
  IF (COALESCE(NEW.metadata, '{}'::jsonb) ? 'dunning') THEN RETURN NEW; END IF;

  v_policy := public.billing_v2_policy_for(NEW.workspace_id);
  NEW.metadata := COALESCE(NEW.metadata, '{}'::jsonb) || jsonb_build_object(
    'dunning', jsonb_build_object(
      'frozen', true,
      'frozen_at', now(),
      'grace_period_days', (v_policy->>'grace_period_days')::int,
      'fallback_plan_id', v_policy->>'fallback_plan_id',
      'reminder_days_before_due', v_policy->'reminder_days_before_due'
    ));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_billing_v2_freeze_invoice_dunning ON public.billing_invoices;
CREATE TRIGGER trg_billing_v2_freeze_invoice_dunning
  BEFORE INSERT OR UPDATE OF status ON public.billing_invoices
  FOR EACH ROW EXECUTE FUNCTION public.billing_v2_freeze_invoice_dunning();

-- ─── 2. Arming ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.billing_v2_arm_invoice_dunning()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status = 'open'
     AND (TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status) THEN
    PERFORM public.billing_v2_schedule_invoice_notifications(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_billing_v2_invoice_arm_dunning ON public.billing_invoices;
CREATE TRIGGER trg_billing_v2_invoice_arm_dunning
  AFTER INSERT OR UPDATE OF status ON public.billing_invoices
  FOR EACH ROW EXECUTE FUNCTION public.billing_v2_arm_invoice_dunning();

-- ─── 3. Due-day processing, snapshot-governed ──────────────────────────────
CREATE OR REPLACE FUNCTION public.billing_v2_process_due_invoice(p_invoice_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_inv    public.billing_invoices;
  v_sub    public.workspace_subscriptions;
  v_policy JSONB;
  v_snap   JSONB;
  v_res    JSONB;
  v_grace  TIMESTAMPTZ;
BEGIN
  PERFORM public.billing_expire_stale_collections(p_invoice_id);

  SELECT * INTO v_inv FROM public.billing_invoices WHERE id = p_invoice_id FOR UPDATE;
  IF v_inv.id IS NULL THEN RETURN jsonb_build_object('skipped', 'unknown_invoice'); END IF;

  IF v_inv.status = 'paid' OR v_inv.amount_due_irr <= 0 THEN
    PERFORM public.billing_v2_cancel_invoice_notifications(v_inv.id, 'invoice_paid');
    PERFORM public.billing_v2_restore_subscription(v_inv.workspace_id);
    RETURN jsonb_build_object('skipped', 'already_paid');
  END IF;
  IF v_inv.status IN ('void', 'expired', 'refunded') THEN
    RETURN jsonb_build_object('skipped', 'not_collectible:' || v_inv.status);
  END IF;
  IF v_inv.due_at IS NULL OR v_inv.due_at > now() THEN
    RETURN jsonb_build_object('skipped', 'not_due');
  END IF;

  IF EXISTS (SELECT 1 FROM public.billing_invoice_collections
              WHERE invoice_id = v_inv.id AND status = 'active') THEN
    RETURN jsonb_build_object('skipped', 'collection_active');
  END IF;

  v_policy := public.billing_v2_policy_for(v_inv.workspace_id);
  v_snap   := public.billing_v2_dunning_snapshot(v_inv.id);

  INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
  VALUES (v_inv.workspace_id, 'invoice_due', 'due_date_reached',
          jsonb_build_object('invoice_id', v_inv.id, 'amount_due_irr', v_inv.amount_due_irr));

  IF (v_policy->>'wallet_auto_pay')::boolean THEN
    v_res := public.billing_v2_wallet_autopay_invoice(v_inv.id);
    INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
    VALUES (v_inv.workspace_id, 'wallet_autopay_attempted', COALESCE(v_res->>'skipped', 'paid'),
            jsonb_build_object('invoice_id', v_inv.id));

    IF COALESCE((v_res->>'paid')::boolean, false) THEN
      INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
      VALUES (v_inv.workspace_id, 'wallet_autopay_succeeded', 'due_day',
              jsonb_build_object('invoice_id', v_inv.id));
      PERFORM public.billing_v2_cancel_invoice_notifications(v_inv.id, 'invoice_paid');
      PERFORM public.billing_v2_enqueue_notification(
        v_inv.workspace_id, 'payment_received', 'email', v_inv.id, now(),
        jsonb_build_object('invoice_number', v_inv.invoice_number,
                           'amount_irr', v_inv.amount_due_irr, 'method', 'wallet'),
        v_inv.id::text);
      PERFORM public.billing_v2_restore_subscription(v_inv.workspace_id);
      RETURN jsonb_build_object('paid', true, 'via', 'wallet');
    END IF;

    IF v_res->>'skipped' = 'collection_active' THEN
      RETURN jsonb_build_object('skipped', 'collection_active');
    END IF;
    IF v_res->>'skipped' = 'insufficient_balance' THEN
      INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
      VALUES (v_inv.workspace_id, 'wallet_autopay_insufficient', 'due_day',
              jsonb_build_object('invoice_id', v_inv.id));
      PERFORM public.billing_v2_enqueue_notification(
        v_inv.workspace_id, 'wallet_autopay_insufficient', 'email', v_inv.id, now(),
        jsonb_build_object('invoice_number', v_inv.invoice_number,
                           'amount_irr', v_inv.amount_due_irr),
        v_inv.id::text);
    END IF;
  END IF;

  UPDATE public.billing_invoices
     SET status = 'past_due', past_due_at = COALESCE(past_due_at, now()), updated_at = now()
   WHERE id = v_inv.id AND status IN ('open', 'partially_paid');

  SELECT * INTO v_sub FROM public.workspace_subscriptions
   WHERE workspace_id = v_inv.workspace_id FOR UPDATE;

  IF v_sub.id IS NOT NULL AND v_sub.status IN ('active', 'past_due') THEN
    v_grace := COALESCE(
      v_sub.grace_period_ends_at,
      now() + make_interval(days => COALESCE((v_snap->>'grace_period_days')::int,
                                             (v_policy->>'grace_period_days')::int)));
    UPDATE public.workspace_subscriptions
       SET status = 'past_due',
           past_due_since = COALESCE(past_due_since, now()),
           grace_period_ends_at = v_grace,
           updated_at = now()
     WHERE id = v_sub.id;

    IF v_sub.status <> 'past_due' THEN
      INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
      VALUES (v_inv.workspace_id, 'subscription_past_due', 'grace_started',
              jsonb_build_object('subscription_id', v_sub.id, 'grace_period_ends_at', v_grace));
    END IF;
  END IF;

  INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
  VALUES (v_inv.workspace_id, 'invoice_past_due', 'unpaid_at_due',
          jsonb_build_object('invoice_id', v_inv.id, 'amount_due_irr', v_inv.amount_due_irr));

  IF (v_policy->>'notify_on_past_due')::boolean THEN
    PERFORM public.billing_v2_enqueue_notification(
      v_inv.workspace_id, 'invoice_past_due', 'email', v_inv.id, now(),
      jsonb_build_object('invoice_number', v_inv.invoice_number,
                         'amount_irr', v_inv.amount_due_irr,
                         'grace_period_ends_at', v_grace),
      v_inv.id::text);
    PERFORM public.billing_v2_enqueue_notification(
      v_inv.workspace_id, 'invoice_past_due', 'sms', v_inv.id, now(),
      jsonb_build_object('invoice_number', v_inv.invoice_number),
      v_inv.id::text);
  END IF;

  RETURN jsonb_build_object(
    'past_due', true,
    'grace_period_ends_at', v_grace,
    'reason', CASE WHEN NOT (v_policy->>'wallet_auto_pay')::boolean THEN 'auto_pay_disabled'
                   WHEN v_res->>'skipped' = 'insufficient_balance' THEN 'insufficient_balance'
                   ELSE 'unpaid' END);
END;
$$;

-- ─── 4. Fallback refuses to guess a plan ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.billing_v2_apply_free_fallback(p_workspace_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_sub      public.workspace_subscriptions;
  v_policy   JSONB;
  v_plan     public.billing_plans;
  v_plan_id  UUID;
  v_period   public.billing_subscription_periods;
  v_start    TIMESTAMPTZ;
  v_allow    BIGINT;
  v_expired  INTEGER := 0;
BEGIN
  SELECT * INTO v_sub FROM public.workspace_subscriptions
   WHERE workspace_id = p_workspace_id FOR UPDATE;
  IF v_sub.id IS NULL THEN RETURN jsonb_build_object('skipped', 'no_subscription'); END IF;
  IF v_sub.status = 'free_fallback' THEN
    RETURN jsonb_build_object('skipped', 'already_free_fallback');
  END IF;
  IF v_sub.status <> 'past_due' THEN
    RETURN jsonb_build_object('skipped', 'not_past_due:' || v_sub.status);
  END IF;
  IF v_sub.grace_period_ends_at IS NULL THEN
    RETURN jsonb_build_object('skipped', 'not_in_grace');
  END IF;
  IF v_sub.grace_period_ends_at > now() THEN
    RETURN jsonb_build_object('skipped', 'grace_active');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.billing_invoices
     WHERE workspace_id = p_workspace_id
       AND status IN ('open', 'partially_paid', 'past_due')
       AND amount_due_irr > 0
       AND due_at IS NOT NULL AND due_at <= now()
  ) THEN
    PERFORM public.billing_v2_restore_subscription(p_workspace_id);
    RETURN jsonb_build_object('skipped', 'nothing_unpaid');
  END IF;

  v_policy := public.billing_v2_policy_for(p_workspace_id);
  v_plan_id := NULLIF(v_policy->>'fallback_plan_id', '')::uuid;
  IF v_plan_id IS NULL THEN
    RAISE EXCEPTION 'fallback_plan_not_configured';
  END IF;
  SELECT * INTO v_plan FROM public.billing_plans WHERE id = v_plan_id;
  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'fallback_plan_not_configured';
  END IF;

  UPDATE public.billing_subscription_periods
     SET status = 'canceled', completed_at = now()
   WHERE workspace_id = p_workspace_id AND status = 'scheduled';

  v_start := now();
  v_allow := GREATEST(ROUND(COALESCE((v_plan.limits->>'ai_credits_per_month')::numeric, 0))::bigint, 0);

  INSERT INTO public.billing_subscription_periods (
    workspace_id, subscription_id, plan_id, invoice_id, billing_interval,
    period_start, period_end, status, source, plan_snapshot, limits_snapshot, ai_allowance_irr
  ) VALUES (
    p_workspace_id, v_sub.id, v_plan.id, NULL, 'monthly',
    v_start, public.billing_v2_add_interval(v_start, 'monthly', 1), 'scheduled', 'free_fallback',
    to_jsonb(v_plan), COALESCE(v_plan.limits, '{}'::jsonb), v_allow
  ) RETURNING * INTO v_period;

  PERFORM public.billing_activate_period(v_period.id);

  UPDATE public.billing_invoices
     SET status = 'expired', updated_at = now(),
         metadata = metadata || jsonb_build_object('expired_reason', 'nonpayment_after_grace')
   WHERE workspace_id = p_workspace_id
     AND status IN ('open', 'partially_paid', 'past_due')
     AND amount_due_irr > 0;
  GET DIAGNOSTICS v_expired = ROW_COUNT;

  UPDATE public.workspace_subscriptions
     SET status = 'free_fallback',
         free_fallback_at = now(),
         past_due_since = NULL,
         grace_period_ends_at = NULL,
         pending_change_type = NULL,
         next_plan_id = NULL,
         updated_at = now()
   WHERE id = v_sub.id;

  INSERT INTO public.billing_retention_signals (workspace_id, state, reason, details)
  VALUES (p_workspace_id, 'pending', 'free_fallback_nonpayment',
          jsonb_build_object('subscription_id', v_sub.id, 'fallback_plan_id', v_plan_id))
  ON CONFLICT (workspace_id) DO UPDATE
    SET state = 'pending', reason = 'free_fallback_nonpayment',
        signaled_at = now(), cleared_at = NULL,
        details = EXCLUDED.details;

  INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
  VALUES
    (p_workspace_id, 'grace_expired', 'unpaid',
     jsonb_build_object('subscription_id', v_sub.id)),
    (p_workspace_id, 'subscription_free_fallback', 'grace_expired',
     jsonb_build_object('plan_id', v_plan_id, 'period_id', v_period.id)),
    (p_workspace_id, 'invoice_expired_after_nonpayment', 'grace_expired',
     jsonb_build_object('invoices_expired', v_expired));

  IF (v_policy->>'notify_on_fallback')::boolean THEN
    PERFORM public.billing_v2_enqueue_notification(
      p_workspace_id, 'subscription_free_fallback', 'email', NULL, now(),
      jsonb_build_object('plan_name', v_plan.name),
      v_sub.id::text || ':' || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI'));
    PERFORM public.billing_v2_enqueue_notification(
      p_workspace_id, 'subscription_free_fallback', 'sms', NULL, now(), '{}'::jsonb,
      v_sub.id::text || ':' || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI'));
  END IF;

  RETURN jsonb_build_object('free_fallback', true, 'plan_id', v_plan_id,
                            'period_id', v_period.id, 'invoices_expired', v_expired);
END;
$$;

-- ─── 5. Late payment after fallback is audited ─────────────────────────────
CREATE OR REPLACE FUNCTION public.billing_v2_payment_after_fallback()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_status TEXT;
BEGIN
  IF NEW.status = 'paid' AND OLD.status IS DISTINCT FROM 'paid' THEN
    SELECT status INTO v_status FROM public.workspace_subscriptions
     WHERE workspace_id = NEW.workspace_id;
    IF v_status = 'free_fallback' THEN
      INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
      VALUES (NEW.workspace_id, 'payment_after_free_fallback', 'late_settlement',
              jsonb_build_object('invoice_id', NEW.id, 'amount_irr', NEW.amount_paid_irr));
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_billing_v2_payment_after_fallback ON public.billing_invoices;
CREATE TRIGGER trg_billing_v2_payment_after_fallback
  AFTER UPDATE OF status ON public.billing_invoices
  FOR EACH ROW EXECUTE FUNCTION public.billing_v2_payment_after_fallback();

-- ─── 6. No stacking of renewal invoices ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.billing_v2_run_invoice_scheduler(p_limit INTEGER DEFAULT 50)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  r         RECORD;
  j         public.billing_v2_jobs;
  v_res     JSONB;
  v_issued  INTEGER := 0;
  v_skipped INTEGER := 0;
  v_failed  INTEGER := 0;
  v_last    TEXT;
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
       AND NOT EXISTS (
         SELECT 1 FROM public.billing_invoices i
          WHERE i.workspace_id = s.workspace_id
            AND i.invoice_type = 'subscription_renewal'
            AND i.status IN ('open', 'partially_paid', 'past_due')
            AND i.amount_due_irr > 0)
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

-- ─── 7. ACL ────────────────────────────────────────────────────────────────
DO $acl$
DECLARE f TEXT;
BEGIN
  FOR f IN
    SELECT format('public.%I(%s)', p.proname, pg_get_function_identity_arguments(p.oid))
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN (
         'billing_v2_dunning_snapshot', 'billing_v2_process_due_invoice',
         'billing_v2_apply_free_fallback', 'billing_v2_run_invoice_scheduler')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
    END IF;
  END LOOP;
END $acl$;

-- ─── 8. Recipient resolution tolerant of optional profile columns ──────────
CREATE OR REPLACE FUNCTION public.billing_v2_resolve_billing_recipient(p_workspace_id UUID)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_owner   UUID;
  v_email   TEXT;
  v_locale  TEXT;
  v_phone   TEXT;
  v_contact JSONB;
BEGIN
  SELECT metadata->'billing_contact' INTO v_contact
    FROM public.workspace_subscriptions WHERE workspace_id = p_workspace_id;

  SELECT owner_id INTO v_owner FROM public.workspaces WHERE id = p_workspace_id;
  IF v_owner IS NOT NULL THEN
    SELECT email INTO v_email FROM public.profiles WHERE id = v_owner;

    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'profiles'
         AND column_name = 'preferred_locale'
    ) THEN
      EXECUTE 'SELECT preferred_locale FROM public.profiles WHERE id = $1'
        INTO v_locale USING v_owner;
    END IF;
  END IF;

  IF to_regclass('public.user_phone_verifications') IS NOT NULL AND v_owner IS NOT NULL THEN
    EXECUTE 'SELECT phone_e164 FROM public.user_phone_verifications
              WHERE user_id = $1 AND phone_verified_at IS NOT NULL'
      INTO v_phone USING v_owner;
  END IF;

  IF v_phone IS NULL AND v_owner IS NOT NULL AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'phone'
  ) THEN
    EXECUTE 'SELECT phone FROM public.profiles WHERE id = $1' INTO v_phone USING v_owner;
  END IF;

  RETURN jsonb_build_object(
    'user_id', v_owner,
    'email', NULLIF(COALESCE(v_contact->>'email', v_email), ''),
    'phone', NULLIF(COALESCE(v_contact->>'phone', v_phone), ''),
    'locale', COALESCE(NULLIF(v_contact->>'locale', ''), NULLIF(v_locale, ''), 'fa')
  );
END;
$$;

DO $acl2$
DECLARE f TEXT;
BEGIN
  FOR f IN
    SELECT format('public.%I(%s)', p.proname, pg_get_function_identity_arguments(p.oid))
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'billing_v2_resolve_billing_recipient'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
    END IF;
  END LOOP;
END $acl2$;

-- ─── 9. Reminder payload carries its own offset ────────────────────────────
CREATE OR REPLACE FUNCTION public.billing_v2_schedule_invoice_notifications(p_invoice_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_inv     public.billing_invoices;
  v_policy  JSONB;
  v_days    INTEGER;
  v_at      TIMESTAMPTZ;
  v_created INTEGER := 0;
  v_payload JSONB;
BEGIN
  SELECT * INTO v_inv FROM public.billing_invoices WHERE id = p_invoice_id;
  IF v_inv.id IS NULL THEN RETURN jsonb_build_object('skipped', 'unknown_invoice'); END IF;
  IF v_inv.status NOT IN ('open', 'partially_paid') THEN
    RETURN jsonb_build_object('skipped', 'not_open:' || v_inv.status);
  END IF;

  v_policy := public.billing_v2_policy_for(v_inv.workspace_id);
  v_payload := jsonb_build_object(
    'invoice_number', v_inv.invoice_number,
    'amount_irr', v_inv.amount_due_irr,
    'due_at', v_inv.due_at
  );

  IF (v_policy->>'send_invoice_issued_email')::boolean THEN
    IF public.billing_v2_enqueue_notification(
         v_inv.workspace_id, 'invoice_issued', 'email', v_inv.id, now(), v_payload,
         v_inv.id::text) IS NOT NULL THEN v_created := v_created + 1; END IF;
  END IF;
  IF (v_policy->>'send_invoice_issued_sms')::boolean THEN
    IF public.billing_v2_enqueue_notification(
         v_inv.workspace_id, 'invoice_issued', 'sms', v_inv.id, now(), v_payload,
         v_inv.id::text) IS NOT NULL THEN v_created := v_created + 1; END IF;
  END IF;

  IF v_inv.due_at IS NOT NULL THEN
    FOR v_days IN
      SELECT DISTINCT (value)::int
        FROM jsonb_array_elements_text(v_policy->'reminder_days_before_due')
    LOOP
      v_at := v_inv.due_at - make_interval(days => GREATEST(v_days, 0));
      CONTINUE WHEN v_at <= now();
      IF public.billing_v2_enqueue_notification(
           v_inv.workspace_id, 'invoice_reminder', 'email', v_inv.id, v_at,
           v_payload || jsonb_build_object('days_before_due', v_days),
           v_inv.id::text || ':d' || v_days::text) IS NOT NULL THEN
        v_created := v_created + 1;
      END IF;
    END LOOP;
  END IF;

  INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
  VALUES (v_inv.workspace_id, 'invoice_reminders_scheduled', 'dunning',
          jsonb_build_object('invoice_id', v_inv.id, 'created', v_created));

  RETURN jsonb_build_object('invoice_id', v_inv.id, 'created', v_created);
END;
$$;

-- ─── 10. Closing an invoice silences EVERY message it owns ─────────────────
CREATE OR REPLACE FUNCTION public.billing_v2_invoice_notification_sync()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status IN ('paid', 'void', 'expired') THEN
    PERFORM public.billing_v2_cancel_invoice_notifications(
      NEW.id, 'invoice_' || NEW.status,
      ARRAY['invoice_issued', 'invoice_reminder', 'invoice_due',
            'invoice_past_due', 'wallet_autopay_insufficient']);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_billing_v2_invoice_notification_sync ON public.billing_invoices;
CREATE TRIGGER trg_billing_v2_invoice_notification_sync
  AFTER UPDATE ON public.billing_invoices
  FOR EACH ROW EXECUTE FUNCTION public.billing_v2_invoice_notification_sync();

-- ─── 11. Any settlement of a due invoice ends the dunning ──────────────────
CREATE OR REPLACE FUNCTION public.billing_v2_invoice_paid_recovery()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_status TEXT;
BEGIN
  IF NEW.status = 'paid' AND OLD.status IS DISTINCT FROM 'paid' THEN
    SELECT status INTO v_status FROM public.workspace_subscriptions
     WHERE workspace_id = NEW.workspace_id;
    IF v_status = 'past_due' THEN
      PERFORM public.billing_v2_restore_subscription(NEW.workspace_id);
      INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
      VALUES (NEW.workspace_id, 'invoice_restored_during_grace', 'payment_settled',
              jsonb_build_object('invoice_id', NEW.id));
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_billing_v2_invoice_paid_recovery ON public.billing_invoices;
CREATE TRIGGER trg_billing_v2_invoice_paid_recovery
  AFTER UPDATE ON public.billing_invoices
  FOR EACH ROW EXECUTE FUNCTION public.billing_v2_invoice_paid_recovery();

-- ─── 12. Notification worker outcome vocabulary ────────────────────────────
ALTER TABLE public.billing_notification_jobs
  DROP CONSTRAINT IF EXISTS billing_notification_jobs_status_check;
ALTER TABLE public.billing_notification_jobs
  ADD CONSTRAINT billing_notification_jobs_status_check CHECK (
    status IN ('pending', 'processing', 'sent', 'failed', 'canceled',
               'skipped', 'skipped_no_recipient')
  );

CREATE OR REPLACE FUNCTION public.billing_v2_complete_notification_job(
  p_job_id UUID,
  p_result JSONB
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_row public.billing_notification_jobs;
BEGIN
  UPDATE public.billing_notification_jobs
     SET status = 'sent', sent_at = now(), lease_until = NULL,
         last_error = NULL, payload = payload || jsonb_build_object('result', p_result),
         updated_at = now()
   WHERE id = p_job_id
   RETURNING * INTO v_row;
  IF v_row.id IS NULL THEN RETURN jsonb_build_object('skipped', 'unknown_job'); END IF;
  RETURN jsonb_build_object('job_id', v_row.id, 'status', v_row.status);
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_v2_skip_notification_job(
  p_job_id UUID,
  p_reason TEXT DEFAULT 'skipped'
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_row public.billing_notification_jobs;
BEGIN
  UPDATE public.billing_notification_jobs
     SET status = 'skipped', lease_until = NULL,
         last_error = left(COALESCE(p_reason, 'skipped'), 200), updated_at = now()
   WHERE id = p_job_id
   RETURNING * INTO v_row;
  IF v_row.id IS NULL THEN RETURN jsonb_build_object('skipped', 'unknown_job'); END IF;
  RETURN jsonb_build_object('job_id', v_row.id, 'status', v_row.status);
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_v2_billing_recipient(p_workspace_id UUID)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT public.billing_v2_resolve_billing_recipient(p_workspace_id) $$;

-- ─── 13. Operational surface ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.billing_v2_dunning_metrics()
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'past_due_invoices', (SELECT count(*) FROM public.billing_invoices WHERE status = 'past_due'),
    'grace_subscriptions', (SELECT count(*) FROM public.workspace_subscriptions
                             WHERE status = 'past_due' AND grace_period_ends_at IS NOT NULL),
    'grace_expired_pending', (SELECT count(*) FROM public.workspace_subscriptions
                               WHERE status = 'past_due' AND grace_period_ends_at IS NOT NULL
                                 AND grace_period_ends_at <= now()),
    'fallbacks_total', (SELECT count(*) FROM public.workspace_subscriptions
                         WHERE status = 'free_fallback'),
    'notification_backlog', (SELECT count(*) FROM public.billing_notification_jobs
                              WHERE status IN ('pending', 'processing')
                                AND next_attempt_at <= now()),
    'notifications_failed', (SELECT count(*) FROM public.billing_notification_jobs
                              WHERE status = 'failed'),
    'autopay_insufficient_events', (SELECT count(*) FROM public.billing_v2_audit
                                     WHERE event IN ('wallet_autopay_insufficient',
                                                     'wallet_autopay_skipped_insufficient')),
    'retention_signals_pending', (SELECT count(*) FROM public.billing_retention_signals
                                   WHERE state = 'pending'),
    'checked_at', now()
  );
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
    'notification_backlog', (SELECT count(*) FROM public.billing_notification_jobs
                              WHERE status IN ('pending','processing') AND next_attempt_at <= now()),
    'grace_subscriptions', (SELECT count(*) FROM public.workspace_subscriptions
                             WHERE status = 'past_due' AND grace_period_ends_at IS NOT NULL),
    'failed_jobs', (SELECT count(*) FROM public.billing_v2_jobs WHERE status = 'failed'),
    'checked_at', now()
  );
$$;

DO $acl3$
DECLARE f TEXT;
BEGIN
  FOR f IN
    SELECT format('public.%I(%s)', p.proname, pg_get_function_identity_arguments(p.oid))
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname IN (
       'billing_v2_schedule_invoice_notifications', 'billing_v2_invoice_notification_sync',
       'billing_v2_invoice_paid_recovery', 'billing_v2_complete_notification_job',
       'billing_v2_skip_notification_job', 'billing_v2_billing_recipient',
       'billing_v2_dunning_metrics', 'billing_v2_scheduler_health')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
    END IF;
  END LOOP;
END $acl3$;