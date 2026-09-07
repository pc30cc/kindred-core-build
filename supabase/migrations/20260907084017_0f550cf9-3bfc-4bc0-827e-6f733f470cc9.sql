-- Wallet top-up becomes invoice-driven, exactly like a plan purchase or an AI
-- credit purchase: one invoice → one checkout → one settlement → one effect.
ALTER TABLE public.billing_invoices DROP CONSTRAINT IF EXISTS billing_invoices_type_check;
ALTER TABLE public.billing_invoices ADD CONSTRAINT billing_invoices_type_check
  CHECK (invoice_type = ANY (ARRAY['new_subscription','subscription_renewal','plan_upgrade','addon','manual','ai_credit_purchase','wallet_deposit']));

ALTER TABLE public.billing_invoice_lines DROP CONSTRAINT IF EXISTS billing_invoice_lines_type_check;
ALTER TABLE public.billing_invoice_lines ADD CONSTRAINT billing_invoice_lines_type_check
  CHECK (line_type = ANY (ARRAY['plan','upgrade_proration','addon','ai_credit','wallet_deposit','discount','tax','credit','manual_adjustment']));

CREATE OR REPLACE FUNCTION public.billing_apply_invoice_effects(p_invoice_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inv       public.billing_invoices;
  v_app       public.billing_invoice_applications;
  v_snap      JSONB;
  v_sub       public.workspace_subscriptions;
  v_period    public.billing_subscription_periods;
  v_period_id UUID;
  v_start     TIMESTAMPTZ;
  v_end       TIMESTAMPTZ;
  v_activate  BOOLEAN;
  v_lot       UUID;
  v_type      TEXT;
  v_entry     JSONB;
BEGIN
  SELECT * INTO v_inv FROM public.billing_invoices WHERE id = p_invoice_id FOR UPDATE;
  IF v_inv.id IS NULL THEN
    RAISE EXCEPTION 'unknown_invoice:%', p_invoice_id;
  END IF;
  IF v_inv.status <> 'paid' THEN
    RAISE EXCEPTION 'invoice_not_paid:%:%', v_inv.id, v_inv.status;
  END IF;

  v_snap := COALESCE(v_inv.effect_snapshot, '{}'::jsonb);
  v_type := COALESCE(v_snap->>'action_type', v_inv.invoice_type);

  INSERT INTO public.billing_invoice_applications (
    invoice_id, workspace_id, application_type, application_status
  ) VALUES (v_inv.id, v_inv.workspace_id, v_type, 'pending')
  ON CONFLICT (invoice_id) DO NOTHING;

  SELECT * INTO v_app FROM public.billing_invoice_applications
   WHERE invoice_id = v_inv.id FOR UPDATE;

  IF v_app.application_status = 'applied' THEN
    RETURN jsonb_build_object(
      'invoice_id', v_inv.id, 'application_id', v_app.id,
      'period_id', v_app.period_id,
      'lot_id', v_app.result_snapshot->>'lot_id',
      'replayed', true
    );
  END IF;

  UPDATE public.billing_invoice_applications
     SET application_status = 'processing',
         attempt_count = attempt_count + 1,
         lease_until = now() + interval '5 minutes'
   WHERE id = v_app.id;

  IF v_inv.invoice_type = 'ai_credit_purchase' THEN
    v_lot := public.ai_purchase_credit(
      v_inv.workspace_id,
      COALESCE((v_snap->>'ai_credit_amount_irr')::numeric, v_inv.total_irr::numeric),
      'invoice:' || v_inv.id::text,
      'invoice_' || v_inv.invoice_number
    );

    UPDATE public.billing_invoice_applications
       SET application_status = 'applied',
           application_type   = 'ai_credit_purchase',
           applied_at         = now(),
           lease_until        = NULL,
           last_error         = NULL,
           result_snapshot    = jsonb_build_object('lot_id', v_lot, 'amount_irr', v_inv.total_irr)
     WHERE id = v_app.id;

    RETURN jsonb_build_object(
      'invoice_id', v_inv.id, 'application_id', v_app.id,
      'lot_id', v_lot, 'replayed', false
    );
  END IF;

  IF v_inv.invoice_type = 'wallet_deposit' THEN
    v_entry := public.billing_wallet_append(
      v_inv.workspace_id,
      'deposit',
      COALESCE((v_snap->>'wallet_deposit_amount_irr')::bigint, v_inv.total_irr::bigint),
      'invoice_deposit:' || v_inv.id::text,
      'invoice_' || v_inv.invoice_number,
      v_inv.id,
      NULL,
      NULL,
      NULL,
      '{}'::jsonb
    );

    UPDATE public.billing_invoice_applications
       SET application_status = 'applied',
           application_type   = 'wallet_deposit',
           applied_at         = now(),
           lease_until        = NULL,
           last_error         = NULL,
           result_snapshot    = jsonb_build_object('wallet_entry', v_entry, 'amount_irr', v_inv.total_irr)
     WHERE id = v_app.id;

    RETURN jsonb_build_object(
      'invoice_id', v_inv.id, 'application_id', v_app.id,
      'wallet_entry', v_entry, 'replayed', false
    );
  END IF;

  SELECT * INTO v_sub FROM public.workspace_subscriptions
   WHERE workspace_id = v_inv.workspace_id FOR UPDATE;

  v_start := COALESCE((v_snap->>'period_start')::timestamptz, v_inv.period_start, now());
  v_end   := COALESCE((v_snap->>'period_end')::timestamptz, v_inv.period_end, v_start + interval '1 month');
  v_activate := v_start <= now();

  INSERT INTO public.billing_subscription_periods (
    workspace_id, subscription_id, plan_id, invoice_id, billing_interval,
    period_start, period_end, status, source,
    plan_snapshot, limits_snapshot, ai_allowance_irr
  ) VALUES (
    v_inv.workspace_id, v_sub.id,
    COALESCE((v_snap->>'target_plan_id')::uuid, v_inv.plan_id),
    v_inv.id,
    COALESCE(v_snap->>'billing_interval', v_inv.billing_interval, 'monthly'),
    v_start, v_end, 'scheduled', 'invoice',
    COALESCE(v_snap->'plan_snapshot', '{}'::jsonb),
    COALESCE(v_snap->'limits_snapshot', '{}'::jsonb),
    GREATEST(COALESCE((v_snap->>'ai_allowance_irr')::bigint, 0), 0)
  )
  RETURNING * INTO v_period;

  v_period_id := v_period.id;

  UPDATE public.billing_invoice_applications
     SET application_status = 'applied',
         application_type   = v_type,
         period_id          = v_period_id,
         applied_at         = now(),
         lease_until        = NULL,
         last_error         = NULL,
         result_snapshot    = jsonb_build_object(
           'period_start', v_start, 'period_end', v_end, 'scheduled_only', NOT v_activate
         )
   WHERE id = v_app.id;

  IF v_activate THEN
    PERFORM public.billing_activate_period(v_period_id);
  END IF;

  RETURN jsonb_build_object(
    'invoice_id', v_inv.id, 'application_id', v_app.id,
    'period_id', v_period_id, 'activated', v_activate, 'replayed', false
  );
END;
$function$;
