-- 256: Billing notifications name the currency of the amount they carry.
--
-- Since 255 a renewal invoice can be in USD/EUR/TRY, whose amount columns hold
-- minor units (cents) of billing_invoices.currency, and a card payment row
-- (billing_payments.amount) is in minor units of billing_payments.currency.
-- The notification payloads carried only {amount_irr}, and
-- server/services/billing/notifications/messages.ts printed every amount as
-- Rial: a $29.00 renewal reminder read "2,900 IRR".
--
-- Each payload that carries an amount now carries its currency as well:
--
--   billing_v2_schedule_invoice_notifications (129)
--     invoice_issued (email, sms) and invoice_reminder: + currency
--   billing_v2_process_due_invoice (202)
--     payment_received (wallet), wallet_autopay_insufficient,
--     invoice_past_due (email): + currency. The SMS past-due payload carries
--     no amount and is unchanged.
--   billing_notify_payment_recorded (156, trigger on billing_payments)
--     payment_received / wallet_deposit_received / ai_credit_purchased: + currency
--
-- `currency` is the column as stored (billing_invoices.currency,
-- billing_payments.currency). messages.ts reads it the way invoiceCurrency()
-- in readModels.ts does (trimmed, upper-cased, IRR unless three letters), so
-- a job queued before this migration, without the key, still renders as IRR,
-- and an IRR amount renders exactly as before.
--
-- Nothing else in these functions changes: each body is the latest one
-- (129, 202, 156; none is redefined later) with the one key added. Same
-- signatures, SECURITY DEFINER and search_path; CREATE OR REPLACE keeps the
-- owner and the grants as they are. Re-runnable.

-- ─── invoice issued / reminders ────────────────────────────────────────────
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
    'currency', v_inv.currency,
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
      CONTINUE WHEN v_at <= now();   -- no stale reminder floods on catch-up
      IF public.billing_v2_enqueue_notification(
           v_inv.workspace_id, 'invoice_reminder', 'email', v_inv.id, v_at,
           v_payload || jsonb_build_object('days_before_due', v_days),
           v_inv.id::text || ':d' || v_days::text) IS NOT NULL THEN

        v_created := v_created + 1;
      END IF;
    END LOOP;
  END IF;

  -- Audit ONLY a real state change. A check that scheduled nothing is not an
  -- event and must not cost a write.
  IF v_created > 0 THEN
    INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
    VALUES (v_inv.workspace_id, 'invoice_reminders_scheduled', 'dunning',
            jsonb_build_object('invoice_id', v_inv.id, 'created', v_created));
  END IF;

  RETURN jsonb_build_object('invoice_id', v_inv.id, 'created', v_created);
END;
$$;

-- ─── due day: wallet auto-pay, past due ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.billing_v2_process_due_invoice(p_invoice_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
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
                           'amount_irr', v_inv.amount_due_irr, 'currency', v_inv.currency,
                           'method', 'wallet'),
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
                           'amount_irr', v_inv.amount_due_irr, 'currency', v_inv.currency),
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
                         'currency', v_inv.currency,
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
$function$;

-- ─── money received (every succeeded billing_payments row) ─────────────────
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
      'currency', NEW.currency,
      'plan_name', NEW.plan_name_snapshot
    ),
    NEW.id::text);

  RETURN NEW;
END;
$$;
