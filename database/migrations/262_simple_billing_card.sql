-- 262 — Simple billing, phase 3b: the saved card that renews a Multi Region
-- plan automatically (docs/billing/SIMPLE_BILLING.md).
--
-- A saved card is a Paddle subscription that carries one recurring price we
-- set. Paddle's clock charges it 24 hours before our period end. The charge
-- comes in as a payment row (source card_renewal) and is credited to the
-- balance and spent on the renewal in the same transaction, so it becomes
-- the prepaid next period; the due moment then only starts that period. A
-- card account is never renewed from the balance on its own: at the due
-- moment without a card payment the workspace moves to Free and the card is
-- cancelled.
--
--   billing_account_cards     one row per Paddle subscription we ever saw;
--                             at most one live (active or past_due) per
--                             workspace. What Paddle showed at the last
--                             sync, and the reconciler's state.
--   billing_account_payments  gains where a payment came from (source), its
--                             card, when a charge was asked for, and why a
--                             card payment needs a person (review).
--
-- Changed: settling a card renewal (billing_card_apply_renewal), the
-- renewal (it can be told the price to charge: the card's), the due moment
-- (no balance auto-renew while a card is live), the renewal reminders (none
-- while the card pays) and the pruning of payments (card charges stay). An
-- account without a card behaves exactly as in 261. The Iran edition
-- (WebYar) never has a card row, so nothing changes there.
--
-- Triggers move a card's sync_version whenever what it should charge may
-- have changed (plan, interval, period, auto-renew, prices, VAT), so the
-- server's reconciler syncs it with Paddle again. A card row is never
-- deleted before Paddle has cancelled it (a workspace's purge marks it
-- canceling instead).
--
-- Server-only: every table and function is reachable by service_role alone.
-- Re-runnable: every step is guarded or a no-op the second time.

-- ─── 1. Cards ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.billing_account_cards (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- No foreign key: a card outlives its workspace until Paddle has cancelled
  -- it (the triggers below mark it canceling, and keep its row).
  workspace_id            uuid NOT NULL,
  provider                text NOT NULL,
  subscription_id         text NOT NULL,
  customer_id             text,
  currency                text NOT NULL,
  -- The checkout that saved the card (it paid the first period).
  setup_payment_id        uuid REFERENCES public.billing_account_payments(id) ON DELETE SET NULL,
  -- active | past_due: live, at most one per workspace. canceling: still to
  -- be cancelled at Paddle. canceled: final.
  status                  text NOT NULL DEFAULT 'active',
  cancel_reason           text,
  -- What we asked Paddle for: a cancel at the period end, or now. A cancel
  -- Paddle shows that we did not ask for was made in Paddle's own portal.
  cancel_intent           text,
  brand                   text,
  last4                   text,
  exp_month               integer,
  exp_year                integer,
  -- What Paddle showed at the last sync.
  paddle_status           text,
  paddle_next_billed_at   timestamptz,
  paddle_scheduled_change jsonb,
  paddle_item             jsonb,
  -- The reconciler: sync_version moves on every change that may change what
  -- the card should charge; synced_version is the last one Paddle matched.
  sync_version            bigint NOT NULL DEFAULT 1,
  synced_version          bigint NOT NULL DEFAULT 0,
  synced_at               timestamptz,
  sync_error              text,
  sync_failures           integer NOT NULL DEFAULT 0,
  next_sync_at            timestamptz NOT NULL DEFAULT now(),
  -- The last declined charge: {"at", "code", "txn"}.
  last_failure            jsonb,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  canceled_at             timestamptz
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_account_cards_provider_check') THEN
    ALTER TABLE public.billing_account_cards
      ADD CONSTRAINT billing_account_cards_provider_check CHECK (provider IN ('paddle', 'paddle_sandbox'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_account_cards_currency_check') THEN
    ALTER TABLE public.billing_account_cards
      ADD CONSTRAINT billing_account_cards_currency_check CHECK (currency ~ '^[A-Z]{3}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_account_cards_status_check') THEN
    ALTER TABLE public.billing_account_cards
      ADD CONSTRAINT billing_account_cards_status_check
      CHECK (status IN ('active', 'past_due', 'canceling', 'canceled'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_account_cards_cancel_intent_check') THEN
    ALTER TABLE public.billing_account_cards
      ADD CONSTRAINT billing_account_cards_cancel_intent_check
      CHECK (cancel_intent IS NULL OR cancel_intent IN ('period_end', 'now'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_account_cards_subscription
  ON public.billing_account_cards (provider, subscription_id);
-- One live card per workspace ("live" everywhere: active or past_due).
CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_account_cards_live
  ON public.billing_account_cards (workspace_id) WHERE status IN ('active', 'past_due');
CREATE INDEX IF NOT EXISTS idx_billing_account_cards_sync
  ON public.billing_account_cards (next_sync_at) WHERE status <> 'canceled';
CREATE INDEX IF NOT EXISTS idx_billing_account_cards_workspace
  ON public.billing_account_cards (workspace_id);

-- ─── 2. Payments: where a payment came from ───────────────────────────────
-- checkout     the customer paid a Paddle.js (or bank) checkout (as before);
-- card_setup   a checkout that also saves the card (its first period);
-- card_renewal a renewal Paddle charged on the card by itself;
-- card_charge  a charge we asked Paddle for (an upgrade), or one we did not
--              expect (credited to the balance, for review).
ALTER TABLE public.billing_account_payments ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'checkout';
ALTER TABLE public.billing_account_payments
  ADD COLUMN IF NOT EXISTS card_id uuid REFERENCES public.billing_account_cards(id) ON DELETE SET NULL;
-- Set just before the charge is asked for: from then on Paddle may have
-- charged, so the row is resolved by looking the charge up, never retried.
ALTER TABLE public.billing_account_payments ADD COLUMN IF NOT EXISTS charge_requested_at timestamptz;
-- Why a card payment was credited but needs a person: amount_mismatch,
-- unexpected_charge:<origin>, charge_mismatch.
ALTER TABLE public.billing_account_payments ADD COLUMN IF NOT EXISTS review text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_account_payments_source_check') THEN
    ALTER TABLE public.billing_account_payments
      ADD CONSTRAINT billing_account_payments_source_check
      CHECK (source IN ('checkout', 'card_setup', 'card_renewal', 'card_charge'));
  END IF;
END $$;

-- One upgrade charge in flight per workspace: a double click is refused.
CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_account_payments_card_charge
  ON public.billing_account_payments (workspace_id)
  WHERE source = 'card_charge' AND purpose = 'upgrade' AND status = 'pending';
CREATE INDEX IF NOT EXISTS idx_billing_account_payments_card
  ON public.billing_account_payments (card_id) WHERE card_id IS NOT NULL;
-- The job's activation recovery: card checkouts with no card yet.
CREATE INDEX IF NOT EXISTS idx_billing_account_payments_card_setup
  ON public.billing_account_payments (created_at) WHERE source = 'card_setup' AND card_id IS NULL;

-- ─── 3. Registering a card, and its status ────────────────────────────────

-- Records the card a checkout saved (Paddle's subscription.created, or the
-- job's recovery) for the workspace of that checkout's payment. A second
-- live card of the same workspace (two tabs) is recorded as canceling
-- ('duplicate'): the server cancels it at Paddle, and the period its
-- checkout paid stays paid. Otherwise it becomes the account's card,
-- auto-renew comes on, and the payment is linked to it. Idempotent per
-- subscription. The payment need not be settled yet: Paddle's events arrive
-- in any order. The payment is locked before the account, as its settlement
-- (billing_account_settle_payment) locks them: subscription.created and the
-- checkout's transaction.paid arrive together.
CREATE OR REPLACE FUNCTION public.billing_card_register(
  p_provider         text,
  p_subscription_id  text,
  p_customer_id      text,
  p_currency         text,
  p_setup_payment_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_pay      public.billing_account_payments;
  v_acc      public.billing_accounts;
  v_card     public.billing_account_cards;
  v_currency text := upper(coalesce(p_currency, ''));
  v_live     boolean;
BEGIN
  SELECT * INTO v_pay FROM public.billing_account_payments WHERE id = p_setup_payment_id FOR UPDATE;
  IF v_pay.id IS NULL OR v_pay.source <> 'card_setup' OR v_pay.provider IS DISTINCT FROM p_provider
     OR p_provider NOT IN ('paddle', 'paddle_sandbox') OR v_pay.currency <> v_currency
     OR coalesce(p_subscription_id, '') = '' THEN
    RAISE EXCEPTION 'billing_card_setup_invalid';
  END IF;
  v_acc := public.billing_account_lock(v_pay.workspace_id);
  IF v_acc.currency <> v_currency THEN
    RAISE EXCEPTION 'billing_account_currency_mismatch';
  END IF;
  SELECT * INTO v_card FROM public.billing_account_cards
   WHERE provider = p_provider AND subscription_id = p_subscription_id
   FOR UPDATE;
  IF v_card.id IS NOT NULL THEN
    IF v_card.workspace_id <> v_pay.workspace_id THEN
      RAISE EXCEPTION 'billing_card_conflict';
    END IF;
    RETURN jsonb_build_object(
      'card_id', v_card.id, 'workspace_id', v_card.workspace_id,
      'live', v_card.status IN ('active', 'past_due'),
      'duplicate', v_card.cancel_reason IS NOT DISTINCT FROM 'duplicate',
      'replayed', true
    );
  END IF;

  v_live := NOT EXISTS (
    SELECT 1 FROM public.billing_account_cards
     WHERE workspace_id = v_pay.workspace_id AND status IN ('active', 'past_due')
  );
  BEGIN
    INSERT INTO public.billing_account_cards (
      workspace_id, provider, subscription_id, customer_id, currency, setup_payment_id, status, cancel_reason
    ) VALUES (
      v_pay.workspace_id, p_provider, p_subscription_id, nullif(p_customer_id, ''), v_currency, v_pay.id,
      CASE WHEN v_live THEN 'active' ELSE 'canceling' END,
      CASE WHEN v_live THEN NULL ELSE 'duplicate' END
    ) RETURNING * INTO v_card;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'billing_card_conflict';
  END;
  UPDATE public.billing_account_payments
     SET card_id = v_card.id, updated_at = now()
   WHERE id = v_pay.id AND card_id IS NULL;
  IF v_live THEN
    -- "Default on" for Multi Region comes from here: the customer chose the
    -- card to renew the plan.
    UPDATE public.billing_accounts
       SET card_provider = p_provider,
           card_subscription_id = p_subscription_id,
           card_customer_id = coalesce(nullif(p_customer_id, ''), card_customer_id),
           auto_renew = true,
           updated_at = now()
     WHERE workspace_id = v_pay.workspace_id;
  END IF;
  RETURN jsonb_build_object(
    'card_id', v_card.id, 'workspace_id', v_card.workspace_id,
    'live', v_live, 'duplicate', NOT v_live, 'replayed', false
  );
END;
$$;

-- Moves a card between its states: active ↔ past_due; either → canceling
-- (to be cancelled at Paddle) → canceled (final). A card that stops being
-- live stops being the account's card: the pointer is cleared (the Paddle
-- customer is kept, for the next checkout) and auto-renew goes off. Moving
-- to the state a card is in, or away from canceled, changes nothing.
CREATE OR REPLACE FUNCTION public.billing_card_set_status(
  p_card_id uuid,
  p_status  text,
  p_reason  text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_card     public.billing_account_cards;
  v_previous text;
  v_was_live boolean;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('active', 'past_due', 'canceling', 'canceled') THEN
    RAISE EXCEPTION 'billing_card_status_invalid';
  END IF;
  SELECT * INTO v_card FROM public.billing_account_cards WHERE id = p_card_id;
  IF v_card.id IS NULL THEN
    RAISE EXCEPTION 'billing_card_not_found';
  END IF;
  -- The account first, then the card, as every card function locks. Not
  -- billing_account_lock: a deleted workspace has no account to create.
  PERFORM 1 FROM public.billing_accounts WHERE workspace_id = v_card.workspace_id FOR UPDATE;
  SELECT * INTO v_card FROM public.billing_account_cards WHERE id = p_card_id FOR UPDATE;
  v_previous := v_card.status;
  v_was_live := v_previous IN ('active', 'past_due');
  IF v_previous = p_status OR v_previous = 'canceled' THEN
    RETURN jsonb_build_object(
      'card_id', v_card.id, 'workspace_id', v_card.workspace_id, 'status', v_previous,
      'previous_status', v_previous, 'changed', false, 'was_live', v_was_live
    );
  END IF;
  IF v_previous = 'canceling' AND p_status IN ('active', 'past_due') THEN
    RAISE EXCEPTION 'billing_card_status_invalid';
  END IF;

  UPDATE public.billing_account_cards
     SET status = p_status,
         cancel_reason = CASE WHEN p_status IN ('canceling', 'canceled') THEN coalesce(cancel_reason, p_reason)
                              ELSE cancel_reason END,
         canceled_at = CASE WHEN p_status = 'canceled' THEN now() ELSE canceled_at END,
         -- A card to cancel is picked up at once, whatever its back-off.
         next_sync_at = CASE WHEN p_status = 'canceling' THEN least(next_sync_at, now()) ELSE next_sync_at END,
         updated_at = now()
   WHERE id = v_card.id;
  IF p_status IN ('canceling', 'canceled') THEN
    UPDATE public.billing_accounts
       SET card_provider = NULL, card_subscription_id = NULL, auto_renew = false, updated_at = now()
     WHERE workspace_id = v_card.workspace_id
       AND card_provider = v_card.provider
       AND card_subscription_id = v_card.subscription_id;
  END IF;
  RETURN jsonb_build_object(
    'card_id', v_card.id, 'workspace_id', v_card.workspace_id, 'status', p_status,
    'previous_status', v_previous, 'changed', true, 'was_live', v_was_live
  );
END;
$$;

-- ─── 4. A charge Paddle made on a card ────────────────────────────────────
-- One transaction of a card's subscription as a payment row (pending until
-- Paddle reports it paid), recorded once per transaction:
--   subscription_recurring  the renewal Paddle charged: a card_renewal row
--                           for the next period, net and tax from the price's
--                           custom_data as we set it. Amounts that do not add
--                           up make it a top-up, for review.
--   subscription_charge     our own /charge (an upgrade): binds the pending
--                           card_charge row it was made for (p_payment_id),
--                           when that row matches; else a top-up, for review.
--   anything else           (a charge made in Paddle's dashboard, an update
--                           that billed): a top-up, for review.
-- Money is never dropped: what cannot be spent on its purpose stays in the
-- balance. Zero-amount transactions (a card change) have no row.
CREATE OR REPLACE FUNCTION public.billing_card_record_charge(
  p_card_id      uuid,
  p_txn_id       text,
  p_origin       text,
  p_amount_minor bigint,
  p_currency     text,
  p_items        jsonb DEFAULT '[]'::jsonb,
  p_payment_id   uuid DEFAULT NULL
) RETURNS public.billing_account_payments
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_card     public.billing_account_cards;
  v_pay      public.billing_account_payments;
  v_claimed  public.billing_account_payments;
  v_currency text := upper(coalesce(p_currency, ''));
  v_item     jsonb;
  v_net      numeric;
  v_tax      numeric;
  v_plan     text;
  v_interval text;
  v_source   text := 'card_charge';
  v_purpose  text := 'topup';
  v_detail   jsonb;
  v_review   text;
  v_vat      numeric;
BEGIN
  IF p_amount_minor IS NULL OR p_amount_minor <= 0 THEN
    RAISE EXCEPTION 'billing_card_charge_amount_invalid';
  END IF;
  IF coalesce(p_txn_id, '') = '' THEN
    RAISE EXCEPTION 'billing_payment_reference_missing';
  END IF;
  SELECT * INTO v_card FROM public.billing_account_cards WHERE id = p_card_id;
  IF v_card.id IS NULL THEN
    RAISE EXCEPTION 'billing_card_not_found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspaces WHERE id = v_card.workspace_id) THEN
    RAISE EXCEPTION 'billing_card_workspace_missing';
  END IF;
  -- Under the account lock, so one transaction reported twice at once is
  -- recorded once.
  PERFORM public.billing_account_lock(v_card.workspace_id);
  SELECT * INTO v_pay FROM public.billing_account_payments
   WHERE provider = v_card.provider AND (provider_ref = p_txn_id OR provider_payment_id = p_txn_id)
   ORDER BY (provider_ref IS NOT DISTINCT FROM p_txn_id) DESC
   LIMIT 1;
  IF v_pay.id IS NOT NULL THEN
    IF v_pay.workspace_id <> v_card.workspace_id THEN
      RAISE EXCEPTION 'billing_card_conflict';
    END IF;
    RETURN v_pay;
  END IF;
  IF v_currency <> v_card.currency THEN
    RAISE EXCEPTION 'billing_account_currency_mismatch';
  END IF;

  -- Our own /charge: the pending row it was asked for, when it matches.
  IF p_origin = 'subscription_charge' AND p_payment_id IS NOT NULL THEN
    SELECT * INTO v_claimed FROM public.billing_account_payments WHERE id = p_payment_id FOR UPDATE;
    IF v_claimed.id IS NOT NULL AND v_claimed.source = 'card_charge' AND v_claimed.status = 'pending'
       AND v_claimed.workspace_id = v_card.workspace_id AND v_claimed.card_id = v_card.id
       AND v_claimed.provider = v_card.provider
       AND v_claimed.provider_ref IS NULL AND v_claimed.provider_payment_id IS NULL
       AND v_claimed.amount_minor = p_amount_minor AND v_claimed.currency = v_currency THEN
      UPDATE public.billing_account_payments
         SET provider_ref = p_txn_id, updated_at = now()
       WHERE id = v_claimed.id
       RETURNING * INTO v_pay;
      RETURN v_pay;
    END IF;
    v_review := 'charge_mismatch';
  END IF;

  v_net := p_amount_minor;
  v_tax := 0;
  v_detail := jsonb_strip_nulls(jsonb_build_object(
    'card_id', v_card.id, 'origin', p_origin,
    'claimed_payment_id', CASE WHEN v_review = 'charge_mismatch' THEN p_payment_id END
  ));
  IF p_origin = 'subscription_recurring' THEN
    v_source := 'card_renewal';
    v_item := CASE WHEN jsonb_typeof(p_items) = 'array' THEN p_items -> 0 END;
    IF jsonb_typeof(v_item) = 'object' THEN
      v_net := public.billing_jsonb_number(v_item -> 'net_minor');
      v_tax := coalesce(public.billing_jsonb_number(v_item -> 'tax_minor'), 0);
      v_plan := v_item ->> 'plan_id';
      v_interval := v_item ->> 'interval';
    ELSE
      v_net := NULL;
    END IF;
    IF v_net IS NOT NULL AND v_net > 0 AND v_net = trunc(v_net) AND v_tax >= 0 AND v_tax = trunc(v_tax)
       AND v_net + v_tax = p_amount_minor THEN
      v_purpose := 'renewal';
      v_detail := jsonb_strip_nulls(jsonb_build_object(
        'plan_id', CASE WHEN v_plan ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN lower(v_plan) END,
        'billing_interval', CASE WHEN v_interval IN ('monthly', 'month') THEN 'monthly'
                                 WHEN v_interval IN ('yearly', 'year') THEN 'yearly' END,
        'card_id', v_card.id
      ));
    ELSE
      v_net := p_amount_minor;
      v_tax := 0;
      v_review := 'amount_mismatch';
    END IF;
  ELSE
    v_review := coalesce(v_review, 'unexpected_charge:' || coalesce(nullif(p_origin, ''), 'unknown'));
  END IF;

  -- The VAT percent of a renewal's tax is the one its item was priced with
  -- (the item carries it): the item may have been set before a VAT change
  -- that could not reach Paddle in time. An item without it: today's percent
  -- when it gives that tax, else the percent the item's own amounts make.
  IF v_tax > 0 THEN
    v_vat := public.billing_jsonb_number(v_item -> 'vat_percent');
    IF v_vat IS NULL OR v_vat <= 0 OR v_vat >= 100 THEN
      SELECT public.billing_jsonb_number(s.vat_percent -> v_currency) INTO v_vat
        FROM public.billing_settings s WHERE s.edition = public.platform_edition();
      IF v_vat IS NULL OR v_vat <= 0 OR v_vat >= 100 OR round(v_net * round(v_vat, 3) / 100) <> v_tax THEN
        v_vat := v_tax * 100 / v_net;
      END IF;
    END IF;
    v_vat := CASE WHEN v_vat > 0 AND v_vat < 100 THEN round(v_vat, 3) END;
  END IF;
  INSERT INTO public.billing_account_payments (
    workspace_id, provider, currency, amount_minor, net_minor, tax_minor, tax_percent,
    purpose, purpose_detail, status, provider_ref, created_by, source, card_id, review
  ) VALUES (
    v_card.workspace_id, v_card.provider, v_currency, p_amount_minor, v_net::bigint, v_tax::bigint,
    CASE WHEN v_tax > 0 THEN v_vat END,
    v_purpose, v_detail, 'pending', p_txn_id, NULL, v_source, v_card.id, v_review
  ) RETURNING * INTO v_pay;
  RETURN v_pay;
END;
$$;

-- ─── 5. Settling a card payment, and what a card renewal pays for ─────────

-- A card payment Paddle reports paid: its confirmation and its settlement
-- (the credit, then the purpose) in one transaction. The transaction must be
-- the one the row was recorded for. The account is locked before the
-- payment, as billing_card_record_charge locks them, so binding a charge and
-- settling it at the same time wait for each other instead of deadlocking.
-- A payment this transaction already settled (paid, then completed) answers
-- without asking for the payment's lock: a refund holds that lock while it
-- waits for the account's. A purpose that could not be done (a renewal
-- guard, a failed upgrade) is kept as the payment's review reason: the money
-- is in the balance and a person should look.
CREATE OR REPLACE FUNCTION public.billing_card_settle(
  p_payment_id   uuid,
  p_amount_minor bigint,
  p_currency     text,
  p_txn_id       text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_pay    public.billing_account_payments;
  v_result jsonb;
BEGIN
  SELECT * INTO v_pay FROM public.billing_account_payments WHERE id = p_payment_id;
  IF v_pay.id IS NULL THEN
    RAISE EXCEPTION 'billing_payment_not_found';
  END IF;
  PERFORM 1 FROM public.billing_accounts WHERE workspace_id = v_pay.workspace_id FOR UPDATE;
  SELECT * INTO v_pay FROM public.billing_account_payments WHERE id = p_payment_id;
  IF v_pay.provider_ref IS NOT NULL AND v_pay.provider_ref IS DISTINCT FROM p_txn_id THEN
    RAISE EXCEPTION 'billing_payment_reference_mismatch';
  END IF;
  IF v_pay.status = 'succeeded' AND v_pay.provider_payment_id = p_txn_id THEN
    RETURN jsonb_build_object('replayed', true, 'ledger_id', v_pay.ledger_id, 'payment_id', v_pay.id);
  END IF;
  IF v_pay.verified_at IS NULL OR v_pay.provider_payment_id IS DISTINCT FROM p_txn_id THEN
    PERFORM public.billing_account_record_verification(p_payment_id, p_amount_minor, p_currency, p_txn_id);
  END IF;
  v_result := public.billing_account_settle_payment(p_payment_id);
  IF v_result -> 'purpose_result' ->> 'error' IS NOT NULL THEN
    UPDATE public.billing_account_payments
       SET review = coalesce(review, left(v_result -> 'purpose_result' ->> 'error', 200)), updated_at = now()
     WHERE id = p_payment_id;
  END IF;
  RETURN v_result;
END;
$$;

-- What a card renewal pays for (called by billing_account_settle_payment,
-- the payment already credited to the balance): the next period of the
-- running paid plan, kept as the prepaid next period. It spends nothing, and
-- says why, unless this card is the account's live card, auto-renew is on,
-- the next period is not paid yet, it is sold, and the payment covers its
-- price; the money then stays in the balance, for review. A charge for the
-- next period's own plan and interval is spent at the price Paddle charged
-- when that is below today's: a price raised too late to reach Paddle's
-- item applies from the next cycle. A renewal that arrives after the plan
-- ended because this card had not paid by then (the card was cancelled as
-- 'not_renewed') buys the plan again, if it covers that plan's price: the
-- customer paid for it, and their balance is never spent on a difference.
CREATE OR REPLACE FUNCTION public.billing_card_apply_renewal(
  p_payment public.billing_account_payments
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_card     public.billing_account_cards;
  v_acc      public.billing_accounts;
  v_sub      public.workspace_subscriptions;
  v_plan     public.billing_plans;
  v_target   uuid;
  v_interval text;
  v_price    bigint;
  v_charged  bigint;
BEGIN
  SELECT * INTO v_card FROM public.billing_account_cards WHERE id = p_payment.card_id;
  IF v_card.id IS NULL THEN
    RETURN jsonb_build_object('error', 'card_not_found');
  END IF;
  SELECT * INTO v_acc FROM public.billing_accounts WHERE workspace_id = p_payment.workspace_id FOR UPDATE;
  v_sub := public.billing_account_paid_subscription(p_payment.workspace_id);
  IF v_sub.id IS NULL THEN
    IF v_card.status IN ('canceling', 'canceled') AND v_card.cancel_reason = 'not_renewed'
       AND p_payment.purpose_detail ? 'plan_id' THEN
      v_interval := coalesce(p_payment.purpose_detail ->> 'billing_interval', 'monthly');
      v_price := public.billing_plan_price((p_payment.purpose_detail ->> 'plan_id')::uuid, v_acc.currency, v_interval);
      IF v_price IS NULL OR v_price <= 0 THEN
        RETURN jsonb_build_object('error', 'price_unavailable', 'late', true);
      END IF;
      IF p_payment.net_minor < v_price THEN
        RETURN jsonb_build_object('error', 'amount_below_price', 'late', true);
      END IF;
      RETURN public.billing_account_purchase_plan(
        p_payment.workspace_id, (p_payment.purpose_detail ->> 'plan_id')::uuid, v_interval,
        'payment:' || p_payment.id::text, NULL
      ) || jsonb_build_object('card', true, 'late', true);
    END IF;
    RETURN jsonb_build_object('error', 'no_paid_plan');
  END IF;
  IF v_card.status NOT IN ('active', 'past_due')
     OR v_acc.card_provider IS DISTINCT FROM v_card.provider
     OR v_acc.card_subscription_id IS DISTINCT FROM v_card.subscription_id THEN
    RETURN jsonb_build_object('error', 'card_not_live');
  END IF;
  IF NOT v_acc.auto_renew THEN
    RETURN jsonb_build_object('error', 'auto_renew_off');
  END IF;
  IF (v_acc.next_period_prepaid_minor IS NOT NULL AND v_acc.next_period_start IS NOT DISTINCT FROM v_sub.current_period_end)
     OR public.billing_account_v2_next_period(p_payment.workspace_id) IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'already_renewed');
  END IF;
  v_target := coalesce(v_acc.scheduled_plan_id, v_sub.plan_id);
  v_interval := coalesce(v_acc.scheduled_interval, v_sub.billing_interval, 'monthly');
  SELECT * INTO v_plan FROM public.billing_plans WHERE id = v_target;
  IF v_plan.is_free THEN
    RETURN jsonb_build_object('error', 'renewal_to_free');
  END IF;
  v_price := public.billing_plan_price(v_target, v_acc.currency, v_interval);
  IF v_price IS NULL OR v_price <= 0 THEN
    RETURN jsonb_build_object('error', 'price_unavailable');
  END IF;
  -- Charged for exactly this plan and interval: the item the reconciler set,
  -- whose price may not have caught up with a rise (Paddle's lock and our
  -- freeze before the charge). That price is the one spent.
  IF p_payment.purpose_detail ->> 'plan_id' = v_target::text
     AND p_payment.purpose_detail ->> 'billing_interval' = v_interval THEN
    v_charged := least(p_payment.net_minor, v_price);
  ELSIF p_payment.net_minor < v_price THEN
    RETURN jsonb_build_object('error', 'amount_below_price');
  END IF;
  RETURN public.billing_account_renew(
           p_payment.workspace_id, NULL, v_sub.current_period_end, coalesce(v_charged, v_price), v_charged)
    || jsonb_build_object('card', true);
END;
$$;

-- ─── 6. The reconciler's queue ────────────────────────────────────────────
-- Cards to sync with Paddle now: changed since the last sync, to be
-- cancelled, never synced, not checked for 6 hours, or whose Paddle date has
-- passed (Paddle should have moved it on). A card backing off after errors
-- waits for its next_sync_at.
CREATE OR REPLACE FUNCTION public.billing_card_sync_candidates(p_limit integer DEFAULT 100)
RETURNS SETOF public.billing_account_cards
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT c.* FROM public.billing_account_cards c
   WHERE c.status <> 'canceled'
     AND c.next_sync_at <= now()
     AND (c.sync_version > c.synced_version
          OR c.status = 'canceling'
          OR c.synced_at IS NULL
          OR c.synced_at < now() - interval '6 hours'
          OR c.paddle_next_billed_at < now() - interval '1 hour')
   ORDER BY c.next_sync_at
   LIMIT greatest(coalesce(p_limit, 100), 1)
$$;

-- The result of one sync: what Paddle showed (only the keys given), then
-- either success (synced_version becomes p_version only while the card is
-- still at that version: a change made during the sync is synced again at
-- once) or an error (backs off 2^failures minutes, at most an hour). True
-- when the sync covered the card's current version.
CREATE OR REPLACE FUNCTION public.billing_card_mark_synced(
  p_card_id uuid,
  p_version bigint,
  p_mirror  jsonb DEFAULT '{}'::jsonb,
  p_error   text DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_card   public.billing_account_cards;
  v_mirror jsonb := CASE WHEN jsonb_typeof(p_mirror) = 'object' THEN p_mirror ELSE '{}'::jsonb END;
  v_error  text := nullif(p_error, '');
BEGIN
  SELECT * INTO v_card FROM public.billing_account_cards WHERE id = p_card_id FOR UPDATE;
  IF v_card.id IS NULL THEN
    RAISE EXCEPTION 'billing_card_not_found';
  END IF;
  UPDATE public.billing_account_cards
     SET paddle_status = CASE WHEN v_mirror ? 'paddle_status' THEN v_mirror ->> 'paddle_status' ELSE paddle_status END,
         paddle_next_billed_at = CASE WHEN v_mirror ? 'paddle_next_billed_at'
                                      THEN (v_mirror ->> 'paddle_next_billed_at')::timestamptz ELSE paddle_next_billed_at END,
         paddle_scheduled_change = CASE WHEN v_mirror ? 'paddle_scheduled_change'
                                        THEN nullif(v_mirror -> 'paddle_scheduled_change', 'null'::jsonb) ELSE paddle_scheduled_change END,
         paddle_item = CASE WHEN v_mirror ? 'paddle_item' THEN nullif(v_mirror -> 'paddle_item', 'null'::jsonb) ELSE paddle_item END,
         customer_id = CASE WHEN v_mirror ? 'customer_id' THEN v_mirror ->> 'customer_id' ELSE customer_id END,
         brand = CASE WHEN v_mirror ? 'brand' THEN v_mirror ->> 'brand' ELSE brand END,
         last4 = CASE WHEN v_mirror ? 'last4' THEN v_mirror ->> 'last4' ELSE last4 END,
         exp_month = CASE WHEN v_mirror ? 'exp_month' THEN public.billing_jsonb_number(v_mirror -> 'exp_month')::integer ELSE exp_month END,
         exp_year = CASE WHEN v_mirror ? 'exp_year' THEN public.billing_jsonb_number(v_mirror -> 'exp_year')::integer ELSE exp_year END,
         cancel_intent = CASE WHEN v_mirror ? 'cancel_intent' THEN v_mirror ->> 'cancel_intent' ELSE cancel_intent END,
         synced_at = CASE WHEN v_error IS NULL THEN now() ELSE synced_at END,
         sync_error = CASE WHEN v_error IS NULL THEN NULL ELSE left(v_error, 500) END,
         sync_failures = CASE WHEN v_error IS NULL THEN 0 ELSE sync_failures + 1 END,
         synced_version = CASE WHEN v_error IS NULL AND sync_version = p_version THEN p_version ELSE synced_version END,
         next_sync_at = CASE
           WHEN v_error IS NOT NULL THEN now() + least(power(2, least(sync_failures, 6)), 60) * interval '1 minute'
           WHEN sync_version > p_version THEN now()
           ELSE now() + interval '6 hours'
         END,
         updated_at = now()
   WHERE id = p_card_id;
  RETURN v_error IS NULL AND v_card.sync_version = p_version;
END;
$$;

-- ─── 7. What a card should charge may have changed ────────────────────────
-- The workspace's cards that are not cancelled are synced again soon (their
-- back-off is cut short). Cheap, and a no-op for a workspace without a card.
CREATE OR REPLACE FUNCTION public.billing_card_touch_workspace(p_workspace_id uuid)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  UPDATE public.billing_account_cards
     SET sync_version = sync_version + 1, next_sync_at = least(next_sync_at, now()), updated_at = now()
   WHERE workspace_id = p_workspace_id AND status <> 'canceled'
$$;

-- billing_accounts and workspace_subscriptions (the columns are in each
-- trigger's WHEN), and a subscription row deleted (a Super Admin revoke:
-- the card must be cancelled before Paddle charges for a plan that is gone).
-- A row deleted with its workspace is left to billing_card_workspace_deleted:
-- touching the cards in the middle of that cascade would write a card whose
-- setup payment is being deleted. Security definer: whoever changes those
-- rows, the cards table stays server-only.
CREATE OR REPLACE FUNCTION public.billing_card_touch_trigger()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = OLD.workspace_id) THEN
      PERFORM public.billing_card_touch_workspace(OLD.workspace_id);
    END IF;
    RETURN NULL;
  END IF;
  PERFORM public.billing_card_touch_workspace(NEW.workspace_id);
  RETURN NULL;
END;
$$;

-- A plan's prices or availability: the workspaces on it now or next.
CREATE OR REPLACE FUNCTION public.billing_card_touch_plan()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.billing_account_cards c
     SET sync_version = c.sync_version + 1, next_sync_at = least(c.next_sync_at, now()), updated_at = now()
   WHERE c.status <> 'canceled'
     AND (EXISTS (SELECT 1 FROM public.workspace_subscriptions s WHERE s.workspace_id = c.workspace_id AND s.plan_id = NEW.id)
          OR EXISTS (SELECT 1 FROM public.billing_accounts a WHERE a.workspace_id = c.workspace_id AND a.scheduled_plan_id = NEW.id));
  RETURN NULL;
END;
$$;

-- The VAT percent: every card that is not cancelled.
CREATE OR REPLACE FUNCTION public.billing_card_touch_settings()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR OLD.vat_percent IS DISTINCT FROM NEW.vat_percent THEN
    UPDATE public.billing_account_cards
       SET sync_version = sync_version + 1, next_sync_at = least(next_sync_at, now()), updated_at = now()
     WHERE status <> 'canceled';
  END IF;
  RETURN NULL;
END;
$$;

-- A deleted workspace's live card is cancelled at Paddle by the job. Its
-- account may already be gone (cascade): only the card is written.
CREATE OR REPLACE FUNCTION public.billing_card_workspace_deleted()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.billing_account_cards
     SET status = 'canceling',
         cancel_reason = coalesce(cancel_reason, 'workspace_deleted'),
         sync_version = sync_version + 1,
         next_sync_at = least(next_sync_at, now()),
         updated_at = now()
   WHERE workspace_id = OLD.id AND status IN ('active', 'past_due');
  RETURN NULL;
END;
$$;

-- A card row is never deleted before it is cancelled at Paddle: the
-- workspace purge (admin_purge_workspaces) deletes every workspace-scoped
-- row, the cards included, before the workspace itself, so the trigger
-- above would find none and Paddle would go on charging. Such a card stays,
-- marked canceling for the job (it has no foreign key to its workspace); a
-- cancelled one is deleted.
CREATE OR REPLACE FUNCTION public.billing_card_keep_on_delete()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.status = 'canceled' THEN
    RETURN OLD;
  END IF;
  UPDATE public.billing_account_cards
     SET status = 'canceling',
         cancel_reason = coalesce(cancel_reason, 'workspace_deleted'),
         sync_version = sync_version + 1,
         next_sync_at = least(next_sync_at, now()),
         updated_at = now()
   WHERE id = OLD.id;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_billing_card_touch_account ON public.billing_accounts;
CREATE TRIGGER trg_billing_card_touch_account
  AFTER UPDATE ON public.billing_accounts
  FOR EACH ROW
  WHEN (OLD.auto_renew IS DISTINCT FROM NEW.auto_renew
        OR OLD.scheduled_plan_id IS DISTINCT FROM NEW.scheduled_plan_id
        OR OLD.scheduled_interval IS DISTINCT FROM NEW.scheduled_interval
        OR OLD.next_period_prepaid_minor IS DISTINCT FROM NEW.next_period_prepaid_minor
        OR OLD.next_period_start IS DISTINCT FROM NEW.next_period_start)
  EXECUTE FUNCTION public.billing_card_touch_trigger();

DROP TRIGGER IF EXISTS trg_billing_card_touch_subscription_insert ON public.workspace_subscriptions;
CREATE TRIGGER trg_billing_card_touch_subscription_insert
  AFTER INSERT ON public.workspace_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.billing_card_touch_trigger();

DROP TRIGGER IF EXISTS trg_billing_card_touch_subscription_update ON public.workspace_subscriptions;
CREATE TRIGGER trg_billing_card_touch_subscription_update
  AFTER UPDATE ON public.workspace_subscriptions
  FOR EACH ROW
  WHEN (OLD.plan_id IS DISTINCT FROM NEW.plan_id
        OR OLD.status IS DISTINCT FROM NEW.status
        OR OLD.billing_interval IS DISTINCT FROM NEW.billing_interval
        OR OLD.current_period_end IS DISTINCT FROM NEW.current_period_end)
  EXECUTE FUNCTION public.billing_card_touch_trigger();

DROP TRIGGER IF EXISTS trg_billing_card_touch_subscription_delete ON public.workspace_subscriptions;
CREATE TRIGGER trg_billing_card_touch_subscription_delete
  AFTER DELETE ON public.workspace_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.billing_card_touch_trigger();

DROP TRIGGER IF EXISTS trg_billing_card_touch_plan ON public.billing_plans;
CREATE TRIGGER trg_billing_card_touch_plan
  AFTER UPDATE ON public.billing_plans
  FOR EACH ROW
  WHEN (OLD.prices IS DISTINCT FROM NEW.prices
        OR OLD.is_active IS DISTINCT FROM NEW.is_active
        OR OLD.is_hidden IS DISTINCT FROM NEW.is_hidden
        OR OLD.is_free IS DISTINCT FROM NEW.is_free)
  EXECUTE FUNCTION public.billing_card_touch_plan();

DROP TRIGGER IF EXISTS trg_billing_card_touch_settings ON public.billing_settings;
CREATE TRIGGER trg_billing_card_touch_settings
  AFTER INSERT OR UPDATE OF vat_percent ON public.billing_settings
  FOR EACH ROW EXECUTE FUNCTION public.billing_card_touch_settings();

DROP TRIGGER IF EXISTS trg_billing_card_workspace_deleted ON public.workspaces;
CREATE TRIGGER trg_billing_card_workspace_deleted
  AFTER DELETE ON public.workspaces
  FOR EACH ROW EXECUTE FUNCTION public.billing_card_workspace_deleted();

DROP TRIGGER IF EXISTS trg_billing_card_keep_on_delete ON public.billing_account_cards;
CREATE TRIGGER trg_billing_card_keep_on_delete
  BEFORE DELETE ON public.billing_account_cards
  FOR EACH ROW EXECUTE FUNCTION public.billing_card_keep_on_delete();

-- ─── 8. 261's renewal, settlement, due moment and reminders; 259's pruning ─

-- 261's renewal, which can now be told the price to charge
-- (p_price_override_minor, instead of the plan's price): a card renewal pays
-- the price Paddle charged for the next period's plan and interval
-- (billing_card_apply_renewal). Without it, exactly 261's. The 4-argument
-- function is replaced, not overloaded, so 261's calls (named, 3 or 4
-- arguments) reach this one without ambiguity.
DROP FUNCTION IF EXISTS public.billing_account_renew(uuid, uuid, timestamptz, bigint);
CREATE OR REPLACE FUNCTION public.billing_account_renew(
  p_workspace_id         uuid,
  p_actor                uuid DEFAULT NULL,
  p_expected_period_end  timestamptz DEFAULT NULL,
  p_expected_price_minor bigint DEFAULT NULL,
  p_price_override_minor bigint DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_acc      public.billing_accounts;
  v_sub      public.workspace_subscriptions;
  v_plan     public.billing_plans;
  v_target   uuid;
  v_interval text;
  v_price    bigint;
  v_start    timestamptz;
  v_end      timestamptz;
  v_entry    public.billing_account_ledger;
BEGIN
  v_acc := public.billing_account_lock(p_workspace_id);
  PERFORM public.billing_account_release_stale_prepaid(p_workspace_id);
  SELECT * INTO v_acc FROM public.billing_accounts WHERE workspace_id = p_workspace_id FOR UPDATE;
  v_sub := public.billing_account_paid_subscription(p_workspace_id);
  IF v_sub.id IS NULL THEN
    RAISE EXCEPTION 'billing_no_paid_plan';
  END IF;
  -- The renewal is for the period the customer (or the job) saw: once that
  -- period was renewed or replaced, a retry or a second tab renews nothing.
  -- (A period end that went through JSON or a browser keeps milliseconds
  -- only; periods are months apart, so a second's tolerance is exact enough.)
  IF p_expected_period_end IS NOT NULL
     AND abs(extract(epoch FROM v_sub.current_period_end - p_expected_period_end)) >= 1 THEN
    RAISE EXCEPTION 'billing_period_changed';
  END IF;
  IF v_acc.next_period_prepaid_minor IS NOT NULL OR public.billing_account_v2_next_period(p_workspace_id) IS NOT NULL THEN
    RAISE EXCEPTION 'billing_already_renewed';
  END IF;
  v_target := coalesce(v_acc.scheduled_plan_id, v_sub.plan_id);
  v_interval := coalesce(v_acc.scheduled_interval, v_sub.billing_interval, 'monthly');
  SELECT * INTO v_plan FROM public.billing_plans WHERE id = v_target;
  IF v_plan.is_free THEN
    RAISE EXCEPTION 'billing_renewal_to_free';
  END IF;
  v_price := CASE WHEN p_price_override_minor IS NOT NULL THEN p_price_override_minor
                  ELSE public.billing_plan_price(v_target, v_acc.currency, v_interval) END;
  IF v_price IS NULL OR v_price <= 0 THEN
    RAISE EXCEPTION 'billing_plan_price_unavailable';
  END IF;
  -- The price the customer was shown (the page sends it): a price or a
  -- scheduled change that moved since is never charged unseen.
  IF p_expected_price_minor IS NOT NULL AND p_expected_price_minor <> v_price THEN
    RAISE EXCEPTION 'billing_quote_changed';
  END IF;
  -- Due and not yet processed: the next period follows on from the current
  -- one, unless it ended long ago (then it starts now).
  v_start := CASE WHEN v_sub.current_period_end > now() - interval '1 day' THEN v_sub.current_period_end ELSE now() END;
  v_end := public.billing_period_end(v_start, v_interval);
  -- Every renewal is its own charge (the guards above keep it to one per
  -- period); a returned prepayment never lets a later renewal replay it.
  v_entry := public.billing_account_debit(
    p_workspace_id, 'renewal', v_price, v_target, v_interval, v_start, v_end,
    jsonb_build_object('plan_slug', v_plan.slug), p_actor,
    'renewal:' || p_workspace_id::text || ':' || to_char(v_sub.current_period_end AT TIME ZONE 'UTC', 'YYYYMMDD"T"HH24MISS')
      || ':' || gen_random_uuid()::text
  );
  IF v_sub.current_period_end > now() THEN
    UPDATE public.billing_accounts
       SET next_period_prepaid_minor = v_price, next_period_start = v_sub.current_period_end, updated_at = now()
     WHERE workspace_id = p_workspace_id;
    RETURN jsonb_build_object(
      'action', 'prepaid', 'ledger_id', v_entry.id, 'plan_id', v_target, 'billing_interval', v_interval,
      'period_start', v_start, 'period_end', v_end, 'amount_minor', v_price, 'balance_minor', v_entry.balance_after
    );
  END IF;
  UPDATE public.billing_accounts
     SET scheduled_plan_id = NULL, scheduled_interval = NULL, next_period_prepaid_minor = NULL,
         next_period_start = NULL, updated_at = now()
   WHERE workspace_id = p_workspace_id;
  PERFORM public.billing_account_write_subscription(
    p_workspace_id, v_target, v_interval, v_start, v_end, 'active',
    CASE WHEN v_target = v_sub.plan_id THEN 'renewal' ELSE 'change' END, p_actor,
    jsonb_build_object('ledger_id', v_entry.id, 'price_minor', v_price)
  );
  PERFORM public.billing_account_grant_month(p_workspace_id, v_target, v_start, v_end);
  RETURN jsonb_build_object(
    'action', 'renewed', 'ledger_id', v_entry.id, 'plan_id', v_target, 'previous_plan_id', v_sub.plan_id,
    'billing_interval', v_interval, 'period_start', v_start, 'period_end', v_end,
    'amount_minor', v_price, 'balance_minor', v_entry.balance_after
  );
END;
$$;

-- 259's settlement, now also spending the credit on the payment's purpose
-- (plan, renewal, upgrade) in the same transaction. If the purpose can no
-- longer be done (the plan changed meanwhile), the money stays in the
-- balance and the reason is returned. A renewal Paddle charged on a saved
-- card (source card_renewal) is spent by billing_card_apply_renewal, which
-- has its own rule for a renewal paid after the plan ended.
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

  IF v_pay.purpose IN ('plan', 'renewal', 'upgrade') THEN
    BEGIN
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

-- The due moment (261), with a saved card: for a paid period that has ended,
-- a prepaid next period starts (a card renewal arrives as one); else, with
-- auto-renew on and enough balance, it is renewed from the balance, but only
-- without a live card (a card account is renewed by its card alone); else
-- (or when the change scheduled for the period end is the free plan) the
-- workspace moves to Free at once, and a live card is marked canceling and
-- returned as card_cancel for the server to cancel at Paddle. Returns what
-- happened, for the mail.
CREATE OR REPLACE FUNCTION public.billing_account_process_due(
  p_workspace_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_acc      public.billing_accounts;
  v_sub      public.workspace_subscriptions;
  v_plan     public.billing_plans;
  v_target   uuid;
  v_interval text;
  v_price    bigint;
  v_start    timestamptz;
  v_end      timestamptz;
  v_result   jsonb;
  v_reason   text;
  v_v2       uuid;
  v_card     public.billing_account_cards;
BEGIN
  v_acc := public.billing_account_lock(p_workspace_id);
  v_sub := public.billing_account_paid_subscription(p_workspace_id);
  IF v_sub.id IS NULL OR v_sub.current_period_end > now() THEN
    RETURN jsonb_build_object('action', 'none');
  END IF;

  -- A next period already paid through billing v2 (its scheduler no longer
  -- runs) starts now, as v2 would have started it.
  IF to_regclass('public.billing_subscription_periods') IS NOT NULL THEN
    SELECT id INTO v_v2 FROM public.billing_subscription_periods
     WHERE workspace_id = p_workspace_id AND status = 'scheduled' AND period_start <= now()
     ORDER BY period_start DESC LIMIT 1;
    IF v_v2 IS NOT NULL THEN
      PERFORM public.billing_activate_period(v_v2);
      -- A prepayment made here for the same next period returns.
      PERFORM public.billing_account_release_stale_prepaid(p_workspace_id);
      SELECT * INTO v_acc FROM public.billing_accounts WHERE workspace_id = p_workspace_id;
      SELECT * INTO v_sub FROM public.workspace_subscriptions WHERE workspace_id = p_workspace_id;
      RETURN jsonb_build_object(
        'action', 'renewed', 'source', 'billing_v2', 'plan_id', v_sub.plan_id, 'billing_interval', v_sub.billing_interval,
        'period_start', v_sub.current_period_start, 'period_end', v_sub.current_period_end, 'amount_minor', 0,
        'balance_minor', v_acc.balance_minor
      );
    END IF;
  END IF;

  -- A prepayment made for another period (the period was replaced) returns.
  PERFORM public.billing_account_release_stale_prepaid(p_workspace_id);
  SELECT * INTO v_acc FROM public.billing_accounts WHERE workspace_id = p_workspace_id FOR UPDATE;
  -- The live card, if any (262).
  SELECT * INTO v_card FROM public.billing_account_cards
   WHERE workspace_id = p_workspace_id AND status IN ('active', 'past_due')
   FOR UPDATE;

  v_target := coalesce(v_acc.scheduled_plan_id, v_sub.plan_id);
  v_interval := coalesce(v_acc.scheduled_interval, v_sub.billing_interval, 'monthly');
  SELECT * INTO v_plan FROM public.billing_plans WHERE id = v_target;

  IF v_acc.next_period_prepaid_minor IS NOT NULL AND NOT coalesce(v_plan.is_free, true) THEN
    v_start := v_sub.current_period_end;
    v_end := public.billing_period_end(v_start, v_interval);
    UPDATE public.billing_accounts
       SET scheduled_plan_id = NULL, scheduled_interval = NULL, next_period_prepaid_minor = NULL,
           next_period_start = NULL, updated_at = now()
     WHERE workspace_id = p_workspace_id;
    PERFORM public.billing_account_write_subscription(
      p_workspace_id, v_target, v_interval, v_start, v_end, 'active',
      CASE WHEN v_target = v_sub.plan_id THEN 'renewal' ELSE 'change' END, NULL,
      jsonb_build_object('prepaid_minor', v_acc.next_period_prepaid_minor)
    );
    PERFORM public.billing_account_grant_month(p_workspace_id, v_target, v_start, v_end);
    RETURN jsonb_build_object(
      'action', 'renewed', 'prepaid', true, 'plan_id', v_target, 'previous_plan_id', v_sub.plan_id,
      'billing_interval', v_interval, 'period_start', v_start, 'period_end', v_end,
      'amount_minor', v_acc.next_period_prepaid_minor, 'balance_minor', v_acc.balance_minor,
      'prepaid_card', v_card.id IS NOT NULL
    );
  END IF;

  -- With a live card only the card renews (its payment would have been the
  -- prepaid next period above): the balance is never spent unasked.
  IF v_card.id IS NOT NULL THEN
    v_reason := CASE WHEN coalesce(v_plan.is_free, true) THEN 'changed_to_free'
                     WHEN v_acc.auto_renew THEN 'card_not_paid'
                     ELSE 'not_renewed' END;
  ELSIF NOT coalesce(v_plan.is_free, true) AND v_acc.auto_renew THEN
    v_price := public.billing_plan_price(v_target, v_acc.currency, v_interval);
    IF v_price IS NOT NULL AND v_price > 0 AND v_acc.balance_minor >= v_price THEN
      v_result := public.billing_account_renew(p_workspace_id, NULL, v_sub.current_period_end);
      RETURN v_result || jsonb_build_object('auto_renew', true);
    END IF;
    v_reason := CASE WHEN v_price IS NULL OR v_price <= 0 THEN 'no_price' ELSE 'insufficient_balance' END;
  ELSIF coalesce(v_plan.is_free, true) THEN
    v_reason := 'changed_to_free';
  ELSE
    v_reason := 'not_renewed';
  END IF;

  -- The card stops with the plan: marked canceling (which also takes it off
  -- the account and turns auto-renew off) before the subscription is
  -- written; the server cancels it at Paddle at once (card_cancel). Only a
  -- card that did not pay is 'not_renewed': its late payment buys the plan
  -- again (billing_card_apply_renewal).
  IF v_card.id IS NOT NULL THEN
    PERFORM public.billing_card_set_status(
      v_card.id, 'canceling', CASE WHEN v_reason = 'card_not_paid' THEN 'not_renewed' ELSE 'plan_ended' END
    );
  END IF;

  -- To Free: the subscription ends (the entitlement code then reads Free);
  -- the plan it had stays on the row, for "renew".
  IF v_acc.next_period_prepaid_minor IS NOT NULL THEN
    PERFORM public.billing_account_credit_back(
      p_workspace_id, v_acc.next_period_prepaid_minor,
      jsonb_build_object('reason', 'changed_to_free'), NULL,
      'prepaid_return:' || p_workspace_id::text || ':due:' || gen_random_uuid()::text
    );
  END IF;
  UPDATE public.billing_accounts
     SET scheduled_plan_id = NULL, scheduled_interval = NULL, next_period_prepaid_minor = NULL,
         next_period_start = NULL, updated_at = now()
   WHERE workspace_id = p_workspace_id;
  PERFORM public.billing_account_write_subscription(
    p_workspace_id, v_sub.plan_id, v_sub.billing_interval, v_sub.current_period_start, v_sub.current_period_end,
    'expired', 'expire', NULL, jsonb_build_object('reason', v_reason)
  );
  RETURN jsonb_build_object(
    'action', 'expired', 'reason', v_reason, 'plan_id', v_sub.plan_id,
    'expired_at', v_sub.current_period_end, 'balance_minor',
    (SELECT balance_minor FROM public.billing_accounts WHERE workspace_id = p_workspace_id)
  ) || CASE WHEN v_card.id IS NOT NULL THEN jsonb_build_object('card_cancel', jsonb_build_object(
         'card_id', v_card.id, 'provider', v_card.provider, 'subscription_id', v_card.subscription_id))
       ELSE '{}'::jsonb END;
END;
$$;

-- Paid periods ending within p_days that are not paid for yet: the renewal
-- reminders. With auto-renew on and enough balance nothing is sent (it
-- renews), nor when an active saved card will pay a sold next period (262);
-- a change to Free at the period end is not reminded either.
CREATE OR REPLACE FUNCTION public.billing_account_reminder_candidates(p_days integer DEFAULT 7)
RETURNS TABLE (
  workspace_id uuid, plan_id uuid, target_plan_id uuid, billing_interval text,
  period_end timestamptz, currency text, balance_minor bigint, price_minor bigint,
  auto_renew boolean, notices_sent jsonb
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT s.workspace_id, s.plan_id,
         coalesce(a.scheduled_plan_id, s.plan_id),
         coalesce(a.scheduled_interval, s.billing_interval, 'monthly'),
         s.current_period_end,
         coalesce(a.currency, public.billing_region_currency()),
         coalesce(a.balance_minor, 0),
         public.billing_plan_price(coalesce(a.scheduled_plan_id, s.plan_id),
                                   coalesce(a.currency, public.billing_region_currency()),
                                   coalesce(a.scheduled_interval, s.billing_interval, 'monthly')),
         coalesce(a.auto_renew, false),
         coalesce(a.notices_sent, '{}'::jsonb)
    FROM public.workspace_subscriptions s
    JOIN public.billing_plans p ON p.id = s.plan_id
    LEFT JOIN public.billing_accounts a ON a.workspace_id = s.workspace_id
    LEFT JOIN public.billing_plans t ON t.id = coalesce(a.scheduled_plan_id, s.plan_id)
   WHERE s.status = 'active' AND NOT p.is_free
     AND s.current_period_end > now()
     AND s.current_period_end <= now() + make_interval(days => greatest(p_days, 1))
     AND NOT (a.next_period_prepaid_minor IS NOT NULL AND a.next_period_start = s.current_period_end)
     AND public.billing_account_v2_next_period(s.workspace_id) IS NULL
     AND NOT coalesce(t.is_free, true)
     AND NOT (
       coalesce(a.auto_renew, false)
       AND coalesce(a.balance_minor, 0) >= coalesce(public.billing_plan_price(
             coalesce(a.scheduled_plan_id, s.plan_id),
             coalesce(a.currency, public.billing_region_currency()),
             coalesce(a.scheduled_interval, s.billing_interval, 'monthly')), 9223372036854775807)
     )
     AND NOT (
       coalesce(a.auto_renew, false)
       AND coalesce(public.billing_plan_price(
             coalesce(a.scheduled_plan_id, s.plan_id),
             coalesce(a.currency, public.billing_region_currency()),
             coalesce(a.scheduled_interval, s.billing_interval, 'monthly')), 0) > 0
       AND EXISTS (
         SELECT 1 FROM public.billing_account_cards c
          WHERE c.workspace_id = s.workspace_id AND c.status = 'active'
       )
     )
$$;

-- Deletes gateway attempts that never completed and are older than p_days
-- (30 by default) — but only those that can no longer be paid: no checkout
-- reference, a checkout the provider confirmed closed, or a provider whose
-- checkouts expire on their own (p_short_lived: the Iranian bank gateways).
-- A confirmed-but-unsettled attempt is never deleted. Settled payments are
-- kept: their receipt refers to them. Card payments Paddle may have taken
-- stay too (262): a charge we asked for (charge_requested_at set) until it
-- is resolved, and every renewal Paddle charged.
CREATE OR REPLACE FUNCTION public.billing_account_prune_payments(
  p_days        integer DEFAULT 30,
  p_short_lived text[] DEFAULT '{}'
)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_count integer;
BEGIN
  DELETE FROM public.billing_account_payments
   WHERE status <> 'succeeded'
     AND verified_at IS NULL
     AND created_at < now() - make_interval(days => greatest(coalesce(p_days, 30), 1))
     AND (provider_ref IS NULL OR closed_at IS NOT NULL OR provider = ANY (coalesce(p_short_lived, '{}')))
     AND NOT (source = 'card_charge' AND status = 'pending' AND charge_requested_at IS NOT NULL)
     AND source <> 'card_renewal';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- ─── 9. The card emails (Super Admin → Branding → Email templates) ────────
-- Seeded in both editions, like 261's (migration 260 keeps every template in
-- each edition); only Multi Region ever sends them. In fa/en/tr; a row that
-- exists (edited) is never overwritten. The server fills {card} ("Visa ••••
-- 4242"), the amounts, dates and reasons, and the links. A renewal the card
-- paid is mailed as billing_card_renewed, which names the card
-- (billing_renewed stays the balance's renewal, as 261 seeded it).
CREATE OR REPLACE FUNCTION pg_temp._email_262_layout(p_locale text, p_title text, p_body text)
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

CREATE OR REPLACE FUNCTION pg_temp._email_262_seed(
  p_slug text, p_locale text, p_subject text, p_title text, p_body text, p_text text
) RETURNS void
LANGUAGE plpgsql
AS $f$
DECLARE
  v_edition text;
BEGIN
  FOREACH v_edition IN ARRAY ARRAY['iran', 'international'] LOOP
    INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active, edition)
    SELECT NULL, p_slug, p_locale, p_subject, pg_temp._email_262_layout(p_locale, p_title, p_body), p_text, true, v_edition
     WHERE NOT EXISTS (
       SELECT 1 FROM public.email_templates
        WHERE workspace_id IS NULL AND edition = v_edition AND slug = p_slug AND locale = p_locale
     );
  END LOOP;
END;
$f$;

SELECT pg_temp._email_262_seed('billing_card_payment_failed', 'fa',
  'پرداخت با کارت برای پلن {plan_name} انجام نشد — {brand}', 'پرداخت با کارت انجام نشد',
  '<p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">مبلغ <strong>{amount}</strong> برای تمدید پلن {plan_name} فضای کاری شما از کارت {card} پرداخت نشد.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">دلیل: {failure_reason}</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">لطفاً پیش از {due_at} کارت خود را به‌روز کنید و مبلغ را بپردازید، یا پلن را از موجودی حساب تمدید کنید. در غیر این صورت فضای کاری در همان زمان به پلن رایگان منتقل می‌شود.</p><p style="margin:24px 0 0;text-align:center;"><a href="{billing_url}" style="display:inline-block;background:#1E40AF;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;">به‌روزرسانی کارت و پرداخت</a></p>',
  'مبلغ {amount} برای تمدید پلن {plan_name} از کارت {card} پرداخت نشد. دلیل: {failure_reason}. پیش از {due_at} کارت را به‌روز کنید و بپردازید یا از موجودی تمدید کنید؛ در غیر این صورت فضای کاری به پلن رایگان منتقل می‌شود. صورت‌حساب: {billing_url}');
SELECT pg_temp._email_262_seed('billing_card_payment_failed', 'en',
  'Card payment for your {plan_name} plan failed — {brand}', 'Card payment failed',
  '<p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">We could not charge <strong>{amount}</strong> to {card} for the renewal of your workspace''s {plan_name} plan.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Reason: {failure_reason}</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Please update your card and pay, or renew from your balance, before {due_at}. Otherwise the workspace moves to the Free plan at that time.</p><p style="margin:24px 0 0;text-align:center;"><a href="{billing_url}" style="display:inline-block;background:#1E40AF;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;">Update card and pay</a></p>',
  'We could not charge {amount} to {card} for the renewal of your {plan_name} plan. Reason: {failure_reason}. Update your card and pay, or renew from your balance, before {due_at}; otherwise the workspace moves to the Free plan. Billing: {billing_url}');
SELECT pg_temp._email_262_seed('billing_card_payment_failed', 'tr',
  '{plan_name} planınız için kart ödemesi başarısız oldu — {brand}', 'Kart ödemesi başarısız oldu',
  '<p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Çalışma alanınızın {plan_name} planını yenilemek için {card} kartınızdan <strong>{amount}</strong> tahsil edilemedi.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Neden: {failure_reason}</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Lütfen {due_at} tarihinden önce kartınızı güncelleyip ödemeyi yapın ya da planı bakiyenizden yenileyin. Aksi halde çalışma alanı o tarihte Ücretsiz plana geçer.</p><p style="margin:24px 0 0;text-align:center;"><a href="{billing_url}" style="display:inline-block;background:#1E40AF;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;">Kartı güncelle ve öde</a></p>',
  '{plan_name} planınızı yenilemek için {card} kartınızdan {amount} tahsil edilemedi. Neden: {failure_reason}. {due_at} tarihinden önce kartınızı güncelleyip ödeyin ya da bakiyenizden yenileyin; aksi halde çalışma alanı Ücretsiz plana geçer. Faturalandırma: {billing_url}');

SELECT pg_temp._email_262_seed('billing_card_removed', 'fa',
  'کارت ذخیره‌شده حذف شد — {brand}', 'کارت ذخیره‌شده حذف شد',
  '<p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">کارت {card} دیگر برای تمدید خودکار پلن {plan_name} فضای کاری شما ذخیره نیست و برداشت دیگری از آن انجام نمی‌شود.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">دلیل: {reason}<br>دوره‌ی پرداخت‌شده: تا {period_end}</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">برای ادامه‌ی پلن پس از این تاریخ، آن را از موجودی حساب تمدید کنید یا در صفحه‌ی صورت‌حساب به‌صورت آنلاین بپردازید. هر زمان بخواهید می‌توانید دوباره کارت اضافه کنید.</p><p style="margin:24px 0 0;text-align:center;"><a href="{billing_url}" style="display:inline-block;background:#1E40AF;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;">صورت‌حساب</a></p>',
  'کارت {card} دیگر برای تمدید خودکار پلن {plan_name} ذخیره نیست و برداشت دیگری از آن انجام نمی‌شود. دلیل: {reason}. دوره‌ی پرداخت‌شده: تا {period_end}. صورت‌حساب: {billing_url}');
SELECT pg_temp._email_262_seed('billing_card_removed', 'en',
  'Your saved card was removed — {brand}', 'Saved card removed',
  '<p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">{card} is no longer saved for the automatic renewal of your workspace''s {plan_name} plan, and it will not be charged again.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Reason: {reason}<br>Paid period: until {period_end}</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">To keep the plan after that date, renew it from your balance or pay online on the billing page. You can add a card again at any time.</p><p style="margin:24px 0 0;text-align:center;"><a href="{billing_url}" style="display:inline-block;background:#1E40AF;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;">Billing</a></p>',
  '{card} is no longer saved for the automatic renewal of your {plan_name} plan and will not be charged again. Reason: {reason}. Paid period: until {period_end}. Billing: {billing_url}');
SELECT pg_temp._email_262_seed('billing_card_removed', 'tr',
  'Kayıtlı kartınız kaldırıldı — {brand}', 'Kayıtlı kart kaldırıldı',
  '<p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">{card} artık çalışma alanınızın {plan_name} planının otomatik yenilemesi için kayıtlı değil ve bu karttan yeniden ödeme alınmayacak.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Neden: {reason}<br>Ödenmiş dönem: {period_end} tarihine kadar</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Planı bu tarihten sonra da kullanmak için bakiyenizden yenileyin veya faturalandırma sayfasından çevrimiçi ödeme yapın. İstediğiniz zaman yeniden kart ekleyebilirsiniz.</p><p style="margin:24px 0 0;text-align:center;"><a href="{billing_url}" style="display:inline-block;background:#1E40AF;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;">Faturalandırma</a></p>',
  '{card} artık {plan_name} planınızın otomatik yenilemesi için kayıtlı değil ve bu karttan yeniden ödeme alınmayacak. Neden: {reason}. Ödenmiş dönem: {period_end} tarihine kadar. Faturalandırma: {billing_url}');

SELECT pg_temp._email_262_seed('billing_card_renewed', 'fa',
  'پلن {plan_name} با کارت شما تمدید شد — {brand}', 'تمدید با کارت انجام شد',
  '<p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">پلن {plan_name} فضای کاری شما با کارت ذخیره‌شده‌ی {card} برای دوره‌ی {period_start} تا {period_end} تمدید شد.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">مبلغ: {amount}<br>موجودی حساب: {balance}</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">فاکتور پرداخت با کارت جداگانه برای شما ایمیل می‌شود.</p><p style="margin:24px 0 0;text-align:center;"><a href="{billing_url}" style="display:inline-block;background:#1E40AF;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;">صورت‌حساب</a></p>',
  'پلن {plan_name} با کارت ذخیره‌شده‌ی {card} برای دوره‌ی {period_start} تا {period_end} تمدید شد. مبلغ: {amount}. موجودی: {balance}. فاکتور پرداخت با کارت جداگانه ایمیل می‌شود. صورت‌حساب: {billing_url}');
SELECT pg_temp._email_262_seed('billing_card_renewed', 'en',
  'Your {plan_name} plan was renewed with your card — {brand}', 'Plan renewed by card',
  '<p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Your workspace''s {plan_name} plan was renewed with your saved card {card} for {period_start} to {period_end}.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Amount: {amount}<br>Your balance: {balance}</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">The invoice for the card payment is emailed to you separately.</p><p style="margin:24px 0 0;text-align:center;"><a href="{billing_url}" style="display:inline-block;background:#1E40AF;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;">Billing</a></p>',
  'Your {plan_name} plan was renewed with your saved card {card} for {period_start} to {period_end}. Amount: {amount}. Balance: {balance}. The invoice for the card payment is emailed separately. Billing: {billing_url}');
SELECT pg_temp._email_262_seed('billing_card_renewed', 'tr',
  '{plan_name} planınız kartınızla yenilendi — {brand}', 'Plan kartla yenilendi',
  '<p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Çalışma alanınızın {plan_name} planı, kayıtlı kartınız {card} ile {period_start} – {period_end} dönemi için yenilendi.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Tutar: {amount}<br>Bakiyeniz: {balance}</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Kart ödemesinin faturası size ayrıca e-postayla gönderilir.</p><p style="margin:24px 0 0;text-align:center;"><a href="{billing_url}" style="display:inline-block;background:#1E40AF;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;">Faturalandırma</a></p>',
  '{plan_name} planınız kayıtlı kartınız {card} ile {period_start} – {period_end} dönemi için yenilendi. Tutar: {amount}. Bakiye: {balance}. Kart ödemesinin faturası ayrıca e-postayla gönderilir. Faturalandırma: {billing_url}');

-- ─── 10. Access: the backend (service_role) only ──────────────────────────
DO $$
BEGIN
  ALTER TABLE public.billing_account_cards ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON public.billing_account_cards FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.billing_account_cards FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.billing_account_cards FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT ALL ON public.billing_account_cards TO service_role;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'billing_account_cards' AND policyname = 'service_role_only'
    ) THEN
      CREATE POLICY service_role_only ON public.billing_account_cards
        FOR ALL TO service_role USING (true) WITH CHECK (true);
    END IF;
  END IF;
END $$;

DO $acl$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.billing_card_register(text, text, text, text, uuid)',
    'public.billing_card_set_status(uuid, text, text)',
    'public.billing_card_record_charge(uuid, text, text, bigint, text, jsonb, uuid)',
    'public.billing_card_settle(uuid, bigint, text, text)',
    'public.billing_card_apply_renewal(public.billing_account_payments)',
    'public.billing_card_sync_candidates(integer)',
    'public.billing_card_mark_synced(uuid, bigint, jsonb, text)',
    'public.billing_card_touch_workspace(uuid)',
    'public.billing_card_touch_trigger()',
    'public.billing_card_touch_plan()',
    'public.billing_card_touch_settings()',
    'public.billing_card_workspace_deleted()',
    'public.billing_card_keep_on_delete()',
    'public.billing_account_renew(uuid, uuid, timestamptz, bigint, bigint)',
    'public.billing_account_settle_payment(uuid)',
    'public.billing_account_process_due(uuid)',
    'public.billing_account_reminder_candidates(integer)',
    'public.billing_account_prune_payments(integer, text[])'
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
