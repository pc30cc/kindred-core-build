-- ============================================================
-- 114 — BILLING ENGINE V2, WALLET (Phase A)
-- ============================================================

-- ─── 1. Wallet account (cache) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.billing_wallet_accounts (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id           UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  currency               TEXT NOT NULL DEFAULT 'IRR',
  available_balance_irr  BIGINT NOT NULL DEFAULT 0,
  frozen                 BOOLEAN NOT NULL DEFAULT false,
  auto_pay_enabled       BOOLEAN,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_wallet_accounts_workspace
  ON public.billing_wallet_accounts (workspace_id);

ALTER TABLE public.billing_wallet_accounts DROP CONSTRAINT IF EXISTS billing_wallet_accounts_balance_check;
ALTER TABLE public.billing_wallet_accounts ADD CONSTRAINT billing_wallet_accounts_balance_check
  CHECK (available_balance_irr >= 0);

COMMENT ON COLUMN public.billing_wallet_accounts.available_balance_irr IS
  'DENORMALIZED cache of the append-only ledger. Never compute or write this from application code — only the wallet_* SQL functions may touch it.';
COMMENT ON COLUMN public.billing_wallet_accounts.auto_pay_enabled IS
  'NULL means "inherit the platform default" so a Super Admin policy change reaches workspaces that never expressed a preference.';

-- ─── 2. Wallet ledger (append-only source of truth) ───────────────────────
CREATE TABLE IF NOT EXISTS public.billing_wallet_ledger (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  entry_type            TEXT NOT NULL,
  amount_irr            BIGINT NOT NULL,
  balance_after_irr     BIGINT NOT NULL,
  invoice_id            UUID REFERENCES public.billing_invoices(id) ON DELETE SET NULL,
  payment_id            UUID REFERENCES public.billing_payments(id) ON DELETE SET NULL,
  wallet_deposit_id     UUID,
  command_key           TEXT NOT NULL,
  reason                TEXT,
  actor_id              UUID,
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.billing_wallet_ledger DROP CONSTRAINT IF EXISTS billing_wallet_ledger_type_check;
ALTER TABLE public.billing_wallet_ledger ADD CONSTRAINT billing_wallet_ledger_type_check
  CHECK (entry_type IN (
    'deposit', 'invoice_payment', 'refund', 'credit', 'debit',
    'admin_adjustment', 'chargeback'
  ));

ALTER TABLE public.billing_wallet_ledger DROP CONSTRAINT IF EXISTS billing_wallet_ledger_balance_check;
ALTER TABLE public.billing_wallet_ledger ADD CONSTRAINT billing_wallet_ledger_balance_check
  CHECK (balance_after_irr >= 0 AND amount_irr <> 0);

CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_wallet_ledger_command
  ON public.billing_wallet_ledger (command_key);

CREATE INDEX IF NOT EXISTS ix_billing_wallet_ledger_workspace
  ON public.billing_wallet_ledger (workspace_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.billing_wallet_ledger_block_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'wallet_ledger_append_only'
    USING HINT = 'Correct a wallet entry with a new compensating entry, never by editing history.';
END;
$$;

DROP TRIGGER IF EXISTS trg_billing_wallet_ledger_append_only ON public.billing_wallet_ledger;
CREATE TRIGGER trg_billing_wallet_ledger_append_only
  BEFORE UPDATE OR DELETE ON public.billing_wallet_ledger
  FOR EACH ROW EXECUTE FUNCTION public.billing_wallet_ledger_block_mutation();

-- ─── 3. Wallet deposits (a receipt document, NOT an invoice) ──────────────
CREATE TABLE IF NOT EXISTS public.billing_wallet_deposits (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  document_number   TEXT NOT NULL,
  document_type     TEXT NOT NULL DEFAULT 'wallet_deposit',
  amount_irr        BIGINT NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'IRR',
  status            TEXT NOT NULL DEFAULT 'pending',
  payment_intent_id UUID REFERENCES public.billing_payment_intents(id) ON DELETE SET NULL,
  payment_id        UUID REFERENCES public.billing_payments(id) ON DELETE SET NULL,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at           TIMESTAMPTZ
);

ALTER TABLE public.billing_wallet_deposits DROP CONSTRAINT IF EXISTS billing_wallet_deposits_status_check;
ALTER TABLE public.billing_wallet_deposits ADD CONSTRAINT billing_wallet_deposits_status_check
  CHECK (status IN ('pending', 'paid', 'failed', 'expired', 'canceled'));

ALTER TABLE public.billing_wallet_deposits DROP CONSTRAINT IF EXISTS billing_wallet_deposits_amount_check;
ALTER TABLE public.billing_wallet_deposits ADD CONSTRAINT billing_wallet_deposits_amount_check
  CHECK (amount_irr > 0);

CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_wallet_deposits_document
  ON public.billing_wallet_deposits (document_number);
CREATE INDEX IF NOT EXISTS ix_billing_wallet_deposits_workspace
  ON public.billing_wallet_deposits (workspace_id, created_at DESC);

ALTER TABLE public.billing_payment_intents
  ADD COLUMN IF NOT EXISTS wallet_deposit_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'billing_payment_intents_wallet_deposit_fkey'
  ) THEN
    ALTER TABLE public.billing_payment_intents
      ADD CONSTRAINT billing_payment_intents_wallet_deposit_fkey
      FOREIGN KEY (wallet_deposit_id)
      REFERENCES public.billing_wallet_deposits(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'billing_wallet_ledger_deposit_fkey'
  ) THEN
    ALTER TABLE public.billing_wallet_ledger
      ADD CONSTRAINT billing_wallet_ledger_deposit_fkey
      FOREIGN KEY (wallet_deposit_id)
      REFERENCES public.billing_wallet_deposits(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ─── 4. Payment allocations (money → invoice) ─────────────────────────────
CREATE TABLE IF NOT EXISTS public.billing_payment_allocations (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id             UUID NOT NULL REFERENCES public.billing_invoices(id) ON DELETE CASCADE,
  workspace_id           UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  payment_id             UUID REFERENCES public.billing_payments(id) ON DELETE SET NULL,
  wallet_ledger_entry_id UUID REFERENCES public.billing_wallet_ledger(id) ON DELETE SET NULL,
  amount_irr             BIGINT NOT NULL,
  command_key            TEXT NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.billing_payment_allocations DROP CONSTRAINT IF EXISTS billing_payment_allocations_source_check;
ALTER TABLE public.billing_payment_allocations ADD CONSTRAINT billing_payment_allocations_source_check
  CHECK (payment_id IS NOT NULL OR wallet_ledger_entry_id IS NOT NULL);

ALTER TABLE public.billing_payment_allocations DROP CONSTRAINT IF EXISTS billing_payment_allocations_amount_check;
ALTER TABLE public.billing_payment_allocations ADD CONSTRAINT billing_payment_allocations_amount_check
  CHECK (amount_irr > 0);

CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_payment_allocations_command
  ON public.billing_payment_allocations (command_key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_payment_allocations_payment
  ON public.billing_payment_allocations (invoice_id, payment_id)
  WHERE payment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_billing_payment_allocations_invoice
  ON public.billing_payment_allocations (invoice_id, created_at);

CREATE OR REPLACE FUNCTION public.billing_allocation_block_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'payment_allocation_append_only';
END;
$$;

DROP TRIGGER IF EXISTS trg_billing_payment_allocations_append_only ON public.billing_payment_allocations;
CREATE TRIGGER trg_billing_payment_allocations_append_only
  BEFORE UPDATE OR DELETE ON public.billing_payment_allocations
  FOR EACH ROW EXECUTE FUNCTION public.billing_allocation_block_mutation();

-- ─── 5. Security: server-only ─────────────────────────────────────────────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'billing_wallet_accounts', 'billing_wallet_ledger',
    'billing_wallet_deposits', 'billing_payment_allocations'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM authenticated', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = t AND policyname = 'service_role_only'
    ) THEN
      EXECUTE format(
        'CREATE POLICY service_role_only ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
        t
      );
    END IF;
  END LOOP;
END $$;