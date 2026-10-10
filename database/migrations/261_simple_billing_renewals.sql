-- 261 — Simple billing, phase 3: buying a plan, renewal, upgrade, changes at
-- period end, the monthly AI credit, and the billing emails
-- (docs/billing/SIMPLE_BILLING.md).
--
-- Everything is paid from the workspace's prepaid balance (259). A gateway
-- payment made for a purpose (plan, renewal, upgrade) is credited to the
-- balance with its receipt and then spent on that purpose in the same
-- transaction; if the purpose can no longer be done, the money stays in the
-- balance.
--
--   Buy a plan       on Free (or a trial, or after a plan ran out): the full
--                    price; the period starts now.
--   Renew            early: pays the next period, which starts when the
--                    current one ends. At the due moment the hourly job
--                    renews from the balance when auto-renew is on, or a
--                    prepaid period starts; otherwise the workspace moves to
--                    Free at once (no grace period).
--   Upgrade          immediate; the due date does not move. Monthly: the
--                    price difference. Yearly: the difference × whole months
--                    left / 12. The month's AI credit difference is added.
--   Change at the    downgrade, monthly ↔ yearly, or a higher plan "from the
--   end of a period  next period": takes effect at the due date and is paid
--                    then; it can be cancelled until then. A prepaid next
--                    period is re-priced: the difference returns to the
--                    balance, or a missing part is taken from it.
--   AI credit        each month of a period (also of a yearly one) the
--                    plan's monthly allowance, expiring at that month's end.
--
-- workspace_subscriptions stays the only source the entitlement code reads.
-- Billing v2's guard and lifecycle-mail triggers on it are dropped: v2 no
-- longer runs (shared/billingMode.ts) and its mails are not the Super
-- Admin's templates. Its functions and tables stay until phase 7.
--
-- Re-runnable: every step is guarded or a no-op the second time.

-- ─── 1. Billing v2 no longer guards or mails subscriptions ────────────────
DROP TRIGGER IF EXISTS trg_billing_v2_block_direct_subscription ON public.workspace_subscriptions;
DROP TRIGGER IF EXISTS trg_billing_notify_subscription_lifecycle ON public.workspace_subscriptions;

-- ─── 1b. Columns ──────────────────────────────────────────────────────────
-- The period a prepaid next period follows (its start = that period's end):
-- a prepayment is only ever used for the period it was paid for.
ALTER TABLE public.billing_accounts ADD COLUMN IF NOT EXISTS next_period_start timestamptz;
-- What spending a gateway payment on its purpose did (or why it could not),
-- so a later look at the payment can tell the customer.
ALTER TABLE public.billing_account_payments ADD COLUMN IF NOT EXISTS purpose_result jsonb;

-- ─── 2. Helpers ───────────────────────────────────────────────────────────

-- The currency the region charges (shared/edition.ts REGION_CURRENCY).
CREATE OR REPLACE FUNCTION public.billing_region_currency()
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT CASE (SELECT s.region_mode FROM public.platform_settings s LIMIT 1)
           WHEN 'iran' THEN 'IRR'
           WHEN 'turkey' THEN 'TRY'
           ELSE 'USD'
         END
$$;

-- `a + n months`, counted in UTC (month ends clamp: Jan 31 + 1 = Feb 28).
CREATE OR REPLACE FUNCTION public.billing_add_months(p_at timestamptz, p_months integer)
RETURNS timestamptz
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp
AS $$
  SELECT ((p_at AT TIME ZONE 'UTC') + make_interval(months => p_months)) AT TIME ZONE 'UTC'
$$;

-- Whole months from p_from to p_to (UTC); 0 when p_to is not later.
CREATE OR REPLACE FUNCTION public.billing_whole_months(p_from timestamptz, p_to timestamptz)
RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN p_to <= p_from THEN 0 ELSE (
    extract(year FROM age(p_to AT TIME ZONE 'UTC', p_from AT TIME ZONE 'UTC'))::integer * 12
    + extract(month FROM age(p_to AT TIME ZONE 'UTC', p_from AT TIME ZONE 'UTC'))::integer
  ) END
$$;

CREATE OR REPLACE FUNCTION public.billing_period_end(p_start timestamptz, p_interval text)
RETURNS timestamptz
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp
AS $$
  SELECT public.billing_add_months(p_start, CASE WHEN p_interval = 'yearly' THEN 12 ELSE 1 END)
$$;

-- A plan's price for one period, in minor units of the currency (IRR in
-- whole Rial). 0 for a free plan; NULL when the plan is not sold in that
-- currency for that interval (no positive price).
CREATE OR REPLACE FUNCTION public.billing_plan_price(p_plan_id uuid, p_currency text, p_interval text)
RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_plan public.billing_plans;
  v_raw  text;
BEGIN
  SELECT * INTO v_plan FROM public.billing_plans WHERE id = p_plan_id;
  IF v_plan.id IS NULL THEN
    RETURN NULL;
  END IF;
  IF v_plan.is_free THEN
    RETURN 0;
  END IF;
  v_raw := v_plan.prices -> upper(coalesce(p_currency, '')) ->> coalesce(p_interval, 'monthly');
  IF v_raw IS NULL OR v_raw !~ '^\d+(\.\d+)?$' OR v_raw::numeric <= 0 THEN
    RETURN NULL;
  END IF;
  RETURN round(v_raw::numeric)::bigint;
END;
$$;

-- A number from a jsonb value, NULL when it is not one.
CREATE OR REPLACE FUNCTION public.billing_jsonb_number(p_value jsonb)
RETURNS numeric
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN jsonb_typeof(p_value) = 'number' THEN p_value::text::numeric
              WHEN jsonb_typeof(p_value) = 'string' AND (p_value #>> '{}') ~ '^-?\d+(\.\d+)?$' THEN (p_value #>> '{}')::numeric
         END
$$;

-- The monthly AI credit of a plan for a workspace, in the AI wallet's unit
-- (Rial): the workspace's own override (Super Admin), else the plan's
-- ai_allowance.IRR, else its limit included_ai_allowance_irr, else
-- ai_credits_per_month (what billing v2 granted). Never negative.
CREATE OR REPLACE FUNCTION public.billing_plan_ai_allowance(p_plan_id uuid, p_workspace_id uuid)
RETURNS numeric
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_plan     public.billing_plans;
  v_override numeric;
BEGIN
  SELECT * INTO v_plan FROM public.billing_plans WHERE id = p_plan_id;
  IF v_plan.id IS NULL THEN
    RETURN 0;
  END IF;
  IF p_workspace_id IS NOT NULL AND to_regclass('public.workspace_limit_overrides') IS NOT NULL THEN
    EXECUTE 'SELECT limit_value::numeric FROM public.workspace_limit_overrides
              WHERE workspace_id = $1 AND limit_key = ''included_ai_allowance_irr'' LIMIT 1'
      INTO v_override USING p_workspace_id;
  END IF;
  RETURN greatest(coalesce(
    v_override,
    public.billing_jsonb_number(v_plan.ai_allowance -> 'IRR'),
    public.billing_jsonb_number(v_plan.limits -> 'included_ai_allowance_irr'),
    public.billing_jsonb_number(v_plan.limits -> 'ai_credits_per_month'),
    0
  ), 0);
END;
$$;

-- ─── 3. The AI credit of one month of a period ────────────────────────────
-- The month of [p_period_start, p_period_end) that contains p_at gets the
-- plan's monthly allowance once (source 'plan'), expiring at that month's
-- end; an upgrade adds the difference under its own source. The cycle id
-- starts with 'cycle:' (billing v2's allowance guard lets those through).
-- A month that another path already funded is not funded twice: billing
-- v2's own cycle, or the old calendar grant ('YYYY-MM') made in this month
-- of this period. Granting a month retires what is left of older calendar
-- lots (another plan's, or an earlier month's), as billing v2 did, so they
-- never add up with it.
CREATE OR REPLACE FUNCTION public.billing_account_grant_month(
  p_workspace_id uuid,
  p_plan_id      uuid,
  p_period_start timestamptz,
  p_period_end   timestamptz,
  p_source       text DEFAULT 'plan',
  p_amount       numeric DEFAULT NULL,
  p_at           timestamptz DEFAULT now()
) RETURNS numeric
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_k           integer;
  v_cycle_start timestamptz;
  v_cycle_end   timestamptz;
  v_cycle_id    text;
  v_amount      numeric;
  v_lot         public.workspace_ai_balance_lots;
  v_left        numeric;
  v_entry       uuid;
  v_retired     integer := 0;
BEGIN
  IF p_period_start IS NULL OR p_period_end IS NULL OR p_at < p_period_start OR p_at >= p_period_end THEN
    RETURN 0;
  END IF;
  -- The month of the period that contains p_at, on the same boundaries
  -- billing_add_months draws (month ends clamp).
  v_k := public.billing_whole_months(p_period_start, p_at);
  WHILE v_k > 0 AND public.billing_add_months(p_period_start, v_k) > p_at LOOP
    v_k := v_k - 1;
  END LOOP;
  WHILE public.billing_add_months(p_period_start, v_k + 1) <= p_at LOOP
    v_k := v_k + 1;
  END LOOP;
  v_cycle_start := public.billing_add_months(p_period_start, v_k);
  v_cycle_end := least(public.billing_add_months(p_period_start, v_k + 1), p_period_end);
  v_cycle_id := 'cycle:account:' || to_char(v_cycle_start AT TIME ZONE 'UTC', 'YYYYMMDD"T"HH24MISS');
  v_amount := coalesce(p_amount, public.billing_plan_ai_allowance(p_plan_id, p_workspace_id));
  IF v_amount IS NULL OR v_amount <= 0 THEN
    RETURN 0;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.workspace_ai_balance_lots
     WHERE workspace_id = p_workspace_id
       AND source_type = 'PLAN_ALLOWANCE'
       AND billing_cycle_id = v_cycle_id
       AND allowance_source = p_source
  ) THEN
    RETURN 0;
  END IF;
  -- A month billing v2 funded itself (its own period or cycle lot covering
  -- part of this month) is not funded twice. Lots of other paths (a trial,
  -- the Free plan's calendar month) are another plan's credit and do not
  -- count.
  IF p_source = 'plan' AND EXISTS (
    SELECT 1 FROM public.workspace_ai_balance_lots
     WHERE workspace_id = p_workspace_id
       AND source_type = 'PLAN_ALLOWANCE'
       AND coalesce(allowance_source, 'plan') = 'plan'
       AND (billing_cycle_id LIKE 'period:%'
            OR (billing_cycle_id LIKE 'cycle:%' AND billing_cycle_id NOT LIKE 'cycle:account:%'))
       AND created_at < v_cycle_end
       AND (expires_at IS NULL OR expires_at > v_cycle_start)
  ) THEN
    RETURN 0;
  END IF;
  IF p_source = 'plan' THEN
    -- The old calendar grant funded this month of this period already.
    IF EXISTS (
      SELECT 1 FROM public.workspace_ai_balance_lots
       WHERE workspace_id = p_workspace_id
         AND source_type = 'PLAN_ALLOWANCE'
         AND billing_cycle_id ~ '^[0-9]{4}-[0-9]{2}$'
         AND created_at >= greatest(p_period_start, v_cycle_start)
         AND created_at < v_cycle_end
    ) THEN
      RETURN 0;
    END IF;
    -- What is left of older calendar lots expires (what is reserved by a
    -- reply in flight stays until it settles).
    PERFORM public.ai_wallet_lock(p_workspace_id);
    FOR v_lot IN
      SELECT * FROM public.workspace_ai_balance_lots
       WHERE workspace_id = p_workspace_id
         AND source_type = 'PLAN_ALLOWANCE'
         AND billing_cycle_id ~ '^[0-9]{4}-[0-9]{2}$'
         AND state IN ('ACTIVE', 'EXPIRING')
         AND remaining_amount > 0
       FOR UPDATE
    LOOP
      v_left := v_lot.remaining_amount - v_lot.reserved_amount;
      IF v_left > 0 THEN
        INSERT INTO public.workspace_ai_ledger (workspace_id, entry_type, amount, billing_cycle_id, reason)
        VALUES (v_lot.workspace_id, 'EXPIRATION', -v_left, v_lot.billing_cycle_id, 'legacy_allowance_superseded')
        RETURNING id INTO v_entry;
        INSERT INTO public.workspace_ai_ledger_allocations (ledger_entry_id, lot_id, amount)
        VALUES (v_entry, v_lot.id, v_left);
      END IF;
      UPDATE public.workspace_ai_balance_lots
         SET remaining_amount = v_lot.reserved_amount,
             state = CASE WHEN v_lot.reserved_amount > 0 THEN 'EXPIRING' ELSE 'EXPIRED' END,
             updated_at = now()
       WHERE id = v_lot.id;
      v_retired := v_retired + 1;
    END LOOP;
    IF v_retired > 0 THEN
      PERFORM public.ai_wallet_project(p_workspace_id);
    END IF;
  END IF;
  PERFORM public.ai_grant_allowance(
    p_workspace_id, v_amount, v_cycle_id, p_source, v_cycle_end,
    'account_allowance:' || p_workspace_id::text || ':' || v_cycle_id || ':' || p_source
  );
  RETURN v_amount;
END;
$$;

-- ─── 4. Writing the subscription ──────────────────────────────────────────
-- The one place the simple billing writes workspace_subscriptions, with its
-- plan_change_log row. Clears what billing v2 kept there (its period link,
-- pending change, dunning markers): none of it applies any more.
CREATE OR REPLACE FUNCTION public.billing_account_write_subscription(
  p_workspace_id uuid,
  p_plan_id      uuid,
  p_interval     text,
  p_start        timestamptz,
  p_end          timestamptz,
  p_status       text,
  p_change       text,
  p_actor        uuid DEFAULT NULL,
  p_details      jsonb DEFAULT '{}'::jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_old public.workspace_subscriptions;
BEGIN
  SELECT * INTO v_old FROM public.workspace_subscriptions WHERE workspace_id = p_workspace_id FOR UPDATE;
  INSERT INTO public.workspace_subscriptions (
    workspace_id, plan_id, provider_name, status, billing_interval,
    current_period_start, current_period_end, metadata
  ) VALUES (
    p_workspace_id, p_plan_id, 'account', p_status, p_interval,
    p_start, p_end, jsonb_build_object('source', 'simple_billing', 'change', p_change)
  )
  ON CONFLICT (workspace_id) DO UPDATE SET
    plan_id = EXCLUDED.plan_id,
    provider_name = 'account',
    status = EXCLUDED.status,
    billing_interval = EXCLUDED.billing_interval,
    current_period_start = EXCLUDED.current_period_start,
    current_period_end = EXCLUDED.current_period_end,
    cancel_at_period_end = false,
    canceled_at = NULL,
    current_period_id = NULL,
    next_plan_id = NULL,
    pending_change_type = NULL,
    pending_change_currency = NULL,
    next_invoice_at = NULL,
    past_due_since = NULL,
    grace_period_ends_at = NULL,
    free_fallback_at = NULL,
    metadata = coalesce(public.workspace_subscriptions.metadata, '{}'::jsonb)
      || jsonb_build_object('source', 'simple_billing', 'change', p_change),
    updated_at = now();

  INSERT INTO public.plan_change_log (workspace_id, old_plan_id, new_plan_id, change_type, changed_by, metadata)
  VALUES (
    p_workspace_id, v_old.plan_id, p_plan_id, p_change, p_actor,
    jsonb_build_object(
      'source', 'simple_billing',
      'old_status', v_old.status, 'new_status', p_status,
      'billing_interval', p_interval, 'period_start', p_start, 'period_end', p_end
    ) || coalesce(p_details, '{}'::jsonb)
  );
END;
$$;

-- The account of a workspace, locked, created in the region's currency.
CREATE OR REPLACE FUNCTION public.billing_account_lock(p_workspace_id uuid)
RETURNS public.billing_accounts
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_acc public.billing_accounts;
BEGIN
  PERFORM public.billing_account_ensure(p_workspace_id, public.billing_region_currency());
  SELECT * INTO v_acc FROM public.billing_accounts WHERE workspace_id = p_workspace_id FOR UPDATE;
  RETURN v_acc;
END;
$$;

-- A debit from the balance, with its ledger row. Idempotent per key: a
-- replay returns the row already written.
CREATE OR REPLACE FUNCTION public.billing_account_debit(
  p_workspace_id uuid,
  p_kind         text,
  p_amount       bigint,
  p_plan_id      uuid,
  p_interval     text,
  p_start        timestamptz,
  p_end          timestamptz,
  p_description  jsonb,
  p_actor        uuid,
  p_key          text
) RETURNS public.billing_account_ledger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_acc   public.billing_accounts;
  v_entry public.billing_account_ledger;
BEGIN
  SELECT * INTO v_entry FROM public.billing_account_ledger WHERE idempotency_key = p_key;
  IF v_entry.id IS NOT NULL THEN
    -- A replay must be the same charge; a key never stands in for another.
    IF v_entry.workspace_id <> p_workspace_id OR v_entry.kind <> p_kind OR v_entry.amount_minor <> -p_amount THEN
      RAISE EXCEPTION 'billing_idempotency_conflict';
    END IF;
    RETURN v_entry;
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'billing_amount_invalid';
  END IF;
  SELECT * INTO v_acc FROM public.billing_accounts WHERE workspace_id = p_workspace_id FOR UPDATE;
  IF v_acc.balance_minor < p_amount THEN
    RAISE EXCEPTION 'billing_insufficient_balance';
  END IF;
  -- clock_timestamp(): after a credit made earlier in the same transaction
  -- (a payment spent on its purpose), so the history lists them in order.
  INSERT INTO public.billing_account_ledger (
    workspace_id, kind, amount_minor, balance_after, currency,
    plan_id, billing_interval, period_start, period_end, description, actor_id, idempotency_key, created_at
  ) VALUES (
    p_workspace_id, p_kind, -p_amount, v_acc.balance_minor - p_amount, v_acc.currency,
    p_plan_id, p_interval, p_start, p_end, coalesce(p_description, '{}'::jsonb), p_actor, p_key, clock_timestamp()
  ) RETURNING * INTO v_entry;
  UPDATE public.billing_accounts
     SET balance_minor = balance_minor - p_amount, updated_at = now()
   WHERE workspace_id = p_workspace_id;
  RETURN v_entry;
END;
$$;

-- Money back to the balance (a prepaid next period that changed). Idempotent
-- per key. The row names the prepaid period it comes from (its plan,
-- interval and dates), for the history: callers return it before they clear
-- the prepayment.
CREATE OR REPLACE FUNCTION public.billing_account_credit_back(
  p_workspace_id uuid,
  p_amount       bigint,
  p_description  jsonb,
  p_actor        uuid,
  p_key          text
) RETURNS public.billing_account_ledger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_acc      public.billing_accounts;
  v_entry    public.billing_account_ledger;
  v_sub      public.workspace_subscriptions;
  v_plan     uuid;
  v_interval text;
BEGIN
  SELECT * INTO v_entry FROM public.billing_account_ledger WHERE idempotency_key = p_key;
  IF v_entry.id IS NOT NULL THEN
    IF v_entry.workspace_id <> p_workspace_id OR v_entry.kind <> 'prepaid_return' OR v_entry.amount_minor <> p_amount THEN
      RAISE EXCEPTION 'billing_idempotency_conflict';
    END IF;
    RETURN v_entry;
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN v_entry;
  END IF;
  SELECT * INTO v_acc FROM public.billing_accounts WHERE workspace_id = p_workspace_id FOR UPDATE;
  IF v_acc.next_period_start IS NOT NULL THEN
    SELECT * INTO v_sub FROM public.workspace_subscriptions WHERE workspace_id = p_workspace_id;
    v_plan := coalesce(v_acc.scheduled_plan_id, v_sub.plan_id);
    v_interval := coalesce(v_acc.scheduled_interval, v_sub.billing_interval, 'monthly');
  END IF;
  INSERT INTO public.billing_account_ledger (
    workspace_id, kind, amount_minor, balance_after, currency, plan_id, billing_interval, period_start, period_end,
    description, actor_id, idempotency_key, created_at
  ) VALUES (
    p_workspace_id, 'prepaid_return', p_amount, v_acc.balance_minor + p_amount, v_acc.currency,
    v_plan, v_interval, v_acc.next_period_start,
    CASE WHEN v_acc.next_period_start IS NOT NULL THEN public.billing_period_end(v_acc.next_period_start, v_interval) END,
    coalesce(p_description, '{}'::jsonb), p_actor, p_key, clock_timestamp()
  ) RETURNING * INTO v_entry;
  UPDATE public.billing_accounts
     SET balance_minor = balance_minor + p_amount, updated_at = now()
   WHERE workspace_id = p_workspace_id;
  RETURN v_entry;
END;
$$;

-- A next period already paid through billing v2 (a 'scheduled' service
-- period; its scheduler no longer runs, so the due moment starts it). Such a
-- period is renewed: no reminder, no second renewal.
CREATE OR REPLACE FUNCTION public.billing_account_v2_next_period(p_workspace_id uuid)
RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF to_regclass('public.billing_subscription_periods') IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT id INTO v_id FROM public.billing_subscription_periods
   WHERE workspace_id = p_workspace_id AND status = 'scheduled'
   ORDER BY period_start LIMIT 1;
  RETURN v_id;
END;
$$;

-- A Super Admin assignment (or revocation) replaces the running period: a
-- prepayment made for the period after the old one returns to the balance,
-- and a change the customer scheduled for its end no longer applies. (The
-- period end alone cannot tell: an assignment may keep the same date.)
CREATE OR REPLACE FUNCTION public.billing_account_admin_replaced(p_workspace_id uuid)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_acc public.billing_accounts;
BEGIN
  SELECT * INTO v_acc FROM public.billing_accounts WHERE workspace_id = p_workspace_id FOR UPDATE;
  IF v_acc.workspace_id IS NULL THEN
    RETURN 0;
  END IF;
  IF v_acc.next_period_prepaid_minor IS NOT NULL THEN
    PERFORM public.billing_account_credit_back(
      p_workspace_id, v_acc.next_period_prepaid_minor,
      jsonb_build_object('reason', 'admin_assignment', 'for_period_start', v_acc.next_period_start), NULL,
      'prepaid_return:' || p_workspace_id::text || ':admin:' || gen_random_uuid()::text
    );
  END IF;
  UPDATE public.billing_accounts
     SET next_period_prepaid_minor = NULL, next_period_start = NULL,
         scheduled_plan_id = NULL, scheduled_interval = NULL, updated_at = now()
   WHERE workspace_id = p_workspace_id;
  RETURN coalesce(v_acc.next_period_prepaid_minor, 0);
END;
$$;

-- A prepaid next period belongs to the period it follows (next_period_start
-- = that period's end). When that period no longer is the running one (it
-- ended, or a Super Admin assignment or billing v2 replaced it), the
-- prepayment returns to the balance. Returns what was returned.
CREATE OR REPLACE FUNCTION public.billing_account_release_stale_prepaid(p_workspace_id uuid)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_acc public.billing_accounts;
  v_sub public.workspace_subscriptions;
BEGIN
  SELECT * INTO v_acc FROM public.billing_accounts WHERE workspace_id = p_workspace_id FOR UPDATE;
  IF v_acc.workspace_id IS NULL OR v_acc.next_period_prepaid_minor IS NULL THEN
    RETURN 0;
  END IF;
  v_sub := public.billing_account_paid_subscription(p_workspace_id);
  IF v_sub.id IS NOT NULL AND v_acc.next_period_start IS NOT DISTINCT FROM v_sub.current_period_end THEN
    RETURN 0;
  END IF;
  PERFORM public.billing_account_credit_back(
    p_workspace_id, v_acc.next_period_prepaid_minor,
    jsonb_build_object('reason', 'period_changed', 'for_period_start', v_acc.next_period_start), NULL,
    'prepaid_return:' || p_workspace_id::text || ':stale:' || gen_random_uuid()::text
  );
  UPDATE public.billing_accounts
     SET next_period_prepaid_minor = NULL, next_period_start = NULL, updated_at = now()
   WHERE workspace_id = p_workspace_id;
  RETURN v_acc.next_period_prepaid_minor;
END;
$$;

-- ─── 5. The paid period a workspace is in ─────────────────────────────────
-- Its active subscription on a plan that is not free, with time left (or
-- just due, before the hourly job ran). NULL otherwise.
CREATE OR REPLACE FUNCTION public.billing_account_paid_subscription(p_workspace_id uuid)
RETURNS public.workspace_subscriptions
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT s.* FROM public.workspace_subscriptions s
    JOIN public.billing_plans p ON p.id = s.plan_id
   WHERE s.workspace_id = p_workspace_id
     AND s.status = 'active'
     AND NOT p.is_free
     AND s.current_period_end IS NOT NULL
$$;

-- What an upgrade to p_plan_id costs now: monthly, the price difference;
-- yearly, the difference × whole months left / 12 (rounded).
CREATE OR REPLACE FUNCTION public.billing_account_upgrade_cost(
  p_workspace_id uuid,
  p_plan_id      uuid,
  p_at           timestamptz DEFAULT now()
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_sub      public.workspace_subscriptions;
  v_acc      public.billing_accounts;
  v_currency text;
  v_interval text;
  v_new      bigint;
  v_old      bigint;
  v_months   integer;
  v_cost     bigint;
  v_next     bigint;
  v_reprice  bigint;
BEGIN
  v_sub := public.billing_account_paid_subscription(p_workspace_id);
  IF v_sub.id IS NULL OR v_sub.current_period_end <= p_at THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_acc FROM public.billing_accounts WHERE workspace_id = p_workspace_id;
  v_currency := coalesce(v_acc.currency, public.billing_region_currency());
  v_interval := coalesce(v_sub.billing_interval, 'monthly');
  v_new := public.billing_plan_price(p_plan_id, v_currency, v_interval);
  v_old := coalesce(public.billing_plan_price(v_sub.plan_id, v_currency, v_interval), 0);
  IF v_new IS NULL OR v_new <= v_old THEN
    RETURN jsonb_build_object('upgrade', false, 'new_price_minor', v_new, 'old_price_minor', v_old);
  END IF;
  v_months := public.billing_whole_months(p_at, v_sub.current_period_end);
  IF v_interval = 'yearly' THEN
    -- The yearly difference for the whole months left.
    v_cost := round((v_new - v_old)::numeric * v_months / 12);
  ELSE
    -- The monthly difference; a window longer than a month (a Super Admin
    -- grant) pays it for each whole month left.
    v_cost := (v_new - v_old) * greatest(v_months, 1);
  END IF;
  -- A prepaid next period follows the new plan: what it now costs more (or
  -- less) is taken from (or returned to) the balance with the upgrade. (One
  -- paid for a period that was replaced returns whole first; see
  -- billing_account_release_stale_prepaid.)
  IF v_acc.next_period_prepaid_minor IS NOT NULL
     AND v_acc.next_period_start IS NOT DISTINCT FROM v_sub.current_period_end THEN
    v_next := public.billing_plan_price(p_plan_id, v_currency, coalesce(v_acc.scheduled_interval, v_interval));
    v_reprice := CASE WHEN v_next IS NULL THEN -v_acc.next_period_prepaid_minor ELSE v_next - v_acc.next_period_prepaid_minor END;
  END IF;
  RETURN jsonb_build_object(
    'upgrade', true, 'cost_minor', v_cost, 'new_price_minor', v_new, 'old_price_minor', v_old,
    'months_left', CASE WHEN v_interval = 'yearly' OR v_months > 1 THEN v_months END,
    'currency', v_currency, 'billing_interval', v_interval,
    'prepaid_minor', v_acc.next_period_prepaid_minor, 'next_price_minor', v_next, 'reprice_minor', v_reprice,
    'period_end', v_sub.current_period_end
  );
END;
$$;

-- ─── 6. Buying a plan ─────────────────────────────────────────────────────
-- On Free, a trial, or after a plan ran out: the full price from the
-- balance; the period starts now. Idempotent per p_key.
CREATE OR REPLACE FUNCTION public.billing_account_purchase_plan(
  p_workspace_id uuid,
  p_plan_id      uuid,
  p_interval     text,
  p_key          text,
  p_actor        uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_acc    public.billing_accounts;
  v_plan   public.billing_plans;
  v_sub    public.workspace_subscriptions;
  v_price  bigint;
  v_entry  public.billing_account_ledger;
  v_start  timestamptz := now();
  v_end    timestamptz;
  v_due    jsonb;
BEGIN
  IF p_interval NOT IN ('monthly', 'yearly') THEN
    RAISE EXCEPTION 'billing_interval_invalid';
  END IF;
  SELECT * INTO v_entry FROM public.billing_account_ledger WHERE idempotency_key = 'plan:' || p_key;
  IF v_entry.id IS NOT NULL THEN
    RETURN jsonb_build_object('replayed', true, 'action', 'purchase', 'ledger_id', v_entry.id, 'plan_id', v_entry.plan_id,
      'period_start', v_entry.period_start, 'period_end', v_entry.period_end);
  END IF;
  v_acc := public.billing_account_lock(p_workspace_id);
  -- A double submit waited for the lock above: it replays the first one.
  SELECT * INTO v_entry FROM public.billing_account_ledger WHERE idempotency_key = 'plan:' || p_key;
  IF v_entry.id IS NOT NULL THEN
    RETURN jsonb_build_object('replayed', true, 'action', 'purchase', 'ledger_id', v_entry.id, 'plan_id', v_entry.plan_id,
      'period_start', v_entry.period_start, 'period_end', v_entry.period_end);
  END IF;
  -- A paid period that is due but not yet processed is processed first: its
  -- prepaid next period starts (or auto-renew pays), or it ends.
  v_sub := public.billing_account_paid_subscription(p_workspace_id);
  IF v_sub.id IS NOT NULL AND v_sub.current_period_end <= now() THEN
    v_due := public.billing_account_process_due(p_workspace_id);
    v_sub := public.billing_account_paid_subscription(p_workspace_id);
  END IF;
  IF v_sub.id IS NOT NULL AND v_sub.current_period_end > now() THEN
    RAISE EXCEPTION 'billing_plan_active';
  END IF;
  PERFORM public.billing_account_release_stale_prepaid(p_workspace_id);
  SELECT * INTO v_acc FROM public.billing_accounts WHERE workspace_id = p_workspace_id FOR UPDATE;
  SELECT * INTO v_plan FROM public.billing_plans WHERE id = p_plan_id;
  IF v_plan.id IS NULL OR NOT coalesce(v_plan.is_active, false) OR v_plan.is_hidden OR v_plan.is_free THEN
    RAISE EXCEPTION 'billing_plan_not_available';
  END IF;
  v_price := public.billing_plan_price(p_plan_id, v_acc.currency, p_interval);
  IF v_price IS NULL OR v_price <= 0 THEN
    RAISE EXCEPTION 'billing_plan_price_unavailable';
  END IF;
  v_end := public.billing_period_end(v_start, p_interval);
  v_entry := public.billing_account_debit(
    p_workspace_id, 'plan', v_price, p_plan_id, p_interval, v_start, v_end,
    jsonb_build_object('plan_slug', v_plan.slug), p_actor, 'plan:' || p_key
  );
  UPDATE public.billing_accounts
     SET scheduled_plan_id = NULL, scheduled_interval = NULL, next_period_prepaid_minor = NULL,
         next_period_start = NULL, updated_at = now()
   WHERE workspace_id = p_workspace_id;
  PERFORM public.billing_account_write_subscription(
    p_workspace_id, p_plan_id, p_interval, v_start, v_end, 'active', 'purchase', p_actor,
    jsonb_build_object('ledger_id', v_entry.id, 'price_minor', v_price)
  );
  PERFORM public.billing_account_grant_month(p_workspace_id, p_plan_id, v_start, v_end);
  RETURN jsonb_build_object(
    'replayed', false, 'action', 'purchase', 'ledger_id', v_entry.id, 'plan_id', p_plan_id,
    'billing_interval', p_interval, 'period_start', v_start, 'period_end', v_end,
    'amount_minor', v_price, 'balance_minor', v_entry.balance_after, 'due_result', v_due
  );
END;
$$;

-- ─── 7. Renewal ───────────────────────────────────────────────────────────
-- Pays the next period from the balance: the current plan, or the change
-- scheduled for the period end. Before the due date the payment is kept as
-- the prepaid next period (it starts when the current one ends); once due
-- (the hourly job has not run yet) the next period starts at once.
-- One renewal per period: the key is the period it pays for.
CREATE OR REPLACE FUNCTION public.billing_account_renew(
  p_workspace_id         uuid,
  p_actor                uuid DEFAULT NULL,
  p_expected_period_end  timestamptz DEFAULT NULL,
  p_expected_price_minor bigint DEFAULT NULL
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
  v_price := public.billing_plan_price(v_target, v_acc.currency, v_interval);
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

-- ─── 8. The due moment (hourly job) ───────────────────────────────────────
-- For a paid period that has ended: a prepaid next period starts; else, with
-- auto-renew on and enough balance, it is renewed from the balance; else
-- (or when the change scheduled for the period end is the free plan) the
-- workspace moves to Free at once. Returns what happened, for the mail.
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
      'amount_minor', v_acc.next_period_prepaid_minor, 'balance_minor', v_acc.balance_minor
    );
  END IF;

  IF NOT coalesce(v_plan.is_free, true) AND v_acc.auto_renew THEN
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
  );
END;
$$;

-- ─── 9. Upgrade (immediate) ───────────────────────────────────────────────
-- The due date and interval stay. A change scheduled for the period end is
-- dropped (the interval part stays), and a prepaid next period returns to
-- the balance: the renewal then charges the new price. One upgrade per
-- (period, plan).
CREATE OR REPLACE FUNCTION public.billing_account_upgrade(
  p_workspace_id uuid,
  p_plan_id      uuid,
  p_actor        uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_acc       public.billing_accounts;
  v_sub       public.workspace_subscriptions;
  v_plan      public.billing_plans;
  v_quote     jsonb;
  v_cost      bigint;
  v_reprice   bigint;
  v_next      bigint;
  v_entry     public.billing_account_ledger;
  v_key       text;
  v_ai_diff   numeric;
BEGIN
  v_acc := public.billing_account_lock(p_workspace_id);
  PERFORM public.billing_account_release_stale_prepaid(p_workspace_id);
  SELECT * INTO v_acc FROM public.billing_accounts WHERE workspace_id = p_workspace_id FOR UPDATE;
  v_sub := public.billing_account_paid_subscription(p_workspace_id);
  IF v_sub.id IS NULL OR v_sub.current_period_end <= now() THEN
    RAISE EXCEPTION 'billing_no_paid_plan';
  END IF;
  v_key := 'upgrade:' || p_workspace_id::text || ':' || p_plan_id::text || ':'
    || to_char(v_sub.current_period_start AT TIME ZONE 'UTC', 'YYYYMMDD"T"HH24MISS');
  -- Already on that plan: a retried request (or nothing to do).
  IF v_sub.plan_id = p_plan_id THEN
    SELECT * INTO v_entry FROM public.billing_account_ledger WHERE idempotency_key = v_key;
    RETURN jsonb_build_object('action', 'upgraded', 'replayed', true, 'plan_id', p_plan_id, 'ledger_id', v_entry.id,
      'period_end', v_sub.current_period_end, 'balance_minor', v_acc.balance_minor);
  END IF;
  SELECT * INTO v_plan FROM public.billing_plans WHERE id = p_plan_id;
  IF v_plan.id IS NULL OR NOT coalesce(v_plan.is_active, false) OR v_plan.is_hidden OR v_plan.is_free THEN
    RAISE EXCEPTION 'billing_plan_not_available';
  END IF;
  v_quote := public.billing_account_upgrade_cost(p_workspace_id, p_plan_id);
  IF v_quote IS NULL OR NOT (v_quote ->> 'upgrade')::boolean THEN
    RAISE EXCEPTION 'billing_not_an_upgrade';
  END IF;
  v_cost := (v_quote ->> 'cost_minor')::bigint;
  v_reprice := (v_quote ->> 'reprice_minor')::bigint;
  v_next := (v_quote ->> 'next_price_minor')::bigint;

  -- This month's credit of the plan it had is granted first (if the job has
  -- not yet), so the difference below is never added on top of the new
  -- plan's full allowance.
  PERFORM public.billing_account_grant_month(
    p_workspace_id, v_sub.plan_id, v_sub.current_period_start, v_sub.current_period_end
  );

  -- A prepaid next period follows the new plan. What it now costs less
  -- returns first, so the balance it frees can pay the upgrade.
  IF v_reprice IS NOT NULL AND v_reprice < 0 THEN
    PERFORM public.billing_account_credit_back(
      p_workspace_id, -v_reprice,
      jsonb_build_object('reason', 'upgrade', 'plan_id', p_plan_id), p_actor,
      'prepaid_return:' || v_key || ':' || gen_random_uuid()::text
    );
  END IF;
  IF v_cost > 0 THEN
    PERFORM public.billing_account_debit(
      p_workspace_id, 'upgrade', v_cost, p_plan_id, v_sub.billing_interval,
      now(), v_sub.current_period_end,
      jsonb_build_object('plan_slug', v_plan.slug, 'from_plan_id', v_sub.plan_id, 'months_left', v_quote -> 'months_left'),
      p_actor, v_key
    );
  END IF;
  IF v_reprice IS NOT NULL AND v_reprice > 0 THEN
    PERFORM public.billing_account_debit(
      p_workspace_id, 'renewal', v_reprice, p_plan_id, coalesce(v_acc.scheduled_interval, v_sub.billing_interval),
      v_sub.current_period_end,
      public.billing_period_end(v_sub.current_period_end, coalesce(v_acc.scheduled_interval, v_sub.billing_interval, 'monthly')),
      jsonb_build_object('reason', 'upgrade', 'plan_slug', v_plan.slug), p_actor,
      'renewal_reprice:' || v_key || ':' || gen_random_uuid()::text
    );
  END IF;
  UPDATE public.billing_accounts
     SET scheduled_plan_id = NULL,
         next_period_prepaid_minor = CASE WHEN next_period_prepaid_minor IS NULL OR v_next IS NULL THEN NULL ELSE v_next END,
         next_period_start = CASE WHEN next_period_prepaid_minor IS NULL OR v_next IS NULL THEN NULL ELSE next_period_start END,
         updated_at = now()
   WHERE workspace_id = p_workspace_id;
  PERFORM public.billing_account_write_subscription(
    p_workspace_id, p_plan_id, v_sub.billing_interval, v_sub.current_period_start, v_sub.current_period_end,
    'active', 'upgrade', p_actor, jsonb_build_object('cost_minor', v_cost, 'reprice_minor', v_reprice)
  );
  v_ai_diff := public.billing_plan_ai_allowance(p_plan_id, p_workspace_id)
             - public.billing_plan_ai_allowance(v_sub.plan_id, p_workspace_id);
  IF v_ai_diff > 0 THEN
    PERFORM public.billing_account_grant_month(
      p_workspace_id, p_plan_id, v_sub.current_period_start, v_sub.current_period_end,
      'upgrade:' || p_plan_id::text, v_ai_diff
    );
  END IF;
  SELECT * INTO v_acc FROM public.billing_accounts WHERE workspace_id = p_workspace_id;
  RETURN jsonb_build_object(
    'action', 'upgraded', 'replayed', false, 'plan_id', p_plan_id, 'previous_plan_id', v_sub.plan_id,
    'amount_minor', v_cost, 'months_left', v_quote -> 'months_left', 'reprice_minor', v_reprice,
    'period_end', v_sub.current_period_end, 'balance_minor', v_acc.balance_minor,
    'next_period_prepaid_minor', v_acc.next_period_prepaid_minor
  );
END;
$$;

-- ─── 10. A change at the end of the period ────────────────────────────────
-- Downgrade (also to the free plan), monthly ↔ yearly, or a higher plan from
-- the next period. Choosing the current plan and interval cancels a change.
-- A prepaid next period is re-priced: the difference returns to the
-- balance, or the missing part is taken from it.
CREATE OR REPLACE FUNCTION public.billing_account_schedule_change(
  p_workspace_id uuid,
  p_plan_id      uuid,
  p_interval     text,
  p_actor        uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_acc       public.billing_accounts;
  v_sub       public.workspace_subscriptions;
  v_plan      public.billing_plans;
  v_interval  text;
  v_current   text;
  v_cancel    boolean;
  v_new_price bigint;
  v_prepaid   bigint;
  v_start     timestamptz;
  v_tag       text;
BEGIN
  v_acc := public.billing_account_lock(p_workspace_id);
  PERFORM public.billing_account_release_stale_prepaid(p_workspace_id);
  SELECT * INTO v_acc FROM public.billing_accounts WHERE workspace_id = p_workspace_id FOR UPDATE;
  v_sub := public.billing_account_paid_subscription(p_workspace_id);
  IF v_sub.id IS NULL OR v_sub.current_period_end <= now() THEN
    RAISE EXCEPTION 'billing_no_paid_plan';
  END IF;
  v_current := coalesce(v_sub.billing_interval, 'monthly');
  SELECT * INTO v_plan FROM public.billing_plans WHERE id = p_plan_id;
  v_cancel := p_plan_id = v_sub.plan_id AND coalesce(p_interval, v_current) = v_current;
  IF NOT v_cancel AND (v_plan.id IS NULL OR NOT coalesce(v_plan.is_active, false)
     OR (v_plan.is_hidden AND p_plan_id <> v_sub.plan_id)) THEN
    RAISE EXCEPTION 'billing_plan_not_available';
  END IF;
  v_interval := CASE WHEN v_cancel OR coalesce(v_plan.is_free, false) THEN v_current
                     ELSE coalesce(p_interval, v_current) END;
  IF v_interval NOT IN ('monthly', 'yearly') THEN
    RAISE EXCEPTION 'billing_interval_invalid';
  END IF;
  v_new_price := public.billing_plan_price(p_plan_id, v_acc.currency, v_interval);
  -- Cancelling always works; a new change needs a price for the next period.
  IF v_new_price IS NULL AND NOT v_cancel THEN
    RAISE EXCEPTION 'billing_plan_price_unavailable';
  END IF;

  -- A prepaid next period is re-priced to what it will be. What it costs
  -- less returns to the balance; the missing part is taken from it. A next
  -- period that can no longer be priced (the plan is not sold any more)
  -- returns whole.
  v_tag := gen_random_uuid()::text;
  v_prepaid := v_acc.next_period_prepaid_minor;
  v_start := v_acc.next_period_start;
  IF v_prepaid IS NOT NULL THEN
    IF v_new_price IS NULL OR v_new_price < v_prepaid THEN
      PERFORM public.billing_account_credit_back(
        p_workspace_id, v_prepaid - coalesce(v_new_price, 0),
        jsonb_build_object('reason', 'change', 'plan_id', p_plan_id, 'billing_interval', v_interval), p_actor,
        'prepaid_return:' || p_workspace_id::text || ':change:' || v_tag
      );
    ELSIF v_new_price > v_prepaid THEN
      PERFORM public.billing_account_debit(
        p_workspace_id, 'renewal', v_new_price - v_prepaid, p_plan_id, v_interval,
        v_sub.current_period_end, public.billing_period_end(v_sub.current_period_end, v_interval),
        jsonb_build_object('reason', 'change', 'plan_slug', v_plan.slug), p_actor,
        'renewal_change:' || p_workspace_id::text || ':' || v_tag
      );
    END IF;
    IF coalesce(v_new_price, 0) > 0 THEN
      v_prepaid := v_new_price;
    ELSE
      v_prepaid := NULL;
      v_start := NULL;
    END IF;
  END IF;

  UPDATE public.billing_accounts
     SET scheduled_plan_id = CASE WHEN p_plan_id = v_sub.plan_id THEN NULL ELSE p_plan_id END,
         scheduled_interval = CASE WHEN v_interval = v_current THEN NULL ELSE v_interval END,
         next_period_prepaid_minor = v_prepaid,
         next_period_start = v_start,
         updated_at = now()
   WHERE workspace_id = p_workspace_id
   RETURNING * INTO v_acc;

  INSERT INTO public.plan_change_log (workspace_id, old_plan_id, new_plan_id, change_type, changed_by, metadata)
  VALUES (p_workspace_id, v_sub.plan_id, p_plan_id,
          CASE WHEN v_acc.scheduled_plan_id IS NULL AND v_acc.scheduled_interval IS NULL THEN 'change_cancelled' ELSE 'change_scheduled' END,
          p_actor,
          jsonb_build_object('source', 'simple_billing', 'billing_interval', v_interval, 'effective_at', v_sub.current_period_end));

  RETURN jsonb_build_object(
    'action', CASE WHEN v_acc.scheduled_plan_id IS NULL AND v_acc.scheduled_interval IS NULL THEN 'change_cancelled' ELSE 'change_scheduled' END,
    'plan_id', p_plan_id, 'previous_plan_id', v_sub.plan_id,
    'billing_interval', v_interval, 'previous_interval', v_current, 'effective_at', v_sub.current_period_end,
    'price_minor', v_new_price, 'next_period_prepaid_minor', v_acc.next_period_prepaid_minor,
    'balance_minor', v_acc.balance_minor, 'auto_renew', v_acc.auto_renew
  );
END;
$$;

-- ─── 11. A gateway payment made for a purpose ─────────────────────────────
-- 259's settlement, now also spending the credit on the payment's purpose
-- (plan, renewal, upgrade) in the same transaction. If the purpose can no
-- longer be done (the plan changed meanwhile), the money stays in the
-- balance and the reason is returned.
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
   WHERE id = v_pay.id;

  IF v_pay.purpose IN ('plan', 'renewal', 'upgrade') THEN
    BEGIN
      v_purpose := CASE v_pay.purpose
        WHEN 'plan' THEN public.billing_account_purchase_plan(
          v_pay.workspace_id, (v_pay.purpose_detail ->> 'plan_id')::uuid,
          coalesce(v_pay.purpose_detail ->> 'billing_interval', 'monthly'),
          'payment:' || v_pay.id::text, v_pay.created_by)
        WHEN 'renewal' THEN public.billing_account_renew(
          v_pay.workspace_id, v_pay.created_by, (v_pay.purpose_detail ->> 'period_end')::timestamptz)
        WHEN 'upgrade' THEN public.billing_account_upgrade(
          v_pay.workspace_id, (v_pay.purpose_detail ->> 'plan_id')::uuid, v_pay.created_by)
      END;
    EXCEPTION WHEN others THEN
      v_purpose := jsonb_build_object('error', SQLERRM);
    END;
    -- A renewal paid after the plan already ran out buys that plan again
    -- (the customer paid for it); the period starts now.
    IF v_pay.purpose = 'renewal' AND v_purpose ? 'error'
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

-- 259's refund, now also for a payment spent on its purpose. A renewal paid
-- online sits as the prepaid next period, outside the balance: a refund the
-- balance cannot cover first returns that prepayment to the balance (the
-- next period is unpaid again), then takes the refund from it. What still
-- cannot be taken back (spent on a period already running) stays
-- `shortfall_minor`, for review.
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
                  'released_prepaid_minor', v_released))
         ),
         updated_at = now()
   WHERE id = v_pay.id;

  RETURN jsonb_build_object(
    'replayed', false,
    'ledger_id', v_entry.id,
    'debited_minor', v_debit,
    'shortfall_minor', v_shortfall,
    'released_prepaid_minor', v_released
  );
END;
$$;

-- ─── 12. The work of the hourly job ───────────────────────────────────────
-- Workspaces whose paid period has ended (processed one by one).
CREATE OR REPLACE FUNCTION public.billing_account_due_workspaces(p_limit integer DEFAULT 500)
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT s.workspace_id
    FROM public.workspace_subscriptions s
    JOIN public.billing_plans p ON p.id = s.plan_id
   WHERE s.status = 'active' AND NOT p.is_free
     AND s.current_period_end IS NOT NULL AND s.current_period_end <= now()
   ORDER BY s.current_period_end
   LIMIT greatest(p_limit, 1)
$$;

-- The month's AI credit for every paid period (and trial) running now.
-- Returns how many workspaces were funded.
CREATE OR REPLACE FUNCTION public.billing_account_grant_due_allowances()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_row         record;
  v_count       integer := 0;
  v_free        uuid;
  v_free_base   numeric;
  v_month_start timestamptz;
  v_month_end   timestamptz;
BEGIN
  -- Paid periods and trials running now: their period's month.
  FOR v_row IN
    SELECT s.workspace_id, s.plan_id, s.status,
           coalesce(s.current_period_start, s.trial_start, s.created_at) AS period_start,
           CASE WHEN s.status = 'trialing' THEN coalesce(s.trial_end, s.current_period_end) ELSE s.current_period_end END AS period_end
      FROM public.workspace_subscriptions s
      JOIN public.billing_plans p ON p.id = s.plan_id
     WHERE (s.status = 'active' AND NOT p.is_free AND s.current_period_end > now())
        OR (s.status = 'trialing' AND coalesce(s.trial_end, s.current_period_end) > now())
  LOOP
    BEGIN
      IF public.billing_account_grant_month(v_row.workspace_id, v_row.plan_id, v_row.period_start, v_row.period_end) > 0 THEN
        v_count := v_count + 1;
      END IF;
    EXCEPTION WHEN others THEN
      RAISE WARNING 'billing_account_grant_due_allowances: % %', v_row.workspace_id, SQLERRM;
    END;
  END LOOP;

  -- Workspaces on Free (no paid period or trial applies) whose Free plan, or
  -- Super Admin override, has a monthly AI credit: the calendar month (UTC),
  -- as the calendar grant this replaces did. A month that grant already
  -- funded ('YYYY-MM') is not funded again.
  SELECT id INTO v_free FROM public.billing_plans WHERE slug = 'free' AND is_active LIMIT 1;
  IF v_free IS NULL THEN
    RETURN v_count;
  END IF;
  v_free_base := public.billing_plan_ai_allowance(v_free, NULL);
  v_month_start := date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  v_month_end := public.billing_add_months(v_month_start, 1);
  FOR v_row IN
    SELECT w.id AS workspace_id
      FROM public.workspaces w
     WHERE (v_free_base > 0 OR (to_regclass('public.workspace_limit_overrides') IS NOT NULL AND EXISTS (
              SELECT 1 FROM public.workspace_limit_overrides o
               WHERE o.workspace_id = w.id AND o.limit_key = 'included_ai_allowance_irr' AND o.limit_value > 0)))
       AND NOT EXISTS (
         SELECT 1 FROM public.workspace_subscriptions s
           JOIN public.billing_plans p ON p.id = s.plan_id
          WHERE s.workspace_id = w.id AND NOT p.is_free
            AND (s.status = 'active'
                 OR (s.status = 'past_due' AND s.free_fallback_at IS NULL)
                 OR (s.status = 'trialing' AND (s.trial_end IS NULL OR s.trial_end > now()))
                 OR (s.status IN ('canceled', 'cancelled') AND s.cancel_at_period_end IS TRUE AND s.current_period_end > now())))
       AND NOT EXISTS (
         SELECT 1 FROM public.workspace_ai_balance_lots l
          WHERE l.workspace_id = w.id AND l.source_type = 'PLAN_ALLOWANCE'
            AND l.billing_cycle_id = to_char(v_month_start AT TIME ZONE 'UTC', 'YYYY-MM'))
  LOOP
    BEGIN
      IF public.billing_account_grant_month(v_row.workspace_id, v_free, v_month_start, v_month_end) > 0 THEN
        v_count := v_count + 1;
      END IF;
    EXCEPTION WHEN others THEN
      RAISE WARNING 'billing_account_grant_due_allowances (free): % %', v_row.workspace_id, SQLERRM;
    END;
  END LOOP;
  RETURN v_count;
END;
$$;

-- Paid periods ending within p_days that are not paid for yet: the renewal
-- reminders. With auto-renew on and enough balance nothing is sent (it
-- renews); a change to Free at the period end is not reminded either.
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
$$;

-- Records that a notice was sent (with the larger ones it supersedes), once:
-- true only for the call that recorded it, so two runs never both send it.
CREATE OR REPLACE FUNCTION public.billing_account_mark_notice(
  p_workspace_id uuid,
  p_key          text,
  p_notices      text[]
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_acc  public.billing_accounts;
  v_sent jsonb;
BEGIN
  v_acc := public.billing_account_lock(p_workspace_id);
  v_sent := coalesce(v_acc.notices_sent -> p_key, '[]'::jsonb);
  IF v_sent ? p_notices[1] THEN
    RETURN false;
  END IF;
  UPDATE public.billing_accounts
     SET notices_sent = jsonb_set(
           coalesce(notices_sent, '{}'::jsonb), ARRAY[p_key],
           (SELECT coalesce(jsonb_agg(DISTINCT x), '[]'::jsonb)
              FROM (SELECT jsonb_array_elements_text(v_sent) AS x UNION SELECT unnest(p_notices)) u)),
         updated_at = now()
   WHERE workspace_id = p_workspace_id;
  RETURN true;
END;
$$;

-- Takes a notice back (its mail could not be sent; the next run retries).
CREATE OR REPLACE FUNCTION public.billing_account_unmark_notice(
  p_workspace_id uuid,
  p_key          text,
  p_notice       text
) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  UPDATE public.billing_accounts
     SET notices_sent = jsonb_set(notices_sent, ARRAY[p_key], coalesce(notices_sent -> p_key, '[]'::jsonb) - p_notice),
         updated_at = now()
   WHERE workspace_id = p_workspace_id AND notices_sent ? p_key
$$;

-- Trials ending within p_days, and trials that have ended.
CREATE OR REPLACE FUNCTION public.billing_account_trial_candidates(p_days integer DEFAULT 3)
RETURNS TABLE (workspace_id uuid, plan_id uuid, trial_end timestamptz, ended boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT s.workspace_id, s.plan_id, s.trial_end, s.trial_end <= now()
    FROM public.workspace_subscriptions s
   WHERE s.status = 'trialing'
     AND s.trial_end IS NOT NULL
     AND s.trial_end <= now() + make_interval(days => greatest(p_days, 1))
$$;

-- Ends a trial that ran out: true only for the call that ended it.
CREATE OR REPLACE FUNCTION public.billing_account_end_trial(p_workspace_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_sub public.workspace_subscriptions;
BEGIN
  SELECT * INTO v_sub FROM public.workspace_subscriptions
   WHERE workspace_id = p_workspace_id
     AND status = 'trialing'
     AND trial_end IS NOT NULL AND trial_end <= now()
   FOR UPDATE;
  IF v_sub.id IS NULL THEN
    RETURN false;
  END IF;
  PERFORM public.billing_account_write_subscription(
    p_workspace_id, v_sub.plan_id, v_sub.billing_interval, v_sub.current_period_start, v_sub.current_period_end,
    'expired', 'trial_ended', NULL, jsonb_build_object('trial_end', v_sub.trial_end)
  );
  RETURN true;
END;
$$;

-- ─── 13. The billing emails, per edition (Super Admin → Branding → Email templates) ─
-- Seeded for both editions in fa/en/tr; a row that exists (edited) is never
-- overwritten. The server fills the amounts and dates for the edition
-- (Toman and the Persian calendar in Iran) and the links.
CREATE OR REPLACE FUNCTION pg_temp._email_261_layout(p_locale text, p_title text, p_body text)
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

CREATE OR REPLACE FUNCTION pg_temp._email_261_seed(
  p_slug text, p_locale text, p_subject text, p_title text, p_body text, p_text text
) RETURNS void
LANGUAGE plpgsql
AS $f$
DECLARE
  v_edition text;
BEGIN
  FOREACH v_edition IN ARRAY ARRAY['iran', 'international'] LOOP
    INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active, edition)
    SELECT NULL, p_slug, p_locale, p_subject, pg_temp._email_261_layout(p_locale, p_title, p_body), p_text, true, v_edition
     WHERE NOT EXISTS (
       SELECT 1 FROM public.email_templates
        WHERE workspace_id IS NULL AND edition = v_edition AND slug = p_slug AND locale = p_locale
     );
  END LOOP;
END;
$f$;

SELECT pg_temp._email_261_seed('billing_renewal_reminder', 'fa',
  'تمدید پلن {plan_name}: {days_left} روز مانده — {brand}', 'یادآوری تمدید',
  '<p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">پلن {plan_name} فضای کاری شما در تاریخ {period_end} به پایان می‌رسد ({days_left} روز دیگر).</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">مبلغ تمدید ({new_plan_name}): <strong>{amount}</strong><br>موجودی حساب: {balance}</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">اگر تا آن زمان تمدید نشود، فضای کاری به پلن رایگان منتقل می‌شود.</p><p style="margin:24px 0 0;text-align:center;"><a href="{billing_url}" style="display:inline-block;background:#1E40AF;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;">تمدید پلن</a></p>',
  'پلن {plan_name} در تاریخ {period_end} به پایان می‌رسد. مبلغ تمدید ({new_plan_name}): {amount}. موجودی: {balance}. تمدید: {billing_url}');
SELECT pg_temp._email_261_seed('billing_renewal_reminder', 'en',
  'Your {plan_name} plan ends on {period_end} — {brand}', 'Renewal reminder',
  '<p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Your workspace''s {plan_name} plan ends on {period_end}.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Renewal ({new_plan_name}): <strong>{amount}</strong><br>Your balance: {balance}</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">If it is not renewed by then, the workspace moves to the Free plan.</p><p style="margin:24px 0 0;text-align:center;"><a href="{billing_url}" style="display:inline-block;background:#1E40AF;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;">Renew</a></p>',
  'Your {plan_name} plan ends on {period_end}. Renewal ({new_plan_name}): {amount}. Balance: {balance}. Renew: {billing_url}');
SELECT pg_temp._email_261_seed('billing_renewal_reminder', 'tr',
  '{plan_name} planınız {days_left} gün içinde sona eriyor — {brand}', 'Yenileme hatırlatması',
  '<p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Çalışma alanınızın {plan_name} planı {period_end} tarihinde sona eriyor ({days_left} gün sonra).</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Yenileme tutarı ({new_plan_name}): <strong>{amount}</strong><br>Bakiyeniz: {balance}</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">O zamana kadar yenilenmezse çalışma alanı Ücretsiz plana geçer.</p><p style="margin:24px 0 0;text-align:center;"><a href="{billing_url}" style="display:inline-block;background:#1E40AF;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;">Yenile</a></p>',
  '{plan_name} planınız {period_end} tarihinde sona eriyor. Yenileme ({new_plan_name}): {amount}. Bakiye: {balance}. Yenile: {billing_url}');

SELECT pg_temp._email_261_seed('billing_renewed', 'fa',
  'پلن {plan_name} تمدید شد — {brand}', 'تمدید انجام شد',
  '<p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">پلن {plan_name} فضای کاری شما تا {period_end} تمدید شد.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">مبلغ: {amount}<br>موجودی حساب: {balance}</p><p style="margin:24px 0 0;text-align:center;"><a href="{billing_url}" style="display:inline-block;background:#1E40AF;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;">صورت‌حساب</a></p>',
  'پلن {plan_name} تا {period_end} تمدید شد. مبلغ: {amount}. موجودی: {balance}.');
SELECT pg_temp._email_261_seed('billing_renewed', 'en',
  'Your {plan_name} plan was renewed — {brand}', 'Plan renewed',
  '<p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Your workspace''s {plan_name} plan is renewed until {period_end}.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Amount: {amount}<br>Your balance: {balance}</p><p style="margin:24px 0 0;text-align:center;"><a href="{billing_url}" style="display:inline-block;background:#1E40AF;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;">Billing</a></p>',
  'Your {plan_name} plan is renewed until {period_end}. Amount: {amount}. Balance: {balance}.');
SELECT pg_temp._email_261_seed('billing_renewed', 'tr',
  '{plan_name} planınız yenilendi — {brand}', 'Plan yenilendi',
  '<p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Çalışma alanınızın {plan_name} planı {period_end} tarihine kadar yenilendi.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Tutar: {amount}<br>Bakiyeniz: {balance}</p><p style="margin:24px 0 0;text-align:center;"><a href="{billing_url}" style="display:inline-block;background:#1E40AF;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;">Faturalandırma</a></p>',
  '{plan_name} planınız {period_end} tarihine kadar yenilendi. Tutar: {amount}. Bakiye: {balance}.');

SELECT pg_temp._email_261_seed('billing_expired', 'fa',
  'پلن {plan_name} به پایان رسید — {brand}', 'پلن به پایان رسید',
  '<p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">پلن {plan_name} فضای کاری شما در تاریخ {expired_at} به پایان رسید و فضای کاری به پلن رایگان منتقل شد.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">داده‌های شما حفظ می‌شوند؛ با خرید دوباره‌ی پلن، همه‌ی امکانات در دسترس قرار می‌گیرد.</p><p style="margin:24px 0 0;text-align:center;"><a href="{billing_url}" style="display:inline-block;background:#1E40AF;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;">خرید پلن</a></p>',
  'پلن {plan_name} در تاریخ {expired_at} به پایان رسید و فضای کاری به پلن رایگان منتقل شد. خرید پلن: {billing_url}');
SELECT pg_temp._email_261_seed('billing_expired', 'en',
  'Your {plan_name} plan has ended — {brand}', 'Your plan has ended',
  '<p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Your workspace''s {plan_name} plan ended on {expired_at} and the workspace moved to the Free plan.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Your data is kept: buy a plan again to use every feature.</p><p style="margin:24px 0 0;text-align:center;"><a href="{billing_url}" style="display:inline-block;background:#1E40AF;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;">Buy a plan</a></p>',
  'Your {plan_name} plan ended on {expired_at} and the workspace moved to the Free plan. Buy a plan: {billing_url}');
SELECT pg_temp._email_261_seed('billing_expired', 'tr',
  '{plan_name} planınız sona erdi — {brand}', 'Planınız sona erdi',
  '<p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Çalışma alanınızın {plan_name} planı {expired_at} tarihinde sona erdi ve çalışma alanı Ücretsiz plana geçti.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Verileriniz saklanıyor: tüm özellikleri kullanmak için yeniden plan satın alın.</p><p style="margin:24px 0 0;text-align:center;"><a href="{billing_url}" style="display:inline-block;background:#1E40AF;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;">Plan satın al</a></p>',
  '{plan_name} planınız {expired_at} tarihinde sona erdi ve çalışma alanı Ücretsiz plana geçti. Plan satın al: {billing_url}');

SELECT pg_temp._email_261_seed('billing_plan_changed', 'fa',
  'پلن شما به {plan_name} تغییر کرد — {brand}', 'تغییر پلن انجام شد',
  '<p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">تغییر برنامه‌ریزی‌شده انجام شد: پلن فضای کاری از {old_plan_name} به {plan_name} تغییر کرد.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">دوره‌ی جدید تا {period_end} است. مبلغ: {amount}</p><p style="margin:24px 0 0;text-align:center;"><a href="{billing_url}" style="display:inline-block;background:#1E40AF;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;">صورت‌حساب</a></p>',
  'پلن فضای کاری از {old_plan_name} به {plan_name} تغییر کرد. دوره‌ی جدید تا {period_end}.');
SELECT pg_temp._email_261_seed('billing_plan_changed', 'en',
  'Your plan changed to {plan_name} — {brand}', 'Plan changed',
  '<p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">The scheduled change is done: the workspace moved from {old_plan_name} to {plan_name}.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">The new period runs until {period_end}. Amount: {amount}</p><p style="margin:24px 0 0;text-align:center;"><a href="{billing_url}" style="display:inline-block;background:#1E40AF;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;">Billing</a></p>',
  'The workspace moved from {old_plan_name} to {plan_name}. The new period runs until {period_end}.');
SELECT pg_temp._email_261_seed('billing_plan_changed', 'tr',
  'Planınız {plan_name} olarak değişti — {brand}', 'Plan değişti',
  '<p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Planlanan değişiklik yapıldı: çalışma alanı {old_plan_name} planından {plan_name} planına geçti.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Yeni dönem {period_end} tarihine kadar. Tutar: {amount}</p><p style="margin:24px 0 0;text-align:center;"><a href="{billing_url}" style="display:inline-block;background:#1E40AF;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;">Faturalandırma</a></p>',
  'Çalışma alanı {old_plan_name} planından {plan_name} planına geçti. Yeni dönem {period_end} tarihine kadar.');

SELECT pg_temp._email_261_seed('billing_change_scheduled', 'fa',
  'تغییر پلن ثبت شد — {brand}', 'تغییر پلن ثبت شد',
  '<p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">از {effective_at} پلن فضای کاری از {plan_name} به {new_plan_name} تغییر می‌کند.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">این تغییر با تمدید دوره اعمال می‌شود (از موجودی، پرداخت آنلاین یا تمدید خودکار)؛ اگر دوره تمدید نشود، فضای کاری به پلن رایگان منتقل می‌شود. تا آن زمان می‌توانید تغییر را لغو کنید.</p><p style="margin:24px 0 0;text-align:center;"><a href="{billing_url}" style="display:inline-block;background:#1E40AF;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;">صورت‌حساب</a></p>',
  'از {effective_at} پلن فضای کاری از {plan_name} به {new_plan_name} تغییر می‌کند. تا آن زمان می‌توانید آن را لغو کنید.');
SELECT pg_temp._email_261_seed('billing_change_scheduled', 'en',
  'Plan change scheduled — {brand}', 'Plan change scheduled',
  '<p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">From {effective_at} the workspace moves from {plan_name} to {new_plan_name}.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">It takes effect when the period is renewed (from your balance, online, or by auto-renew); if it is not renewed, the workspace moves to the Free plan. You can cancel this change until then.</p><p style="margin:24px 0 0;text-align:center;"><a href="{billing_url}" style="display:inline-block;background:#1E40AF;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;">Billing</a></p>',
  'From {effective_at} the workspace moves from {plan_name} to {new_plan_name}. You can cancel this change until then.');
SELECT pg_temp._email_261_seed('billing_change_scheduled', 'tr',
  'Plan değişikliği planlandı — {brand}', 'Plan değişikliği planlandı',
  '<p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">{effective_at} tarihinden itibaren çalışma alanı {plan_name} planından {new_plan_name} planına geçecek.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Değişiklik dönem yenilendiğinde (bakiyeden, çevrimiçi ödemeyle veya otomatik yenilemeyle) uygulanır; yenilenmezse çalışma alanı Ücretsiz plana geçer. O zamana kadar bu değişikliği iptal edebilirsiniz.</p><p style="margin:24px 0 0;text-align:center;"><a href="{billing_url}" style="display:inline-block;background:#1E40AF;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;">Faturalandırma</a></p>',
  '{effective_at} tarihinden itibaren çalışma alanı {plan_name} planından {new_plan_name} planına geçecek.');

SELECT pg_temp._email_261_seed('billing_payment_receipt', 'fa',
  'رسید پرداخت {receipt_number} — {brand}', 'پرداخت شما دریافت شد',
  '<p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">شماره‌ی رسید: {receipt_number}<br>مبلغ: <strong>{amount}</strong><br>موجودی حساب: {balance}</p><p style="margin:24px 0 0;text-align:center;"><a href="{receipt_url}" style="display:inline-block;background:#1E40AF;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;">مشاهده‌ی رسید</a></p>',
  'پرداخت شما دریافت شد. رسید: {receipt_number}. مبلغ: {amount}. موجودی: {balance}. {receipt_url}');
SELECT pg_temp._email_261_seed('billing_payment_receipt', 'en',
  'Payment receipt {receipt_number} — {brand}', 'We received your payment',
  '<p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Receipt: {receipt_number}<br>Amount: <strong>{amount}</strong><br>Your balance: {balance}</p><p style="margin:24px 0 0;text-align:center;"><a href="{receipt_url}" style="display:inline-block;background:#1E40AF;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;">View receipt</a></p>',
  'We received your payment. Receipt: {receipt_number}. Amount: {amount}. Balance: {balance}. {receipt_url}');
SELECT pg_temp._email_261_seed('billing_payment_receipt', 'tr',
  'Ödeme makbuzu {receipt_number} — {brand}', 'Ödemeniz alındı',
  '<p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Makbuz: {receipt_number}<br>Tutar: <strong>{amount}</strong><br>Bakiyeniz: {balance}</p><p style="margin:24px 0 0;text-align:center;"><a href="{receipt_url}" style="display:inline-block;background:#1E40AF;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;">Makbuzu görüntüle</a></p>',
  'Ödemeniz alındı. Makbuz: {receipt_number}. Tutar: {amount}. Bakiye: {balance}. {receipt_url}');

SELECT pg_temp._email_261_seed('billing_plan_activated', 'fa',
  'پلن {plan_name} فعال شد — {brand}', 'پلن فعال شد',
  '<p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">پلن {plan_name} برای فضای کاری شما فعال شد و تا {period_end} معتبر است.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">مبلغ: {amount}<br>موجودی حساب: {balance}</p><p style="margin:24px 0 0;text-align:center;"><a href="{billing_url}" style="display:inline-block;background:#1E40AF;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;">صورت‌حساب</a></p>',
  'پلن {plan_name} فعال شد و تا {period_end} معتبر است.');
SELECT pg_temp._email_261_seed('billing_plan_activated', 'en',
  'Your {plan_name} plan is active — {brand}', 'Plan activated',
  '<p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">The {plan_name} plan is now active for your workspace, until {period_end}.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Amount: {amount}<br>Your balance: {balance}</p><p style="margin:24px 0 0;text-align:center;"><a href="{billing_url}" style="display:inline-block;background:#1E40AF;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;">Billing</a></p>',
  'The {plan_name} plan is now active for your workspace, until {period_end}.');
SELECT pg_temp._email_261_seed('billing_plan_activated', 'tr',
  '{plan_name} planınız etkin — {brand}', 'Plan etkinleştirildi',
  '<p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">{plan_name} planı çalışma alanınız için {period_end} tarihine kadar etkin.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Tutar: {amount}<br>Bakiyeniz: {balance}</p><p style="margin:24px 0 0;text-align:center;"><a href="{billing_url}" style="display:inline-block;background:#1E40AF;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;">Faturalandırma</a></p>',
  '{plan_name} planı çalışma alanınız için {period_end} tarihine kadar etkin.');

SELECT pg_temp._email_261_seed('billing_trial_ending', 'fa',
  'دوره‌ی آزمایشی {days_left} روز دیگر تمام می‌شود — {brand}', 'دوره‌ی آزمایشی رو به پایان است',
  '<p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">دوره‌ی آزمایشی فضای کاری شما در تاریخ {trial_end} به پایان می‌رسد.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">برای ادامه‌ی استفاده از همه‌ی امکانات، یک پلن انتخاب کنید.</p><p style="margin:24px 0 0;text-align:center;"><a href="{billing_url}" style="display:inline-block;background:#1E40AF;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;">انتخاب پلن</a></p>',
  'دوره‌ی آزمایشی در تاریخ {trial_end} به پایان می‌رسد. انتخاب پلن: {billing_url}');
SELECT pg_temp._email_261_seed('billing_trial_ending', 'en',
  'Your trial ends on {trial_end} — {brand}', 'Your trial is ending',
  '<p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Your workspace trial ends on {trial_end}.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Choose a plan to keep every feature.</p><p style="margin:24px 0 0;text-align:center;"><a href="{billing_url}" style="display:inline-block;background:#1E40AF;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;">Choose a plan</a></p>',
  'Your trial ends on {trial_end}. Choose a plan: {billing_url}');
SELECT pg_temp._email_261_seed('billing_trial_ending', 'tr',
  'Deneme süreniz {days_left} gün içinde bitiyor — {brand}', 'Deneme süreniz bitiyor',
  '<p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Çalışma alanınızın deneme süresi {trial_end} tarihinde bitiyor.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Tüm özellikleri kullanmaya devam etmek için bir plan seçin.</p><p style="margin:24px 0 0;text-align:center;"><a href="{billing_url}" style="display:inline-block;background:#1E40AF;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;">Plan seç</a></p>',
  'Deneme süreniz {trial_end} tarihinde bitiyor. Plan seç: {billing_url}');

SELECT pg_temp._email_261_seed('billing_trial_ended', 'fa',
  'دوره‌ی آزمایشی به پایان رسید — {brand}', 'دوره‌ی آزمایشی به پایان رسید',
  '<p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">دوره‌ی آزمایشی فضای کاری شما به پایان رسید و پلن رایگان فعال است.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">برای استفاده از همه‌ی امکانات، یک پلن بخرید.</p><p style="margin:24px 0 0;text-align:center;"><a href="{billing_url}" style="display:inline-block;background:#1E40AF;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;">خرید پلن</a></p>',
  'دوره‌ی آزمایشی به پایان رسید و پلن رایگان فعال است. خرید پلن: {billing_url}');
SELECT pg_temp._email_261_seed('billing_trial_ended', 'en',
  'Your trial has ended — {brand}', 'Your trial has ended',
  '<p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Your workspace trial has ended and the Free plan is now active.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Buy a plan to use every feature.</p><p style="margin:24px 0 0;text-align:center;"><a href="{billing_url}" style="display:inline-block;background:#1E40AF;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;">Buy a plan</a></p>',
  'Your trial has ended and the Free plan is now active. Buy a plan: {billing_url}');
SELECT pg_temp._email_261_seed('billing_trial_ended', 'tr',
  'Deneme süreniz sona erdi — {brand}', 'Deneme süreniz sona erdi',
  '<p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Çalışma alanınızın deneme süresi sona erdi ve Ücretsiz plan etkin.</p><p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">Tüm özellikleri kullanmak için bir plan satın alın.</p><p style="margin:24px 0 0;text-align:center;"><a href="{billing_url}" style="display:inline-block;background:#1E40AF;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;">Plan satın al</a></p>',
  'Deneme süreniz sona erdi ve Ücretsiz plan etkin. Plan satın al: {billing_url}');

-- ─── 14. Access: the backend (service_role) only ──────────────────────────
DO $acl$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.billing_region_currency()',
    'public.billing_add_months(timestamptz, integer)',
    'public.billing_whole_months(timestamptz, timestamptz)',
    'public.billing_period_end(timestamptz, text)',
    'public.billing_plan_price(uuid, text, text)',
    'public.billing_jsonb_number(jsonb)',
    'public.billing_plan_ai_allowance(uuid, uuid)',
    'public.billing_account_grant_month(uuid, uuid, timestamptz, timestamptz, text, numeric, timestamptz)',
    'public.billing_account_write_subscription(uuid, uuid, text, timestamptz, timestamptz, text, text, uuid, jsonb)',
    'public.billing_account_lock(uuid)',
    'public.billing_account_debit(uuid, text, bigint, uuid, text, timestamptz, timestamptz, jsonb, uuid, text)',
    'public.billing_account_credit_back(uuid, bigint, jsonb, uuid, text)',
    'public.billing_account_paid_subscription(uuid)',
    'public.billing_account_upgrade_cost(uuid, uuid, timestamptz)',
    'public.billing_account_purchase_plan(uuid, uuid, text, text, uuid)',
    'public.billing_account_renew(uuid, uuid, timestamptz, bigint)',
    'public.billing_account_release_stale_prepaid(uuid)',
    'public.billing_account_v2_next_period(uuid)',
    'public.billing_account_admin_replaced(uuid)',
    'public.billing_account_refund_payment(uuid, text, bigint)',
    'public.billing_account_process_due(uuid)',
    'public.billing_account_upgrade(uuid, uuid, uuid)',
    'public.billing_account_schedule_change(uuid, uuid, text, uuid)',
    'public.billing_account_settle_payment(uuid)',
    'public.billing_account_due_workspaces(integer)',
    'public.billing_account_grant_due_allowances()',
    'public.billing_account_reminder_candidates(integer)',
    'public.billing_account_mark_notice(uuid, text, text[])',
    'public.billing_account_unmark_notice(uuid, text, text)',
    'public.billing_account_trial_candidates(integer)',
    'public.billing_account_end_trial(uuid)'
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
