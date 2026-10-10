-- 259 — Simple billing: prepaid accounts (docs/billing/SIMPLE_BILLING.md).
--
-- Billing v2 (invoices, dunning, its scheduler) is hidden since #296 and is
-- replaced by a prepaid account per workspace:
--
--   billing_settings          one row per edition: the seller printed on
--                             receipts, VAT per currency, the receipt prefix,
--                             the AI credit packs.
--   billing_accounts          one row per workspace: the balance in one fixed
--                             currency, auto-renew, the scheduled plan change,
--                             the saved card, the buyer's billing profile.
--   billing_account_ledger    append-only; every movement of the balance, with
--                             the receipt for money that came in through a
--                             gateway.
--   billing_account_payments  one row per gateway attempt, created only when
--                             the customer presses pay.
--
-- Which plan a workspace is on stays in workspace_subscriptions; nothing here
-- changes how entitlements are read.
--
-- The balance is service credit in the account's currency (minor units: Rial
-- for IRR, cents for USD, kuruş for TRY). It never goes negative, and only the
-- SQL functions below write it, under a row lock, together with its ledger row.
--
-- Server-only: every table and function is reachable by service_role alone.
-- Re-runnable: every step is guarded or a no-op the second time.

-- ─── 1. Settings per edition ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.billing_settings (
  edition         text PRIMARY KEY,
  -- The seller printed on every receipt: legal_name, economic_code,
  -- national_id, registration_number, vat_id, address, postal_code, phone,
  -- email, website. Keys left out are not printed.
  seller          jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- VAT percent per currency code, e.g. {"IRR": 10}. A currency that is
  -- missing or null has no VAT line at all (Paddle computes tax itself).
  vat_percent     jsonb NOT NULL DEFAULT '{}'::jsonb,
  receipt_prefix  text NOT NULL DEFAULT 'R',
  -- AI credit packs per currency: {"USD": [{"id": "s", "price_minor": 500,
  -- "credit_minor": 500}], ...}. Read by the AI credit phase.
  ai_packs        jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'billing_settings_edition_check'
  ) THEN
    ALTER TABLE public.billing_settings
      ADD CONSTRAINT billing_settings_edition_check CHECK (edition IN ('iran', 'international'));
  END IF;
END $$;

-- ─── 2. Accounts ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.billing_accounts (
  workspace_id               uuid PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE CASCADE,
  currency                   text NOT NULL,
  balance_minor              bigint NOT NULL DEFAULT 0,
  auto_renew                 boolean NOT NULL DEFAULT false,
  -- The change that takes effect at the end of the current period
  -- (downgrade, interval change). Paid at the due date.
  scheduled_plan_id          uuid REFERENCES public.billing_plans(id) ON DELETE SET NULL,
  scheduled_interval         text,
  -- What was already paid for the next period (early renewal); returned to
  -- the balance if the next period changes before it starts.
  next_period_prepaid_minor  bigint,
  -- The saved card (Multi Region: a Paddle subscription that charges it).
  card_provider              text,
  card_customer_id           text,
  card_subscription_id       text,
  -- The buyer printed on receipts: company, economic_code, national_id,
  -- vat_id, address, postal_code, city, country, phone, invoice_email.
  billing_profile            jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Reminders already sent, so a retry or a second run never repeats one:
  -- {"<period end ISO>": ["7", "3", "1"]}.
  notices_sent               jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_accounts_currency_check') THEN
    ALTER TABLE public.billing_accounts
      ADD CONSTRAINT billing_accounts_currency_check CHECK (currency ~ '^[A-Z]{3}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_accounts_balance_check') THEN
    ALTER TABLE public.billing_accounts
      ADD CONSTRAINT billing_accounts_balance_check CHECK (balance_minor >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_accounts_interval_check') THEN
    ALTER TABLE public.billing_accounts
      ADD CONSTRAINT billing_accounts_interval_check
      CHECK (scheduled_interval IS NULL OR scheduled_interval IN ('monthly', 'yearly'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_accounts_prepaid_check') THEN
    ALTER TABLE public.billing_accounts
      ADD CONSTRAINT billing_accounts_prepaid_check
      CHECK (next_period_prepaid_minor IS NULL OR next_period_prepaid_minor >= 0);
  END IF;
END $$;

-- ─── 3. Ledger (append-only) ──────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS public.billing_receipt_seq;

CREATE TABLE IF NOT EXISTS public.billing_account_ledger (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  kind             text NOT NULL,
  -- Signed: money in is positive, money out negative.
  amount_minor     bigint NOT NULL,
  balance_after    bigint NOT NULL,
  currency         text NOT NULL,
  -- What a debit paid for.
  plan_id          uuid REFERENCES public.billing_plans(id) ON DELETE SET NULL,
  billing_interval text,
  period_start     timestamptz,
  period_end       timestamptz,
  -- The receipt, for money that came in through a gateway: the customer paid
  -- net + tax; the balance was credited with net.
  payment_id       uuid,
  receipt_number   text,
  net_minor        bigint,
  tax_minor        bigint,
  tax_percent      numeric(6,3),
  buyer            jsonb,
  seller           jsonb,
  description      jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_id         uuid,
  idempotency_key  text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_account_ledger_key
  ON public.billing_account_ledger (idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_account_ledger_receipt
  ON public.billing_account_ledger (receipt_number) WHERE receipt_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_billing_account_ledger_workspace
  ON public.billing_account_ledger (workspace_id, created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_account_ledger_kind_check') THEN
    ALTER TABLE public.billing_account_ledger
      ADD CONSTRAINT billing_account_ledger_kind_check CHECK (kind IN (
        'topup', 'renewal', 'upgrade', 'plan', 'ai_pack',
        'admin_credit', 'admin_debit', 'refund', 'prepaid_return'
      ));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_account_ledger_amount_check') THEN
    ALTER TABLE public.billing_account_ledger
      ADD CONSTRAINT billing_account_ledger_amount_check
      CHECK (amount_minor <> 0 AND balance_after >= 0);
  END IF;
END $$;

-- Append-only: rows are never changed. They go only with their workspace.
CREATE OR REPLACE FUNCTION public.billing_account_ledger_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  RAISE EXCEPTION 'billing_account_ledger is append-only';
END;
$$;

DROP TRIGGER IF EXISTS trg_billing_account_ledger_immutable ON public.billing_account_ledger;
CREATE TRIGGER trg_billing_account_ledger_immutable
  BEFORE UPDATE ON public.billing_account_ledger
  FOR EACH ROW EXECUTE FUNCTION public.billing_account_ledger_immutable();

-- ─── 4. Gateway attempts ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.billing_account_payments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  provider             text NOT NULL,
  currency             text NOT NULL,
  -- What the gateway charges: net + tax.
  amount_minor         bigint NOT NULL,
  net_minor            bigint NOT NULL,
  tax_minor            bigint NOT NULL DEFAULT 0,
  tax_percent          numeric(6,3),
  -- topup only adds to the balance; the others then spend it on their
  -- purchase in the same transaction (details in purpose_detail).
  purpose              text NOT NULL DEFAULT 'topup',
  purpose_detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  status               text NOT NULL DEFAULT 'pending',
  provider_ref         text,
  provider_payment_id  text,
  failure_reason       text,
  ledger_id            uuid REFERENCES public.billing_account_ledger(id) ON DELETE SET NULL,
  return_url           text,
  created_by           uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  completed_at         timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_account_payments_ref
  ON public.billing_account_payments (provider, provider_ref) WHERE provider_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_billing_account_payments_workspace
  ON public.billing_account_payments (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_billing_account_payments_open
  ON public.billing_account_payments (created_at) WHERE status <> 'succeeded';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_account_payments_status_check') THEN
    ALTER TABLE public.billing_account_payments
      ADD CONSTRAINT billing_account_payments_status_check
      CHECK (status IN ('pending', 'succeeded', 'failed', 'canceled', 'expired'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_account_payments_purpose_check') THEN
    ALTER TABLE public.billing_account_payments
      ADD CONSTRAINT billing_account_payments_purpose_check
      CHECK (purpose IN ('topup', 'renewal', 'upgrade', 'plan', 'ai_pack'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_account_payments_amount_check') THEN
    ALTER TABLE public.billing_account_payments
      ADD CONSTRAINT billing_account_payments_amount_check
      CHECK (net_minor > 0 AND tax_minor >= 0 AND amount_minor = net_minor + tax_minor);
  END IF;
END $$;

-- ─── 5. Plans: locked-data retention and AI allowance per currency ────────
ALTER TABLE public.billing_plans
  ADD COLUMN IF NOT EXISTS locked_data_retention_days integer;
ALTER TABLE public.billing_plans
  ADD COLUMN IF NOT EXISTS ai_allowance jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_plans_locked_retention_check') THEN
    ALTER TABLE public.billing_plans
      ADD CONSTRAINT billing_plans_locked_retention_check
      CHECK (locked_data_retention_days IS NULL OR locked_data_retention_days > 0);
  END IF;
END $$;

COMMENT ON COLUMN public.billing_plans.locked_data_retention_days IS
  'Days locked data (over this plan''s limits) is kept before it is deleted, after notices 30 and 7 days before. NULL = never deleted.';
COMMENT ON COLUMN public.billing_plans.ai_allowance IS
  'AI credit granted each month of a period, per currency in minor units: {"IRR": 300000, "USD": 300}. Yearly plans grant it monthly.';

-- ─── 6. Functions ─────────────────────────────────────────────────────────

-- The account of a workspace, created on first use in the given currency.
-- An existing account keeps its currency whatever is passed.
CREATE OR REPLACE FUNCTION public.billing_account_ensure(
  p_workspace_id uuid,
  p_currency     text
) RETURNS public.billing_accounts
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_acc public.billing_accounts;
BEGIN
  IF p_currency IS NULL OR upper(p_currency) !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'billing_account_bad_currency';
  END IF;
  INSERT INTO public.billing_accounts (workspace_id, currency)
  VALUES (p_workspace_id, upper(p_currency))
  ON CONFLICT (workspace_id) DO NOTHING;
  SELECT * INTO v_acc FROM public.billing_accounts WHERE workspace_id = p_workspace_id;
  RETURN v_acc;
END;
$$;

-- Settles a gateway payment the server has verified with the gateway:
-- credits the net amount to the balance and writes its receipt. Idempotent:
-- a payment settles once; a replay returns the same ledger row.
--
-- p_amount_minor / p_currency are what the GATEWAY confirmed; they must equal
-- what the payment row asked for, or nothing is credited.
CREATE OR REPLACE FUNCTION public.billing_account_settle_payment(
  p_payment_id          uuid,
  p_amount_minor        bigint,
  p_currency            text,
  p_provider_payment_id text DEFAULT NULL
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
  v_receipt  text;
  v_balance  bigint;
BEGIN
  SELECT * INTO v_pay FROM public.billing_account_payments WHERE id = p_payment_id FOR UPDATE;
  IF v_pay.id IS NULL THEN
    RAISE EXCEPTION 'billing_payment_not_found';
  END IF;

  IF v_pay.status = 'succeeded' THEN
    RETURN jsonb_build_object('replayed', true, 'ledger_id', v_pay.ledger_id, 'payment_id', v_pay.id);
  END IF;
  -- A gateway can confirm money for an attempt we already gave up on (the
  -- customer paid at the last second): the money is real, so it is credited.
  IF v_pay.status NOT IN ('pending', 'failed', 'canceled', 'expired') THEN
    RAISE EXCEPTION 'billing_payment_bad_status:%', v_pay.status;
  END IF;
  IF p_amount_minor IS DISTINCT FROM v_pay.amount_minor THEN
    RAISE EXCEPTION 'billing_payment_amount_mismatch';
  END IF;
  IF upper(coalesce(p_currency, '')) <> v_pay.currency THEN
    RAISE EXCEPTION 'billing_payment_currency_mismatch';
  END IF;

  v_acc := public.billing_account_ensure(v_pay.workspace_id, v_pay.currency);
  SELECT * INTO v_acc FROM public.billing_accounts WHERE workspace_id = v_pay.workspace_id FOR UPDATE;
  IF v_acc.currency <> v_pay.currency THEN
    RAISE EXCEPTION 'billing_account_currency_mismatch';
  END IF;

  v_edition := public.platform_edition();
  SELECT * INTO v_settings FROM public.billing_settings WHERE edition = v_edition;
  SELECT name INTO v_ws_name FROM public.workspaces WHERE id = v_pay.workspace_id;

  v_receipt := coalesce(nullif(v_settings.receipt_prefix, ''), 'R')
    || to_char(now() AT TIME ZONE 'UTC', 'YYYY') || '-'
    || lpad(nextval('public.billing_receipt_seq')::text, 6, '0');
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
    jsonb_build_object('purpose', v_pay.purpose, 'provider', v_pay.provider) || coalesce(v_pay.purpose_detail, '{}'::jsonb),
    v_pay.created_by,
    'payment:' || v_pay.id::text
  ) RETURNING * INTO v_entry;

  UPDATE public.billing_accounts
     SET balance_minor = v_balance, updated_at = now()
   WHERE workspace_id = v_pay.workspace_id;

  UPDATE public.billing_account_payments
     SET status = 'succeeded',
         ledger_id = v_entry.id,
         provider_payment_id = coalesce(p_provider_payment_id, provider_payment_id),
         failure_reason = NULL,
         completed_at = now(),
         updated_at = now()
   WHERE id = v_pay.id;

  RETURN jsonb_build_object(
    'replayed', false,
    'ledger_id', v_entry.id,
    'payment_id', v_pay.id,
    'receipt_number', v_receipt,
    'balance_minor', v_balance
  );
END;
$$;

-- Super Admin credit (+) or debit (−) of a balance, with a reason. A debit
-- never takes the balance below zero. Idempotent per command key.
CREATE OR REPLACE FUNCTION public.billing_account_admin_adjust(
  p_workspace_id uuid,
  p_amount_minor bigint,
  p_currency     text,
  p_reason       text,
  p_actor_id     uuid,
  p_command_key  text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_acc     public.billing_accounts;
  v_entry   public.billing_account_ledger;
  v_balance bigint;
BEGIN
  IF p_amount_minor IS NULL OR p_amount_minor = 0 THEN
    RAISE EXCEPTION 'billing_adjust_zero';
  END IF;
  IF coalesce(p_command_key, '') = '' THEN
    RAISE EXCEPTION 'billing_adjust_missing_key';
  END IF;
  SELECT * INTO v_entry FROM public.billing_account_ledger WHERE idempotency_key = 'admin:' || p_command_key;
  IF v_entry.id IS NOT NULL THEN
    RETURN jsonb_build_object('replayed', true, 'ledger_id', v_entry.id, 'balance_minor', v_entry.balance_after);
  END IF;

  PERFORM public.billing_account_ensure(p_workspace_id, p_currency);
  SELECT * INTO v_acc FROM public.billing_accounts WHERE workspace_id = p_workspace_id FOR UPDATE;
  IF v_acc.currency <> upper(p_currency) THEN
    RAISE EXCEPTION 'billing_account_currency_mismatch';
  END IF;
  v_balance := v_acc.balance_minor + p_amount_minor;
  IF v_balance < 0 THEN
    RAISE EXCEPTION 'billing_insufficient_balance';
  END IF;

  INSERT INTO public.billing_account_ledger (
    workspace_id, kind, amount_minor, balance_after, currency,
    description, actor_id, idempotency_key
  ) VALUES (
    p_workspace_id,
    CASE WHEN p_amount_minor > 0 THEN 'admin_credit' ELSE 'admin_debit' END,
    p_amount_minor, v_balance, v_acc.currency,
    jsonb_build_object('reason', coalesce(p_reason, '')),
    p_actor_id,
    'admin:' || p_command_key
  ) RETURNING * INTO v_entry;

  UPDATE public.billing_accounts
     SET balance_minor = v_balance, updated_at = now()
   WHERE workspace_id = p_workspace_id;

  RETURN jsonb_build_object('replayed', false, 'ledger_id', v_entry.id, 'balance_minor', v_balance);
END;
$$;

-- Deletes gateway attempts that never completed and are older than the given
-- number of days (30 by default). Settled payments are kept: their receipt
-- refers to them.
CREATE OR REPLACE FUNCTION public.billing_account_prune_payments(p_days integer DEFAULT 30)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_count integer;
BEGIN
  DELETE FROM public.billing_account_payments
   WHERE status <> 'succeeded'
     AND created_at < now() - make_interval(days => greatest(coalesce(p_days, 30), 1));
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- ─── 7. Security: server-only ─────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'billing_settings', 'billing_accounts', 'billing_account_ledger', 'billing_account_payments'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM authenticated', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = t AND policyname = 'service_role_only'
      ) THEN
        EXECUTE format(
          'CREATE POLICY service_role_only ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
          t
        );
      END IF;
    END IF;
  END LOOP;

  REVOKE ALL ON SEQUENCE public.billing_receipt_seq FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT USAGE, SELECT ON SEQUENCE public.billing_receipt_seq TO service_role;
  END IF;
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.billing_account_ensure(uuid, text)',
    'public.billing_account_settle_payment(uuid, bigint, text, text)',
    'public.billing_account_admin_adjust(uuid, bigint, text, text, uuid, text)',
    'public.billing_account_prune_payments(integer)',
    'public.billing_account_ledger_immutable()'
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
END $$;
