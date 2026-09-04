-- ============================================================
-- 126 — UNIFIED BILLING (single engine, app-wide, multi-currency)
--
-- One billing implementation for the whole app. No versions, no
-- region-specific path, no rollout gating:
--
--   * every workspace runs the invoice-driven engine (auto-enrolled);
--   * money is stored in MINOR UNITS of the document currency (the historic
--     `*_irr` column names are kept to avoid breaking the engine, but they
--     mean "minor units of `currency`");
--   * platform-wide configuration (currencies, gateways, tax, coupons,
--     usage items) lives in the database and is edited from the super-admin
--     finance panel;
--   * all existing financial data is reset — this install has no real
--     customers yet and the previous data mixed two engines.
-- ============================================================

-- ─── 1. Reset all financial data ─────────────────────────────────────────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'billing_invoice_applications','billing_invoice_collections','billing_invoice_lines',
    'billing_payment_allocations','billing_subscription_applications','billing_notification_jobs',
    'billing_retention_signals','billing_period_allowance_grants','billing_entitlement_cycles',
    'billing_wallet_ledger','billing_wallet_deposits','billing_wallet_accounts',
    'billing_payments','billing_payment_intents','billing_invoices',
    'billing_subscription_periods','billing_events','plan_change_log',
    'billing_v2_jobs','billing_v2_audit','entitlement_fanout_jobs',
    'workspace_ai_balance_lots','workspace_ai_balance_alerts','ai_usage_events',
    'ai_run_settlements','ai_run_steps','ai_runs','ai_billing_adjustments',
    'ai_billing_audit_log','ai_billing_commands','ai_usage_event_conflicts'
  ] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('TRUNCATE TABLE public.%I CASCADE', t);
    END IF;
  END LOOP;
END $$;

-- ─── 2. Single engine: every workspace is enrolled, always ───────────────
INSERT INTO public.billing_v2_rollout (workspace_id, state)
SELECT w.id, 'v2_active' FROM public.workspaces w
ON CONFLICT (workspace_id) DO UPDATE SET state = 'v2_active';

CREATE OR REPLACE FUNCTION public.billing_enroll_workspace()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.billing_v2_rollout (workspace_id, state)
  VALUES (NEW.id, 'v2_active')
  ON CONFLICT (workspace_id) DO NOTHING;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_billing_enroll_workspace ON public.workspaces;
CREATE TRIGGER trg_billing_enroll_workspace
AFTER INSERT ON public.workspaces
FOR EACH ROW EXECUTE FUNCTION public.billing_enroll_workspace();

-- ─── 3. Currencies ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.billing_currencies (
  code          TEXT PRIMARY KEY,
  display_name  JSONB NOT NULL DEFAULT '{}'::jsonb,
  symbol        TEXT NOT NULL DEFAULT '',
  minor_units   INTEGER NOT NULL DEFAULT 0,
  is_base       BOOLEAN NOT NULL DEFAULT false,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.billing_currencies TO authenticated, anon;
GRANT ALL ON public.billing_currencies TO service_role;
ALTER TABLE public.billing_currencies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_currencies_read ON public.billing_currencies;
CREATE POLICY billing_currencies_read ON public.billing_currencies
  FOR SELECT USING (is_active);

CREATE UNIQUE INDEX IF NOT EXISTS billing_currencies_one_base
  ON public.billing_currencies ((is_base)) WHERE is_base;

INSERT INTO public.billing_currencies (code, display_name, symbol, minor_units, is_base, sort_order)
VALUES
  ('IRR', '{"fa":"ریال","en":"Iranian Rial","tr":"İran Riyali"}', 'ریال', 0, true, 1),
  ('USD', '{"fa":"دلار","en":"US Dollar","tr":"ABD Doları"}', '$', 2, false, 2),
  ('EUR', '{"fa":"یورو","en":"Euro","tr":"Euro"}', '€', 2, false, 3),
  ('TRY', '{"fa":"لیر","en":"Turkish Lira","tr":"Türk Lirası"}', '₺', 2, false, 4)
ON CONFLICT (code) DO NOTHING;

-- ─── 4. Exchange rates (versioned, for reporting/conversion) ─────────────
CREATE TABLE IF NOT EXISTS public.billing_exchange_rates (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  base_code     TEXT NOT NULL REFERENCES public.billing_currencies(code) ON DELETE CASCADE,
  quote_code    TEXT NOT NULL REFERENCES public.billing_currencies(code) ON DELETE CASCADE,
  rate          NUMERIC(24,8) NOT NULL CHECK (rate > 0),
  effective_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT billing_exchange_rates_distinct CHECK (base_code <> quote_code)
);
CREATE INDEX IF NOT EXISTS billing_exchange_rates_lookup
  ON public.billing_exchange_rates (base_code, quote_code, effective_at DESC);
GRANT SELECT ON public.billing_exchange_rates TO authenticated;
GRANT ALL ON public.billing_exchange_rates TO service_role;
ALTER TABLE public.billing_exchange_rates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_exchange_rates_read ON public.billing_exchange_rates;
CREATE POLICY billing_exchange_rates_read ON public.billing_exchange_rates
  FOR SELECT TO authenticated USING (true);

-- ─── 5. Payment gateways (platform registry) ─────────────────────────────
CREATE TABLE IF NOT EXISTS public.billing_gateways (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_name TEXT NOT NULL UNIQUE,
  display_name  JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active     BOOLEAN NOT NULL DEFAULT false,
  is_test       BOOLEAN NOT NULL DEFAULT false,
  currencies    TEXT[] NOT NULL DEFAULT '{}',
  countries     TEXT[] NOT NULL DEFAULT '{}',
  sort_order    INTEGER NOT NULL DEFAULT 0,
  config        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT ALL ON public.billing_gateways TO service_role;
ALTER TABLE public.billing_gateways ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_gateways_service_only ON public.billing_gateways;
CREATE POLICY billing_gateways_service_only ON public.billing_gateways
  FOR ALL TO service_role USING (true) WITH CHECK (true);

INSERT INTO public.billing_gateways (provider_name, display_name, currencies, is_test, sort_order)
VALUES
  ('manual',       '{"fa":"پرداخت دستی / کارت به کارت","en":"Manual / bank transfer","tr":"Manuel ödeme"}', '{IRR,USD,EUR,TRY}', false, 0),
  ('zarinpal',     '{"fa":"زرین‌پال","en":"ZarinPal","tr":"ZarinPal"}', '{IRR}', false, 1),
  ('zarinpal_test','{"fa":"زرین‌پال (تست)","en":"ZarinPal (test)","tr":"ZarinPal (test)"}', '{IRR}', true, 2),
  ('zibal',        '{"fa":"زیبال","en":"Zibal","tr":"Zibal"}', '{IRR}', false, 3),
  ('idpay',        '{"fa":"آیدی‌پی","en":"IDPay","tr":"IDPay"}', '{IRR}', false, 4),
  ('payping',      '{"fa":"پی‌پینگ","en":"PayPing","tr":"PayPing"}', '{IRR}', false, 5),
  ('nextpay',      '{"fa":"نکست‌پی","en":"NextPay","tr":"NextPay"}', '{IRR}', false, 6),
  ('sep_shaparak', '{"fa":"سامان (سپ)","en":"SEP Shaparak","tr":"SEP"}', '{IRR}', false, 7),
  ('stripe',       '{"fa":"استرایپ","en":"Stripe","tr":"Stripe"}', '{USD,EUR,TRY}', false, 8),
  ('paddle',       '{"fa":"پدل","en":"Paddle","tr":"Paddle"}', '{USD,EUR}', false, 9),
  ('paypal',       '{"fa":"پی‌پال","en":"PayPal","tr":"PayPal"}', '{USD,EUR}', false, 10),
  ('lemon_squeezy','{"fa":"لمون اسکوییزی","en":"Lemon Squeezy","tr":"Lemon Squeezy"}', '{USD,EUR}', false, 11),
  ('iyzico',       '{"fa":"آیزیکو","en":"iyzico","tr":"iyzico"}', '{TRY}', false, 12),
  ('paytr',        '{"fa":"پی‌تی‌آر","en":"PayTR","tr":"PayTR"}', '{TRY}', false, 13),
  ('sipay',        '{"fa":"سای‌پی","en":"Sipay","tr":"Sipay"}', '{TRY}', false, 14),
  ('paratika',     '{"fa":"پاراتیکا","en":"Paratika","tr":"Paratika"}', '{TRY}', false, 15),
  ('craftgate',    '{"fa":"کرفت‌گیت","en":"Craftgate","tr":"Craftgate"}', '{TRY}', false, 16)
ON CONFLICT (provider_name) DO NOTHING;

-- ─── 6. Tax rates ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.billing_tax_rates (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  rate_percent  NUMERIC(6,3) NOT NULL DEFAULT 0 CHECK (rate_percent >= 0 AND rate_percent <= 100),
  country_code  TEXT,
  currency      TEXT REFERENCES public.billing_currencies(code) ON DELETE SET NULL,
  is_inclusive  BOOLEAN NOT NULL DEFAULT false,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT ALL ON public.billing_tax_rates TO service_role;
ALTER TABLE public.billing_tax_rates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_tax_rates_service_only ON public.billing_tax_rates;
CREATE POLICY billing_tax_rates_service_only ON public.billing_tax_rates
  FOR ALL TO service_role USING (true) WITH CHECK (true);

INSERT INTO public.billing_tax_rates (name, rate_percent, country_code, currency)
SELECT 'VAT Iran', 10, 'IR', 'IRR'
WHERE NOT EXISTS (SELECT 1 FROM public.billing_tax_rates);

-- ─── 7. Coupons ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.billing_coupons (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code             TEXT NOT NULL UNIQUE,
  description      TEXT,
  discount_type    TEXT NOT NULL DEFAULT 'percent' CHECK (discount_type IN ('percent','fixed')),
  percent_off      NUMERIC(6,3) CHECK (percent_off IS NULL OR (percent_off > 0 AND percent_off <= 100)),
  amount_off_minor BIGINT CHECK (amount_off_minor IS NULL OR amount_off_minor > 0),
  currency         TEXT REFERENCES public.billing_currencies(code) ON DELETE SET NULL,
  applies_to_plans UUID[] NOT NULL DEFAULT '{}',
  max_redemptions  INTEGER,
  redeemed_count   INTEGER NOT NULL DEFAULT 0,
  once_per_workspace BOOLEAN NOT NULL DEFAULT true,
  starts_at        TIMESTAMPTZ,
  expires_at       TIMESTAMPTZ,
  is_active        BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT billing_coupons_value_shape CHECK (
    (discount_type = 'percent' AND percent_off IS NOT NULL)
    OR (discount_type = 'fixed' AND amount_off_minor IS NOT NULL AND currency IS NOT NULL)
  )
);
GRANT ALL ON public.billing_coupons TO service_role;
ALTER TABLE public.billing_coupons ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_coupons_service_only ON public.billing_coupons;
CREATE POLICY billing_coupons_service_only ON public.billing_coupons
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS public.billing_coupon_redemptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coupon_id     UUID NOT NULL REFERENCES public.billing_coupons(id) ON DELETE CASCADE,
  workspace_id  UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  invoice_id    UUID REFERENCES public.billing_invoices(id) ON DELETE SET NULL,
  amount_minor  BIGINT NOT NULL DEFAULT 0,
  currency      TEXT NOT NULL DEFAULT 'IRR',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS billing_coupon_redemptions_invoice
  ON public.billing_coupon_redemptions (invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS billing_coupon_redemptions_workspace
  ON public.billing_coupon_redemptions (coupon_id, workspace_id);
GRANT ALL ON public.billing_coupon_redemptions TO service_role;
ALTER TABLE public.billing_coupon_redemptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_coupon_redemptions_service_only ON public.billing_coupon_redemptions;
CREATE POLICY billing_coupon_redemptions_service_only ON public.billing_coupon_redemptions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ─── 8. Metered usage items (AI credit, SMS, storage, …) ─────────────────
CREATE TABLE IF NOT EXISTS public.billing_usage_items (
  key           TEXT PRIMARY KEY,
  display_name  JSONB NOT NULL DEFAULT '{}'::jsonb,
  unit          TEXT NOT NULL DEFAULT 'unit',
  prices        JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT ALL ON public.billing_usage_items TO service_role;
ALTER TABLE public.billing_usage_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_usage_items_service_only ON public.billing_usage_items;
CREATE POLICY billing_usage_items_service_only ON public.billing_usage_items
  FOR ALL TO service_role USING (true) WITH CHECK (true);

INSERT INTO public.billing_usage_items (key, display_name, unit, prices, sort_order)
VALUES
  ('ai_credit', '{"fa":"اعتبار هوش مصنوعی","en":"AI credit","tr":"Yapay zeka kredisi"}', 'credit', '{"IRR":1,"USD":0.00002}', 1),
  ('sms',       '{"fa":"پیامک","en":"SMS","tr":"SMS"}', 'message', '{"IRR":2000,"USD":0.05}', 2),
  ('storage',   '{"fa":"فضای ذخیره‌سازی","en":"Storage","tr":"Depolama"}', 'gb_month', '{"IRR":300000,"USD":0.5}', 3)
ON CONFLICT (key) DO NOTHING;

-- ─── 9. Invoice tax / coupon linkage ─────────────────────────────────────
ALTER TABLE public.billing_invoices
  ADD COLUMN IF NOT EXISTS tax_rate_percent NUMERIC(6,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS coupon_id UUID REFERENCES public.billing_coupons(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS coupon_code TEXT;

-- ─── 10. updated_at triggers ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.billing_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'billing_currencies','billing_gateways','billing_tax_rates','billing_coupons','billing_usage_items'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_touch ON public.%1$s', t);
    EXECUTE format(
      'CREATE TRIGGER trg_%1$s_touch BEFORE UPDATE ON public.%1$s
       FOR EACH ROW EXECUTE FUNCTION public.billing_touch_updated_at()', t);
  END LOOP;
END $$;
