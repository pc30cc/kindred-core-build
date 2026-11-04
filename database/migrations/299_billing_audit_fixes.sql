-- 299 — billing audit fixes (2026-11-04 audit, billing-2 and billing-4).
--
-- 1. billing_account_refund_payment_to_total(payment, refunded_total): a
--    refund reported as the running total refunded on a payment (Stripe's
--    charge.refunded, PayPal's PAYMENT.CAPTURE.REFUNDED / REVERSED). The
--    server used to compute the new part (the total minus what was already
--    taken back) from a payment row it read before any lock, so two quick
--    partial refunds (totals 300, then 500) processed at the same time both
--    saw nothing taken back and took 300 + 500 = 800 for 500 refunded. The
--    difference is now taken here, under the payment's FOR UPDATE lock, and
--    handed to 264's billing_account_refund_payment (same lock order:
--    payment, then account) as `total:<payment id>:<n>`. The server's old id,
--    `total:<n>`, made the ledger key (refund:<provider>:<id>, unique across
--    every payment) collide: a second payment refunded to the same running
--    total read as a replay of the first and was never taken back. Refunds
--    recorded under the old id still count toward the total. A total
--    already covered takes nothing (`ignored`).
-- 2. billing_account_settle_payment(payment): 264's body. A plan, a renewal
--    or an upgrade paid online is bought at most at the price the customer
--    was quoted at checkout: purpose_detail.quoted_price_minor (plan and
--    renewal: the period's price) or quoted_charge_minor (upgrade: its cost
--    plus what a prepaid next period costs more), which the server writes on
--    the payment since this migration's code. A price raised meanwhile
--    leaves the money in the balance (billing_quote_changed in
--    purpose_result), as 264 already did for AI packs. A payment opened
--    before carries neither key and is settled exactly as before.
--
-- Server-only: both functions are SECURITY DEFINER with a fixed
-- search_path, executable by service_role alone. Re-runnable (CREATE OR
-- REPLACE). It writes no data: no row is inserted, changed or deleted by
-- the migration itself; nothing is dropped, and no archive is touched.
--
-- Applied by hand on WebYar BEFORE the merge of the code that calls it
-- (CLAUDE.md, Migrations): a dry run of this file inside BEGIN … ROLLBACK
-- first. The backend of that merge calls (1), which does not exist before
-- this file; this file needs nothing of that backend (2 reads keys the old
-- backend never writes). RESPOK: by its migrator, on push. Needs 261
-- (billing_jsonb_number, billing_account_upgrade_cost), 264 (refund and
-- settlement) and 268 (billing_account_renew with p_expected_price_minor).
-- Like 284 to 292, it sets lock_timeout 5s itself.

SET lock_timeout = '5s';

DO $guard$
BEGIN
  IF to_regprocedure('public.billing_account_refund_payment(uuid, text, bigint)') IS NULL
     OR to_regprocedure('public.billing_account_upgrade_cost(uuid, uuid, timestamptz)') IS NULL
     OR to_regprocedure('public.billing_jsonb_number(jsonb)') IS NULL
     OR to_regprocedure('public.billing_account_renew(uuid, uuid, timestamptz, bigint, bigint)') IS NULL
     OR to_regprocedure('public.billing_ai_pack_find(text, text, text)') IS NULL THEN
    RAISE EXCEPTION '299 needs 261, 264 and 268 (simple billing refund, upgrade cost or renewal are missing)';
  END IF;
END $guard$;

-- ─── 1. A refund reported as the running total ────────────────────────────
CREATE OR REPLACE FUNCTION public.billing_account_refund_payment_to_total(
  p_payment_id     uuid,
  p_refunded_total bigint
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_pay     public.billing_account_payments;
  v_already numeric;
  v_amount  bigint;
  v_id      text;
  v_res     jsonb;
BEGIN
  IF p_refunded_total IS NULL OR p_refunded_total <= 0 THEN
    RAISE EXCEPTION 'billing_refund_invalid';
  END IF;
  -- The lock 264's refund takes first: a concurrent refund of this payment
  -- waits here, and reads what the first one took back once it committed.
  SELECT * INTO v_pay FROM public.billing_account_payments WHERE id = p_payment_id FOR UPDATE;
  IF v_pay.id IS NULL THEN
    RAISE EXCEPTION 'billing_payment_not_found';
  END IF;
  -- Scoped to the payment: the ledger key (refund:<provider>:<id>) is
  -- unique across all payments, and two payments refunded to the same total
  -- must not read as one replayed refund.
  v_id := 'total:' || v_pay.id::text || ':' || p_refunded_total::text;
  -- Every refund recorded on the payment, in the provider's amount (what the
  -- server summed before 299).
  SELECT coalesce(sum(coalesce(public.billing_jsonb_number(r.value -> 'amount_minor'), 0)), 0)
    INTO v_already
    FROM jsonb_each(CASE WHEN jsonb_typeof(v_pay.purpose_detail -> 'refunds') = 'object'
                         THEN v_pay.purpose_detail -> 'refunds' ELSE '{}'::jsonb END) r;
  IF (v_pay.purpose_detail -> 'refunds') ? v_id THEN
    RETURN jsonb_build_object('replayed', true, 'refund_id', v_id, 'amount_minor', 0);
  END IF;
  v_amount := p_refunded_total - floor(v_already)::bigint;
  IF v_amount <= 0 THEN
    -- An earlier total, or one already covered: nothing more to take back.
    RETURN jsonb_build_object('replayed', false, 'ignored', true, 'refund_id', v_id, 'amount_minor', 0);
  END IF;
  v_res := public.billing_account_refund_payment(p_payment_id, v_id, v_amount);
  RETURN v_res || jsonb_build_object('refund_id', v_id, 'amount_minor', v_amount);
END;
$$;

COMMENT ON FUNCTION public.billing_account_refund_payment_to_total(uuid, bigint) IS
  'A refund reported as the running total refunded on a payment (Stripe, PayPal; 299): under the payment''s lock, the new part (the total minus every refund recorded) is refunded through billing_account_refund_payment as total:<payment id>:<n>. A total already covered takes nothing (ignored). Returns that function''s result plus refund_id and amount_minor.';

-- ─── 2. Settlement: 264's, at the quoted price ────────────────────────────
CREATE OR REPLACE FUNCTION public.billing_account_settle_payment(
  p_payment_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_pay      public.billing_account_payments;
  v_acc      public.billing_accounts;
  v_entry    public.billing_account_ledger;
  v_settings public.billing_settings;
  v_edition  text;
  v_ws_name  text;
  v_gateway  jsonb;
  v_seq      text;
  v_receipt  text;
  v_balance  bigint;
  v_purpose  jsonb;
  v_quote    jsonb;
  v_charge   bigint;
BEGIN
  SELECT * INTO v_pay FROM public.billing_account_payments WHERE id = p_payment_id FOR UPDATE;
  IF v_pay.id IS NULL THEN
    RAISE EXCEPTION 'billing_payment_not_found';
  END IF;
  IF v_pay.status = 'succeeded' THEN
    RETURN jsonb_build_object('replayed', true, 'ledger_id', v_pay.ledger_id, 'payment_id', v_pay.id);
  END IF;
  IF v_pay.verified_at IS NULL OR v_pay.verified_amount_minor IS DISTINCT FROM v_pay.amount_minor THEN
    RAISE EXCEPTION 'billing_payment_not_verified';
  END IF;

  PERFORM public.billing_account_ensure(v_pay.workspace_id, v_pay.currency);
  SELECT * INTO v_acc FROM public.billing_accounts WHERE workspace_id = v_pay.workspace_id FOR UPDATE;
  IF v_acc.currency <> v_pay.currency THEN
    IF v_acc.balance_minor = 0
       AND NOT EXISTS (SELECT 1 FROM public.billing_account_ledger WHERE workspace_id = v_pay.workspace_id) THEN
      UPDATE public.billing_accounts SET currency = v_pay.currency, updated_at = now()
       WHERE workspace_id = v_pay.workspace_id
       RETURNING * INTO v_acc;
    ELSE
      RAISE EXCEPTION 'billing_account_currency_mismatch';
    END IF;
  END IF;

  v_edition := public.platform_edition();
  SELECT * INTO v_settings FROM public.billing_settings WHERE edition = v_edition;
  SELECT name INTO v_ws_name FROM public.workspaces WHERE id = v_pay.workspace_id;
  SELECT display_name INTO v_gateway FROM public.billing_gateways WHERE provider_name = v_pay.provider;

  v_seq := nextval('public.billing_receipt_seq')::text;
  v_receipt := coalesce(nullif(v_settings.receipt_prefix, ''), 'R')
    || to_char(now() AT TIME ZONE 'UTC', 'YYYY') || '-'
    || lpad(v_seq, greatest(6, length(v_seq)), '0');
  v_balance := v_acc.balance_minor + v_pay.net_minor;

  INSERT INTO public.billing_account_ledger (
    workspace_id, kind, amount_minor, balance_after, currency,
    payment_id, receipt_number, net_minor, tax_minor, tax_percent,
    buyer, seller, description, actor_id, idempotency_key
  ) VALUES (
    v_pay.workspace_id, 'topup', v_pay.net_minor, v_balance, v_pay.currency,
    v_pay.id, v_receipt, v_pay.net_minor, v_pay.tax_minor, v_pay.tax_percent,
    jsonb_build_object('workspace_name', v_ws_name) || coalesce(v_acc.billing_profile, '{}'::jsonb),
    coalesce(v_settings.seller, '{}'::jsonb),
    jsonb_build_object('purpose', v_pay.purpose, 'provider', v_pay.provider, 'provider_name', coalesce(v_gateway, '{}'::jsonb))
      || coalesce(v_pay.purpose_detail, '{}'::jsonb),
    v_pay.created_by,
    'payment:' || v_pay.id::text
  ) RETURNING * INTO v_entry;

  UPDATE public.billing_accounts
     SET balance_minor = v_balance, updated_at = now()
   WHERE workspace_id = v_pay.workspace_id;

  UPDATE public.billing_account_payments
     SET status = 'succeeded',
         ledger_id = v_entry.id,
         failure_reason = NULL,
         completed_at = now(),
         updated_at = now()
   WHERE id = v_pay.id
   RETURNING * INTO v_pay;

  IF v_pay.purpose IN ('plan', 'renewal', 'upgrade', 'ai_pack') THEN
    BEGIN
      -- A pack whose credit changed since checkout (same price) is a changed
      -- quote too: the money stays in the balance.
      IF v_pay.purpose = 'ai_pack' AND v_pay.purpose_detail ? 'credit_minor'
         AND public.billing_jsonb_number(public.billing_ai_pack_find(
               v_edition, v_acc.currency, v_pay.purpose_detail ->> 'pack_id') -> 'credit_minor')
             <> public.billing_jsonb_number(v_pay.purpose_detail -> 'credit_minor') THEN
        RAISE EXCEPTION 'billing_quote_changed';
      END IF;
      -- 299: a plan or an upgrade is bought at most at the price quoted at
      -- checkout (purpose_detail.quoted_price_minor / quoted_charge_minor,
      -- written since 299's code; a payment opened before carries neither
      -- and is settled as before). A price raised meanwhile leaves the money
      -- in the balance (billing_quote_changed). A renewal passes its quoted
      -- price to billing_account_renew below.
      IF v_pay.purpose = 'plan' AND v_pay.purpose_detail ? 'quoted_price_minor'
         AND public.billing_plan_price(
               (v_pay.purpose_detail ->> 'plan_id')::uuid, v_acc.currency,
               coalesce(v_pay.purpose_detail ->> 'billing_interval', 'monthly'))
             IS DISTINCT FROM public.billing_jsonb_number(v_pay.purpose_detail -> 'quoted_price_minor')::bigint THEN
        RAISE EXCEPTION 'billing_quote_changed';
      END IF;
      IF v_pay.purpose = 'upgrade' AND v_pay.purpose_detail ? 'quoted_charge_minor' THEN
        -- What billing_account_upgrade will take: its cost, plus what a
        -- prepaid next period costs more. Less than quoted (fewer whole
        -- months left) is fine; more is not. Not an upgrade any more: the
        -- upgrade itself refuses below.
        v_quote := public.billing_account_upgrade_cost(v_pay.workspace_id, (v_pay.purpose_detail ->> 'plan_id')::uuid);
        IF v_quote IS NOT NULL AND coalesce((v_quote ->> 'upgrade')::boolean, false) THEN
          v_charge := coalesce((v_quote ->> 'cost_minor')::bigint, 0)
                    + greatest(coalesce((v_quote ->> 'reprice_minor')::bigint, 0), 0);
          IF v_charge > public.billing_jsonb_number(v_pay.purpose_detail -> 'quoted_charge_minor')::bigint THEN
            RAISE EXCEPTION 'billing_quote_changed';
          END IF;
        END IF;
      END IF;
      v_purpose := CASE v_pay.purpose
        WHEN 'plan' THEN public.billing_account_purchase_plan(
          v_pay.workspace_id, (v_pay.purpose_detail ->> 'plan_id')::uuid,
          coalesce(v_pay.purpose_detail ->> 'billing_interval', 'monthly'),
          'payment:' || v_pay.id::text, v_pay.created_by)
        WHEN 'renewal' THEN CASE WHEN v_pay.source = 'card_renewal'
          THEN public.billing_card_apply_renewal(v_pay)
          ELSE public.billing_account_renew(
            v_pay.workspace_id, v_pay.created_by, (v_pay.purpose_detail ->> 'period_end')::timestamptz,
            public.billing_jsonb_number(v_pay.purpose_detail -> 'quoted_price_minor')::bigint) END
        WHEN 'upgrade' THEN public.billing_account_upgrade(
          v_pay.workspace_id, (v_pay.purpose_detail ->> 'plan_id')::uuid, v_pay.created_by)
        WHEN 'ai_pack' THEN public.billing_account_buy_ai_pack(
          v_pay.workspace_id, v_pay.purpose_detail ->> 'pack_id',
          public.billing_jsonb_number(v_pay.purpose_detail -> 'price_minor')::bigint,
          'payment:' || v_pay.id::text, v_pay.created_by)
      END;
    EXCEPTION WHEN others THEN
      v_purpose := jsonb_build_object('error', SQLERRM);
    END;
    -- A renewal paid after the plan already ran out buys that plan again
    -- (the customer paid for it); the period starts now.
    IF v_pay.purpose = 'renewal' AND v_pay.source <> 'card_renewal' AND v_purpose ? 'error'
       AND (public.billing_account_paid_subscription(v_pay.workspace_id)).id IS NULL
       AND v_pay.purpose_detail ? 'plan_id' THEN
      BEGIN
        -- 299: at the renewal's quoted price only (same plan and interval).
        IF v_pay.purpose_detail ? 'quoted_price_minor'
           AND public.billing_plan_price(
                 (v_pay.purpose_detail ->> 'plan_id')::uuid, v_acc.currency,
                 coalesce(v_pay.purpose_detail ->> 'billing_interval', 'monthly'))
               IS DISTINCT FROM public.billing_jsonb_number(v_pay.purpose_detail -> 'quoted_price_minor')::bigint THEN
          RAISE EXCEPTION 'billing_quote_changed';
        END IF;
        v_purpose := public.billing_account_purchase_plan(
          v_pay.workspace_id, (v_pay.purpose_detail ->> 'plan_id')::uuid,
          coalesce(v_pay.purpose_detail ->> 'billing_interval', 'monthly'),
          'payment:' || v_pay.id::text, v_pay.created_by);
      EXCEPTION WHEN others THEN
        v_purpose := v_purpose || jsonb_build_object('fallback_error', SQLERRM);
      END;
    END IF;
    UPDATE public.billing_account_payments SET purpose_result = v_purpose WHERE id = v_pay.id;
    SELECT balance_minor INTO v_balance FROM public.billing_accounts WHERE workspace_id = v_pay.workspace_id;
  END IF;

  RETURN jsonb_build_object(
    'replayed', false,
    'ledger_id', v_entry.id,
    'payment_id', v_pay.id,
    'receipt_number', v_receipt,
    'balance_minor', v_balance,
    'purpose', v_pay.purpose,
    'purpose_result', v_purpose
  );
END;
$$;


-- ─── 3. Access: the backend (service_role) only ──────────────────────────
DO $acl$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.billing_account_refund_payment_to_total(uuid, bigint)',
    'public.billing_account_settle_payment(uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', f);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', f);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
    END IF;
  END LOOP;
END $acl$;

RESET lock_timeout;
