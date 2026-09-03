-- ============================================================
-- 113 — BILLING ENGINE V2, CORE INVOICE MODEL (Phase A)
--
-- THE INVARIANT THIS MIGRATION EXISTS TO ENFORCE
--
--   Money does not directly create entitlement.
--   Money settles an Invoice.
--   A paid Invoice creates or schedules a Service Period.
--   A Service Period grants entitlements and its AI allowance exactly once.
--
-- Until now a verified gateway payment mutated `workspace_subscriptions`
-- directly (105/106) and an AI credit top-up called the AI ledger directly.
-- From V2 on, both go through an Invoice: the payment settles the invoice, and
-- ONLY the paid invoice is allowed to produce a service period, an entitlement
-- change or an AI grant.
--
-- Two further invariants encoded here:
--
--   * Wallet money, purchased AI credit and plan AI allowance are three
--     separate domains and never share a balance (wallet lives in 114, the AI
--     ledger stays in 073 — this migration deliberately does NOT merge them).
--   * Every paid subscription period grants exactly one plan allowance; paying
--     early never grants it early (the period is created `scheduled` and its
--     allowance is granted at activation), replay never grants twice
--     (`billing_invoice_applications.invoice_id` is UNIQUE), and a calendar
--     month rollover alone never creates an allowance (allowance is bound to
--     `billing_subscription_periods.id`, not to "YYYY-MM").
--
-- Additive, rerunnable, backward compatible: nothing existing is dropped, the
-- 105–109 payment-intent state machine, provider binding, replay protection,
-- document numbers and financial ACL all keep working unchanged.
-- ============================================================

-- ─── 1. Invoices ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.billing_invoices (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  subscription_id     UUID REFERENCES public.workspace_subscriptions(id) ON DELETE SET NULL,

  -- Financial document identity. `invoice_number` is a WebYar billing document
  -- number (2 letters + 8 digits, CSPRNG, DB-unique) — NEVER a provider
  -- tracking reference and NEVER a legal tax invoice number.
  invoice_number      TEXT NOT NULL,
  document_type       TEXT NOT NULL DEFAULT 'invoice',

  invoice_type        TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'draft',

  currency            TEXT NOT NULL DEFAULT 'IRR',
  subtotal_irr        BIGINT NOT NULL DEFAULT 0,
  discount_irr        BIGINT NOT NULL DEFAULT 0,
  tax_irr             BIGINT NOT NULL DEFAULT 0,
  total_irr           BIGINT NOT NULL DEFAULT 0,
  amount_paid_irr     BIGINT NOT NULL DEFAULT 0,
  amount_due_irr      BIGINT NOT NULL DEFAULT 0,

  issued_at           TIMESTAMPTZ,
  due_at              TIMESTAMPTZ,
  paid_at             TIMESTAMPTZ,
  past_due_at         TIMESTAMPTZ,
  voided_at           TIMESTAMPTZ,

  period_start        TIMESTAMPTZ,
  period_end          TIMESTAMPTZ,

  plan_id             UUID REFERENCES public.billing_plans(id),
  plan_name_snapshot  TEXT,
  billing_interval    TEXT,

  -- FROZEN at issue time. applyInvoiceEffects() reads ONLY this, so a later
  -- Super Admin price or plan-definition change can never re-price or
  -- re-target an invoice the customer already paid.
  effect_snapshot     JSONB,

  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.billing_invoices DROP CONSTRAINT IF EXISTS billing_invoices_type_check;
ALTER TABLE public.billing_invoices ADD CONSTRAINT billing_invoices_type_check
  CHECK (invoice_type IN (
    'new_subscription', 'subscription_renewal', 'plan_upgrade',
    'addon', 'manual', 'ai_credit_purchase'
  ));

ALTER TABLE public.billing_invoices DROP CONSTRAINT IF EXISTS billing_invoices_status_check;
ALTER TABLE public.billing_invoices ADD CONSTRAINT billing_invoices_status_check
  CHECK (status IN (
    'draft', 'open', 'partially_paid', 'paid', 'past_due', 'void', 'expired', 'refunded'
  ));

ALTER TABLE public.billing_invoices DROP CONSTRAINT IF EXISTS billing_invoices_interval_check;
ALTER TABLE public.billing_invoices ADD CONSTRAINT billing_invoices_interval_check
  CHECK (billing_interval IS NULL OR billing_interval IN ('monthly', 'yearly'));

-- Money is BIGINT IRR and may never go negative or overpay.
ALTER TABLE public.billing_invoices DROP CONSTRAINT IF EXISTS billing_invoices_amounts_check;
ALTER TABLE public.billing_invoices ADD CONSTRAINT billing_invoices_amounts_check
  CHECK (
    subtotal_irr >= 0 AND discount_irr >= 0 AND tax_irr >= 0 AND total_irr >= 0
    AND amount_paid_irr >= 0 AND amount_due_irr >= 0
    AND amount_paid_irr <= total_irr
    AND amount_paid_irr + amount_due_irr = total_irr
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_invoices_number
  ON public.billing_invoices (invoice_number);

-- Scheduler idempotency: one live invoice per (subscription, period, type).
-- Voided/expired documents are excluded so a re-purchase after a failed cycle
-- can legitimately issue a fresh invoice for the same window.
CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_invoices_subscription_period
  ON public.billing_invoices (subscription_id, invoice_type, period_start)
  WHERE subscription_id IS NOT NULL
    AND period_start IS NOT NULL
    AND status NOT IN ('void', 'expired');

CREATE INDEX IF NOT EXISTS ix_billing_invoices_workspace_created
  ON public.billing_invoices (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_billing_invoices_status_due
  ON public.billing_invoices (status, due_at)
  WHERE status IN ('open', 'partially_paid', 'past_due');

COMMENT ON TABLE public.billing_invoices IS
  'Canonical billing document. A paid invoice — never a gateway payment — is the only authority that may create a service period, change a plan or grant AI credit.';
COMMENT ON COLUMN public.billing_invoices.effect_snapshot IS
  'Business effect frozen at issue time (source/target plan, action, effective_at, period, proration inputs and result, limits snapshot, AI allowance delta, interval). Invoice application reads ONLY this snapshot.';

-- ─── 2. Invoice lines ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.billing_invoice_lines (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id      UUID NOT NULL REFERENCES public.billing_invoices(id) ON DELETE CASCADE,
  line_type       TEXT NOT NULL,
  description     TEXT NOT NULL,
  quantity        INTEGER NOT NULL DEFAULT 1,
  unit_amount_irr BIGINT NOT NULL DEFAULT 0,
  amount_irr      BIGINT NOT NULL DEFAULT 0,
  plan_id         UUID REFERENCES public.billing_plans(id),
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.billing_invoice_lines DROP CONSTRAINT IF EXISTS billing_invoice_lines_type_check;
ALTER TABLE public.billing_invoice_lines ADD CONSTRAINT billing_invoice_lines_type_check
  CHECK (line_type IN (
    'plan', 'upgrade_proration', 'addon', 'ai_credit',
    'discount', 'tax', 'credit', 'manual_adjustment'
  ));

CREATE INDEX IF NOT EXISTS ix_billing_invoice_lines_invoice
  ON public.billing_invoice_lines (invoice_id, sort_order);

-- ─── 3. Subscription periods ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.billing_subscription_periods (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  subscription_id   UUID REFERENCES public.workspace_subscriptions(id) ON DELETE CASCADE,
  plan_id           UUID REFERENCES public.billing_plans(id),
  invoice_id        UUID REFERENCES public.billing_invoices(id) ON DELETE SET NULL,

  billing_interval  TEXT NOT NULL DEFAULT 'monthly',
  period_start      TIMESTAMPTZ NOT NULL,
  period_end        TIMESTAMPTZ NOT NULL,

  status            TEXT NOT NULL DEFAULT 'scheduled',
  source            TEXT NOT NULL DEFAULT 'invoice',

  activated_at      TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,

  plan_snapshot     JSONB NOT NULL DEFAULT '{}'::jsonb,
  limits_snapshot   JSONB NOT NULL DEFAULT '{}'::jsonb,
  ai_allowance_irr  BIGINT NOT NULL DEFAULT 0,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.billing_subscription_periods DROP CONSTRAINT IF EXISTS billing_subscription_periods_status_check;
ALTER TABLE public.billing_subscription_periods ADD CONSTRAINT billing_subscription_periods_status_check
  CHECK (status IN ('scheduled', 'active', 'completed', 'canceled'));

ALTER TABLE public.billing_subscription_periods DROP CONSTRAINT IF EXISTS billing_subscription_periods_source_check;
ALTER TABLE public.billing_subscription_periods ADD CONSTRAINT billing_subscription_periods_source_check
  CHECK (source IN ('invoice', 'legacy_migration', 'free_plan', 'trial', 'admin'));

ALTER TABLE public.billing_subscription_periods DROP CONSTRAINT IF EXISTS billing_subscription_periods_window_check;
ALTER TABLE public.billing_subscription_periods ADD CONSTRAINT billing_subscription_periods_window_check
  CHECK (period_end > period_start AND ai_allowance_irr >= 0);

-- One invoice can never produce two service periods.
CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_subscription_periods_invoice
  ON public.billing_subscription_periods (invoice_id)
  WHERE invoice_id IS NOT NULL;

-- A workspace has at most ONE active period at any time.
CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_subscription_periods_active
  ON public.billing_subscription_periods (workspace_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS ix_billing_subscription_periods_workspace
  ON public.billing_subscription_periods (workspace_id, period_start DESC);
CREATE INDEX IF NOT EXISTS ix_billing_subscription_periods_due_activation
  ON public.billing_subscription_periods (period_start)
  WHERE status = 'scheduled';

COMMENT ON TABLE public.billing_subscription_periods IS
  'One row per real service period. The period — not the calendar month — is what grants entitlements and exactly one plan AI allowance (command key plan_allowance:<period_id>).';

-- ─── 4. Durable invoice application ledger ────────────────────────────────
CREATE TABLE IF NOT EXISTS public.billing_invoice_applications (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id        UUID NOT NULL REFERENCES public.billing_invoices(id) ON DELETE CASCADE,
  workspace_id      UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  application_type  TEXT NOT NULL,
  application_status TEXT NOT NULL DEFAULT 'applied',
  period_id         UUID REFERENCES public.billing_subscription_periods(id) ON DELETE SET NULL,
  result_snapshot   JSONB NOT NULL DEFAULT '{}'::jsonb,
  applied_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- THE replay guard: one invoice applies its effects at most once, ever.
CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_invoice_applications_invoice
  ON public.billing_invoice_applications (invoice_id);

CREATE INDEX IF NOT EXISTS ix_billing_invoice_applications_workspace
  ON public.billing_invoice_applications (workspace_id, applied_at DESC);

-- ─── 5. Subscription contract columns ─────────────────────────────────────
ALTER TABLE public.workspace_subscriptions
  ADD COLUMN IF NOT EXISTS billing_anchor_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS current_period_id     UUID REFERENCES public.billing_subscription_periods(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS next_invoice_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS next_plan_id          UUID REFERENCES public.billing_plans(id),
  ADD COLUMN IF NOT EXISTS pending_change_type   TEXT,
  ADD COLUMN IF NOT EXISTS canceled_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS past_due_since        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS grace_period_ends_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS free_fallback_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trial_start           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS billing_engine_version TEXT NOT NULL DEFAULT 'v1',
  ADD COLUMN IF NOT EXISTS billing_v2_effective_at TIMESTAMPTZ;

ALTER TABLE public.workspace_subscriptions DROP CONSTRAINT IF EXISTS workspace_subscriptions_pending_change_check;
ALTER TABLE public.workspace_subscriptions ADD CONSTRAINT workspace_subscriptions_pending_change_check
  CHECK (pending_change_type IS NULL OR pending_change_type IN ('upgrade', 'downgrade', 'cancel'));

-- Widen the status vocabulary for V2 lifecycle states WITHOUT invalidating any
-- existing production value (every legacy value is preserved).
ALTER TABLE public.workspace_subscriptions DROP CONSTRAINT IF EXISTS workspace_subscriptions_status_check;
ALTER TABLE public.workspace_subscriptions ADD CONSTRAINT workspace_subscriptions_status_check
  CHECK (status IN (
    'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'expired',
    'incomplete', 'paused', 'free_fallback', 'suspended'
  ));

COMMENT ON COLUMN public.workspace_subscriptions.billing_v2_effective_at IS
  'Rollout boundary. Once set, the legacy calendar-month plan allowance grant is disabled for this workspace and plan allowance comes exclusively from subscription period activation — this is what prevents a double grant during the V1→V2 transition.';

-- ─── 6. Payment intents become invoice-aware ──────────────────────────────
-- The invoice remains the pricing authority, but the intent carries an
-- IMMUTABLE expected amount copied from the invoice at checkout creation, so
-- verification can assert:
--   gateway_verified_amount = intent.expected_amount_irr = invoice.amount_due_irr
ALTER TABLE public.billing_payment_intents
  ADD COLUMN IF NOT EXISTS invoice_id          UUID REFERENCES public.billing_invoices(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS expected_amount_irr BIGINT;

CREATE INDEX IF NOT EXISTS ix_billing_payment_intents_invoice
  ON public.billing_payment_intents (invoice_id)
  WHERE invoice_id IS NOT NULL;

-- `billing_payments` gains the invoice relation plus a reconciliation flag for
-- money that arrived but could not be applied (amount mismatch, expired or
-- voided invoice). Such money is NEVER discarded.
ALTER TABLE public.billing_payments
  ADD COLUMN IF NOT EXISTS invoice_id            UUID REFERENCES public.billing_invoices(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reconciliation_state  TEXT NOT NULL DEFAULT 'settled',
  ADD COLUMN IF NOT EXISTS reconciliation_reason TEXT;

ALTER TABLE public.billing_payments DROP CONSTRAINT IF EXISTS billing_payments_reconciliation_state_check;
ALTER TABLE public.billing_payments ADD CONSTRAINT billing_payments_reconciliation_state_check
  CHECK (reconciliation_state IN ('settled', 'unapplied', 'credited_to_wallet', 'refunded'));

CREATE INDEX IF NOT EXISTS ix_billing_payments_invoice
  ON public.billing_payments (invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_billing_payments_unapplied
  ON public.billing_payments (workspace_id, created_at DESC)
  WHERE reconciliation_state = 'unapplied';

-- ─── 7. Immutability: an issued invoice is a financial contract ───────────
CREATE OR REPLACE FUNCTION public.billing_invoice_freeze()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();

  -- Draft invoices are still being composed.
  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;

  -- Once issued, the priced contract is immutable. Only settlement/lifecycle
  -- fields may move. Corrections happen with a NEW document (credit note or
  -- adjustment invoice), never by rewriting history.
  IF NEW.invoice_number  IS DISTINCT FROM OLD.invoice_number
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.invoice_type IS DISTINCT FROM OLD.invoice_type
     OR NEW.currency     IS DISTINCT FROM OLD.currency
     OR NEW.subtotal_irr IS DISTINCT FROM OLD.subtotal_irr
     OR NEW.discount_irr IS DISTINCT FROM OLD.discount_irr
     OR NEW.tax_irr      IS DISTINCT FROM OLD.tax_irr
     OR NEW.total_irr    IS DISTINCT FROM OLD.total_irr
     OR NEW.period_start IS DISTINCT FROM OLD.period_start
     OR NEW.period_end   IS DISTINCT FROM OLD.period_end
     OR NEW.plan_id      IS DISTINCT FROM OLD.plan_id
     OR NEW.plan_name_snapshot IS DISTINCT FROM OLD.plan_name_snapshot
     OR NEW.billing_interval   IS DISTINCT FROM OLD.billing_interval
     OR NEW.issued_at    IS DISTINCT FROM OLD.issued_at
     OR NEW.effect_snapshot IS DISTINCT FROM OLD.effect_snapshot
  THEN
    RAISE EXCEPTION 'invoice_immutable:%', OLD.id
      USING HINT = 'An issued invoice is frozen. Issue a credit note or a new invoice instead.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_billing_invoice_freeze ON public.billing_invoices;
CREATE TRIGGER trg_billing_invoice_freeze
  BEFORE UPDATE ON public.billing_invoices
  FOR EACH ROW EXECUTE FUNCTION public.billing_invoice_freeze();

-- Lines follow the same contract: they may only change while the invoice is a
-- draft.
CREATE OR REPLACE FUNCTION public.billing_invoice_line_freeze()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_status TEXT;
  v_invoice UUID;
BEGIN
  v_invoice := COALESCE(NEW.invoice_id, OLD.invoice_id);
  SELECT status INTO v_status FROM public.billing_invoices WHERE id = v_invoice;
  IF v_status IS NOT NULL AND v_status <> 'draft' THEN
    RAISE EXCEPTION 'invoice_lines_immutable:%', v_invoice
      USING HINT = 'Invoice lines are frozen once the invoice is issued.';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_billing_invoice_line_freeze ON public.billing_invoice_lines;
CREATE TRIGGER trg_billing_invoice_line_freeze
  BEFORE INSERT OR UPDATE OR DELETE ON public.billing_invoice_lines
  FOR EACH ROW EXECUTE FUNCTION public.billing_invoice_line_freeze();

-- Financial period rows are append-mostly: the money-bearing fields of a
-- period can never be edited after creation.
CREATE OR REPLACE FUNCTION public.billing_period_freeze()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.workspace_id      IS DISTINCT FROM OLD.workspace_id
     OR NEW.invoice_id     IS DISTINCT FROM OLD.invoice_id
     OR NEW.plan_id        IS DISTINCT FROM OLD.plan_id
     OR NEW.period_start   IS DISTINCT FROM OLD.period_start
     OR NEW.period_end     IS DISTINCT FROM OLD.period_end
     OR NEW.ai_allowance_irr IS DISTINCT FROM OLD.ai_allowance_irr
     OR NEW.limits_snapshot  IS DISTINCT FROM OLD.limits_snapshot
     OR NEW.plan_snapshot    IS DISTINCT FROM OLD.plan_snapshot
  THEN
    RAISE EXCEPTION 'subscription_period_immutable:%', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_billing_period_freeze ON public.billing_subscription_periods;
CREATE TRIGGER trg_billing_period_freeze
  BEFORE UPDATE ON public.billing_subscription_periods
  FOR EACH ROW EXECUTE FUNCTION public.billing_period_freeze();

-- The application ledger is append-only.
CREATE OR REPLACE FUNCTION public.billing_invoice_application_block_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'invoice_application_append_only';
END;
$$;

DROP TRIGGER IF EXISTS trg_billing_invoice_applications_append_only ON public.billing_invoice_applications;
CREATE TRIGGER trg_billing_invoice_applications_append_only
  BEFORE UPDATE OR DELETE ON public.billing_invoice_applications
  FOR EACH ROW EXECUTE FUNCTION public.billing_invoice_application_block_mutation();

-- ─── 8. Security: financial tables are server-only ────────────────────────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'billing_invoices', 'billing_invoice_lines',
    'billing_subscription_periods', 'billing_invoice_applications'
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

-- ─── 9. Durable application state (paid → applied crash recovery) ─────────
--
-- A settlement and its effects are two different transactions in the worst
-- case: the money commits, then the process dies. Without a durable marker the
-- invoice stays `paid` and nothing is ever granted — silent, permanent loss of
-- service the customer paid for.
--
-- So the settlement itself CREATES the application row in `pending`, inside
-- the same transaction that marks the invoice paid. From then on the row is a
-- work item any recovery loop can find and retry.
ALTER TABLE public.billing_invoice_applications
  ADD COLUMN IF NOT EXISTS attempt_count   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lease_until     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_error      TEXT,
  ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE public.billing_invoice_applications
  ALTER COLUMN application_status SET DEFAULT 'pending',
  ALTER COLUMN applied_at DROP NOT NULL,
  ALTER COLUMN applied_at DROP DEFAULT;

ALTER TABLE public.billing_invoice_applications
  DROP CONSTRAINT IF EXISTS billing_invoice_applications_status_check;
ALTER TABLE public.billing_invoice_applications
  ADD CONSTRAINT billing_invoice_applications_status_check
  CHECK (application_status IN ('pending', 'processing', 'applied', 'failed'));

CREATE INDEX IF NOT EXISTS ix_billing_invoice_applications_recovery
  ON public.billing_invoice_applications (next_attempt_at)
  WHERE application_status <> 'applied';

-- Append-only, with ONE exception: the state machine may advance a not-yet
-- applied row. Nothing may ever be deleted, no identity or result field may be
-- rewritten, and an `applied` row is frozen forever.
CREATE OR REPLACE FUNCTION public.billing_invoice_application_block_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'invoice_application_append_only';
  END IF;

  IF OLD.application_status = 'applied' THEN
    RAISE EXCEPTION 'invoice_application_append_only'
      USING HINT = 'An applied invoice effect is history. Compensate with a new document, never by editing it.';
  END IF;

  IF NEW.invoice_id       IS DISTINCT FROM OLD.invoice_id
     OR NEW.workspace_id  IS DISTINCT FROM OLD.workspace_id
     OR NEW.created_at    IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'invoice_application_append_only';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_billing_invoice_applications_append_only ON public.billing_invoice_applications;
CREATE TRIGGER trg_billing_invoice_applications_append_only
  BEFORE UPDATE OR DELETE ON public.billing_invoice_applications
  FOR EACH ROW EXECUTE FUNCTION public.billing_invoice_application_block_mutation();

COMMENT ON COLUMN public.billing_invoice_applications.application_status IS
  'pending → processing → applied|failed. Created by settlement in the SAME transaction that marks the invoice paid, so a crash before the effects run leaves a durable work item instead of a silently unapplied paid invoice.';

-- ─── 10. Invoice collection reservation (gateway ↔ wallet race) ───────────
--
-- Prevention, not just reconciliation: while a gateway checkout is live for an
-- invoice, wallet auto-pay must not settle the same invoice, and while a
-- wallet settlement is running no new gateway checkout may be created for the
-- same amount. The reservation is durable (survives a closed browser),
-- expiring (a dead checkout never blocks the invoice forever) and idempotent.
CREATE TABLE IF NOT EXISTS public.billing_invoice_collections (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id        UUID NOT NULL REFERENCES public.billing_invoices(id) ON DELETE CASCADE,
  workspace_id      UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  channel           TEXT NOT NULL,
  amount_irr        BIGINT NOT NULL,
  payment_intent_id UUID REFERENCES public.billing_payment_intents(id) ON DELETE SET NULL,
  status            TEXT NOT NULL DEFAULT 'active',
  command_key       TEXT NOT NULL,
  expires_at        TIMESTAMPTZ NOT NULL,
  released_at       TIMESTAMPTZ,
  release_reason    TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.billing_invoice_collections
  DROP CONSTRAINT IF EXISTS billing_invoice_collections_channel_check;
ALTER TABLE public.billing_invoice_collections
  ADD CONSTRAINT billing_invoice_collections_channel_check
  CHECK (channel IN ('gateway', 'wallet', 'admin'));

ALTER TABLE public.billing_invoice_collections
  DROP CONSTRAINT IF EXISTS billing_invoice_collections_status_check;
ALTER TABLE public.billing_invoice_collections
  ADD CONSTRAINT billing_invoice_collections_status_check
  CHECK (status IN ('active', 'consumed', 'released', 'expired'));

ALTER TABLE public.billing_invoice_collections
  DROP CONSTRAINT IF EXISTS billing_invoice_collections_amount_check;
ALTER TABLE public.billing_invoice_collections
  ADD CONSTRAINT billing_invoice_collections_amount_check
  CHECK (amount_irr > 0);

-- THE lock: at most one live collection attempt per invoice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_invoice_collections_active
  ON public.billing_invoice_collections (invoice_id)
  WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_invoice_collections_command
  ON public.billing_invoice_collections (command_key);

CREATE INDEX IF NOT EXISTS ix_billing_invoice_collections_expiry
  ON public.billing_invoice_collections (expires_at) WHERE status = 'active';

COMMENT ON TABLE public.billing_invoice_collections IS
  'Durable collection reservation. Holding one is the precondition for settling an invoice, which is what makes a gateway callback and a wallet auto-pay mutually exclusive instead of merely reconcilable afterwards.';

DO $$
BEGIN
  EXECUTE 'ALTER TABLE public.billing_invoice_collections ENABLE ROW LEVEL SECURITY';
  EXECUTE 'REVOKE ALL ON public.billing_invoice_collections FROM PUBLIC';
  EXECUTE 'REVOKE ALL ON public.billing_invoice_collections FROM anon';
  EXECUTE 'REVOKE ALL ON public.billing_invoice_collections FROM authenticated';
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT ALL ON public.billing_invoice_collections TO service_role';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'billing_invoice_collections'
       AND policyname = 'service_role_only'
  ) THEN
    EXECUTE 'CREATE POLICY service_role_only ON public.billing_invoice_collections FOR ALL TO service_role USING (true) WITH CHECK (true)';
  END IF;
END $$;
