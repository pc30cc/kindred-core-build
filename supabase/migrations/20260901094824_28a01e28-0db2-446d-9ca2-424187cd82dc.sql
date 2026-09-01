-- ═══════════════════════════════════════════════════════════════════════════
-- AI USAGE BILLING — financial domain (additive, append-only, service-only)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ── 1. Catalog & pricing ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.ai_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  model_key text NOT NULL,
  display_name text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, model_key)
);

CREATE TABLE IF NOT EXISTS public.ai_rate_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  model_key text NOT NULL,
  currency text NOT NULL DEFAULT 'USD',
  version integer NOT NULL DEFAULT 1,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_rate_cards_window CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT ai_rate_cards_no_overlap EXCLUDE USING gist (
    provider WITH =, model_key WITH =,
    tstzrange(effective_from, effective_to, '[)') WITH &&
  )
);

CREATE TABLE IF NOT EXISTS public.ai_rate_card_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rate_card_id uuid NOT NULL REFERENCES public.ai_rate_cards(id) ON DELETE CASCADE,
  component_type text NOT NULL,
  unit text NOT NULL DEFAULT 'TOKEN',
  unit_amount numeric(24,12) NOT NULL DEFAULT 0,
  per_units numeric(24,6) NOT NULL DEFAULT 1000000,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rate_card_id, component_type)
);

CREATE TABLE IF NOT EXISTS public.ai_exchange_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_currency text NOT NULL,
  to_currency text NOT NULL,
  rate numeric(24,12) NOT NULL CHECK (rate > 0),
  version integer NOT NULL DEFAULT 1,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_fx_window CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT ai_fx_no_overlap EXCLUDE USING gist (
    from_currency WITH =, to_currency WITH =,
    tstzrange(effective_from, effective_to, '[)') WITH &&
  )
);

CREATE TABLE IF NOT EXISTS public.ai_sell_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL DEFAULT 'GLOBAL' CHECK (scope IN ('GLOBAL','WORKSPACE')),
  workspace_id uuid,
  multiplier numeric(12,6) NOT NULL DEFAULT 1 CHECK (multiplier > 0),
  overage_policy text NOT NULL DEFAULT 'CAP_AND_ABSORB'
    CHECK (overage_policy IN ('CAP_AND_ABSORB','HALT_BILLABLE_EXECUTION')),
  version integer NOT NULL DEFAULT 1,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_sell_window CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT ai_sell_scope CHECK ((scope = 'GLOBAL' AND workspace_id IS NULL) OR (scope = 'WORKSPACE' AND workspace_id IS NOT NULL)),
  CONSTRAINT ai_sell_no_overlap EXCLUDE USING gist (
    scope WITH =, COALESCE(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid) WITH =,
    tstzrange(effective_from, effective_to, '[)') WITH &&
  )
);

-- ── 2. Runs, steps, usage events ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.ai_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  conversation_id uuid,
  channel text,
  entry_point text NOT NULL DEFAULT 'unknown',
  mode text NOT NULL DEFAULT 'METER_ONLY' CHECK (mode IN ('METER_ONLY','ENFORCED')),
  status text NOT NULL DEFAULT 'RUNNING'
    CHECK (status IN ('RUNNING','USAGE_RECORDED','SETTLEMENT_PENDING','SETTLED','FAILED','CANCELLED')),
  billing_quality text NOT NULL DEFAULT 'ACTUAL'
    CHECK (billing_quality IN ('ACTUAL','ESTIMATED','RECONCILED','UNRESOLVED')),
  unresolved_reason text,
  cost_source text NOT NULL DEFAULT 'PROVIDER_USAGE',
  fallback_kind text,
  primary_provider text,
  primary_model text,
  operation_idempotency_key text NOT NULL UNIQUE,
  operation_request_hash text NOT NULL,
  -- Immutable pricing snapshot resolved once at run start
  sell_policy_id uuid REFERENCES public.ai_sell_policies(id),
  sell_multiplier numeric(12,6),
  billing_fx_id uuid REFERENCES public.ai_exchange_rates(id),
  billing_fx_rate numeric(24,12),
  billing_currency text NOT NULL DEFAULT 'IRR',
  overage_policy text NOT NULL DEFAULT 'CAP_AND_ABSORB',
  reservation_id uuid,
  provider_cost_usd numeric(24,12) NOT NULL DEFAULT 0,
  internal_cost_irr numeric(24,6) NOT NULL DEFAULT 0,
  customer_charge_irr numeric(24,6) NOT NULL DEFAULT 0,
  platform_absorbed_amount numeric(24,6) NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_runs_ws_created_idx ON public.ai_runs(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_runs_unsettled_idx ON public.ai_runs(status) WHERE status IN ('RUNNING','USAGE_RECORDED','SETTLEMENT_PENDING');
CREATE INDEX IF NOT EXISTS ai_runs_quality_idx ON public.ai_runs(billing_quality) WHERE billing_quality = 'UNRESOLVED';

CREATE TABLE IF NOT EXISTS public.ai_run_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.ai_runs(id) ON DELETE CASCADE,
  step_kind text NOT NULL,
  step_seq integer NOT NULL DEFAULT 1,
  attempt_no integer NOT NULL DEFAULT 1,
  provider text,
  requested_model text,
  actual_model text,
  provider_request_id text,
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','SUCCEEDED','FAILED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, step_kind, step_seq, attempt_no)
);

CREATE TABLE IF NOT EXISTS public.ai_usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.ai_runs(id) ON DELETE CASCADE,
  step_id uuid NOT NULL REFERENCES public.ai_run_steps(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  component_type text NOT NULL,
  usage_event_key text NOT NULL,
  payload_hash text NOT NULL,
  provider text NOT NULL,
  requested_model text,
  actual_model text,
  quantity numeric(24,6) NOT NULL DEFAULT 0,
  unit text NOT NULL DEFAULT 'TOKEN',
  rate_card_version_id uuid REFERENCES public.ai_rate_cards(id),
  provider_cost_amount numeric(24,12) NOT NULL DEFAULT 0,
  provider_cost_currency text NOT NULL DEFAULT 'USD',
  usage_fx_id uuid REFERENCES public.ai_exchange_rates(id),
  provider_cost_usd numeric(24,12) NOT NULL DEFAULT 0,
  internal_cost_irr numeric(24,6) NOT NULL DEFAULT 0,
  raw_usage_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (step_id, component_type, usage_event_key)
);
CREATE INDEX IF NOT EXISTS ai_usage_events_run_idx ON public.ai_usage_events(run_id);
CREATE INDEX IF NOT EXISTS ai_usage_events_model_idx ON public.ai_usage_events(provider, actual_model, created_at DESC);

CREATE TABLE IF NOT EXISTS public.ai_usage_event_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,
  step_id uuid NOT NULL,
  component_type text NOT NULL,
  usage_event_key text NOT NULL,
  existing_event_id uuid,
  existing_payload_hash text,
  conflicting_payload_hash text,
  conflicting_payload jsonb,
  resolved boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ai_run_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL UNIQUE REFERENCES public.ai_runs(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  billing_cycle_id text NOT NULL,
  provider_cost_usd numeric(24,12) NOT NULL DEFAULT 0,
  internal_cost_irr numeric(24,6) NOT NULL DEFAULT 0,
  customer_charge_irr numeric(24,6) NOT NULL DEFAULT 0,
  platform_absorbed_amount numeric(24,6) NOT NULL DEFAULT 0,
  ledger_entry_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── 3. Wallet, lots, reservations, ledger ──────────────────────────────────

CREATE TABLE IF NOT EXISTS public.workspace_ai_wallets (
  workspace_id uuid PRIMARY KEY,
  available_amount numeric(24,6) NOT NULL DEFAULT 0,
  reserved_amount numeric(24,6) NOT NULL DEFAULT 0,
  lifetime_charged numeric(24,6) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'IRR',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.workspace_ai_balance_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('PLAN_ALLOWANCE','PURCHASED','ADJUSTMENT','REFUND_COMPENSATION')),
  allowance_source text,
  billing_cycle_id text,
  original_amount numeric(24,6) NOT NULL DEFAULT 0,
  remaining_amount numeric(24,6) NOT NULL DEFAULT 0,
  reserved_amount numeric(24,6) NOT NULL DEFAULT 0,
  expires_at timestamptz,
  state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','EXPIRING','EXPIRED','DEPLETED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lot_amounts_sane CHECK (remaining_amount >= 0 AND reserved_amount >= 0 AND reserved_amount <= remaining_amount)
);
CREATE INDEX IF NOT EXISTS ai_lots_ws_idx ON public.workspace_ai_balance_lots(workspace_id, expires_at NULLS LAST);
CREATE UNIQUE INDEX IF NOT EXISTS ai_lots_allowance_once
  ON public.workspace_ai_balance_lots(workspace_id, billing_cycle_id, allowance_source)
  WHERE source_type = 'PLAN_ALLOWANCE';

CREATE TABLE IF NOT EXISTS public.workspace_ai_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  run_id uuid REFERENCES public.ai_runs(id) ON DELETE SET NULL,
  amount numeric(24,6) NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','SETTLED','RELEASED','EXPIRED')),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 minutes'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_reservations_state_idx ON public.workspace_ai_reservations(state, expires_at);

CREATE TABLE IF NOT EXISTS public.workspace_ai_reservation_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid NOT NULL REFERENCES public.workspace_ai_reservations(id) ON DELETE CASCADE,
  lot_id uuid NOT NULL REFERENCES public.workspace_ai_balance_lots(id) ON DELETE RESTRICT,
  amount numeric(24,6) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_res_alloc_idx ON public.workspace_ai_reservation_allocations(reservation_id);

CREATE TABLE IF NOT EXISTS public.workspace_ai_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  run_id uuid,
  entry_type text NOT NULL CHECK (entry_type IN ('CHARGE','REFUND','ADJUSTMENT','GRANT','PURCHASE','EXPIRATION')),
  amount numeric(24,6) NOT NULL,
  billing_cycle_id text,
  reason text,
  command_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_ledger_ws_idx ON public.workspace_ai_ledger(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_ledger_run_idx ON public.workspace_ai_ledger(run_id);

CREATE TABLE IF NOT EXISTS public.workspace_ai_ledger_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_entry_id uuid NOT NULL REFERENCES public.workspace_ai_ledger(id) ON DELETE RESTRICT,
  lot_id uuid NOT NULL REFERENCES public.workspace_ai_balance_lots(id) ON DELETE RESTRICT,
  amount numeric(24,6) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_ledger_alloc_idx ON public.workspace_ai_ledger_allocations(ledger_entry_id);

CREATE TABLE IF NOT EXISTS public.ai_billing_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  run_id uuid,
  amount numeric(24,6) NOT NULL,
  reason text NOT NULL,
  created_by uuid,
  ledger_entry_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ai_billing_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  command_type text NOT NULL CHECK (command_type IN ('SETTLE_RUN','REFUND','ADJUSTMENT','GRANT_ALLOWANCE','RESERVE','RELEASE','PURCHASE')),
  idempotency_key text NOT NULL UNIQUE,
  workspace_id uuid,
  run_id uuid,
  request_hash text,
  result_ref uuid,
  state text NOT NULL DEFAULT 'COMPLETED' CHECK (state IN ('PENDING','COMPLETED','FAILED')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ai_billing_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid,
  action text NOT NULL,
  workspace_id uuid,
  target_ref uuid,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.workspace_ai_balance_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  billing_cycle_id text NOT NULL,
  threshold integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, billing_cycle_id, threshold)
);

-- ── 4. Immutability guards ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.ai_billing_block_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'append_only_table: % rows cannot be updated or deleted', TG_TABLE_NAME;
END;
$$;

DROP TRIGGER IF EXISTS ai_ledger_append_only ON public.workspace_ai_ledger;
CREATE TRIGGER ai_ledger_append_only
  BEFORE UPDATE OR DELETE ON public.workspace_ai_ledger
  FOR EACH ROW EXECUTE FUNCTION public.ai_billing_block_mutation();

DROP TRIGGER IF EXISTS ai_usage_events_append_only ON public.ai_usage_events;
CREATE TRIGGER ai_usage_events_append_only
  BEFORE UPDATE OR DELETE ON public.ai_usage_events
  FOR EACH ROW EXECUTE FUNCTION public.ai_billing_block_mutation();

DROP TRIGGER IF EXISTS ai_ledger_alloc_append_only ON public.workspace_ai_ledger_allocations;
CREATE TRIGGER ai_ledger_alloc_append_only
  BEFORE UPDATE OR DELETE ON public.workspace_ai_ledger_allocations
  FOR EACH ROW EXECUTE FUNCTION public.ai_billing_block_mutation();

-- ── 5. Grants + RLS (service-role only surface) ────────────────────────────

DO $grants$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'ai_models','ai_rate_cards','ai_rate_card_components','ai_exchange_rates','ai_sell_policies',
    'ai_runs','ai_run_steps','ai_usage_events','ai_usage_event_conflicts','ai_run_settlements',
    'workspace_ai_wallets','workspace_ai_balance_lots','workspace_ai_reservations',
    'workspace_ai_reservation_allocations','workspace_ai_ledger','workspace_ai_ledger_allocations',
    'ai_billing_adjustments','ai_billing_commands','ai_billing_audit_log','workspace_ai_balance_alerts'
  ] LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    -- No policies: the Data API must never reach the financial domain. Only the
    -- backend service (service_role, which bypasses RLS) may read or write.
  END LOOP;
END;
$grants$;

-- ── 6. Pricing publish functions ───────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.ai_publish_rate_card(
  p_provider text, p_model_key text, p_currency text,
  p_components jsonb, p_actor uuid DEFAULT NULL, p_notes text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_now timestamptz := now(); v_id uuid; v_version integer; c jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('ai_rate_card:' || p_provider || ':' || p_model_key));
  UPDATE public.ai_rate_cards SET effective_to = v_now
   WHERE provider = p_provider AND model_key = p_model_key AND effective_to IS NULL;
  SELECT COALESCE(MAX(version), 0) + 1 INTO v_version
    FROM public.ai_rate_cards WHERE provider = p_provider AND model_key = p_model_key;
  INSERT INTO public.ai_rate_cards(provider, model_key, currency, version, effective_from, created_by, notes)
  VALUES (p_provider, p_model_key, COALESCE(p_currency,'USD'), v_version, v_now, p_actor, p_notes)
  RETURNING id INTO v_id;
  FOR c IN SELECT * FROM jsonb_array_elements(COALESCE(p_components, '[]'::jsonb)) LOOP
    INSERT INTO public.ai_rate_card_components(rate_card_id, component_type, unit, unit_amount, per_units)
    VALUES (v_id, c->>'component_type', COALESCE(c->>'unit','TOKEN'),
            COALESCE((c->>'unit_amount')::numeric, 0), COALESCE((c->>'per_units')::numeric, 1000000));
  END LOOP;
  INSERT INTO public.ai_models(provider, model_key) VALUES (p_provider, p_model_key)
    ON CONFLICT (provider, model_key) DO NOTHING;
  INSERT INTO public.ai_billing_audit_log(actor_id, action, target_ref, details)
  VALUES (p_actor, 'publish_rate_card', v_id, jsonb_build_object('provider', p_provider, 'model', p_model_key, 'version', v_version));
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.ai_publish_exchange_rate(
  p_from text, p_to text, p_rate numeric, p_actor uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_now timestamptz := now(); v_id uuid; v_version integer;
BEGIN
  IF p_rate IS NULL OR p_rate <= 0 THEN RAISE EXCEPTION 'invalid_fx_rate'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('ai_fx:' || p_from || ':' || p_to));
  UPDATE public.ai_exchange_rates SET effective_to = v_now
   WHERE from_currency = p_from AND to_currency = p_to AND effective_to IS NULL;
  SELECT COALESCE(MAX(version), 0) + 1 INTO v_version
    FROM public.ai_exchange_rates WHERE from_currency = p_from AND to_currency = p_to;
  INSERT INTO public.ai_exchange_rates(from_currency, to_currency, rate, version, effective_from, created_by)
  VALUES (p_from, p_to, p_rate, v_version, v_now, p_actor) RETURNING id INTO v_id;
  INSERT INTO public.ai_billing_audit_log(actor_id, action, target_ref, details)
  VALUES (p_actor, 'publish_exchange_rate', v_id, jsonb_build_object('from', p_from, 'to', p_to, 'rate', p_rate));
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.ai_publish_sell_policy(
  p_scope text, p_workspace_id uuid, p_multiplier numeric, p_overage_policy text, p_actor uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_now timestamptz := now(); v_id uuid; v_version integer; v_key uuid := COALESCE(p_workspace_id, '00000000-0000-0000-0000-000000000000'::uuid);
BEGIN
  IF p_multiplier IS NULL OR p_multiplier <= 0 THEN RAISE EXCEPTION 'invalid_multiplier'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('ai_sell:' || p_scope || ':' || v_key::text));
  UPDATE public.ai_sell_policies SET effective_to = v_now
   WHERE scope = p_scope AND COALESCE(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid) = v_key
     AND effective_to IS NULL;
  SELECT COALESCE(MAX(version), 0) + 1 INTO v_version FROM public.ai_sell_policies
   WHERE scope = p_scope AND COALESCE(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid) = v_key;
  INSERT INTO public.ai_sell_policies(scope, workspace_id, multiplier, overage_policy, version, effective_from, created_by)
  VALUES (p_scope, p_workspace_id, p_multiplier, COALESCE(p_overage_policy,'CAP_AND_ABSORB'), v_version, v_now, p_actor)
  RETURNING id INTO v_id;
  INSERT INTO public.ai_billing_audit_log(actor_id, action, workspace_id, target_ref, details)
  VALUES (p_actor, 'publish_sell_policy', p_workspace_id, v_id, jsonb_build_object('multiplier', p_multiplier, 'overage_policy', p_overage_policy));
  RETURN v_id;
END;
$$;

-- ── 7. Wallet helpers ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.ai_wallet_lock(p_workspace_id uuid)
RETURNS public.workspace_ai_wallets
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE w public.workspace_ai_wallets;
BEGIN
  INSERT INTO public.workspace_ai_wallets(workspace_id) VALUES (p_workspace_id)
    ON CONFLICT (workspace_id) DO NOTHING;
  SELECT * INTO w FROM public.workspace_ai_wallets WHERE workspace_id = p_workspace_id FOR UPDATE;
  RETURN w;
END;
$$;

CREATE OR REPLACE FUNCTION public.ai_wallet_project(p_workspace_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.workspace_ai_wallets w SET
    available_amount = COALESCE(x.avail, 0),
    reserved_amount = COALESCE(x.res, 0),
    updated_at = now()
  FROM (
    SELECT SUM(remaining_amount - reserved_amount) AS avail, SUM(reserved_amount) AS res
      FROM public.workspace_ai_balance_lots
     WHERE workspace_id = p_workspace_id AND state IN ('ACTIVE','EXPIRING')
  ) x
  WHERE w.workspace_id = p_workspace_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.ai_reconcile_wallet(p_workspace_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE w public.workspace_ai_wallets;
BEGIN
  w := public.ai_wallet_lock(p_workspace_id);
  PERFORM public.ai_wallet_project(p_workspace_id);
  SELECT * INTO w FROM public.workspace_ai_wallets WHERE workspace_id = p_workspace_id;
  RETURN jsonb_build_object('available', w.available_amount, 'reserved', w.reserved_amount);
END;
$$;

CREATE OR REPLACE FUNCTION public.ai_available_balance(p_workspace_id uuid)
RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(SUM(remaining_amount - reserved_amount), 0)
    FROM public.workspace_ai_balance_lots
   WHERE workspace_id = p_workspace_id
     AND state IN ('ACTIVE','EXPIRING')
     AND (expires_at IS NULL OR expires_at > now());
$$;

-- ── 8. Run lifecycle ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.ai_begin_run(
  p_workspace_id uuid,
  p_operation_key text,
  p_request_hash text,
  p_entry_point text,
  p_channel text,
  p_conversation_id uuid,
  p_mode text,
  p_sell_policy_id uuid,
  p_sell_multiplier numeric,
  p_fx_id uuid,
  p_fx_rate numeric,
  p_overage_policy text
) RETURNS public.ai_runs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE r public.ai_runs;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('ai_run:' || p_operation_key));
  SELECT * INTO r FROM public.ai_runs WHERE operation_idempotency_key = p_operation_key;
  IF FOUND THEN
    IF r.operation_request_hash IS DISTINCT FROM p_request_hash THEN
      INSERT INTO public.ai_billing_audit_log(action, workspace_id, target_ref, details)
      VALUES ('idempotency_conflict', p_workspace_id, r.id,
              jsonb_build_object('key', p_operation_key, 'existing_hash', r.operation_request_hash, 'incoming_hash', p_request_hash));
      RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN r;
  END IF;
  INSERT INTO public.ai_runs(
    workspace_id, conversation_id, channel, entry_point, mode,
    operation_idempotency_key, operation_request_hash,
    sell_policy_id, sell_multiplier, billing_fx_id, billing_fx_rate, overage_policy
  ) VALUES (
    p_workspace_id, p_conversation_id, p_channel, COALESCE(p_entry_point,'unknown'), COALESCE(p_mode,'METER_ONLY'),
    p_operation_key, p_request_hash,
    p_sell_policy_id, p_sell_multiplier, p_fx_id, p_fx_rate, COALESCE(p_overage_policy,'CAP_AND_ABSORB')
  ) RETURNING * INTO r;
  RETURN r;
END;
$$;

CREATE OR REPLACE FUNCTION public.ai_open_step(
  p_run_id uuid, p_step_kind text, p_step_seq integer, p_attempt_no integer,
  p_provider text, p_requested_model text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.ai_run_steps(run_id, step_kind, step_seq, attempt_no, provider, requested_model)
  VALUES (p_run_id, p_step_kind, COALESCE(p_step_seq,1), COALESCE(p_attempt_no,1), p_provider, p_requested_model)
  ON CONFLICT (run_id, step_kind, step_seq, attempt_no) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM public.ai_run_steps
     WHERE run_id = p_run_id AND step_kind = p_step_kind
       AND step_seq = COALESCE(p_step_seq,1) AND attempt_no = COALESCE(p_attempt_no,1);
  END IF;
  RETURN v_id;
END;
$$;

/**
 * Immutable, race-safe usage ingestion.
 * Returns 'INSERTED' | 'NOOP' | 'CONFLICT'. Never overwrites a stored event.
 */
CREATE OR REPLACE FUNCTION public.ai_ingest_usage_event(
  p_step_id uuid,
  p_component_type text,
  p_usage_event_key text,
  p_payload jsonb
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_run_id uuid; v_ws uuid; v_hash text; v_existing public.ai_usage_events;
BEGIN
  SELECT s.run_id, r.workspace_id INTO v_run_id, v_ws
    FROM public.ai_run_steps s JOIN public.ai_runs r ON r.id = s.run_id
   WHERE s.id = p_step_id;
  IF v_run_id IS NULL THEN RAISE EXCEPTION 'unknown_step'; END IF;

  -- Serialize concurrent ingestion of the SAME logical event so the conflict
  -- check below can never race with a competing insert.
  PERFORM pg_advisory_xact_lock(hashtext(p_step_id::text || '|' || p_component_type || '|' || p_usage_event_key));

  v_hash := md5(
    COALESCE(p_payload->>'provider','') || '|' || COALESCE(p_payload->>'actual_model','') || '|' ||
    COALESCE(p_payload->>'quantity','0') || '|' || COALESCE(p_payload->>'unit','TOKEN') || '|' ||
    COALESCE(p_payload->>'provider_cost_amount','0') || '|' || COALESCE(p_payload->>'provider_cost_currency','USD') || '|' ||
    COALESCE(p_payload->>'provider_cost_usd','0') || '|' || COALESCE(p_payload->>'internal_cost_irr','0') || '|' ||
    COALESCE(p_payload->>'rate_card_version_id','')
  );

  SELECT * INTO v_existing FROM public.ai_usage_events
   WHERE step_id = p_step_id AND component_type = p_component_type AND usage_event_key = p_usage_event_key;

  IF FOUND THEN
    IF v_existing.payload_hash = v_hash THEN
      RETURN 'NOOP';
    END IF;
    INSERT INTO public.ai_usage_event_conflicts(
      run_id, step_id, component_type, usage_event_key, existing_event_id,
      existing_payload_hash, conflicting_payload_hash, conflicting_payload)
    VALUES (v_run_id, p_step_id, p_component_type, p_usage_event_key, v_existing.id,
            v_existing.payload_hash, v_hash, p_payload);
    UPDATE public.ai_runs
       SET billing_quality = 'UNRESOLVED', unresolved_reason = 'INGESTION_CONFLICT', updated_at = now()
     WHERE id = v_run_id;
    RETURN 'CONFLICT';
  END IF;

  INSERT INTO public.ai_usage_events(
    run_id, step_id, workspace_id, component_type, usage_event_key, payload_hash,
    provider, requested_model, actual_model, quantity, unit,
    rate_card_version_id, provider_cost_amount, provider_cost_currency,
    usage_fx_id, provider_cost_usd, internal_cost_irr, raw_usage_json)
  VALUES (
    v_run_id, p_step_id, v_ws, p_component_type, p_usage_event_key, v_hash,
    COALESCE(p_payload->>'provider','unknown'), p_payload->>'requested_model', p_payload->>'actual_model',
    COALESCE((p_payload->>'quantity')::numeric, 0), COALESCE(p_payload->>'unit','TOKEN'),
    NULLIF(p_payload->>'rate_card_version_id','')::uuid,
    COALESCE((p_payload->>'provider_cost_amount')::numeric, 0),
    COALESCE(p_payload->>'provider_cost_currency','USD'),
    NULLIF(p_payload->>'usage_fx_id','')::uuid,
    COALESCE((p_payload->>'provider_cost_usd')::numeric, 0),
    COALESCE((p_payload->>'internal_cost_irr')::numeric, 0),
    p_payload->'raw_usage_json')
  ON CONFLICT (step_id, component_type, usage_event_key) DO NOTHING;

  RETURN 'INSERTED';
END;
$$;

-- ── 9. Reservations ────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.ai_reserve(
  p_workspace_id uuid, p_run_id uuid, p_amount numeric, p_command_key text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_res_id uuid; v_remaining numeric := GREATEST(COALESCE(p_amount,0), 0);
  v_take numeric; lot record; v_cmd uuid;
BEGIN
  PERFORM public.ai_wallet_lock(p_workspace_id);

  IF p_command_key IS NOT NULL THEN
    SELECT result_ref INTO v_res_id FROM public.ai_billing_commands WHERE idempotency_key = p_command_key;
    IF v_res_id IS NOT NULL THEN
      RETURN jsonb_build_object('reservation_id', v_res_id, 'reserved', (SELECT amount FROM public.workspace_ai_reservations WHERE id = v_res_id), 'replayed', true);
    END IF;
  END IF;

  INSERT INTO public.workspace_ai_reservations(workspace_id, run_id, amount)
  VALUES (p_workspace_id, p_run_id, 0) RETURNING id INTO v_res_id;

  FOR lot IN
    SELECT * FROM public.workspace_ai_balance_lots
     WHERE workspace_id = p_workspace_id AND state IN ('ACTIVE','EXPIRING')
       AND (expires_at IS NULL OR expires_at > now())
       AND remaining_amount > reserved_amount
     ORDER BY (expires_at IS NULL), expires_at ASC, created_at ASC
     FOR UPDATE
  LOOP
    EXIT WHEN v_remaining <= 0;
    v_take := LEAST(v_remaining, lot.remaining_amount - lot.reserved_amount);
    IF v_take > 0 THEN
      UPDATE public.workspace_ai_balance_lots SET reserved_amount = reserved_amount + v_take, updated_at = now()
       WHERE id = lot.id;
      INSERT INTO public.workspace_ai_reservation_allocations(reservation_id, lot_id, amount)
      VALUES (v_res_id, lot.id, v_take);
      v_remaining := v_remaining - v_take;
    END IF;
  END LOOP;

  UPDATE public.workspace_ai_reservations
     SET amount = COALESCE((SELECT SUM(amount) FROM public.workspace_ai_reservation_allocations WHERE reservation_id = v_res_id), 0),
         updated_at = now()
   WHERE id = v_res_id;

  IF p_run_id IS NOT NULL THEN
    UPDATE public.ai_runs SET reservation_id = v_res_id, updated_at = now() WHERE id = p_run_id;
  END IF;

  PERFORM public.ai_wallet_project(p_workspace_id);

  IF p_command_key IS NOT NULL THEN
    INSERT INTO public.ai_billing_commands(command_type, idempotency_key, workspace_id, run_id, result_ref)
    VALUES ('RESERVE', p_command_key, p_workspace_id, p_run_id, v_res_id)
    ON CONFLICT (idempotency_key) DO NOTHING RETURNING id INTO v_cmd;
  END IF;

  RETURN jsonb_build_object(
    'reservation_id', v_res_id,
    'requested', COALESCE(p_amount,0),
    'reserved', (SELECT amount FROM public.workspace_ai_reservations WHERE id = v_res_id),
    'shortfall', v_remaining,
    'replayed', false
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.ai_topup_reservation(p_run_id uuid, p_delta numeric)
RETURNS numeric
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_ws uuid; v_res uuid; v_remaining numeric := GREATEST(COALESCE(p_delta,0),0); v_take numeric; lot record;
BEGIN
  SELECT workspace_id, reservation_id INTO v_ws, v_res FROM public.ai_runs WHERE id = p_run_id;
  IF v_res IS NULL THEN RETURN 0; END IF;
  PERFORM public.ai_wallet_lock(v_ws);
  FOR lot IN
    SELECT * FROM public.workspace_ai_balance_lots
     WHERE workspace_id = v_ws AND state IN ('ACTIVE','EXPIRING')
       AND (expires_at IS NULL OR expires_at > now())
       AND remaining_amount > reserved_amount
     ORDER BY (expires_at IS NULL), expires_at ASC, created_at ASC FOR UPDATE
  LOOP
    EXIT WHEN v_remaining <= 0;
    v_take := LEAST(v_remaining, lot.remaining_amount - lot.reserved_amount);
    IF v_take > 0 THEN
      UPDATE public.workspace_ai_balance_lots SET reserved_amount = reserved_amount + v_take, updated_at = now() WHERE id = lot.id;
      INSERT INTO public.workspace_ai_reservation_allocations(reservation_id, lot_id, amount) VALUES (v_res, lot.id, v_take);
      v_remaining := v_remaining - v_take;
    END IF;
  END LOOP;
  UPDATE public.workspace_ai_reservations
     SET amount = COALESCE((SELECT SUM(amount) FROM public.workspace_ai_reservation_allocations WHERE reservation_id = v_res),0),
         updated_at = now()
   WHERE id = v_res;
  PERFORM public.ai_wallet_project(v_ws);
  RETURN GREATEST(COALESCE(p_delta,0),0) - v_remaining;
END;
$$;

CREATE OR REPLACE FUNCTION public.ai_release_reservation(p_reservation_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_ws uuid; a record;
BEGIN
  SELECT workspace_id INTO v_ws FROM public.workspace_ai_reservations WHERE id = p_reservation_id;
  IF v_ws IS NULL THEN RETURN; END IF;
  PERFORM public.ai_wallet_lock(v_ws);
  FOR a IN SELECT * FROM public.workspace_ai_reservation_allocations WHERE reservation_id = p_reservation_id LOOP
    UPDATE public.workspace_ai_balance_lots
       SET reserved_amount = GREATEST(reserved_amount - a.amount, 0), updated_at = now()
     WHERE id = a.lot_id;
  END LOOP;
  DELETE FROM public.workspace_ai_reservation_allocations WHERE reservation_id = p_reservation_id;
  UPDATE public.workspace_ai_reservations SET state = 'RELEASED', amount = 0, updated_at = now() WHERE id = p_reservation_id AND state = 'ACTIVE';
  PERFORM public.ai_wallet_project(v_ws);
  -- Finish any lot that was waiting on this reservation to expire.
  UPDATE public.workspace_ai_balance_lots
     SET state = 'EXPIRED', remaining_amount = 0, updated_at = now()
   WHERE workspace_id = v_ws AND state = 'EXPIRING' AND reserved_amount = 0;
  PERFORM public.ai_wallet_project(v_ws);
END;
$$;

-- ── 10. Settlement (fully atomic) ──────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.ai_settle_run(
  p_run_id uuid,
  p_command_key text,
  p_provider_cost_usd numeric,
  p_internal_cost_irr numeric,
  p_customer_charge_irr numeric,
  p_billing_cycle_id text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  r public.ai_runs; v_res uuid; v_charge numeric; v_absorbed numeric := 0;
  v_reserved numeric := 0; v_delta numeric; v_added numeric;
  v_entry uuid; v_settlement uuid; v_remaining numeric; v_take numeric; a record;
  v_cycle text; v_avail_before numeric; v_avail_after numeric; v_total numeric; v_pct integer; th integer;
BEGIN
  IF p_command_key IS NOT NULL THEN
    SELECT result_ref INTO v_settlement FROM public.ai_billing_commands WHERE idempotency_key = p_command_key;
    IF v_settlement IS NOT NULL THEN
      RETURN jsonb_build_object('settlement_id', v_settlement, 'replayed', true);
    END IF;
  END IF;

  SELECT * INTO r FROM public.ai_runs WHERE id = p_run_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'unknown_run'; END IF;

  SELECT id INTO v_settlement FROM public.ai_run_settlements WHERE run_id = p_run_id;
  IF v_settlement IS NOT NULL THEN
    RETURN jsonb_build_object('settlement_id', v_settlement, 'replayed', true);
  END IF;

  PERFORM public.ai_wallet_lock(r.workspace_id);
  v_cycle := COALESCE(p_billing_cycle_id, to_char(now(), 'YYYY-MM'));
  v_charge := GREATEST(COALESCE(p_customer_charge_irr, 0), 0);
  v_res := r.reservation_id;
  v_avail_before := public.ai_available_balance(r.workspace_id);

  IF r.mode = 'METER_ONLY' THEN
    v_charge := 0;
  END IF;

  IF v_charge > 0 AND v_res IS NOT NULL THEN
    SELECT COALESCE(amount, 0) INTO v_reserved FROM public.workspace_ai_reservations WHERE id = v_res;
    IF v_charge > v_reserved THEN
      v_delta := v_charge - v_reserved;
      v_added := public.ai_topup_reservation(p_run_id, v_delta);
      IF v_added < v_delta THEN
        -- CAP_AND_ABSORB: never create a negative balance.
        v_absorbed := v_delta - v_added;
        v_charge := v_charge - v_absorbed;
      END IF;
    END IF;
  ELSIF v_charge > 0 AND v_res IS NULL THEN
    v_absorbed := v_charge;
    v_charge := 0;
  END IF;

  INSERT INTO public.ai_run_settlements(
    run_id, workspace_id, billing_cycle_id, provider_cost_usd, internal_cost_irr,
    customer_charge_irr, platform_absorbed_amount)
  VALUES (p_run_id, r.workspace_id, v_cycle, COALESCE(p_provider_cost_usd,0), COALESCE(p_internal_cost_irr,0),
          v_charge, v_absorbed)
  RETURNING id INTO v_settlement;

  IF v_charge > 0 THEN
    INSERT INTO public.workspace_ai_ledger(workspace_id, run_id, entry_type, amount, billing_cycle_id, reason)
    VALUES (r.workspace_id, p_run_id, 'CHARGE', -v_charge, v_cycle, 'ai_run_settlement')
    RETURNING id INTO v_entry;

    v_remaining := v_charge;
    FOR a IN
      SELECT ra.lot_id, ra.amount, l.expires_at
        FROM public.workspace_ai_reservation_allocations ra
        JOIN public.workspace_ai_balance_lots l ON l.id = ra.lot_id
       WHERE ra.reservation_id = v_res
       ORDER BY (l.expires_at IS NULL), l.expires_at ASC
    LOOP
      EXIT WHEN v_remaining <= 0;
      v_take := LEAST(v_remaining, a.amount);
      UPDATE public.workspace_ai_balance_lots
         SET remaining_amount = remaining_amount - v_take,
             reserved_amount = GREATEST(reserved_amount - v_take, 0),
             state = CASE WHEN remaining_amount - v_take <= 0 THEN 'DEPLETED' ELSE state END,
             updated_at = now()
       WHERE id = a.lot_id;
      INSERT INTO public.workspace_ai_ledger_allocations(ledger_entry_id, lot_id, amount)
      VALUES (v_entry, a.lot_id, v_take);
      v_remaining := v_remaining - v_take;
    END LOOP;

    UPDATE public.ai_run_settlements SET ledger_entry_id = v_entry WHERE id = v_settlement;
    UPDATE public.workspace_ai_wallets SET lifetime_charged = lifetime_charged + v_charge, updated_at = now()
     WHERE workspace_id = r.workspace_id;
  END IF;

  IF v_res IS NOT NULL THEN
    PERFORM public.ai_release_reservation(v_res);
    UPDATE public.workspace_ai_reservations SET state = 'SETTLED', updated_at = now() WHERE id = v_res;
  END IF;

  UPDATE public.ai_runs SET
    status = 'SETTLED',
    provider_cost_usd = COALESCE(p_provider_cost_usd, 0),
    internal_cost_irr = COALESCE(p_internal_cost_irr, 0),
    customer_charge_irr = v_charge,
    platform_absorbed_amount = platform_absorbed_amount + v_absorbed,
    finished_at = now(), updated_at = now()
  WHERE id = p_run_id;

  PERFORM public.ai_wallet_project(r.workspace_id);

  -- Deduplicated threshold alerts, inside the same transaction.
  v_avail_after := public.ai_available_balance(r.workspace_id);
  SELECT COALESCE(SUM(original_amount), 0) INTO v_total
    FROM public.workspace_ai_balance_lots
   WHERE workspace_id = r.workspace_id AND billing_cycle_id = v_cycle;
  IF v_total > 0 THEN
    v_pct := FLOOR((v_avail_after / v_total) * 100);
    FOREACH th IN ARRAY ARRAY[20, 10, 0] LOOP
      IF v_pct <= th THEN
        INSERT INTO public.workspace_ai_balance_alerts(workspace_id, billing_cycle_id, threshold)
        VALUES (r.workspace_id, v_cycle, th) ON CONFLICT DO NOTHING;
      END IF;
    END LOOP;
  END IF;

  IF p_command_key IS NOT NULL THEN
    INSERT INTO public.ai_billing_commands(command_type, idempotency_key, workspace_id, run_id, result_ref)
    VALUES ('SETTLE_RUN', p_command_key, r.workspace_id, p_run_id, v_settlement)
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'settlement_id', v_settlement, 'charged', v_charge, 'absorbed', v_absorbed,
    'available_before', v_avail_before, 'available_after', v_avail_after, 'replayed', false);
END;
$$;

-- ── 11. Grants, refunds, expiry ────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.ai_grant_allowance(
  p_workspace_id uuid, p_amount numeric, p_billing_cycle_id text,
  p_allowance_source text, p_expires_at timestamptz, p_command_key text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_lot uuid; v_entry uuid;
BEGIN
  PERFORM public.ai_wallet_lock(p_workspace_id);
  IF p_command_key IS NOT NULL THEN
    SELECT result_ref INTO v_lot FROM public.ai_billing_commands WHERE idempotency_key = p_command_key;
    IF v_lot IS NOT NULL THEN RETURN v_lot; END IF;
  END IF;

  INSERT INTO public.workspace_ai_balance_lots(
    workspace_id, source_type, allowance_source, billing_cycle_id,
    original_amount, remaining_amount, expires_at)
  VALUES (p_workspace_id, 'PLAN_ALLOWANCE', COALESCE(p_allowance_source,'plan'), p_billing_cycle_id,
          GREATEST(COALESCE(p_amount,0),0), GREATEST(COALESCE(p_amount,0),0), p_expires_at)
  ON CONFLICT (workspace_id, billing_cycle_id, allowance_source) WHERE source_type = 'PLAN_ALLOWANCE'
  DO NOTHING
  RETURNING id INTO v_lot;

  IF v_lot IS NULL THEN
    SELECT id INTO v_lot FROM public.workspace_ai_balance_lots
     WHERE workspace_id = p_workspace_id AND billing_cycle_id = p_billing_cycle_id
       AND allowance_source = COALESCE(p_allowance_source,'plan') AND source_type = 'PLAN_ALLOWANCE';
  ELSE
    INSERT INTO public.workspace_ai_ledger(workspace_id, entry_type, amount, billing_cycle_id, reason)
    VALUES (p_workspace_id, 'GRANT', GREATEST(COALESCE(p_amount,0),0), p_billing_cycle_id, 'plan_allowance')
    RETURNING id INTO v_entry;
    INSERT INTO public.workspace_ai_ledger_allocations(ledger_entry_id, lot_id, amount)
    VALUES (v_entry, v_lot, GREATEST(COALESCE(p_amount,0),0));
  END IF;

  PERFORM public.ai_wallet_project(p_workspace_id);
  IF p_command_key IS NOT NULL THEN
    INSERT INTO public.ai_billing_commands(command_type, idempotency_key, workspace_id, result_ref)
    VALUES ('GRANT_ALLOWANCE', p_command_key, p_workspace_id, v_lot) ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;
  RETURN v_lot;
END;
$$;

CREATE OR REPLACE FUNCTION public.ai_purchase_credit(
  p_workspace_id uuid, p_amount numeric, p_command_key text, p_reason text DEFAULT 'purchase'
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_lot uuid; v_entry uuid;
BEGIN
  PERFORM public.ai_wallet_lock(p_workspace_id);
  IF p_command_key IS NOT NULL THEN
    SELECT result_ref INTO v_lot FROM public.ai_billing_commands WHERE idempotency_key = p_command_key;
    IF v_lot IS NOT NULL THEN RETURN v_lot; END IF;
  END IF;
  INSERT INTO public.workspace_ai_balance_lots(workspace_id, source_type, original_amount, remaining_amount)
  VALUES (p_workspace_id, 'PURCHASED', GREATEST(COALESCE(p_amount,0),0), GREATEST(COALESCE(p_amount,0),0))
  RETURNING id INTO v_lot;
  INSERT INTO public.workspace_ai_ledger(workspace_id, entry_type, amount, reason)
  VALUES (p_workspace_id, 'PURCHASE', GREATEST(COALESCE(p_amount,0),0), p_reason) RETURNING id INTO v_entry;
  INSERT INTO public.workspace_ai_ledger_allocations(ledger_entry_id, lot_id, amount)
  VALUES (v_entry, v_lot, GREATEST(COALESCE(p_amount,0),0));
  PERFORM public.ai_wallet_project(p_workspace_id);
  IF p_command_key IS NOT NULL THEN
    INSERT INTO public.ai_billing_commands(command_type, idempotency_key, workspace_id, result_ref)
    VALUES ('PURCHASE', p_command_key, p_workspace_id, v_lot) ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;
  RETURN v_lot;
END;
$$;

/**
 * Deterministic refund routing:
 *   purchased lot        → back to the same purchased lot
 *   active plan lot      → back to the same plan-allowance lot
 *   expired plan lot     → new REFUND_COMPENSATION lot, expiring at cycle end
 */
CREATE OR REPLACE FUNCTION public.ai_refund_run(
  p_run_id uuid, p_amount numeric, p_reason text, p_command_key text, p_actor uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  r public.ai_runs; v_entry uuid; v_prev uuid; v_remaining numeric; v_take numeric;
  a record; v_refunded numeric := 0; v_charged numeric; v_already numeric; v_target uuid;
  v_cycle text; v_cycle_end timestamptz;
BEGIN
  IF p_command_key IS NOT NULL THEN
    SELECT result_ref INTO v_prev FROM public.ai_billing_commands WHERE idempotency_key = p_command_key;
    IF v_prev IS NOT NULL THEN RETURN jsonb_build_object('ledger_entry_id', v_prev, 'replayed', true); END IF;
  END IF;

  SELECT * INTO r FROM public.ai_runs WHERE id = p_run_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'unknown_run'; END IF;
  PERFORM public.ai_wallet_lock(r.workspace_id);

  SELECT COALESCE(customer_charge_irr,0) INTO v_charged FROM public.ai_run_settlements WHERE run_id = p_run_id;
  IF v_charged IS NULL OR v_charged <= 0 THEN RAISE EXCEPTION 'nothing_to_refund'; END IF;
  SELECT COALESCE(SUM(amount),0) INTO v_already FROM public.workspace_ai_ledger
   WHERE run_id = p_run_id AND entry_type = 'REFUND';
  v_remaining := LEAST(GREATEST(COALESCE(p_amount,0),0), v_charged - v_already);
  IF v_remaining <= 0 THEN RAISE EXCEPTION 'refund_cap_exceeded'; END IF;

  v_cycle := to_char(now(), 'YYYY-MM');
  v_cycle_end := date_trunc('month', now()) + interval '1 month';

  INSERT INTO public.workspace_ai_ledger(workspace_id, run_id, entry_type, amount, billing_cycle_id, reason)
  VALUES (r.workspace_id, p_run_id, 'REFUND', v_remaining, v_cycle, COALESCE(p_reason,'refund'))
  RETURNING id INTO v_entry;

  FOR a IN
    SELECT la.lot_id, la.amount, l.source_type, l.state, l.expires_at, l.billing_cycle_id, l.allowance_source
      FROM public.workspace_ai_ledger_allocations la
      JOIN public.workspace_ai_ledger le ON le.id = la.ledger_entry_id
      JOIN public.workspace_ai_balance_lots l ON l.id = la.lot_id
     WHERE le.run_id = p_run_id AND le.entry_type = 'CHARGE'
     ORDER BY la.created_at ASC
  LOOP
    EXIT WHEN v_remaining <= 0;
    v_take := LEAST(v_remaining, a.amount);
    IF a.source_type = 'PLAN_ALLOWANCE'
       AND (a.state = 'EXPIRED' OR (a.expires_at IS NOT NULL AND a.expires_at <= now())) THEN
      -- Expired allowance is never resurrected; compensate inside the current cycle.
      INSERT INTO public.workspace_ai_balance_lots(
        workspace_id, source_type, billing_cycle_id, original_amount, remaining_amount, expires_at)
      VALUES (r.workspace_id, 'REFUND_COMPENSATION', v_cycle, v_take, v_take, v_cycle_end)
      RETURNING id INTO v_target;
    ELSE
      UPDATE public.workspace_ai_balance_lots
         SET remaining_amount = remaining_amount + v_take,
             state = CASE WHEN state = 'DEPLETED' THEN 'ACTIVE' ELSE state END,
             updated_at = now()
       WHERE id = a.lot_id RETURNING id INTO v_target;
    END IF;
    INSERT INTO public.workspace_ai_ledger_allocations(ledger_entry_id, lot_id, amount)
    VALUES (v_entry, v_target, v_take);
    v_refunded := v_refunded + v_take;
    v_remaining := v_remaining - v_take;
  END LOOP;

  PERFORM public.ai_wallet_project(r.workspace_id);

  INSERT INTO public.ai_billing_audit_log(actor_id, action, workspace_id, target_ref, details)
  VALUES (p_actor, 'refund_run', r.workspace_id, p_run_id,
          jsonb_build_object('amount', v_refunded, 'reason', p_reason, 'ledger_entry_id', v_entry));

  IF p_command_key IS NOT NULL THEN
    INSERT INTO public.ai_billing_commands(command_type, idempotency_key, workspace_id, run_id, result_ref)
    VALUES ('REFUND', p_command_key, r.workspace_id, p_run_id, v_entry) ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN jsonb_build_object('ledger_entry_id', v_entry, 'refunded', v_refunded, 'replayed', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.ai_adjust_balance(
  p_workspace_id uuid, p_amount numeric, p_reason text, p_command_key text, p_actor uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_lot uuid; v_entry uuid; v_prev uuid;
BEGIN
  IF p_command_key IS NOT NULL THEN
    SELECT result_ref INTO v_prev FROM public.ai_billing_commands WHERE idempotency_key = p_command_key;
    IF v_prev IS NOT NULL THEN RETURN v_prev; END IF;
  END IF;
  PERFORM public.ai_wallet_lock(p_workspace_id);
  INSERT INTO public.workspace_ai_balance_lots(workspace_id, source_type, original_amount, remaining_amount)
  VALUES (p_workspace_id, 'ADJUSTMENT', GREATEST(COALESCE(p_amount,0),0), GREATEST(COALESCE(p_amount,0),0))
  RETURNING id INTO v_lot;
  INSERT INTO public.workspace_ai_ledger(workspace_id, entry_type, amount, reason)
  VALUES (p_workspace_id, 'ADJUSTMENT', GREATEST(COALESCE(p_amount,0),0), COALESCE(p_reason,'manual_adjustment'))
  RETURNING id INTO v_entry;
  INSERT INTO public.workspace_ai_ledger_allocations(ledger_entry_id, lot_id, amount)
  VALUES (v_entry, v_lot, GREATEST(COALESCE(p_amount,0),0));
  INSERT INTO public.ai_billing_adjustments(workspace_id, amount, reason, created_by, ledger_entry_id)
  VALUES (p_workspace_id, GREATEST(COALESCE(p_amount,0),0), COALESCE(p_reason,'manual_adjustment'), p_actor, v_entry);
  PERFORM public.ai_wallet_project(p_workspace_id);
  IF p_command_key IS NOT NULL THEN
    INSERT INTO public.ai_billing_commands(command_type, idempotency_key, workspace_id, result_ref)
    VALUES ('ADJUSTMENT', p_command_key, p_workspace_id, v_entry) ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;
  INSERT INTO public.ai_billing_audit_log(actor_id, action, workspace_id, target_ref, details)
  VALUES (p_actor, 'adjust_balance', p_workspace_id, v_entry, jsonb_build_object('amount', p_amount, 'reason', p_reason));
  RETURN v_entry;
END;
$$;

CREATE OR REPLACE FUNCTION public.ai_expire_lots()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE lot record; v_free numeric; n integer := 0; v_entry uuid;
BEGIN
  FOR lot IN
    SELECT * FROM public.workspace_ai_balance_lots
     WHERE state IN ('ACTIVE','EXPIRING') AND expires_at IS NOT NULL AND expires_at <= now()
       AND remaining_amount > 0
     FOR UPDATE
  LOOP
    v_free := lot.remaining_amount - lot.reserved_amount;
    IF v_free > 0 THEN
      INSERT INTO public.workspace_ai_ledger(workspace_id, entry_type, amount, billing_cycle_id, reason)
      VALUES (lot.workspace_id, 'EXPIRATION', -v_free, lot.billing_cycle_id, 'lot_expired') RETURNING id INTO v_entry;
      INSERT INTO public.workspace_ai_ledger_allocations(ledger_entry_id, lot_id, amount)
      VALUES (v_entry, lot.id, v_free);
    END IF;
    UPDATE public.workspace_ai_balance_lots
       SET remaining_amount = lot.reserved_amount,
           state = CASE WHEN lot.reserved_amount > 0 THEN 'EXPIRING' ELSE 'EXPIRED' END,
           updated_at = now()
     WHERE id = lot.id;
    PERFORM public.ai_wallet_project(lot.workspace_id);
    n := n + 1;
  END LOOP;
  RETURN n;
END;
$$;

-- ── 12. Function ACL: service-role only ────────────────────────────────────

DO $acl$
DECLARE sig text; fn_oid oid;
BEGIN
  FOREACH sig IN ARRAY ARRAY[
    'public.ai_billing_block_mutation()',
    'public.ai_publish_rate_card(text, text, text, jsonb, uuid, text)',
    'public.ai_publish_exchange_rate(text, text, numeric, uuid)',
    'public.ai_publish_sell_policy(text, uuid, numeric, text, uuid)',
    'public.ai_wallet_lock(uuid)',
    'public.ai_wallet_project(uuid)',
    'public.ai_reconcile_wallet(uuid)',
    'public.ai_available_balance(uuid)',
    'public.ai_begin_run(uuid, text, text, text, text, uuid, text, uuid, numeric, uuid, numeric, text)',
    'public.ai_open_step(uuid, text, integer, integer, text, text)',
    'public.ai_ingest_usage_event(uuid, text, text, jsonb)',
    'public.ai_reserve(uuid, uuid, numeric, text)',
    'public.ai_topup_reservation(uuid, numeric)',
    'public.ai_release_reservation(uuid)',
    'public.ai_settle_run(uuid, text, numeric, numeric, numeric, text)',
    'public.ai_grant_allowance(uuid, numeric, text, text, timestamptz, text)',
    'public.ai_purchase_credit(uuid, numeric, text, text)',
    'public.ai_refund_run(uuid, numeric, text, text, uuid)',
    'public.ai_adjust_balance(uuid, numeric, text, text, uuid)',
    'public.ai_expire_lots()'
  ] LOOP
    fn_oid := to_regprocedure(sig);
    IF fn_oid IS NULL THEN
      RAISE EXCEPTION 'required ai-billing function missing: %', sig;
    END IF;
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn_oid::regprocedure);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn_oid::regprocedure);
  END LOOP;
END;
$acl$;
