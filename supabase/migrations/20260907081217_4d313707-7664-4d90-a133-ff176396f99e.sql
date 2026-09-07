CREATE OR REPLACE FUNCTION public.billing_v2_block_legacy_allowance_grant()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_owned BOOLEAN;
BEGIN
  IF NEW.source_type <> 'PLAN_ALLOWANCE' THEN RETURN NEW; END IF;

  -- Canonical V2 allowances are attached to either the original service
  -- period identity or (since entitlement-cycle rollout) its concrete cycle.
  -- Only calendar keys such as YYYY-MM belong to the retired legacy path.
  IF NEW.billing_cycle_id LIKE 'period:%'
     OR NEW.billing_cycle_id LIKE 'cycle:%' THEN
    RETURN NEW;
  END IF;

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