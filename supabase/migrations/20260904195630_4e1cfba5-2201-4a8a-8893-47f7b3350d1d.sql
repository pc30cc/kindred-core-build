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

  IF v_created > 0 THEN
    INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
    VALUES (v_inv.workspace_id, 'invoice_reminders_scheduled', 'dunning',
            jsonb_build_object('invoice_id', v_inv.id, 'created', v_created));
  END IF;

  RETURN jsonb_build_object('invoice_id', v_inv.id, 'created', v_created);
END;
$$;

CREATE INDEX IF NOT EXISTS idx_operator_activity_bucket
  ON public.operator_activity_samples (bucket);