-- 265 — Simple billing, phase 5: AI credit packs (docs/billing/SIMPLE_BILLING.md).
--
-- Super Admin sets fixed packs per currency in billing_settings.ai_packs
-- (259). A workspace buys one from its prepaid balance with one click, or
-- pays online for it (purpose ai_pack): the gateway payment is credited with
-- its receipt and spent on the pack in the same transaction, as a plan,
-- renewal or upgrade is (261/262).
--
--   The pack       {id, price_minor, credit_minor, active, label}, per
--                  currency. price_minor and credit_minor are both in the
--                  pack's own currency (Rial / cent / kuruş): "$5 buys $6 of
--                  AI credit".
--   Buying it      an `ai_pack` ledger row of −price, then a PURCHASED AI lot
--                  that never expires. The credit is converted into the AI
--                  wallet's unit (Rial) at purchase time with the exchange
--                  rate the AI meter charges with (ai_exchange_rates:
--                  currency→IRR, else currency→USD × USD→IRR); the rate and
--                  the wallet amount are kept on the ledger row. No rate: no
--                  sale, nothing debited.
--   Plan credit    is spent first (it expires; purchased credit does not).
--                  Nothing that grants, retires or expires plan credit
--                  touches a purchased lot.
--   A refund       of a payment that bought a pack takes the pack's unused
--                  credit back first (capped at the refunded share) and
--                  returns its price share to the balance (`ai_pack_return`);
--                  the refund is then taken from the balance as before. What
--                  was already used stays `shortfall_minor`, for review.
--
-- Keys: the ledger row 'ai_pack:<p_key>' (the route sends
-- '<workspace>:<browser key>', a settlement 'payment:<payment id>'); its lot
-- 'ai_pack_lot:<ledger id>'; a reversal 'ai_pack_return:refund:<provider>:
-- <refund id>'. A replay is answered before the pack is looked up, so it
-- still works after the pack was edited or removed.
--
-- Inert until Super Admin saves packs (none are seeded); the server sells
-- them only while AI billing is ENFORCED. Settlement and refund are 262's and
-- 261's bodies with one added branch each.
--
-- Server-only: every function here is reachable by service_role alone.
-- Re-runnable: every step is guarded or a no-op the second time.

-- ─── 1. The ledger: money back from a reversed pack ───────────────────────
-- 259's kinds plus 'ai_pack_return'. Kinds another migration added are kept.
DO $$
DECLARE
  v_def   text;
  v_kinds text[] := ARRAY[
    'topup', 'renewal', 'upgrade', 'plan', 'ai_pack',
    'admin_credit', 'admin_debit', 'refund', 'prepaid_return'
  ];
  v_kind  text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
   WHERE conname = 'billing_account_ledger_kind_check'
     AND conrelid = 'public.billing_account_ledger'::regclass;
  IF v_def IS NULL OR v_def NOT LIKE '%''ai_pack_return''%' THEN
    FOR v_kind IN SELECT m[1] FROM regexp_matches(coalesce(v_def, ''), '''([a-z_]+)''', 'g') AS m LOOP
      IF NOT v_kind = ANY (v_kinds) THEN
        v_kinds := v_kinds || v_kind;
      END IF;
    END LOOP;
    v_kinds := v_kinds || 'ai_pack_return'::text;
    ALTER TABLE public.billing_account_ledger DROP CONSTRAINT IF EXISTS billing_account_ledger_kind_check;
    EXECUTE format(
      'ALTER TABLE public.billing_account_ledger ADD CONSTRAINT billing_account_ledger_kind_check CHECK (kind IN (%s))',
      (SELECT string_agg(quote_literal(k), ', ') FROM unnest(v_kinds) AS k)
    );
  END IF;
END $$;

-- ─── 2. Helpers ───────────────────────────────────────────────────────────

-- Decimal places of a currency's minor unit (IRR in whole Rial).
CREATE OR REPLACE FUNCTION public.billing_currency_exponent(p_currency text)
RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp
AS $$
  SELECT CASE upper(coalesce(p_currency, '')) WHEN 'IRR' THEN 0 ELSE 2 END
$$;

-- AI wallet units (Rial) per one major unit of p_currency, from the rates the
-- AI meter charges with (the open ai_exchange_rates row): currency→IRR, else
-- currency→USD × USD→IRR. IRR is 1. NULL when there is none.
CREATE OR REPLACE FUNCTION public.billing_ai_wallet_rate(p_currency text)
RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN upper(coalesce(p_currency, '')) = 'IRR' THEN 1::numeric ELSE coalesce(
    (SELECT r.rate FROM public.ai_exchange_rates r
      WHERE r.from_currency = upper(p_currency) AND r.to_currency = 'IRR' AND r.effective_to IS NULL
      LIMIT 1),
    (SELECT a.rate * b.rate FROM public.ai_exchange_rates a, public.ai_exchange_rates b
      WHERE a.from_currency = upper(p_currency) AND a.to_currency = 'USD' AND a.effective_to IS NULL
        AND b.from_currency = 'USD' AND b.to_currency = 'IRR' AND b.effective_to IS NULL
      LIMIT 1)
  ) END
$$;

-- One active, well-formed pack of an edition's settings for a currency;
-- NULL when there is none. A pack is active unless `active` is false; its
-- price and credit are positive whole numbers. Anything malformed (a
-- currency entry that is not a list, a price that is not a whole number) is
-- simply not offered.
CREATE OR REPLACE FUNCTION public.billing_ai_pack_find(p_edition text, p_currency text, p_pack_id text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT p
    FROM public.billing_settings s,
         jsonb_array_elements(CASE WHEN jsonb_typeof(s.ai_packs -> upper(coalesce(p_currency, ''))) = 'array'
                                   THEN s.ai_packs -> upper(p_currency) ELSE '[]'::jsonb END) AS p
   WHERE s.edition = p_edition
     AND jsonb_typeof(p) = 'object'
     AND p ->> 'id' = p_pack_id
     AND coalesce(p -> 'active', 'true'::jsonb) <> 'false'::jsonb
     AND CASE WHEN jsonb_typeof(p -> 'price_minor') = 'number' AND (p ->> 'price_minor') ~ '^[0-9]{1,15}$'
              THEN (p ->> 'price_minor')::bigint > 0 ELSE false END
     AND CASE WHEN jsonb_typeof(p -> 'credit_minor') = 'number' AND (p ->> 'credit_minor') ~ '^[0-9]{1,15}$'
              THEN (p ->> 'credit_minor')::bigint > 0 ELSE false END
   LIMIT 1
$$;

-- ─── 3. Buying a pack from the balance ────────────────────────────────────
-- The pack's price from the balance and its credit as a PURCHASED AI lot
-- that never expires, in one transaction. Lock order: the account, then the
-- AI wallet (ai_purchase_credit). p_expected_price_minor is the price the
-- page showed: another one answers billing_quote_changed and charges
-- nothing. Idempotent per key: a replay returns the same ledger row and lot,
-- even after the pack was edited or removed.
CREATE OR REPLACE FUNCTION public.billing_account_buy_ai_pack(
  p_workspace_id         uuid,
  p_pack_id              text,
  p_expected_price_minor bigint,
  p_key                  text,
  p_actor                uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_acc    public.billing_accounts;
  v_entry  public.billing_account_ledger;
  v_pack   jsonb;
  v_price  bigint;
  v_credit bigint;
  v_rate   numeric;
  v_wallet numeric;
  v_lot    uuid;
  v_key    text;
BEGIN
  IF coalesce(p_key, '') = '' THEN
    RAISE EXCEPTION 'billing_key_required';
  END IF;
  v_key := 'ai_pack:' || p_key;
  v_acc := public.billing_account_lock(p_workspace_id);

  -- A replay, before any pack lookup.
  SELECT * INTO v_entry FROM public.billing_account_ledger WHERE idempotency_key = v_key;
  IF v_entry.id IS NOT NULL THEN
    IF v_entry.workspace_id <> p_workspace_id OR v_entry.kind <> 'ai_pack' THEN
      RAISE EXCEPTION 'billing_idempotency_conflict';
    END IF;
    SELECT result_ref INTO v_lot FROM public.ai_billing_commands
     WHERE idempotency_key = 'ai_pack_lot:' || v_entry.id::text;
    RETURN jsonb_build_object(
      'action', 'ai_pack', 'replayed', true,
      'pack_ledger_id', v_entry.id, 'lot_id', v_lot,
      'pack_id', v_entry.description ->> 'pack_id',
      'price_minor', -v_entry.amount_minor,
      'credit_minor', public.billing_jsonb_number(v_entry.description -> 'credit_minor'),
      'currency', v_entry.currency,
      'wallet_amount', v_entry.description -> 'wallet_amount',
      'balance_minor', v_acc.balance_minor
    );
  END IF;

  v_pack := public.billing_ai_pack_find(public.platform_edition(), v_acc.currency, p_pack_id);
  IF v_pack IS NULL THEN
    RAISE EXCEPTION 'billing_ai_pack_not_available';
  END IF;
  v_price := (v_pack ->> 'price_minor')::bigint;
  v_credit := (v_pack ->> 'credit_minor')::bigint;
  IF p_expected_price_minor IS NOT NULL AND p_expected_price_minor <> v_price THEN
    RAISE EXCEPTION 'billing_quote_changed';
  END IF;
  v_rate := public.billing_ai_wallet_rate(v_acc.currency);
  IF v_rate IS NULL OR v_rate <= 0 THEN
    RAISE EXCEPTION 'billing_ai_fx_unavailable';
  END IF;
  v_wallet := round(v_credit::numeric / power(10::numeric, public.billing_currency_exponent(v_acc.currency)) * v_rate, 0);
  IF v_wallet <= 0 THEN
    RAISE EXCEPTION 'billing_ai_pack_not_available';
  END IF;

  -- Raises billing_insufficient_balance; nothing is written then.
  v_entry := public.billing_account_debit(
    p_workspace_id, 'ai_pack', v_price, NULL, NULL, NULL, NULL,
    jsonb_build_object(
      'pack_id', p_pack_id, 'credit_minor', v_credit, 'credit_currency', v_acc.currency,
      'label', v_pack -> 'label', 'wallet_amount', v_wallet, 'wallet_unit', 'IRR', 'fx_rate', v_rate),
    p_actor, v_key);
  v_lot := public.ai_purchase_credit(p_workspace_id, v_wallet, 'ai_pack_lot:' || v_entry.id::text, 'ai_pack');

  RETURN jsonb_build_object(
    'action', 'ai_pack', 'replayed', false,
    'pack_ledger_id', v_entry.id, 'lot_id', v_lot,
    'pack_id', p_pack_id,
    'price_minor', v_price,
    'credit_minor', v_credit,
    'currency', v_acc.currency,
    'wallet_amount', v_wallet,
    'balance_minor', v_entry.balance_after
  );
END;
$$;

-- ─── 4. Reversing a pack (a refund of the payment that bought it) ─────────
-- Takes back at most p_max_minor of the pack's price, never more than the
-- price minus what earlier reversals returned, and never more than the share
-- of the price its unused credit is worth (what a reply in flight reserved
-- is not unused). That credit leaves the lot (an AI ledger ADJUSTMENT) and
-- its price share returns to the balance (`ai_pack_return`). The caller
-- holds the account lock (lock order: account, then AI wallet). Idempotent
-- per key.
CREATE OR REPLACE FUNCTION public.billing_ai_pack_reverse(
  p_workspace_id   uuid,
  p_pack_ledger_id uuid,
  p_max_minor      bigint,
  p_key            text,
  p_refund_id      text,
  p_provider       text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_entry    public.billing_account_ledger;
  v_pack     public.billing_account_ledger;
  v_acc      public.billing_accounts;
  v_lot      public.workspace_ai_balance_lots;
  v_lot_id   uuid;
  v_price    bigint;
  v_wallet   numeric;
  v_already  bigint;
  v_unused   numeric := 0;
  v_m        bigint;
  v_reclaim  numeric;
  v_ai_entry uuid;
BEGIN
  IF coalesce(p_key, '') = '' THEN
    RAISE EXCEPTION 'billing_key_required';
  END IF;
  SELECT * INTO v_entry FROM public.billing_account_ledger WHERE idempotency_key = p_key;
  IF v_entry.id IS NOT NULL THEN
    IF v_entry.workspace_id <> p_workspace_id OR v_entry.kind <> 'ai_pack_return' THEN
      RAISE EXCEPTION 'billing_idempotency_conflict';
    END IF;
    RETURN jsonb_build_object(
      'replayed', true, 'ledger_id', v_entry.id,
      'returned_minor', v_entry.amount_minor,
      'reclaimed_wallet', v_entry.description -> 'reclaimed_wallet'
    );
  END IF;

  SELECT * INTO v_acc FROM public.billing_accounts WHERE workspace_id = p_workspace_id FOR UPDATE;
  SELECT * INTO v_pack FROM public.billing_account_ledger
   WHERE id = p_pack_ledger_id AND workspace_id = p_workspace_id AND kind = 'ai_pack';
  IF v_pack.id IS NULL OR v_acc.workspace_id IS NULL THEN
    RAISE EXCEPTION 'billing_ai_pack_not_found';
  END IF;
  v_price := -v_pack.amount_minor;
  v_wallet := public.billing_jsonb_number(v_pack.description -> 'wallet_amount');
  SELECT coalesce(sum(amount_minor), 0) INTO v_already
    FROM public.billing_account_ledger
   WHERE workspace_id = p_workspace_id AND kind = 'ai_pack_return'
     AND description ->> 'pack_ledger_id' = v_pack.id::text;
  SELECT result_ref INTO v_lot_id FROM public.ai_billing_commands
   WHERE idempotency_key = 'ai_pack_lot:' || v_pack.id::text;

  PERFORM public.ai_wallet_lock(p_workspace_id);
  SELECT * INTO v_lot FROM public.workspace_ai_balance_lots
   WHERE id = v_lot_id AND workspace_id = p_workspace_id
   FOR UPDATE;
  IF v_lot.id IS NOT NULL AND v_lot.state IN ('ACTIVE', 'EXPIRING') THEN
    v_unused := greatest(v_lot.remaining_amount - v_lot.reserved_amount, 0);
  END IF;
  IF v_wallet IS NULL OR v_wallet <= 0 OR v_price <= 0 THEN
    v_m := 0;
  ELSE
    v_m := least(
      greatest(coalesce(p_max_minor, 0), 0),
      v_price - v_already,
      floor(v_price::numeric * v_unused / v_wallet)::bigint
    );
  END IF;
  IF v_m <= 0 THEN
    RETURN jsonb_build_object(
      'replayed', false, 'ledger_id', NULL,
      'returned_minor', 0, 'reclaimed_wallet', 0, 'unused_wallet', v_unused
    );
  END IF;
  v_reclaim := least(v_unused, ceil(v_m::numeric * v_wallet / v_price));

  -- The AI wallet: the credit leaves the lot.
  INSERT INTO public.workspace_ai_ledger (workspace_id, entry_type, amount, reason)
  VALUES (p_workspace_id, 'ADJUSTMENT', -v_reclaim, 'ai_pack_refund')
  RETURNING id INTO v_ai_entry;
  INSERT INTO public.workspace_ai_ledger_allocations (ledger_entry_id, lot_id, amount)
  VALUES (v_ai_entry, v_lot.id, v_reclaim);
  UPDATE public.workspace_ai_balance_lots
     SET remaining_amount = remaining_amount - v_reclaim,
         state = CASE WHEN remaining_amount - v_reclaim <= 0 THEN 'DEPLETED' ELSE state END,
         updated_at = now()
   WHERE id = v_lot.id;
  INSERT INTO public.ai_billing_commands (command_type, idempotency_key, workspace_id, result_ref)
  VALUES ('ADJUSTMENT', p_key, p_workspace_id, v_ai_entry)
  ON CONFLICT (idempotency_key) DO NOTHING;
  PERFORM public.ai_wallet_project(p_workspace_id);

  -- The balance: the price share comes back.
  INSERT INTO public.billing_account_ledger (
    workspace_id, kind, amount_minor, balance_after, currency, description, idempotency_key, created_at
  ) VALUES (
    p_workspace_id, 'ai_pack_return', v_m, v_acc.balance_minor + v_m, v_acc.currency,
    jsonb_build_object(
      'pack_ledger_id', v_pack.id, 'pack_id', v_pack.description ->> 'pack_id',
      'refund_id', p_refund_id, 'provider', p_provider, 'reclaimed_wallet', v_reclaim),
    p_key, clock_timestamp()
  ) RETURNING * INTO v_entry;
  UPDATE public.billing_accounts
     SET balance_minor = balance_minor + v_m, updated_at = now()
   WHERE workspace_id = p_workspace_id;

  RETURN jsonb_build_object(
    'replayed', false, 'ledger_id', v_entry.id,
    'returned_minor', v_m, 'reclaimed_wallet', v_reclaim, 'unused_wallet', v_unused
  );
END;
$$;

-- ─── 5. Settlement: 262's, plus the AI credit pack ────────────────────────
-- 262's body; a payment made for a pack (purpose ai_pack) is spent on it
-- like a plan, a renewal or an upgrade. A pack changed or removed meanwhile,
-- or a missing exchange rate, leaves the money in the balance and its reason
-- in purpose_result.
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
      v_purpose := CASE v_pay.purpose
        WHEN 'plan' THEN public.billing_account_purchase_plan(
          v_pay.workspace_id, (v_pay.purpose_detail ->> 'plan_id')::uuid,
          coalesce(v_pay.purpose_detail ->> 'billing_interval', 'monthly'),
          'payment:' || v_pay.id::text, v_pay.created_by)
        WHEN 'renewal' THEN CASE WHEN v_pay.source = 'card_renewal'
          THEN public.billing_card_apply_renewal(v_pay)
          ELSE public.billing_account_renew(
            v_pay.workspace_id, v_pay.created_by, (v_pay.purpose_detail ->> 'period_end')::timestamptz) END
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


-- ─── 6. Refund: 261's, plus the AI credit pack ────────────────────────────
-- 261's body; a refund of a payment that bought a pack first reverses the
-- pack (billing_ai_pack_reverse, at most this refund's net share), so its
-- price share is back in the balance before the refund is taken from it.
-- What the pack already used stays `shortfall_minor`. A refund of a plain
-- top-up whose money later bought a pack does not touch the pack.
CREATE OR REPLACE FUNCTION public.billing_account_refund_payment(
  p_payment_id   uuid,
  p_refund_id    text,
  p_amount_minor bigint
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_pay       public.billing_account_payments;
  v_acc       public.billing_accounts;
  v_entry     public.billing_account_ledger;
  v_key       text;
  v_credit    bigint;
  v_debit     bigint;
  v_shortfall bigint;
  v_released  bigint := 0;
  v_pack_ret  jsonb;
  v_returned  bigint := 0;
  v_reclaimed numeric := 0;
BEGIN
  IF coalesce(p_refund_id, '') = '' OR p_amount_minor IS NULL OR p_amount_minor <= 0 THEN
    RAISE EXCEPTION 'billing_refund_invalid';
  END IF;
  SELECT * INTO v_pay FROM public.billing_account_payments WHERE id = p_payment_id FOR UPDATE;
  IF v_pay.id IS NULL THEN
    RAISE EXCEPTION 'billing_payment_not_found';
  END IF;
  v_key := 'refund:' || v_pay.provider || ':' || p_refund_id;
  SELECT * INTO v_entry FROM public.billing_account_ledger WHERE idempotency_key = v_key;
  IF v_entry.id IS NOT NULL OR EXISTS (
    SELECT 1 FROM public.billing_account_payments
     WHERE id = p_payment_id AND (purpose_detail -> 'refunds') ? p_refund_id
  ) THEN
    RETURN jsonb_build_object('replayed', true, 'ledger_id', v_entry.id);
  END IF;
  IF v_pay.status <> 'succeeded' THEN
    RAISE EXCEPTION 'billing_refund_unsettled_payment';
  END IF;

  -- The net share of this refund, capped at what is still unrefunded.
  v_credit := least(
    (p_amount_minor * v_pay.net_minor) / greatest(v_pay.amount_minor, 1),
    v_pay.net_minor - v_pay.refunded_minor
  );
  IF v_credit <= 0 THEN
    RETURN jsonb_build_object('replayed', false, 'ledger_id', NULL, 'debited_minor', 0, 'shortfall_minor', 0);
  END IF;

  SELECT * INTO v_acc FROM public.billing_accounts WHERE workspace_id = v_pay.workspace_id FOR UPDATE;
  -- An AI credit pack this payment bought: its unused credit is taken back
  -- first and its price share returns to the balance, so the refund below
  -- takes the pack's money rather than leaving it as a shortfall.
  IF v_pay.purpose = 'ai_pack' AND v_pay.purpose_result ? 'pack_ledger_id' THEN
    v_pack_ret := public.billing_ai_pack_reverse(
      v_pay.workspace_id, (v_pay.purpose_result ->> 'pack_ledger_id')::uuid, v_credit,
      'ai_pack_return:refund:' || v_pay.provider || ':' || p_refund_id, p_refund_id, v_pay.provider);
    v_returned := coalesce((v_pack_ret ->> 'returned_minor')::bigint, 0);
    v_reclaimed := coalesce(public.billing_jsonb_number(v_pack_ret -> 'reclaimed_wallet'), 0);
    SELECT * INTO v_acc FROM public.billing_accounts WHERE workspace_id = v_pay.workspace_id FOR UPDATE;
  END IF;
  IF coalesce(v_acc.balance_minor, 0) < v_credit AND v_acc.next_period_prepaid_minor IS NOT NULL THEN
    v_released := v_acc.next_period_prepaid_minor;
    PERFORM public.billing_account_credit_back(
      v_pay.workspace_id, v_released,
      jsonb_build_object('reason', 'refund', 'refund_id', p_refund_id), NULL,
      'prepaid_return:refund:' || v_pay.provider || ':' || p_refund_id
    );
    UPDATE public.billing_accounts
       SET next_period_prepaid_minor = NULL, next_period_start = NULL, updated_at = now()
     WHERE workspace_id = v_pay.workspace_id
     RETURNING * INTO v_acc;
  END IF;
  v_debit := least(v_credit, coalesce(v_acc.balance_minor, 0));
  v_shortfall := v_credit - v_debit;

  IF v_debit > 0 THEN
    INSERT INTO public.billing_account_ledger (
      workspace_id, kind, amount_minor, balance_after, currency,
      payment_id, description, idempotency_key, created_at
    ) VALUES (
      v_pay.workspace_id, 'refund', -v_debit, v_acc.balance_minor - v_debit, v_acc.currency,
      v_pay.id,
      jsonb_build_object('refund_id', p_refund_id, 'provider', v_pay.provider, 'shortfall_minor', v_shortfall,
                         'released_prepaid_minor', v_released),
      v_key, clock_timestamp()
    ) RETURNING * INTO v_entry;
    UPDATE public.billing_accounts
       SET balance_minor = balance_minor - v_debit, updated_at = now()
     WHERE workspace_id = v_pay.workspace_id;
  END IF;

  UPDATE public.billing_account_payments
     SET refunded_minor = refunded_minor + v_credit,
         purpose_detail = jsonb_set(
           coalesce(purpose_detail, '{}'::jsonb), '{refunds}',
           coalesce(purpose_detail -> 'refunds', '{}'::jsonb)
             || jsonb_build_object(p_refund_id, jsonb_build_object(
                  'amount_minor', p_amount_minor, 'credit_minor', v_credit, 'shortfall_minor', v_shortfall,
                  'released_prepaid_minor', v_released,
                  'pack_returned_minor', v_returned, 'pack_reclaimed_wallet', v_reclaimed))
         ),
         updated_at = now()
   WHERE id = v_pay.id;

  RETURN jsonb_build_object(
    'replayed', false,
    'ledger_id', v_entry.id,
    'debited_minor', v_debit,
    'shortfall_minor', v_shortfall,
    'released_prepaid_minor', v_released,
    'pack_returned_minor', v_returned,
    'pack_reclaimed_wallet', v_reclaimed
  );
END;
$$;

-- ─── 7. The email (Super Admin → Branding → Email templates) ──────────────
-- billing_ai_pack_purchased, sent after every pack (from the balance or paid
-- online). Seeded in both editions in fa/en/tr, like 261's; a row that
-- exists (edited) is never overwritten. The server fills {pack_name},
-- {credit}, {amount}, {balance} and {ai_balance} in the edition's way (Toman
-- and Persian digits in Iran), and the links. The pg_temp helpers are 261's,
-- under this migration's name (they do not outlive a session).
CREATE OR REPLACE FUNCTION pg_temp._email_265_layout(p_locale text, p_title text, p_body text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $f$
  SELECT '<!DOCTYPE html><html lang="' || p_locale || '" dir="' || CASE WHEN p_locale = 'fa' THEN 'rtl' ELSE 'ltr' END || '">'
    || '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>' || p_title || '</title></head>'
    || '<body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,Tahoma,sans-serif;">'
    || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;">'
    || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;">'
    || '<tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">{brand}</h1></td></tr>'
    || '<tr><td style="padding:40px;text-align:' || CASE WHEN p_locale = 'fa' THEN 'right' ELSE 'left' END || ';direction:' || CASE WHEN p_locale = 'fa' THEN 'rtl' ELSE 'ltr' END || ';">'
    || '<h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">' || p_title || '</h2>'
    || p_body
    || '</td></tr>'
    || '<tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;"><p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr>'
    || '</table></td></tr></table></body></html>'
$f$;

CREATE OR REPLACE FUNCTION pg_temp._email_265_seed(
  p_slug text, p_locale text, p_subject text, p_title text, p_body text, p_text text
) RETURNS void
LANGUAGE plpgsql
AS $f$
DECLARE
  v_edition text;
BEGIN
  FOREACH v_edition IN ARRAY ARRAY['iran', 'international'] LOOP
    INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active, edition)
    SELECT NULL, p_slug, p_locale, p_subject, pg_temp._email_265_layout(p_locale, p_title, p_body), p_text, true, v_edition
     WHERE NOT EXISTS (
       SELECT 1 FROM public.email_templates
        WHERE workspace_id IS NULL AND edition = v_edition AND slug = p_slug AND locale = p_locale
     );
  END LOOP;
END;
$f$;

SELECT pg_temp._email_265_seed('billing_ai_pack_purchased', 'fa',
  'اعتبار هوش مصنوعی اضافه شد: {credit} — {brand}', 'اعتبار هوش مصنوعی اضافه شد',
  '<p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">{pack_name}: <strong>{credit}</strong> اعتبار هوش مصنوعی به فضای کاری شما اضافه شد. این اعتبار با پایان پلن منقضی نمی‌شود.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">مبلغ پرداخت‌شده: {amount}<br>موجودی حساب: {balance}<br>اعتبار هوش مصنوعی اکنون: {ai_balance}</p><p style="margin:24px 0 0;text-align:center;"><a href="{billing_url}" style="display:inline-block;background:#1E40AF;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;">صورت‌حساب</a></p>',
  '{pack_name}: {credit} اعتبار هوش مصنوعی به فضای کاری شما اضافه شد. این اعتبار با پایان پلن منقضی نمی‌شود. مبلغ پرداخت‌شده: {amount}. موجودی حساب: {balance}. اعتبار هوش مصنوعی اکنون: {ai_balance}. صورت‌حساب: {billing_url}');
SELECT pg_temp._email_265_seed('billing_ai_pack_purchased', 'en',
  'AI credit added: {credit} — {brand}', 'AI credit added',
  '<p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">{pack_name}: <strong>{credit}</strong> of AI credit was added to your workspace. It does not expire with your plan.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Paid: {amount}<br>Balance: {balance}<br>AI credit now: {ai_balance}</p><p style="margin:24px 0 0;text-align:center;"><a href="{billing_url}" style="display:inline-block;background:#1E40AF;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;">Billing</a></p>',
  '{pack_name}: {credit} of AI credit was added to your workspace. It does not expire with your plan. Paid: {amount}. Balance: {balance}. AI credit now: {ai_balance}. Billing: {billing_url}');
SELECT pg_temp._email_265_seed('billing_ai_pack_purchased', 'tr',
  'Yapay zekâ kredisi eklendi: {credit} — {brand}', 'Yapay zekâ kredisi eklendi',
  '<p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">{pack_name}: çalışma alanınıza <strong>{credit}</strong> yapay zekâ kredisi eklendi. Bu kredi planınızla birlikte sona ermez.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Ödenen: {amount}<br>Bakiyeniz: {balance}<br>Güncel yapay zekâ krediniz: {ai_balance}</p><p style="margin:24px 0 0;text-align:center;"><a href="{billing_url}" style="display:inline-block;background:#1E40AF;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;">Faturalandırma</a></p>',
  '{pack_name}: çalışma alanınıza {credit} yapay zekâ kredisi eklendi. Bu kredi planınızla birlikte sona ermez. Ödenen: {amount}. Bakiyeniz: {balance}. Güncel yapay zekâ krediniz: {ai_balance}. Faturalandırma: {billing_url}');

-- ─── 8. Access: the backend (service_role) only ──────────────────────────
DO $acl$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.billing_currency_exponent(text)',
    'public.billing_ai_wallet_rate(text)',
    'public.billing_ai_pack_find(text, text, text)',
    'public.billing_account_buy_ai_pack(uuid, text, bigint, text, uuid)',
    'public.billing_ai_pack_reverse(uuid, uuid, bigint, text, text, text)',
    'public.billing_account_settle_payment(uuid)',
    'public.billing_account_refund_payment(uuid, text, bigint)'
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

-- ─── 9. The packs' shape ──────────────────────────────────────────────────
COMMENT ON COLUMN public.billing_settings.ai_packs IS
  'AI credit packs per currency (iran: IRR; international: USD, TRY): {"USD": [{"id": "m", "price_minor": 2000, "credit_minor": 2200, "active": true, "label": {"fa": "…", "en": "…", "tr": "…"}}]}. price_minor and credit_minor are minor units of that currency; the credit is converted into the AI wallet''s unit (IRR) at purchase with ai_exchange_rates. id matches ^[a-z0-9][a-z0-9_-]{0,23}$ and is unique per currency; active defaults to true; at most 8 per currency. Sold by billing_account_buy_ai_pack (265).';
