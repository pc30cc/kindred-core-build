-- ============================================================
-- 115 — BILLING ENGINE V2, ATOMIC RPCs (Phase A)
--
-- Every money-moving or entitlement-granting operation lives here, inside a
-- single database transaction, because these are the operations where a crash
-- between two steps would create or destroy real money:
--
--   settle      : allocation + invoice status, exact amount, replay-safe
--   apply       : paid invoice → service period / AI credit, ONCE per invoice
--   activate    : scheduled period → active + exactly one plan AI allowance
--   wallet      : deposit / pay / refund / admin adjust, ledger + cache in sync
--
-- Rules obeyed by all of them:
--   * No JavaScript arithmetic on money. The server passes intent; SQL computes.
--   * Amounts are BIGINT IRR. No floats anywhere.
--   * Every entry point takes a durable command key and is safe to replay.
--   * Locks are taken in a fixed order (workspace wallet → invoice) to avoid
--     deadlocks under concurrent gateway callbacks.
--   * SECURITY DEFINER + pinned search_path + service-role-only EXECUTE.
-- ============================================================

-- ─── helper: lock the wallet row, creating it on first touch ──────────────
CREATE OR REPLACE FUNCTION public.billing_wallet_lock(p_workspace_id UUID)
RETURNS public.billing_wallet_accounts
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_row public.billing_wallet_accounts;
BEGIN
  INSERT INTO public.billing_wallet_accounts (workspace_id)
  VALUES (p_workspace_id)
  ON CONFLICT (workspace_id) DO NOTHING;

  SELECT * INTO v_row FROM public.billing_wallet_accounts
   WHERE workspace_id = p_workspace_id FOR UPDATE;
  RETURN v_row;
END;
$$;

-- ─── helper: append a wallet ledger entry and re-sync the cache ───────────
CREATE OR REPLACE FUNCTION public.billing_wallet_append(
  p_workspace_id UUID,
  p_entry_type   TEXT,
  p_amount_irr   BIGINT,      -- signed
  p_command_key  TEXT,
  p_reason       TEXT DEFAULT NULL,
  p_invoice_id   UUID DEFAULT NULL,
  p_payment_id   UUID DEFAULT NULL,
  p_deposit_id   UUID DEFAULT NULL,
  p_actor_id     UUID DEFAULT NULL,
  p_metadata     JSONB DEFAULT '{}'::jsonb
) RETURNS public.billing_wallet_ledger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_wallet  public.billing_wallet_accounts;
  v_entry   public.billing_wallet_ledger;
  v_balance BIGINT;
BEGIN
  IF p_command_key IS NULL OR length(p_command_key) = 0 THEN
    RAISE EXCEPTION 'wallet_command_key_required';
  END IF;

  -- Replay: return the original entry, move no money.
  SELECT * INTO v_entry FROM public.billing_wallet_ledger WHERE command_key = p_command_key;
  IF v_entry.id IS NOT NULL THEN
    RETURN v_entry;
  END IF;

  v_wallet := public.billing_wallet_lock(p_workspace_id);
  IF v_wallet.frozen AND p_amount_irr < 0 THEN
    RAISE EXCEPTION 'wallet_frozen:%', p_workspace_id;
  END IF;

  v_balance := v_wallet.available_balance_irr + p_amount_irr;
  IF v_balance < 0 THEN
    RAISE EXCEPTION 'wallet_insufficient_funds:%', p_workspace_id
      USING HINT = 'Wallet balance may never go negative. Fail closed and ask for a gateway payment.';
  END IF;

  INSERT INTO public.billing_wallet_ledger (
    workspace_id, entry_type, amount_irr, balance_after_irr,
    invoice_id, payment_id, wallet_deposit_id, command_key, reason, actor_id, metadata
  ) VALUES (
    p_workspace_id, p_entry_type, p_amount_irr, v_balance,
    p_invoice_id, p_payment_id, p_deposit_id, p_command_key, p_reason, p_actor_id,
    COALESCE(p_metadata, '{}'::jsonb)
  )
  RETURNING * INTO v_entry;

  UPDATE public.billing_wallet_accounts
     SET available_balance_irr = v_balance, updated_at = now()
   WHERE workspace_id = p_workspace_id;

  RETURN v_entry;
END;
$$;

-- ─── 1. Settle an invoice ─────────────────────────────────────────────────
-- Exact-amount only for gateway money (V1 policy): the verified gateway amount
-- must equal the invoice's outstanding amount. Anything else fails closed and
-- the caller parks the payment as `unapplied` for reconciliation.
CREATE OR REPLACE FUNCTION public.billing_settle_invoice(
  p_invoice_id     UUID,
  p_amount_irr     BIGINT,
  p_source         TEXT,           -- 'gateway' | 'wallet' | 'admin'
  p_command_key    TEXT,
  p_payment_id     UUID DEFAULT NULL,
  p_wallet_entry_id UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_inv        public.billing_invoices;
  v_alloc      public.billing_payment_allocations;
  v_paid       BIGINT;
  v_due        BIGINT;
  v_status     TEXT;
BEGIN
  IF p_command_key IS NULL OR length(p_command_key) = 0 THEN
    RAISE EXCEPTION 'settlement_command_key_required';
  END IF;
  IF p_amount_irr IS NULL OR p_amount_irr <= 0 THEN
    RAISE EXCEPTION 'settlement_amount_invalid';
  END IF;

  -- Replay: identical command → identical outcome, no double allocation.
  SELECT * INTO v_alloc FROM public.billing_payment_allocations WHERE command_key = p_command_key;
  IF v_alloc.id IS NOT NULL THEN
    SELECT * INTO v_inv FROM public.billing_invoices WHERE id = v_alloc.invoice_id;
    RETURN jsonb_build_object(
      'invoice_id', v_inv.id, 'status', v_inv.status,
      'amount_paid_irr', v_inv.amount_paid_irr, 'amount_due_irr', v_inv.amount_due_irr,
      'allocation_id', v_alloc.id, 'replayed', true
    );
  END IF;

  SELECT * INTO v_inv FROM public.billing_invoices WHERE id = p_invoice_id FOR UPDATE;
  IF v_inv.id IS NULL THEN
    RAISE EXCEPTION 'unknown_invoice:%', p_invoice_id;
  END IF;

  IF v_inv.status NOT IN ('open', 'partially_paid', 'past_due') THEN
    RAISE EXCEPTION 'invoice_not_payable:%:%', v_inv.id, v_inv.status
      USING HINT = 'Money that arrives for a non-payable invoice must be parked as unapplied, never silently consumed.';
  END IF;

  -- V1 gateway policy: exact amount, fail closed.
  IF p_source = 'gateway' AND p_amount_irr <> v_inv.amount_due_irr THEN
    RAISE EXCEPTION 'invoice_amount_mismatch:%:%:%', v_inv.id, v_inv.amount_due_irr, p_amount_irr;
  END IF;

  IF p_amount_irr > v_inv.amount_due_irr THEN
    RAISE EXCEPTION 'invoice_overpayment:%:%:%', v_inv.id, v_inv.amount_due_irr, p_amount_irr;
  END IF;

  INSERT INTO public.billing_payment_allocations (
    invoice_id, workspace_id, payment_id, wallet_ledger_entry_id, amount_irr, command_key
  ) VALUES (
    v_inv.id, v_inv.workspace_id, p_payment_id, p_wallet_entry_id, p_amount_irr, p_command_key
  )
  RETURNING * INTO v_alloc;

  v_paid := v_inv.amount_paid_irr + p_amount_irr;
  v_due  := v_inv.total_irr - v_paid;
  v_status := CASE WHEN v_due = 0 THEN 'paid' ELSE 'partially_paid' END;

  UPDATE public.billing_invoices
     SET amount_paid_irr = v_paid,
         amount_due_irr  = v_due,
         status          = v_status,
         paid_at         = CASE WHEN v_due = 0 THEN COALESCE(paid_at, now()) ELSE paid_at END,
         past_due_at     = CASE WHEN v_due = 0 THEN NULL ELSE past_due_at END,
         updated_at      = now()
   WHERE id = v_inv.id;

  IF p_payment_id IS NOT NULL THEN
    UPDATE public.billing_payments
       SET invoice_id = v_inv.id,
           reconciliation_state = 'settled',
           reconciliation_reason = NULL
     WHERE id = p_payment_id;
  END IF;

  RETURN jsonb_build_object(
    'invoice_id', v_inv.id, 'status', v_status,
    'amount_paid_irr', v_paid, 'amount_due_irr', v_due,
    'allocation_id', v_alloc.id, 'fully_paid', v_due = 0, 'replayed', false
  );
END;
$$;

-- ─── 2. Apply a paid invoice's effects ────────────────────────────────────
-- Reads ONLY `effect_snapshot`, frozen when the invoice was issued. A later
-- price or plan-definition change cannot alter what the customer bought.
CREATE OR REPLACE FUNCTION public.billing_apply_invoice_effects(p_invoice_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_inv      public.billing_invoices;
  v_app      public.billing_invoice_applications;
  v_snap     JSONB;
  v_sub      public.workspace_subscriptions;
  v_period   public.billing_subscription_periods;
  v_period_id UUID;
  v_start    TIMESTAMPTZ;
  v_end      TIMESTAMPTZ;
  v_activate BOOLEAN;
  v_lot      UUID;
  v_type     TEXT;
BEGIN
  SELECT * INTO v_inv FROM public.billing_invoices WHERE id = p_invoice_id FOR UPDATE;
  IF v_inv.id IS NULL THEN
    RAISE EXCEPTION 'unknown_invoice:%', p_invoice_id;
  END IF;
  IF v_inv.status <> 'paid' THEN
    RAISE EXCEPTION 'invoice_not_paid:%:%', v_inv.id, v_inv.status;
  END IF;

  -- Exactly-once, durably: the unique index on invoice_id is the guard.
  SELECT * INTO v_app FROM public.billing_invoice_applications WHERE invoice_id = v_inv.id;
  IF v_app.id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'invoice_id', v_inv.id, 'application_id', v_app.id,
      'period_id', v_app.period_id, 'replayed', true
    );
  END IF;

  v_snap := COALESCE(v_inv.effect_snapshot, '{}'::jsonb);

  -- ── AI credit purchase: no service period, one purchased lot ──
  IF v_inv.invoice_type = 'ai_credit_purchase' THEN
    v_lot := public.ai_purchase_credit(
      v_inv.workspace_id,
      COALESCE((v_snap->>'ai_credit_amount_irr')::numeric, v_inv.total_irr::numeric),
      'invoice:' || v_inv.id::text,            -- invoice-scoped command key
      'invoice_' || v_inv.invoice_number
    );

    INSERT INTO public.billing_invoice_applications (
      invoice_id, workspace_id, application_type, result_snapshot
    ) VALUES (
      v_inv.id, v_inv.workspace_id, 'ai_credit_purchase',
      jsonb_build_object('lot_id', v_lot, 'amount_irr', v_inv.total_irr)
    )
    RETURNING * INTO v_app;

    RETURN jsonb_build_object(
      'invoice_id', v_inv.id, 'application_id', v_app.id,
      'lot_id', v_lot, 'replayed', false
    );
  END IF;

  -- ── Subscription invoice: create the service period ──
  SELECT * INTO v_sub FROM public.workspace_subscriptions
   WHERE workspace_id = v_inv.workspace_id FOR UPDATE;

  v_start := COALESCE(
    (v_snap->>'period_start')::timestamptz,
    v_inv.period_start,
    now()
  );
  v_end := COALESCE(
    (v_snap->>'period_end')::timestamptz,
    v_inv.period_end,
    v_start + interval '1 month'
  );

  -- Paying early must never start service early: a future window is scheduled
  -- and its allowance is granted only at activation.
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
    v_start, v_end,
    CASE WHEN v_activate THEN 'scheduled' ELSE 'scheduled' END,
    'invoice',
    COALESCE(v_snap->'plan_snapshot', '{}'::jsonb),
    COALESCE(v_snap->'limits_snapshot', '{}'::jsonb),
    GREATEST(COALESCE((v_snap->>'ai_allowance_irr')::bigint, 0), 0)
  )
  RETURNING * INTO v_period;

  v_period_id := v_period.id;
  v_type := COALESCE(v_snap->>'action_type', v_inv.invoice_type);

  INSERT INTO public.billing_invoice_applications (
    invoice_id, workspace_id, application_type, period_id, result_snapshot
  ) VALUES (
    v_inv.id, v_inv.workspace_id, v_type, v_period_id,
    jsonb_build_object(
      'period_start', v_start, 'period_end', v_end,
      'scheduled_only', NOT v_activate
    )
  )
  RETURNING * INTO v_app;

  -- Activate immediately when the window has already begun.
  IF v_activate THEN
    PERFORM public.billing_activate_period(v_period_id);
  END IF;

  RETURN jsonb_build_object(
    'invoice_id', v_inv.id, 'application_id', v_app.id,
    'period_id', v_period_id, 'activated', v_activate, 'replayed', false
  );
END;
$$;

-- ─── 3. Activate a service period (grants entitlements + AI allowance) ────
-- The ONLY place a plan AI allowance is created in V2. The allowance command
-- key is bound to the period id, so a calendar rollover, a replay or an early
-- renewal can never produce a second grant.
CREATE OR REPLACE FUNCTION public.billing_activate_period(p_period_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_period public.billing_subscription_periods;
  v_lot    UUID;
BEGIN
  SELECT * INTO v_period FROM public.billing_subscription_periods
   WHERE id = p_period_id FOR UPDATE;
  IF v_period.id IS NULL THEN
    RAISE EXCEPTION 'unknown_period:%', p_period_id;
  END IF;

  IF v_period.status = 'active' THEN
    RETURN jsonb_build_object('period_id', v_period.id, 'replayed', true);
  END IF;
  IF v_period.status <> 'scheduled' THEN
    RAISE EXCEPTION 'period_not_activatable:%:%', v_period.id, v_period.status;
  END IF;

  -- Close whatever was running; the partial unique index guarantees one active
  -- period per workspace, so this must happen in the same transaction.
  UPDATE public.billing_subscription_periods
     SET status = 'completed', completed_at = now()
   WHERE workspace_id = v_period.workspace_id
     AND status = 'active'
     AND id <> v_period.id;

  UPDATE public.billing_subscription_periods
     SET status = 'active', activated_at = now()
   WHERE id = v_period.id;

  -- Entitlement contract follows the period.
  UPDATE public.workspace_subscriptions
     SET plan_id              = COALESCE(v_period.plan_id, plan_id),
         status               = 'active',
         current_period_id    = v_period.id,
         current_period_start = v_period.period_start,
         current_period_end   = v_period.period_end,
         billing_interval     = v_period.billing_interval,
         next_invoice_at      = v_period.period_end,
         past_due_since       = NULL,
         grace_period_ends_at = NULL,
         free_fallback_at     = NULL,
         pending_change_type  = NULL,
         next_plan_id         = NULL,
         billing_engine_version = 'v2',
         billing_v2_effective_at = COALESCE(billing_v2_effective_at, now()),
         updated_at           = now()
   WHERE workspace_id = v_period.workspace_id;

  -- Exactly one plan allowance per period.
  IF v_period.ai_allowance_irr > 0 THEN
    v_lot := public.ai_grant_allowance(
      v_period.workspace_id,
      v_period.ai_allowance_irr::numeric,
      'period:' || v_period.id::text,   -- period-bound cycle id, NOT 'YYYY-MM'
      'plan',
      v_period.period_end,
      'plan_allowance:' || v_period.id::text
    );
  END IF;

  RETURN jsonb_build_object(
    'period_id', v_period.id, 'lot_id', v_lot,
    'allowance_irr', v_period.ai_allowance_irr, 'replayed', false
  );
END;
$$;

-- Worker entry point: activate every scheduled period whose window has begun.
CREATE OR REPLACE FUNCTION public.billing_activate_due_periods(p_limit INTEGER DEFAULT 50)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE r RECORD; v_count INTEGER := 0;
BEGIN
  FOR r IN
    SELECT id FROM public.billing_subscription_periods
     WHERE status = 'scheduled' AND period_start <= now()
     ORDER BY period_start
     LIMIT GREATEST(COALESCE(p_limit, 50), 1)
  LOOP
    PERFORM public.billing_activate_period(r.id);
    v_count := v_count + 1;
  END LOOP;
  RETURN jsonb_build_object('activated', v_count);
END;
$$;

-- ─── 4. Wallet operations ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.billing_wallet_apply_deposit(
  p_deposit_id  UUID,
  p_amount_irr  BIGINT,
  p_payment_id  UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_dep   public.billing_wallet_deposits;
  v_entry public.billing_wallet_ledger;
BEGIN
  SELECT * INTO v_dep FROM public.billing_wallet_deposits WHERE id = p_deposit_id FOR UPDATE;
  IF v_dep.id IS NULL THEN
    RAISE EXCEPTION 'unknown_wallet_deposit:%', p_deposit_id;
  END IF;
  IF v_dep.status = 'paid' THEN
    SELECT * INTO v_entry FROM public.billing_wallet_ledger
     WHERE command_key = 'deposit:' || v_dep.id::text;
    RETURN jsonb_build_object('deposit_id', v_dep.id, 'entry_id', v_entry.id, 'replayed', true);
  END IF;
  IF v_dep.status <> 'pending' THEN
    RAISE EXCEPTION 'wallet_deposit_not_payable:%:%', v_dep.id, v_dep.status;
  END IF;
  IF p_amount_irr <> v_dep.amount_irr THEN
    RAISE EXCEPTION 'wallet_deposit_amount_mismatch:%:%:%', v_dep.id, v_dep.amount_irr, p_amount_irr;
  END IF;

  v_entry := public.billing_wallet_append(
    v_dep.workspace_id, 'deposit', v_dep.amount_irr,
    'deposit:' || v_dep.id::text, 'wallet_deposit',
    NULL, p_payment_id, v_dep.id
  );

  UPDATE public.billing_wallet_deposits
     SET status = 'paid', paid_at = now(), payment_id = COALESCE(p_payment_id, payment_id)
   WHERE id = v_dep.id;

  RETURN jsonb_build_object(
    'deposit_id', v_dep.id, 'entry_id', v_entry.id,
    'balance_after_irr', v_entry.balance_after_irr, 'replayed', false
  );
END;
$$;

-- Pay an invoice from wallet balance. Debit and settlement are one transaction:
-- a debited wallet with an unsettled invoice is impossible.
CREATE OR REPLACE FUNCTION public.billing_wallet_pay_invoice(
  p_invoice_id UUID,
  p_actor_id   UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_inv    public.billing_invoices;
  v_entry  public.billing_wallet_ledger;
  v_amount BIGINT;
  v_result JSONB;
BEGIN
  SELECT * INTO v_inv FROM public.billing_invoices WHERE id = p_invoice_id;
  IF v_inv.id IS NULL THEN
    RAISE EXCEPTION 'unknown_invoice:%', p_invoice_id;
  END IF;
  IF v_inv.status NOT IN ('open', 'partially_paid', 'past_due') THEN
    RAISE EXCEPTION 'invoice_not_payable:%:%', v_inv.id, v_inv.status;
  END IF;

  v_amount := v_inv.amount_due_irr;
  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'invoice_nothing_due:%', v_inv.id;
  END IF;

  -- Wallet lock first, then invoice lock inside settle — fixed order, no deadlock.
  v_entry := public.billing_wallet_append(
    v_inv.workspace_id, 'invoice_payment', -v_amount,
    'invoice_payment:' || v_inv.id::text, 'wallet_invoice_payment',
    v_inv.id, NULL, NULL, p_actor_id
  );

  v_result := public.billing_settle_invoice(
    v_inv.id, v_amount, 'wallet',
    'wallet_settle:' || v_inv.id::text, NULL, v_entry.id
  );

  RETURN v_result || jsonb_build_object('wallet_entry_id', v_entry.id);
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_wallet_refund(
  p_workspace_id UUID,
  p_amount_irr   BIGINT,
  p_command_key  TEXT,
  p_reason       TEXT DEFAULT 'refund',
  p_actor_id     UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_entry public.billing_wallet_ledger;
BEGIN
  IF p_amount_irr <= 0 THEN RAISE EXCEPTION 'refund_amount_invalid'; END IF;
  v_entry := public.billing_wallet_append(
    p_workspace_id, 'refund', -p_amount_irr, p_command_key, p_reason,
    NULL, NULL, NULL, p_actor_id
  );
  RETURN jsonb_build_object('entry_id', v_entry.id, 'balance_after_irr', v_entry.balance_after_irr);
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_wallet_admin_adjust(
  p_workspace_id UUID,
  p_amount_irr   BIGINT,          -- signed
  p_command_key  TEXT,
  p_reason       TEXT,
  p_actor_id     UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_entry public.billing_wallet_ledger;
BEGIN
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'admin_adjustment_reason_required'
      USING HINT = 'Every manual money movement must carry an auditable reason and actor.';
  END IF;
  v_entry := public.billing_wallet_append(
    p_workspace_id, 'admin_adjustment', p_amount_irr, p_command_key, p_reason,
    NULL, NULL, NULL, p_actor_id
  );
  RETURN jsonb_build_object('entry_id', v_entry.id, 'balance_after_irr', v_entry.balance_after_irr);
END;
$$;

-- ─── 5. Reconciliation read model ─────────────────────────────────────────
-- Recomputes the wallet balance from the append-only ledger and reports drift
-- against the cache. Used by tests and by the finance audit screen.
CREATE OR REPLACE FUNCTION public.billing_wallet_reconcile(p_workspace_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_ledger BIGINT; v_cache BIGINT;
BEGIN
  SELECT COALESCE(SUM(amount_irr), 0) INTO v_ledger
    FROM public.billing_wallet_ledger WHERE workspace_id = p_workspace_id;
  SELECT COALESCE(available_balance_irr, 0) INTO v_cache
    FROM public.billing_wallet_accounts WHERE workspace_id = p_workspace_id;
  RETURN jsonb_build_object(
    'ledger_balance_irr', v_ledger,
    'cached_balance_irr', COALESCE(v_cache, 0),
    'drift_irr', COALESCE(v_cache, 0) - v_ledger,
    'consistent', COALESCE(v_cache, 0) = v_ledger
  );
END;
$$;

-- ─── 6. ACL: financial RPCs are service-role only ─────────────────────────
DO $$
DECLARE f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.billing_wallet_lock(uuid)',
    'public.billing_wallet_append(uuid, text, bigint, text, text, uuid, uuid, uuid, uuid, jsonb)',
    'public.billing_settle_invoice(uuid, bigint, text, text, uuid, uuid)',
    'public.billing_apply_invoice_effects(uuid)',
    'public.billing_activate_period(uuid)',
    'public.billing_activate_due_periods(integer)',
    'public.billing_wallet_apply_deposit(uuid, bigint, uuid)',
    'public.billing_wallet_pay_invoice(uuid, uuid)',
    'public.billing_wallet_refund(uuid, bigint, text, text, uuid)',
    'public.billing_wallet_admin_adjust(uuid, bigint, text, text, uuid)',
    'public.billing_wallet_reconcile(uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
    END IF;
  END LOOP;
END $$;

-- ============================================================
-- 7. PHASE A HARDENING — collection reservation, crash recovery,
--    legacy→V2 allowance handover.
--
-- Everything below REPLACES the corresponding function defined earlier in
-- this same migration (same signature, so there is exactly one overload and
-- one ACL entry per function). It is kept at the end of the file, rather than
-- edited in place above, so the intent of each hardening step stays readable.
-- ============================================================

-- ─── 7.1 Collection reservation ───────────────────────────────────────────

/** Releases collection reservations whose checkout window has elapsed. */
CREATE OR REPLACE FUNCTION public.billing_expire_stale_collections(p_invoice_id UUID DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_count INTEGER;
BEGIN
  UPDATE public.billing_invoice_collections
     SET status = 'expired', released_at = now(), release_reason = 'expired'
   WHERE status = 'active'
     AND expires_at <= now()
     AND (p_invoice_id IS NULL OR invoice_id = p_invoice_id);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

/**
 * Reserves the right to collect an invoice through ONE channel.
 *
 * A live gateway checkout therefore blocks wallet auto-pay, and an in-flight
 * wallet settlement blocks a new gateway checkout, without either side having
 * to trust the other's timing. Closing the browser releases nothing — only an
 * explicit release, a consumed settlement or the expiry does.
 */
CREATE OR REPLACE FUNCTION public.billing_begin_collection(
  p_invoice_id  UUID,
  p_channel     TEXT,
  p_amount_irr  BIGINT,
  p_command_key TEXT,
  p_intent_id   UUID DEFAULT NULL,
  p_ttl_seconds INTEGER DEFAULT 1800
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
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

  -- Replay of the same checkout creation returns the same reservation.
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
$$;

CREATE OR REPLACE FUNCTION public.billing_release_collection(
  p_collection_id UUID,
  p_reason        TEXT DEFAULT 'released'
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_col public.billing_invoice_collections;
BEGIN
  UPDATE public.billing_invoice_collections
     SET status = 'released', released_at = now(), release_reason = COALESCE(p_reason, 'released')
   WHERE id = p_collection_id AND status = 'active'
  RETURNING * INTO v_col;
  RETURN jsonb_build_object('collection_id', p_collection_id, 'released', v_col.id IS NOT NULL);
END;
$$;

-- ─── 7.2 Settlement, now reservation-aware and recovery-creating ──────────
CREATE OR REPLACE FUNCTION public.billing_settle_invoice(
  p_invoice_id     UUID,
  p_amount_irr     BIGINT,
  p_source         TEXT,
  p_command_key    TEXT,
  p_payment_id     UUID DEFAULT NULL,
  p_wallet_entry_id UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_inv    public.billing_invoices;
  v_alloc  public.billing_payment_allocations;
  v_col    public.billing_invoice_collections;
  v_paid   BIGINT;
  v_due    BIGINT;
  v_status TEXT;
BEGIN
  IF p_command_key IS NULL OR length(p_command_key) = 0 THEN
    RAISE EXCEPTION 'settlement_command_key_required';
  END IF;
  IF p_amount_irr IS NULL OR p_amount_irr <= 0 THEN
    RAISE EXCEPTION 'settlement_amount_invalid';
  END IF;

  SELECT * INTO v_alloc FROM public.billing_payment_allocations WHERE command_key = p_command_key;
  IF v_alloc.id IS NOT NULL THEN
    SELECT * INTO v_inv FROM public.billing_invoices WHERE id = v_alloc.invoice_id;
    RETURN jsonb_build_object(
      'invoice_id', v_inv.id, 'status', v_inv.status,
      'amount_paid_irr', v_inv.amount_paid_irr, 'amount_due_irr', v_inv.amount_due_irr,
      'allocation_id', v_alloc.id, 'fully_paid', v_inv.status = 'paid', 'replayed', true
    );
  END IF;

  SELECT * INTO v_inv FROM public.billing_invoices WHERE id = p_invoice_id FOR UPDATE;
  IF v_inv.id IS NULL THEN
    RAISE EXCEPTION 'unknown_invoice:%', p_invoice_id;
  END IF;
  IF v_inv.status NOT IN ('open', 'partially_paid', 'past_due') THEN
    RAISE EXCEPTION 'invoice_not_payable:%:%', v_inv.id, v_inv.status
      USING HINT = 'Money that arrives for a non-payable invoice must be parked as unapplied, never silently consumed.';
  END IF;

  PERFORM public.billing_expire_stale_collections(v_inv.id);

  -- The reservation — not the momentary amount_due — is the amount authority
  -- for a channel that reserved the invoice.
  SELECT * INTO v_col FROM public.billing_invoice_collections
   WHERE invoice_id = v_inv.id AND status = 'active' FOR UPDATE;

  IF v_col.id IS NOT NULL THEN
    IF v_col.channel <> p_source THEN
      RAISE EXCEPTION 'invoice_collection_conflict:%:%:%', v_inv.id, v_col.channel, p_source
        USING HINT = 'Another channel holds the collection reservation for this invoice.';
    END IF;
    IF p_amount_irr <> v_col.amount_irr THEN
      RAISE EXCEPTION 'invoice_amount_mismatch:%:%:%', v_inv.id, v_col.amount_irr, p_amount_irr;
    END IF;
  ELSIF p_source = 'gateway' AND p_amount_irr <> v_inv.amount_due_irr THEN
    RAISE EXCEPTION 'invoice_amount_mismatch:%:%:%', v_inv.id, v_inv.amount_due_irr, p_amount_irr;
  END IF;

  IF p_amount_irr > v_inv.amount_due_irr THEN
    RAISE EXCEPTION 'invoice_overpayment:%:%:%', v_inv.id, v_inv.amount_due_irr, p_amount_irr;
  END IF;

  INSERT INTO public.billing_payment_allocations (
    invoice_id, workspace_id, payment_id, wallet_ledger_entry_id, amount_irr, command_key
  ) VALUES (
    v_inv.id, v_inv.workspace_id, p_payment_id, p_wallet_entry_id, p_amount_irr, p_command_key
  )
  RETURNING * INTO v_alloc;

  v_paid := v_inv.amount_paid_irr + p_amount_irr;
  v_due  := v_inv.total_irr - v_paid;
  v_status := CASE WHEN v_due = 0 THEN 'paid' ELSE 'partially_paid' END;

  UPDATE public.billing_invoices
     SET amount_paid_irr = v_paid,
         amount_due_irr  = v_due,
         status          = v_status,
         paid_at         = CASE WHEN v_due = 0 THEN COALESCE(paid_at, now()) ELSE paid_at END,
         past_due_at     = CASE WHEN v_due = 0 THEN NULL ELSE past_due_at END,
         updated_at      = now()
   WHERE id = v_inv.id;

  IF v_col.id IS NOT NULL THEN
    UPDATE public.billing_invoice_collections
       SET status = CASE WHEN v_due = 0 THEN 'consumed' ELSE 'consumed' END,
           released_at = now(), release_reason = 'settled'
     WHERE id = v_col.id;
  END IF;

  IF p_payment_id IS NOT NULL THEN
    UPDATE public.billing_payments
       SET invoice_id = v_inv.id,
           reconciliation_state = 'settled',
           reconciliation_reason = NULL
     WHERE id = p_payment_id;
  END IF;

  -- CRASH SAFETY: the work item for the effects is created in the SAME
  -- transaction that made the invoice paid. A process that dies right after
  -- this commit leaves a durable `pending` row for the recovery loop.
  IF v_due = 0 THEN
    INSERT INTO public.billing_invoice_applications (
      invoice_id, workspace_id, application_type, application_status
    ) VALUES (
      v_inv.id, v_inv.workspace_id,
      COALESCE(v_inv.effect_snapshot->>'action_type', v_inv.invoice_type),
      'pending'
    )
    ON CONFLICT (invoice_id) DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'invoice_id', v_inv.id, 'status', v_status,
    'amount_paid_irr', v_paid, 'amount_due_irr', v_due,
    'allocation_id', v_alloc.id, 'fully_paid', v_due = 0, 'replayed', false
  );
END;
$$;

-- ─── 7.3 Effects, driven by the durable application state machine ─────────
CREATE OR REPLACE FUNCTION public.billing_apply_invoice_effects(p_invoice_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
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

  -- Ensure the durable work item exists (settlement normally created it).
  INSERT INTO public.billing_invoice_applications (
    invoice_id, workspace_id, application_type, application_status
  ) VALUES (v_inv.id, v_inv.workspace_id, v_type, 'pending')
  ON CONFLICT (invoice_id) DO NOTHING;

  SELECT * INTO v_app FROM public.billing_invoice_applications
   WHERE invoice_id = v_inv.id FOR UPDATE;

  -- Exactly once, forever.
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

  -- ── AI credit purchase: no service period, one purchased lot ──
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

  -- ── Subscription invoice: create the service period ──
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
$$;

/**
 * Recovery loop: every paid-but-unapplied invoice, retried.
 *
 * This is what turns "the process crashed between settlement and effects"
 * from a support ticket into a transient state. A failure is recorded on the
 * work item and retried later; it can never become permanent silence.
 */
CREATE OR REPLACE FUNCTION public.billing_recover_unapplied_invoices(p_limit INTEGER DEFAULT 25)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  r         RECORD;
  v_ok      INTEGER := 0;
  v_failed  INTEGER := 0;
BEGIN
  FOR r IN
    SELECT i.id
      FROM public.billing_invoices i
      LEFT JOIN public.billing_invoice_applications a ON a.invoice_id = i.id
     WHERE i.status = 'paid'
       AND (a.id IS NULL OR (a.application_status <> 'applied' AND a.next_attempt_at <= now()))
     ORDER BY i.paid_at NULLS FIRST
     LIMIT GREATEST(COALESCE(p_limit, 25), 1)
  LOOP
    BEGIN
      PERFORM public.billing_apply_invoice_effects(r.id);
      v_ok := v_ok + 1;
    EXCEPTION WHEN OTHERS THEN
      -- The failed attempt's own work is rolled back to this savepoint; the
      -- failure record below is what survives.
      v_failed := v_failed + 1;
      UPDATE public.billing_invoice_applications
         SET application_status = 'failed',
             last_error         = left(SQLERRM, 500),
             lease_until        = NULL,
             next_attempt_at    = now() + interval '5 minutes'
       WHERE invoice_id = r.id AND application_status <> 'applied';
    END;
  END LOOP;
  RETURN jsonb_build_object('applied', v_ok, 'failed', v_failed);
END;
$$;

-- ─── 7.4 Legacy → V2 AI allowance handover ────────────────────────────────

/**
 * TRUE while the legacy calendar-month allowance is still the authority for a
 * workspace: until its FIRST V2 service period activates.
 *
 * This is the whole transition contract. A workspace that never opened the
 * summary screen this month keeps getting its legacy monthly grant (it is
 * never left without entitlement), and the moment a V2 period takes over, the
 * legacy path switches off for good (it can never be granted twice).
 */
CREATE OR REPLACE FUNCTION public.billing_legacy_allowance_active(p_workspace_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    (SELECT v2_allowance_effective_period_id IS NULL
       FROM public.workspace_subscriptions
      WHERE workspace_id = p_workspace_id),
    true
  );
$$;

/**
 * Retires the legacy calendar allowance when a V2 period takes over mid-month.
 *
 * Without this, an immediate upgrade would leave the customer holding both the
 * legacy month lot and the new period's full allowance for the overlapping
 * days. The unreserved remainder of the legacy lot is expired (reserved
 * amounts are left alone so an in-flight AI run is never invalidated); the V2
 * period then grants its full allowance.
 */
CREATE OR REPLACE FUNCTION public.billing_retire_legacy_allowance(p_workspace_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE lot RECORD; v_free NUMERIC; v_entry UUID; n INTEGER := 0;
BEGIN
  FOR lot IN
    SELECT * FROM public.workspace_ai_balance_lots
     WHERE workspace_id = p_workspace_id
       AND source_type = 'PLAN_ALLOWANCE'
       AND state IN ('ACTIVE', 'EXPIRING')
       AND billing_cycle_id IS NOT NULL
       AND billing_cycle_id NOT LIKE 'period:%'    -- legacy calendar lots only
       AND remaining_amount > 0
     FOR UPDATE
  LOOP
    v_free := lot.remaining_amount - lot.reserved_amount;
    IF v_free > 0 THEN
      INSERT INTO public.workspace_ai_ledger(workspace_id, entry_type, amount, billing_cycle_id, reason)
      VALUES (lot.workspace_id, 'EXPIRATION', -v_free, lot.billing_cycle_id, 'legacy_allowance_superseded')
      RETURNING id INTO v_entry;
      INSERT INTO public.workspace_ai_ledger_allocations(ledger_entry_id, lot_id, amount)
      VALUES (v_entry, lot.id, v_free);
    END IF;
    UPDATE public.workspace_ai_balance_lots
       SET remaining_amount = lot.reserved_amount,
           state = CASE WHEN lot.reserved_amount > 0 THEN 'EXPIRING' ELSE 'EXPIRED' END,
           updated_at = now()
     WHERE id = lot.id;
    n := n + 1;
  END LOOP;
  IF n > 0 THEN PERFORM public.ai_wallet_project(p_workspace_id); END IF;
  RETURN n;
END;
$$;

-- ─── 7.5 Period activation, legacy-aware ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.billing_activate_period(p_period_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_period    public.billing_subscription_periods;
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
    RETURN jsonb_build_object('period_id', v_period.id, 'replayed', true);
  END IF;
  IF v_period.status <> 'scheduled' THEN
    RAISE EXCEPTION 'period_not_activatable:%:%', v_period.id, v_period.status;
  END IF;

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

  -- A V2 period supersedes the legacy calendar allowance: retire whatever is
  -- left of it BEFORE granting, so the two never overlap.
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
         next_invoice_at      = v_period.period_end,
         past_due_since       = NULL,
         grace_period_ends_at = NULL,
         free_fallback_at     = NULL,
         pending_change_type  = NULL,
         next_plan_id         = NULL,
         billing_engine_version = 'v2',
         billing_v2_effective_at = CASE
           WHEN v_period.source = 'invoice' THEN COALESCE(billing_v2_effective_at, now())
           ELSE billing_v2_effective_at END,
         -- The handover marker: once set, the legacy monthly grant is off.
         v2_allowance_effective_period_id = CASE
           WHEN v_period.source = 'invoice'
             THEN COALESCE(v2_allowance_effective_period_id, v_period.id)
           ELSE v2_allowance_effective_period_id END,
         updated_at           = now()
   WHERE workspace_id = v_period.workspace_id;

  IF v_period.ai_allowance_irr > 0 THEN
    v_lot := public.ai_grant_allowance(
      v_period.workspace_id,
      v_period.ai_allowance_irr::numeric,
      'period:' || v_period.id::text,
      'plan',
      v_period.period_end,
      'plan_allowance:' || v_period.id::text
    );
  END IF;

  RETURN jsonb_build_object(
    'period_id', v_period.id, 'lot_id', v_lot,
    'allowance_irr', v_period.ai_allowance_irr,
    'previous_period_source', v_prev_src,
    'legacy_lots_retired', v_retired,
    'replayed', false
  );
END;
$$;

-- ─── 7.6 Wallet payment takes the reservation before it debits ────────────
CREATE OR REPLACE FUNCTION public.billing_wallet_pay_invoice(
  p_invoice_id UUID,
  p_actor_id   UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_inv    public.billing_invoices;
  v_entry  public.billing_wallet_ledger;
  v_amount BIGINT;
  v_result JSONB;
BEGIN
  SELECT * INTO v_inv FROM public.billing_invoices WHERE id = p_invoice_id;
  IF v_inv.id IS NULL THEN
    RAISE EXCEPTION 'unknown_invoice:%', p_invoice_id;
  END IF;
  IF v_inv.status NOT IN ('open', 'partially_paid', 'past_due') THEN
    RAISE EXCEPTION 'invoice_not_payable:%:%', v_inv.id, v_inv.status;
  END IF;

  v_amount := v_inv.amount_due_irr;
  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'invoice_nothing_due:%', v_inv.id;
  END IF;

  -- Refuses while a gateway checkout holds the invoice: prevention, not
  -- after-the-fact reconciliation of a double collection.
  PERFORM public.billing_begin_collection(
    v_inv.id, 'wallet', v_amount,
    'wallet_collect:' || v_inv.id::text || ':' || v_inv.amount_paid_irr::text,
    NULL, 300
  );

  v_entry := public.billing_wallet_append(
    v_inv.workspace_id, 'invoice_payment', -v_amount,
    'invoice_payment:' || v_inv.id::text, 'wallet_invoice_payment',
    v_inv.id, NULL, NULL, p_actor_id
  );

  v_result := public.billing_settle_invoice(
    v_inv.id, v_amount, 'wallet',
    'wallet_settle:' || v_inv.id::text, NULL, v_entry.id
  );

  RETURN v_result || jsonb_build_object('wallet_entry_id', v_entry.id);
END;
$$;

-- ─── 7.7 ACL for the hardening functions ──────────────────────────────────
DO $$
DECLARE f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.billing_expire_stale_collections(uuid)',
    'public.billing_begin_collection(uuid, text, bigint, text, uuid, integer)',
    'public.billing_release_collection(uuid, text)',
    'public.billing_recover_unapplied_invoices(integer)',
    'public.billing_legacy_allowance_active(uuid)',
    'public.billing_retire_legacy_allowance(uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
    END IF;
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO postgres', f);
  END LOOP;
END $$;

-- Postgres (the migration/owner role) must also be able to run every function
-- declared earlier in this migration — 109's convergence rule for money.
DO $$
DECLARE f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.billing_wallet_lock(uuid)',
    'public.billing_wallet_append(uuid, text, bigint, text, text, uuid, uuid, uuid, uuid, jsonb)',
    'public.billing_settle_invoice(uuid, bigint, text, text, uuid, uuid)',
    'public.billing_apply_invoice_effects(uuid)',
    'public.billing_activate_period(uuid)',
    'public.billing_activate_due_periods(integer)',
    'public.billing_wallet_apply_deposit(uuid, bigint, uuid)',
    'public.billing_wallet_pay_invoice(uuid, uuid)',
    'public.billing_wallet_refund(uuid, bigint, text, text, uuid)',
    'public.billing_wallet_admin_adjust(uuid, bigint, text, text, uuid)',
    'public.billing_wallet_reconcile(uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
    END IF;
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO postgres', f);
  END LOOP;
END $$;
