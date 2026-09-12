-- ============================================================
-- 156 — BILLING LIFECYCLE NOTIFICATIONS
--
-- Before this migration only invoice-centric messages existed
-- (issued / reminder / due / past due / wallet autopay / restore /
-- free fallback) and `payment_received` was enqueued ONLY on the wallet
-- auto-pay path. Every gateway payment, plan activation, wallet top-up,
-- AI credit purchase and trial expiry was therefore silent.
--
-- The lifecycle stays in SQL (single source of truth, idempotent by
-- unique key). Delivery remains the Express dispatcher. No edge function.
-- ============================================================

-- 1. Vocabulary -------------------------------------------------------
ALTER TABLE public.billing_notification_jobs
  DROP CONSTRAINT IF EXISTS billing_notification_jobs_type_check;
ALTER TABLE public.billing_notification_jobs
  ADD CONSTRAINT billing_notification_jobs_type_check CHECK (notification_type IN (
    'invoice_issued', 'invoice_reminder', 'invoice_due',
    'wallet_autopay_insufficient', 'invoice_past_due', 'payment_received',
    'subscription_restored', 'subscription_free_fallback',
    'subscription_activated', 'subscription_renewed',
    'wallet_deposit_received', 'ai_credit_purchased',
    'trial_ending_soon', 'trial_expired'
  ));

-- 2. Money actually received ------------------------------------------
-- Every successful customer payment row (gateway, internal gateway,
-- recovery replay) produces exactly one receipt message. Keyed by the
-- payment id, so a replayed callback that resolves an existing row
-- inserts nothing and therefore notifies nothing twice.
CREATE OR REPLACE FUNCTION public.billing_notify_payment_recorded()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_type TEXT;
BEGIN
  IF NEW.status IS DISTINCT FROM 'succeeded' THEN RETURN NEW; END IF;

  v_type := CASE NEW.purchase_type
    WHEN 'wallet_deposit'  THEN 'wallet_deposit_received'
    WHEN 'ai_credit_topup' THEN 'ai_credit_purchased'
    ELSE 'payment_received'
  END;

  PERFORM public.billing_v2_enqueue_notification(
    NEW.workspace_id, v_type, 'email', NEW.invoice_id, now(),
    jsonb_build_object(
      'invoice_number', COALESCE(NEW.invoice_number, '—'),
      'amount_irr', NEW.amount,
      'plan_name', NEW.plan_name_snapshot
    ),
    NEW.id::text);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_billing_notify_payment_recorded ON public.billing_payments;
CREATE TRIGGER trg_billing_notify_payment_recorded
  AFTER INSERT ON public.billing_payments
  FOR EACH ROW EXECUTE FUNCTION public.billing_notify_payment_recorded();

-- 3. Plan activated / renewed / trial ended ---------------------------
-- Driven by the subscription projection so EVERY activation path is
-- covered: paid invoice settlement, admin grant, legacy apply. The
-- period id is the idempotency key, so re-running activation is silent.
CREATE OR REPLACE FUNCTION public.billing_notify_subscription_lifecycle()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_plan_name TEXT;
  v_type      TEXT;
BEGIN
  SELECT name INTO v_plan_name FROM public.billing_plans WHERE id = NEW.plan_id;

  -- Trial ended (expire_stale_trials, or a fallback out of trialing).
  IF TG_OP = 'UPDATE'
     AND OLD.status = 'trialing'
     AND NEW.status IN ('expired', 'free_fallback', 'canceled') THEN
    PERFORM public.billing_v2_enqueue_notification(
      NEW.workspace_id, 'trial_expired', 'email', NULL, now(),
      jsonb_build_object('plan_name', v_plan_name),
      NEW.id::text || ':' || to_char(COALESCE(NEW.trial_end, now()) AT TIME ZONE 'UTC', 'YYYY-MM-DD'));
    RETURN NEW;
  END IF;

  IF NEW.status <> 'active' OR NEW.current_period_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- A dunning recovery already has its own message.
  IF TG_OP = 'UPDATE'
     AND OLD.status = 'past_due'
     AND OLD.current_period_id IS NOT DISTINCT FROM NEW.current_period_id THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.current_period_id IS NOT DISTINCT FROM NEW.current_period_id
     AND OLD.status = 'active' THEN
    RETURN NEW;   -- nothing started, nothing to announce
  END IF;

  v_type := CASE
    WHEN TG_OP = 'UPDATE' AND OLD.plan_id IS NOT DISTINCT FROM NEW.plan_id
         AND OLD.current_period_id IS NOT NULL THEN 'subscription_renewed'
    ELSE 'subscription_activated'
  END;

  PERFORM public.billing_v2_enqueue_notification(
    NEW.workspace_id, v_type, 'email', NULL, now(),
    jsonb_build_object(
      'plan_name', v_plan_name,
      'period_end', NEW.current_period_end
    ),
    NEW.current_period_id::text);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_billing_notify_subscription_lifecycle ON public.workspace_subscriptions;
CREATE TRIGGER trg_billing_notify_subscription_lifecycle
  AFTER INSERT OR UPDATE ON public.workspace_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.billing_notify_subscription_lifecycle();

-- 4. Trial about to end ------------------------------------------------
-- Scanned by the Express billing tick. One message per remaining-day
-- bucket per subscription — never a flood on catch-up.
CREATE OR REPLACE FUNCTION public.billing_notify_trial_ending()
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_sub     RECORD;
  v_days    INTEGER;
  v_created INTEGER := 0;
BEGIN
  FOR v_sub IN
    SELECT s.id, s.workspace_id, s.trial_end, p.name AS plan_name
      FROM public.workspace_subscriptions s
      LEFT JOIN public.billing_plans p ON p.id = s.plan_id
     WHERE s.status = 'trialing'
       AND s.trial_end IS NOT NULL
       AND s.trial_end > now()
       AND s.trial_end <= now() + interval '3 days'
  LOOP
    v_days := GREATEST(CEIL(EXTRACT(EPOCH FROM (v_sub.trial_end - now())) / 86400.0)::int, 1);
    IF public.billing_v2_enqueue_notification(
         v_sub.workspace_id, 'trial_ending_soon', 'email', NULL, now(),
         jsonb_build_object('plan_name', v_sub.plan_name,
                            'trial_end', v_sub.trial_end,
                            'days_left', v_days),
         v_sub.id::text || ':d' || v_days::text) IS NOT NULL THEN
      v_created := v_created + 1;
    END IF;
  END LOOP;

  RETURN v_created;
END;
$$;

REVOKE ALL ON FUNCTION public.billing_notify_trial_ending() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_notify_trial_ending() TO service_role;
