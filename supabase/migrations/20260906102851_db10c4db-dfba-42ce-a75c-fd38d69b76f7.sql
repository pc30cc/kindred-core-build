CREATE OR REPLACE FUNCTION public.billing_begin_collection(
  p_invoice_id uuid,
  p_channel text,
  p_amount_irr bigint,
  p_command_key text,
  p_intent_id uuid DEFAULT NULL::uuid,
  p_ttl_seconds integer DEFAULT 1800
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inv public.billing_invoices;
  v_col public.billing_invoice_collections;
BEGIN
  IF p_command_key IS NULL OR length(p_command_key) = 0 THEN
    RAISE EXCEPTION 'collection_command_key_required';
  END IF;
  IF p_channel NOT IN ('gateway', 'wallet', 'admin') THEN
    RAISE EXCEPTION 'collection_channel_invalid:%', p_channel;
  END IF;

  SELECT * INTO v_inv FROM public.billing_invoices WHERE id = p_invoice_id FOR UPDATE;
  IF v_inv.id IS NULL THEN
    RAISE EXCEPTION 'unknown_invoice:%', p_invoice_id;
  END IF;
  IF v_inv.status NOT IN ('open', 'partially_paid', 'past_due') THEN
    RAISE EXCEPTION 'invoice_not_payable:%:%', v_inv.id, v_inv.status;
  END IF;
  IF p_amount_irr IS NULL OR p_amount_irr <= 0 OR p_amount_irr <> v_inv.amount_due_irr THEN
    RAISE EXCEPTION 'collection_amount_mismatch:%:%:%', v_inv.id, v_inv.amount_due_irr, p_amount_irr;
  END IF;

  PERFORM public.billing_expire_stale_collections(v_inv.id);

  -- Repair reservations produced by the former two-step flow, where a crash
  -- could leave an active collection with no payment intent for 15 minutes.
  UPDATE public.billing_invoice_collections c
     SET status = 'released', released_at = now(), release_reason = 'orphaned_checkout'
   WHERE c.invoice_id = v_inv.id
     AND c.status = 'active'
     AND c.channel = 'gateway'
     AND (
       c.payment_intent_id IS NULL
       OR EXISTS (
         SELECT 1 FROM public.billing_payment_intents pi
          WHERE pi.id = c.payment_intent_id
            AND pi.status IN ('failed', 'expired', 'canceled')
       )
     );

  SELECT * INTO v_col FROM public.billing_invoice_collections WHERE command_key = p_command_key;
  IF v_col.id IS NOT NULL THEN
    IF v_col.status <> 'active' THEN
      RAISE EXCEPTION 'collection_not_active:%:%', v_col.id, v_col.status;
    END IF;
    RETURN jsonb_build_object(
      'collection_id', v_col.id, 'channel', v_col.channel,
      'amount_irr', v_col.amount_irr, 'expires_at', v_col.expires_at, 'replayed', true
    );
  END IF;

  SELECT * INTO v_col FROM public.billing_invoice_collections
   WHERE invoice_id = v_inv.id AND status = 'active' FOR UPDATE;
  IF v_col.id IS NOT NULL THEN
    RAISE EXCEPTION 'invoice_collection_locked:%:%', v_inv.id, v_col.channel
      USING HINT = 'Another collection channel already holds this invoice. Release or expire it before collecting again.';
  END IF;

  INSERT INTO public.billing_invoice_collections (
    invoice_id, workspace_id, channel, amount_irr, payment_intent_id, command_key, expires_at
  ) VALUES (
    v_inv.id, v_inv.workspace_id, p_channel, p_amount_irr, p_intent_id, p_command_key,
    now() + make_interval(secs => GREATEST(COALESCE(p_ttl_seconds, 1800), 30))
  )
  RETURNING * INTO v_col;

  RETURN jsonb_build_object(
    'collection_id', v_col.id, 'channel', v_col.channel,
    'amount_irr', v_col.amount_irr, 'expires_at', v_col.expires_at, 'replayed', false
  );
END;
$function$;