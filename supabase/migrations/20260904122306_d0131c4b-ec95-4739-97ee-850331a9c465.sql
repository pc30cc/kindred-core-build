CREATE OR REPLACE FUNCTION public.billing_activate_period(p_period_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_period    public.billing_subscription_periods;
  v_inv       public.billing_invoices;
  v_prev_src  TEXT;
  v_sync      JSONB;
  v_retired   INTEGER := 0;
  v_subscription_id UUID;
BEGIN
  SELECT * INTO v_period FROM public.billing_subscription_periods
   WHERE id = p_period_id FOR UPDATE;
  IF v_period.id IS NULL THEN
    RAISE EXCEPTION 'unknown_period:%', p_period_id;
  END IF;
  IF v_period.status = 'active' THEN
    -- Self-heal historical active periods that were created before their
    -- workspace subscription projection existed.
    INSERT INTO public.workspace_subscriptions (
      workspace_id, plan_id, provider_name, status, current_period_id,
      current_period_start, current_period_end, billing_interval,
      next_invoice_at, billing_engine_version, updated_at
    ) VALUES (
      v_period.workspace_id, v_period.plan_id, 'manual', 'active', v_period.id,
      v_period.period_start, v_period.period_end, v_period.billing_interval,
      v_period.period_end, 'v2', now()
    )
    ON CONFLICT (workspace_id) DO NOTHING;

    SELECT id INTO v_subscription_id
      FROM public.workspace_subscriptions
     WHERE workspace_id = v_period.workspace_id;

    UPDATE public.billing_subscription_periods
       SET subscription_id = COALESCE(subscription_id, v_subscription_id)
     WHERE id = v_period.id;

    v_sync := public.billing_v2_sync_period_cycles(v_period.id);
    RETURN jsonb_build_object('period_id', v_period.id, 'replayed', true, 'cycles', v_sync);
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

  -- A first-time workspace has no projection row yet. Create it before the
  -- canonical update below, in the same transaction, so an admin grant or a
  -- paid first subscription can never leave an orphan active period.
  INSERT INTO public.workspace_subscriptions (
    workspace_id, plan_id, provider_name, status, current_period_id,
    current_period_start, current_period_end, billing_interval,
    next_invoice_at, billing_engine_version, updated_at
  ) VALUES (
    v_period.workspace_id, v_period.plan_id, 'manual', 'active', v_period.id,
    v_period.period_start, v_period.period_end, v_period.billing_interval,
    v_period.period_end, 'v2', now()
  )
  ON CONFLICT (workspace_id) DO NOTHING;

  SELECT id INTO v_subscription_id
    FROM public.workspace_subscriptions
   WHERE workspace_id = v_period.workspace_id
   FOR UPDATE;

  UPDATE public.billing_subscription_periods
     SET subscription_id = COALESCE(subscription_id, v_subscription_id)
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
         updated_at = now()
   WHERE workspace_id = v_period.workspace_id;

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
$function$;