-- Proforma (پیش‌فاکتور) snapshot + document-number uniqueness + financial ACL
-- convergence.
--
-- Migrations 105/106/107 are ALREADY APPLIED to production, so nothing here
-- rewrites them: this migration is additive, idempotent and safe to re-run.
--
-- What it does
--   1. Freezes the proforma on `billing_payment_intents`: what was bought, for
--      which workspace, at which price, for which period. If a super admin
--      changes the plan price tomorrow, a proforma issued today must not move.
--   2. Enforces document-number uniqueness in the DATABASE (the server issues
--      candidates with a CSPRNG and retries on collision — check-before-insert
--      alone is racy).
--   3. Re-enforces, idempotently, the financial SECURITY DEFINER ACL that was
--      applied ad-hoc on production right after 106, so the repository
--      migration chain converges with the live database.

-- ─── 1. Immutable proforma snapshot ───────────────────────────────────────
ALTER TABLE public.billing_payment_intents
  ADD COLUMN IF NOT EXISTS plan_name_snapshot text,
  ADD COLUMN IF NOT EXISTS workspace_name_snapshot text,
  ADD COLUMN IF NOT EXISTS discount_irr bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS final_amount_irr bigint,
  ADD COLUMN IF NOT EXISTS period_start timestamptz,
  ADD COLUMN IF NOT EXISTS period_end timestamptz;

-- Backfill only what is unambiguous for the rows that already exist.
UPDATE public.billing_payment_intents
   SET final_amount_irr = amount_irr
 WHERE final_amount_irr IS NULL;

COMMENT ON COLUMN public.billing_payment_intents.plan_name_snapshot IS
  'Plan name as printed on the proforma. Frozen at issue time so later plan renames/price changes never rewrite history.';
COMMENT ON COLUMN public.billing_payment_intents.discount_irr IS
  'Real discount applied to this proforma, in stored Rial. 0 when there is none — the UI must not invent a discount line.';
COMMENT ON COLUMN public.billing_payment_intents.final_amount_irr IS
  'Payable amount (amount_irr - discount_irr) snapshotted at issue time.';

-- ─── 2. Document-number uniqueness ────────────────────────────────────────
-- Intents already have `uq_billing_payment_intents_invoice_number` (107).
-- The settled payment copy must be unique too: one document number can only
-- ever settle once.
DROP INDEX IF EXISTS public.idx_billing_payments_invoice_number;

CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_payments_invoice_number
  ON public.billing_payments(invoice_number)
  WHERE invoice_number IS NOT NULL;

-- Canonical shape of a WebYar proforma/order number: 2 letters + 8 digits.
-- NOT VALID keeps the 4 pre-existing production intents untouched while every
-- new row is checked.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'billing_payment_intents_invoice_number_format'
  ) THEN
    ALTER TABLE public.billing_payment_intents
      ADD CONSTRAINT billing_payment_intents_invoice_number_format
      CHECK (invoice_number IS NULL OR invoice_number ~ '^[A-Z]{2}[0-9]{8}$') NOT VALID;
  END IF;
END $$;

-- History queries always scan by workspace + recency.
CREATE INDEX IF NOT EXISTS idx_billing_payment_intents_workspace_created
  ON public.billing_payment_intents(workspace_id, created_at DESC);

-- ─── 3. Financial SECURITY DEFINER ACL (converge repo with production) ────
DO $$
DECLARE
  fn text;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure::text
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prosecdef
       AND p.proname IN (
         'billing_apply_subscription_payment'
       )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', fn);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', fn);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    END IF;
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO postgres', fn);
  END LOOP;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT ALL ON public.billing_payment_intents TO service_role;
    GRANT ALL ON public.billing_payments TO service_role;
  END IF;
END $$;
