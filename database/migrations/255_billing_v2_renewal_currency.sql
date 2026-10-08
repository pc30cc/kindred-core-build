-- 255: Renewals are invoiced in the currency the customer pays in, and a paid
-- plan is never renewed for free.
--
-- The invoice engine now sells plans in USD/EUR/TRY as well as Rial
-- (server/services/billing/invoice/issue.ts: the price is
-- billing_plans.prices[currency][interval], whole Rial for IRR and minor
-- units for every other currency, and billing_invoices.currency names it).
-- The renewal issuer still priced every renewal from prices.IRR, and read a
-- missing price as 0. A price of 0 sends it to billing_v2_ensure_free_period,
-- which opens and activates the next period on the subscription's own plan
-- with that plan's limits and AI allowance. A plan sold only in dollars has no
-- IRR price, so one dollar payment bought that plan for every period after it.
--
-- workspace_subscriptions.pending_change_currency (new)
--   The currency the customer chose for a scheduled (next-cycle) plan change.
--   server/services/billing/customer/actions.ts writes it with
--   pending_change_type / next_plan_id and clears it with them. NULL for a
--   change recorded before this migration.
--
-- billing_v2_issue_renewal_invoice (118)
--   The renewal is priced in, and billing_invoices.currency set to:
--     1. for a pending plan change, the currency chosen for it;
--     2. otherwise the currency of the invoice behind the active service
--        period (when that period was not bought — an admin grant — the latest
--        period that was);
--     3. otherwise IRR, as before (free, trial and legacy periods).
--   The price is prices[currency][interval] in that currency's unit. The line
--   reads as issue.ts writes it: Persian for IRR, English for every other
--   currency ("<plan> — monthly"). Another currency's amount is never used.
--   An unpaid renewal invoice issued in another currency for the same window
--   is voided and issued again, as one for a since-changed pending plan
--   already is (void_reason currency_change_before_payment).
--
--   A price of 0 still means the free path, but only for a plan that is free
--   in every currency (is_free, or no positive price anywhere in its price
--   map; billing_v2_ensure_free_period decides, below). A paid plan with no
--   price, or a zero price, in the renewal currency gets no invoice and no
--   free period: once the window is due the issuer raises
--   renewal_price_unavailable:<currency>:<interval>:<plan id>. The
--   scheduler records that as a failed renewal job — a billing_v2_audit
--   renewal_invoice_failed row, the worker's health row, a retry with backoff
--   (eight attempts over about three hours, so a price set in that time is
--   picked up), then the job stays failed and is counted in
--   billing_v2_scheduler_health().failed_jobs. After that, set the price and
--   run SELECT public.billing_v2_issue_renewal_invoice(<workspace>, true).
--   An invoice already issued for the window is still replayed.
--
-- billing_v2_ensure_free_period (118)
--   Refuses ('plan_not_free', nothing written) a plan that is not free in
--   every currency. It also opens the free period on the plan the next period
--   is for — a pending change's, as the issuer resolves it — where it used to
--   take the current plan: a scheduled downgrade from a paid plan to Free
--   opened a free period of the PAID plan, and the activation then dropped the
--   downgrade.
--
-- billing_v2_wallet_autopay_invoice, billing_v2_run_wallet_autopay (118),
-- billing_wallet_pay_invoice (115)
--   The wallet holds Rial (WALLET_CURRENCY, server/services/billing/customer/
--   readModels.ts). A renewal invoice has a due date, so on its due day
--   (billing_v2_run_wallet_autopay, and billing_v2_process_due_invoice through
--   billing_v2_wallet_autopay_invoice) a dollar renewal would have been paid
--   from the wallet by debiting its cents as Rial: $29.00 for 2,900 Rial.
--   Auto-pay now leaves an invoice that is not in IRR alone (skipped
--   currency_not_wallet:<code>), so the due-day path moves it past due like
--   any unpaid invoice and a card gateway collects it; the wallet payment
--   itself refuses one (invoice_currency_not_wallet).
--
-- What IRR keeps. A workspace whose renewal resolves to IRR, on a plan with an
-- IRR price or on a plan free in every currency with no pending change, gets
-- the same price expression, invoice row, line, free period, audit rows and
-- result as before. The IRR cases that change are the two giveaways: a plan
-- with no IRR price that is priced in another currency used to roll forward
-- as a free period of that plan, and now fails as above; a scheduled
-- downgrade to a free plan now lands on that plan. The wallet functions
-- differ only for an invoice whose currency is a well-formed code other than
-- IRR. A currency code is read the way invoiceCurrency() in readModels.ts
-- reads it: trimmed, upper-cased, and IRR unless it is three letters.
--
-- Not changed: what happens when a paid period ends with no renewal invoice
-- at all. Nothing expires an active subscription at its period end; it keeps
-- its plan until an invoice goes unpaid through dunning
-- (billing_v2_process_due_invoice → grace → billing_v2_apply_free_fallback).
--
-- Same signatures, SECURITY DEFINER, search_path and grants as before; the
-- grants are asserted again below exactly as 115 and 118 wrote them.
-- Re-runnable.

ALTER TABLE public.workspace_subscriptions
  ADD COLUMN IF NOT EXISTS pending_change_currency TEXT;

DO $$
BEGIN
  ALTER TABLE public.workspace_subscriptions
    ADD CONSTRAINT workspace_subscriptions_pending_change_currency_chk
    CHECK (pending_change_currency IS NULL OR pending_change_currency ~ '^[A-Z]{3}$');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN public.workspace_subscriptions.pending_change_currency IS
  'Currency (ISO 4217) the customer chose for the pending next-cycle plan change; the renewal that starts it is invoiced in it. Read only while pending_change_type is upgrade/downgrade and next_plan_id is set.';

-- ─── Worker A — renewal invoice issuance ───────────────────────────────────
/**
 * Issues the renewal invoice for one subscription.
 *
 * next_invoice_at SEMANTICS: it is the START of the next period that still
 * needs an invoice (i.e. the end of the latest invoiced period). Issuance
 * becomes eligible at `next_invoice_at - lead_time`, and the successful
 * issuance moves the marker to the end of the window it just invoiced — which
 * is what makes catch-up runs and replays converge instead of duplicating.
 */
CREATE OR REPLACE FUNCTION public.billing_v2_issue_renewal_invoice(
  p_workspace_id UUID,
  p_force        BOOLEAN DEFAULT false
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_sub       public.workspace_subscriptions;
  v_state     TEXT;
  v_policy    JSONB;
  v_lead      INTEGER;
  v_plan      public.billing_plans;
  v_target    UUID;
  v_interval  TEXT;
  v_start     TIMESTAMPTZ;
  v_end       TIMESTAMPTZ;
  v_price     BIGINT;
  v_allowance BIGINT;
  v_existing  public.billing_invoices;
  v_inv       public.billing_invoices;
  v_num       TEXT;
  v_tries     INTEGER := 0;
  v_snapshot  JSONB;
  v_currency  TEXT;
  v_existing_currency TEXT;
  v_void_reason TEXT;
  v_currency_details JSONB;
  v_unpriced  BOOLEAN := false;
  v_free      JSONB;
BEGIN
  SELECT * INTO v_sub FROM public.workspace_subscriptions
   WHERE workspace_id = p_workspace_id FOR UPDATE;
  IF v_sub.id IS NULL THEN
    RETURN jsonb_build_object('skipped', 'no_subscription');
  END IF;

  SELECT state INTO v_state FROM public.billing_v2_rollout WHERE workspace_id = p_workspace_id;
  IF COALESCE(v_state, 'legacy') <> 'v2_active' THEN
    RETURN jsonb_build_object('skipped', 'not_v2_active');
  END IF;

  IF v_sub.status = 'trialing' THEN
    RETURN jsonb_build_object('skipped', 'trial');
  END IF;
  IF v_sub.status NOT IN ('active', 'past_due') THEN
    RETURN jsonb_build_object('skipped', 'subscription_status:' || v_sub.status);
  END IF;
  IF v_sub.cancel_at_period_end OR v_sub.pending_change_type = 'cancel' THEN
    RETURN jsonb_build_object('skipped', 'canceling');
  END IF;

  -- Target contract: a pending plan change is what the NEXT period must bill.
  v_target := CASE
    WHEN v_sub.pending_change_type IN ('upgrade', 'downgrade') AND v_sub.next_plan_id IS NOT NULL
      THEN v_sub.next_plan_id
    ELSE v_sub.plan_id END;
  IF v_target IS NULL THEN
    RETURN jsonb_build_object('skipped', 'no_plan');
  END IF;

  SELECT * INTO v_plan FROM public.billing_plans WHERE id = v_target;
  IF v_plan.id IS NULL THEN
    RETURN jsonb_build_object('skipped', 'unknown_plan');
  END IF;

  v_interval := COALESCE(v_sub.billing_interval, 'monthly');
  v_start := COALESCE(v_sub.next_invoice_at, v_sub.current_period_end);
  IF v_start IS NULL THEN
    RETURN jsonb_build_object('skipped', 'no_anchor');
  END IF;
  v_end := public.billing_v2_add_interval(v_start, v_interval, 1);

  -- The currency the customer pays in. A pending plan change carries the one
  -- chosen for it. Otherwise it is the currency of the invoice behind the
  -- active service period; a period nobody paid for (admin grant) carries
  -- none, and the latest period that was bought decides. With no bought
  -- period at all (free, trial, legacy migration) the renewal is in IRR, as
  -- it always was.
  IF v_sub.pending_change_type IN ('upgrade', 'downgrade') AND v_sub.next_plan_id IS NOT NULL THEN
    v_currency := upper(btrim(v_sub.pending_change_currency));
  END IF;
  IF v_currency IS NULL OR v_currency !~ '^[A-Z]{3}$' THEN
    SELECT upper(btrim(i.currency)) INTO v_currency
      FROM public.billing_subscription_periods p
      JOIN public.billing_invoices i ON i.id = p.invoice_id
     WHERE p.workspace_id = p_workspace_id
       AND p.status IN ('scheduled', 'active', 'completed')
       AND p.period_start < v_start
     ORDER BY (p.status = 'active') DESC, p.period_end DESC, p.period_start DESC
     LIMIT 1;
  END IF;
  IF v_currency IS NULL OR v_currency !~ '^[A-Z]{3}$' THEN
    v_currency := 'IRR';
  END IF;

  -- Prices live in billing_plans.prices as {CURRENCY: {monthly, yearly}}:
  -- whole Rial for IRR, minor units (cents, kuruş) for every other currency.
  IF v_currency = 'IRR' THEN
    v_price := GREATEST(ROUND(COALESCE(
      (v_plan.prices->'IRR'->>v_interval)::numeric, 0))::bigint, 0);
  ELSE
    -- Only this currency's own price. A plan with none in it is never billed
    -- another currency's amount.
    v_price := GREATEST(ROUND(COALESCE(
      NULLIF(btrim(v_plan.prices->v_currency->>v_interval), '')::numeric, 0))::bigint, 0);
  END IF;

  -- Free contract: no invoice at all, the free-period path owns it — for a
  -- plan that is free in every currency, which billing_v2_ensure_free_period
  -- now checks itself. A paid plan with no price here is not free: it is
  -- refused there ('plan_not_free') and handled below.
  IF v_price = 0 THEN
    v_free := public.billing_v2_ensure_free_period(p_workspace_id);
    IF v_free->>'skipped' IS DISTINCT FROM 'plan_not_free' THEN
      RETURN v_free;
    END IF;
    v_unpriced := true;
  END IF;

  v_policy := public.billing_v2_policy_for(p_workspace_id);
  v_lead := (v_policy->>'invoice_lead_time_days')::int;
  IF NOT p_force AND now() < v_start - make_interval(days => v_lead) THEN
    RETURN jsonb_build_object('skipped', 'not_yet_eligible', 'eligible_at', v_start - make_interval(days => v_lead));
  END IF;

  -- Never invoice a window that already has a service period.
  IF EXISTS (
    SELECT 1 FROM public.billing_subscription_periods
     WHERE workspace_id = p_workspace_id
       AND status IN ('scheduled', 'active')
       AND period_start = v_start
  ) THEN
    RETURN jsonb_build_object('skipped', 'period_exists');
  END IF;

  -- Idempotency: one live renewal invoice per (subscription, window).
  SELECT * INTO v_existing FROM public.billing_invoices
   WHERE subscription_id = v_sub.id
     AND invoice_type = 'subscription_renewal'
     AND period_start = v_start
     AND status NOT IN ('void', 'expired')
   ORDER BY created_at DESC LIMIT 1;

  IF v_existing.id IS NOT NULL THEN
    v_existing_currency := upper(btrim(v_existing.currency));
    IF v_existing_currency IS NULL OR v_existing_currency !~ '^[A-Z]{3}$' THEN
      v_existing_currency := 'IRR';
    END IF;

    -- A paid invoice is never rewritten or voided.
    IF v_existing.status = 'paid'
       OR v_existing.amount_paid_irr > 0
       OR (COALESCE((v_existing.effect_snapshot->>'target_plan_id')::uuid, v_existing.plan_id) = v_target
           AND v_existing_currency = v_currency)
    THEN
      INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
      VALUES (p_workspace_id, 'renewal_invoice_issue_replayed', 'already_issued',
              jsonb_build_object('invoice_id', v_existing.id, 'period_start', v_start));
      RETURN jsonb_build_object('invoice_id', v_existing.id, 'replayed', true);
    END IF;
  END IF;

  -- A paid plan with no price in the renewal currency: nothing to invoice,
  -- and no free period either. Loud, so that the price gets set; the
  -- scheduler records it as a failed job and retries it.
  IF v_unpriced THEN
    RAISE EXCEPTION 'renewal_price_unavailable:%:%:%', v_currency, v_interval, v_target
      USING DETAIL = format('Plan %s has no %s %s price; no renewal invoice and no free period for workspace %s.',
                            v_plan.name, v_currency, v_interval, p_workspace_id);
  END IF;

  IF v_existing.id IS NOT NULL THEN
    -- Unpaid invoice whose target no longer matches the pending change, or
    -- that was issued in another currency than the customer pays in: void it
    -- and issue a fresh document with the new snapshot.
    IF EXISTS (SELECT 1 FROM public.billing_invoice_collections
                WHERE invoice_id = v_existing.id AND status = 'active') THEN
      RETURN jsonb_build_object('skipped', 'collection_active', 'invoice_id', v_existing.id);
    END IF;
    v_void_reason := CASE
      WHEN COALESCE((v_existing.effect_snapshot->>'target_plan_id')::uuid, v_existing.plan_id) = v_target
        THEN 'currency_change_before_payment'
      ELSE 'plan_change_before_payment' END;
    UPDATE public.billing_invoices
       SET status = 'void', voided_at = now(),
           metadata = metadata || jsonb_build_object('void_reason', v_void_reason)
     WHERE id = v_existing.id;
    INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
    VALUES (p_workspace_id, 'renewal_invoice_voided', v_void_reason,
            jsonb_build_object('invoice_id', v_existing.id)
            || CASE WHEN v_existing_currency = v_currency THEN '{}'::jsonb
                    ELSE jsonb_build_object('from_currency', v_existing_currency,
                                            'to_currency', v_currency) END);
  END IF;

  v_allowance := GREATEST(ROUND(COALESCE((v_plan.limits->>'ai_credits_per_month')::numeric, 0))::bigint, 0);
  IF v_interval = 'yearly' THEN
    -- Existing V2 contract (issue.ts): a yearly period carries twelve months of
    -- allowance, granted ONCE for the period and expiring at period_end.
    v_allowance := v_allowance * 12;
  END IF;

  v_snapshot := jsonb_build_object(
    'action_type', CASE WHEN v_target = v_sub.plan_id THEN 'plan_renewal'
                        WHEN v_sub.pending_change_type = 'upgrade' THEN 'plan_upgrade'
                        ELSE 'plan_downgrade' END,
    'source_plan_id', v_sub.plan_id,
    'target_plan_id', v_target,
    'billing_interval', v_interval,
    'effective_at', v_start,
    'period_start', v_start,
    'period_end', v_end,
    'plan_snapshot', to_jsonb(v_plan),
    'limits_snapshot', COALESCE(v_plan.limits, '{}'::jsonb),
    'ai_allowance_irr', v_allowance,
    'proration', NULL
  );

  LOOP
    v_tries := v_tries + 1;
    v_num := public.billing_v2_document_number();
    BEGIN
      INSERT INTO public.billing_invoices (
        workspace_id, subscription_id, invoice_number, invoice_type, status,
        currency, subtotal_irr, total_irr, amount_due_irr,
        plan_id, plan_name_snapshot, billing_interval,
        period_start, period_end, effect_snapshot, due_at, metadata
      ) VALUES (
        p_workspace_id, v_sub.id, v_num, 'subscription_renewal', 'draft',
        v_currency, v_price, v_price, v_price,
        v_target, v_plan.name, v_interval,
        v_start, v_end, v_snapshot,
        v_start + make_interval(days => (v_policy->>'invoice_due_offset_days')::int),
        jsonb_build_object('source', 'renewal_scheduler')
      )
      RETURNING * INTO v_inv;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      IF v_tries >= 5 THEN RAISE; END IF;
    END;
  END LOOP;

  -- Line text as issue.ts writes it: Persian for IRR, English otherwise.
  INSERT INTO public.billing_invoice_lines (
    invoice_id, line_type, description, quantity, unit_amount_irr, amount_irr, plan_id, sort_order
  ) VALUES (
    v_inv.id, 'plan',
    v_plan.name || ' — ' || CASE
      WHEN v_currency = 'IRR' THEN CASE WHEN v_interval = 'yearly' THEN 'سالانه' ELSE 'ماهانه' END
      ELSE CASE WHEN v_interval = 'yearly' THEN 'yearly' ELSE 'monthly' END END,
    1, v_price, v_price, v_target, 0
  );

  UPDATE public.billing_invoices
     SET status = 'open', issued_at = now()
   WHERE id = v_inv.id AND status = 'draft'
  RETURNING * INTO v_inv;

  -- The marker moves forward only after the document exists.
  UPDATE public.workspace_subscriptions
     SET next_invoice_at = v_end, updated_at = now()
   WHERE id = v_sub.id;

  -- The amounts below are in v_currency; an IRR renewal reports exactly what
  -- it always did, any other names its currency.
  v_currency_details := CASE WHEN v_currency = 'IRR' THEN '{}'::jsonb
                             ELSE jsonb_build_object('currency', v_currency) END;

  INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
  VALUES (p_workspace_id, 'renewal_invoice_issued', 'scheduler',
          jsonb_build_object('invoice_id', v_inv.id, 'period_start', v_start,
                             'period_end', v_end, 'plan_id', v_target,
                             'interval', v_interval, 'amount_irr', v_price)
          || v_currency_details);

  RETURN jsonb_build_object(
    'invoice_id', v_inv.id, 'period_start', v_start, 'period_end', v_end,
    'amount_irr', v_price, 'replayed', false
  ) || v_currency_details;
END;
$$;

/**
 * Free contract: no invoice, no money — just the next free service period,
 * created and activated idempotently with whatever allowance the plan defines.
 *
 * Only for a plan that is free in every currency (is_free, or no positive
 * price anywhere in its price map), and for the plan the next period is for:
 * a pending plan change's, as the renewal issuer resolves it. Any other plan
 * is refused with 'plan_not_free' and nothing is written.
 */
CREATE OR REPLACE FUNCTION public.billing_v2_ensure_free_period(p_workspace_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_sub    public.workspace_subscriptions;
  v_plan   public.billing_plans;
  v_start  TIMESTAMPTZ;
  v_end    TIMESTAMPTZ;
  v_period public.billing_subscription_periods;
  v_allow  BIGINT;
BEGIN
  SELECT * INTO v_sub FROM public.workspace_subscriptions
   WHERE workspace_id = p_workspace_id FOR UPDATE;
  IF v_sub.id IS NULL OR v_sub.plan_id IS NULL THEN
    RETURN jsonb_build_object('skipped', 'no_subscription');
  END IF;

  SELECT * INTO v_plan FROM public.billing_plans
   WHERE id = CASE
     WHEN v_sub.pending_change_type IN ('upgrade', 'downgrade') AND v_sub.next_plan_id IS NOT NULL
       THEN v_sub.next_plan_id
     ELSE v_sub.plan_id END;
  IF v_plan.id IS NULL THEN RETURN jsonb_build_object('skipped', 'unknown_plan'); END IF;

  -- A plan with a price in any currency is a paid plan, whatever it costs in
  -- the currency at hand: a free period of it would serve it for nothing.
  IF NOT COALESCE((to_jsonb(v_plan)->>'is_free')::boolean, false)
     AND EXISTS (
       SELECT 1
         FROM (
           SELECT j.v FROM jsonb_path_query(COALESCE(v_plan.prices, '{}'::jsonb), '$.**') AS j(v)
           UNION ALL SELECT to_jsonb(v_plan)->'price_monthly'
           UNION ALL SELECT to_jsonb(v_plan)->'price_yearly'
         ) AS amounts(v)
        WHERE jsonb_typeof(amounts.v) IN ('number', 'string')
          AND CASE
                WHEN btrim(amounts.v #>> '{}') = '' THEN false
                WHEN btrim(amounts.v #>> '{}') ~ '^[-+]?([0-9]+[.]?[0-9]*|[.][0-9]+)([eE][-+]?[0-9]+)?$'
                  THEN btrim(amounts.v #>> '{}')::numeric > 0
                -- Not a number: never read as free.
                ELSE true
              END)
  THEN
    RETURN jsonb_build_object('skipped', 'plan_not_free', 'plan_id', v_plan.id);
  END IF;

  v_start := COALESCE(v_sub.next_invoice_at, v_sub.current_period_end, now());
  IF v_start > now() THEN
    RETURN jsonb_build_object('skipped', 'not_yet_due', 'next_at', v_start);
  END IF;
  v_end := public.billing_v2_add_interval(v_start, COALESCE(v_sub.billing_interval, 'monthly'), 1);

  IF EXISTS (SELECT 1 FROM public.billing_subscription_periods
              WHERE workspace_id = p_workspace_id
                AND status IN ('scheduled', 'active')
                AND period_start = v_start) THEN
    RETURN jsonb_build_object('skipped', 'period_exists');
  END IF;

  v_allow := GREATEST(ROUND(COALESCE((v_plan.limits->>'ai_credits_per_month')::numeric, 0))::bigint, 0);

  INSERT INTO public.billing_subscription_periods (
    workspace_id, subscription_id, plan_id, invoice_id, billing_interval,
    period_start, period_end, status, source, plan_snapshot, limits_snapshot, ai_allowance_irr
  ) VALUES (
    p_workspace_id, v_sub.id, v_plan.id, NULL, COALESCE(v_sub.billing_interval, 'monthly'),
    v_start, v_end, 'scheduled', 'free_plan',
    to_jsonb(v_plan), COALESCE(v_plan.limits, '{}'::jsonb), v_allow
  ) RETURNING * INTO v_period;

  UPDATE public.workspace_subscriptions
     SET next_invoice_at = v_end, updated_at = now() WHERE id = v_sub.id;

  PERFORM public.billing_activate_period(v_period.id);

  INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
  VALUES (p_workspace_id, 'free_period_activated', 'scheduler',
          jsonb_build_object('period_id', v_period.id, 'period_start', v_start, 'period_end', v_end));

  RETURN jsonb_build_object('period_id', v_period.id, 'free', true, 'replayed', false);
END;
$$;

-- ─── Worker B — wallet auto-pay ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.billing_v2_wallet_autopay_invoice(p_invoice_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_inv      public.billing_invoices;
  v_policy   JSONB;
  v_balance  BIGINT;
  v_res      JSONB;
  v_currency TEXT;
BEGIN
  PERFORM public.billing_expire_stale_collections(p_invoice_id);

  SELECT * INTO v_inv FROM public.billing_invoices WHERE id = p_invoice_id;
  IF v_inv.id IS NULL THEN RETURN jsonb_build_object('skipped', 'unknown_invoice'); END IF;
  IF v_inv.status NOT IN ('open', 'partially_paid', 'past_due') THEN
    RETURN jsonb_build_object('skipped', 'not_payable:' || v_inv.status);
  END IF;
  IF v_inv.amount_due_irr <= 0 THEN RETURN jsonb_build_object('skipped', 'nothing_due'); END IF;

  -- The wallet holds Rial and pays IRR invoices only: the amount columns of
  -- a USD invoice hold cents, which the wallet would debit as Rial.
  v_currency := upper(btrim(v_inv.currency));
  IF COALESCE(v_currency ~ '^[A-Z]{3}$' AND v_currency <> 'IRR', false) THEN
    RETURN jsonb_build_object('skipped', 'currency_not_wallet:' || v_currency);
  END IF;

  IF v_inv.due_at IS NULL OR v_inv.due_at > now() THEN
    RETURN jsonb_build_object('skipped', 'not_due');
  END IF;

  v_policy := public.billing_v2_policy_for(v_inv.workspace_id);
  IF NOT (v_policy->>'wallet_auto_pay')::boolean THEN
    RETURN jsonb_build_object('skipped', 'auto_pay_disabled');
  END IF;

  IF EXISTS (SELECT 1 FROM public.billing_invoice_collections
              WHERE invoice_id = v_inv.id AND status = 'active') THEN
    INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
    VALUES (v_inv.workspace_id, 'wallet_autopay_skipped_collection_active', 'collection_active',
            jsonb_build_object('invoice_id', v_inv.id));
    RETURN jsonb_build_object('skipped', 'collection_active');
  END IF;

  -- Wallet lock first: the balance we check is the balance we debit.
  PERFORM public.billing_wallet_lock(v_inv.workspace_id);
  SELECT available_balance_irr INTO v_balance FROM public.billing_wallet_accounts
   WHERE workspace_id = v_inv.workspace_id;

  IF COALESCE(v_balance, 0) < v_inv.amount_due_irr THEN
    -- NEVER a partial debit: either the invoice is fully paid or nothing moves.
    INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
    VALUES (v_inv.workspace_id, 'wallet_autopay_skipped_insufficient', 'insufficient_balance',
            jsonb_build_object('invoice_id', v_inv.id, 'due_irr', v_inv.amount_due_irr,
                               'balance_irr', COALESCE(v_balance, 0)));
    RETURN jsonb_build_object('skipped', 'insufficient_balance');
  END IF;

  -- Takes the collection reservation, debits, settles and applies — one txn.
  v_res := public.billing_wallet_pay_invoice(v_inv.id, NULL);

  INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
  VALUES (v_inv.workspace_id, 'wallet_autopay_succeeded', 'scheduler',
          jsonb_build_object('invoice_id', v_inv.id, 'amount_irr', v_inv.amount_due_irr));

  RETURN v_res || jsonb_build_object('paid', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_v2_run_wallet_autopay(p_limit INTEGER DEFAULT 50)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  r         RECORD;
  j         public.billing_v2_jobs;
  v_res     JSONB;
  v_paid    INTEGER := 0;
  v_skipped INTEGER := 0;
  v_failed  INTEGER := 0;
  v_last    TEXT;
BEGIN
  PERFORM public.billing_expire_stale_collections(NULL);

  FOR r IN
    SELECT i.id, i.workspace_id, i.amount_paid_irr
      FROM public.billing_invoices i
      JOIN public.billing_v2_rollout ro ON ro.workspace_id = i.workspace_id AND ro.state = 'v2_active'
     WHERE i.status IN ('open', 'partially_paid', 'past_due')
       AND i.amount_due_irr > 0
       AND i.due_at IS NOT NULL
       AND i.due_at <= now()
       -- The wallet pays IRR invoices only; any other never takes a slot.
       AND NOT COALESCE(upper(btrim(i.currency)) ~ '^[A-Z]{3}$'
                        AND upper(btrim(i.currency)) <> 'IRR', false)
     ORDER BY i.due_at
     LIMIT GREATEST(COALESCE(p_limit, 50), 1)
  LOOP
    PERFORM public.billing_v2_enqueue_job(
      'wallet_autopay',
      r.id::text || ':' || r.amount_paid_irr::text,
      r.workspace_id,
      jsonb_build_object('invoice_id', r.id)
    );
  END LOOP;

  FOR j IN SELECT * FROM public.billing_v2_claim_jobs('wallet_autopay', p_limit, 120) LOOP
    BEGIN
      v_res := public.billing_v2_wallet_autopay_invoice((j.payload->>'invoice_id')::uuid);
      IF v_res ? 'skipped' THEN
        v_skipped := v_skipped + 1;
        -- Transient reasons come back on the next run; terminal ones do not.
        IF split_part(v_res->>'skipped', ':', 1) IN
             ('collection_active', 'insufficient_balance', 'not_due') THEN
          PERFORM public.billing_v2_defer_job(j.id, v_res->>'skipped');
        ELSE
          PERFORM public.billing_v2_complete_job(j.id, v_res);
        END IF;
      ELSE
        v_paid := v_paid + 1;
        PERFORM public.billing_v2_complete_job(j.id, v_res);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      v_last := SQLERRM;
      PERFORM public.billing_v2_fail_job(j.id, SQLERRM);
      INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
      VALUES (j.workspace_id, 'wallet_autopay_failed', left(SQLERRM, 200),
              jsonb_build_object('job_id', j.id, 'invoice_id', j.payload->>'invoice_id'));
    END;
  END LOOP;

  PERFORM public.billing_v2_note_worker_run('wallet_autopay', v_paid + v_skipped, v_failed, v_last);
  RETURN jsonb_build_object('paid', v_paid, 'skipped', v_skipped, 'failed', v_failed);
END;
$$;

-- ─── Wallet payment takes the reservation before it debits ────────────────
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

  -- The wallet holds Rial: an invoice in any other currency is never debited
  -- from it (its amount columns hold that currency's minor units).
  IF COALESCE(upper(btrim(v_inv.currency)) ~ '^[A-Z]{3}$'
              AND upper(btrim(v_inv.currency)) <> 'IRR', false) THEN
    RAISE EXCEPTION 'invoice_currency_not_wallet:%:%', v_inv.id, upper(btrim(v_inv.currency));
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

-- ─── ACL: as 118 and 115 grant them ───────────────────────────────────────
DO $$
DECLARE f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.billing_v2_issue_renewal_invoice(uuid, boolean)',
    'public.billing_v2_ensure_free_period(uuid)',
    'public.billing_v2_wallet_autopay_invoice(uuid)',
    'public.billing_v2_run_wallet_autopay(integer)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE f TEXT := 'public.billing_wallet_pay_invoice(uuid, uuid)';
BEGIN
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', f);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', f);
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO postgres', f);
  END IF;
END $$;
