-- 274 — Card-to-card wallet top-up, Iranian edition (docs/billing/SIMPLE_BILLING.md,
-- "Card to card").
--
-- A temporary way to top up the wallet while no online gateway is live: the
-- workspace owner transfers money to the platform's bank account, uploads the
-- bank receipt, and a Super Admin approves it. Approval books exactly what a
-- gateway payment books (a `manual` billing_account_payments row, verified
-- and settled by billing_account_record_verification and
-- billing_account_settle_payment): a numbered receipt, the `topup` ledger row,
-- the balance, and revenue under provider `manual`.
--
-- 1. billing_settings.card_transfer (jsonb, per edition): enabled,
--    holder_name, card_number, iban, bank. Read and written by the backend.
-- 2. billing_card_transfers: one row per request (amount, bank tracking
--    number, transfer time, the receipt file's storage key), with its review.
--    A tracking number can be used by one live (pending or approved) request.
-- 3. billing_card_transfer_approve(request, admin, net, tax, tax %): in one
--    transaction, locks the pending request, creates the `manual` payment,
--    records it as verified (reference `card_transfer:<request id>`), settles
--    it and marks the request approved. Iranian edition only. Idempotent: an
--    approved request answers its booking again (`replayed`).
--
-- Server-only: service_role alone may read the table and execute the
-- function. Re-runnable: every step is guarded or a no-op the second time.
-- Dry run: the file inside BEGIN … ROLLBACK. Touches no archive schema or
-- table.

-- ─── 1. Card details per edition ───────────────────────────────────────────
ALTER TABLE public.billing_settings
  ADD COLUMN IF NOT EXISTS card_transfer jsonb NOT NULL DEFAULT '{}'::jsonb;

-- ─── 2. Requests ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.billing_card_transfers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  created_by       uuid,
  currency         text NOT NULL DEFAULT 'IRR',
  -- The credit asked for, its VAT, and their sum: what was transferred.
  net_minor        bigint NOT NULL,
  tax_minor        bigint NOT NULL DEFAULT 0,
  tax_percent      numeric(6,3),
  amount_minor     bigint NOT NULL,
  -- The bank's tracking number (digits only), the transfer's time, the last
  -- four digits of the payer's card and a free note.
  reference        text,
  paid_at          timestamptz,
  payer_card_last4 text,
  note             text,
  -- The uploaded bank receipt (private: streamed by the backend only).
  receipt_key      text NOT NULL,
  receipt_mime     text NOT NULL,
  receipt_size     integer NOT NULL,
  receipt_name     text,
  status           text NOT NULL DEFAULT 'pending',
  review_note      text,
  reviewed_by      uuid,
  reviewed_at      timestamptz,
  payment_id       uuid REFERENCES public.billing_account_payments(id) ON DELETE SET NULL,
  ledger_id        uuid REFERENCES public.billing_account_ledger(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_card_transfers_status_check') THEN
    ALTER TABLE public.billing_card_transfers
      ADD CONSTRAINT billing_card_transfers_status_check
      CHECK (status IN ('pending', 'approved', 'rejected', 'canceled'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_card_transfers_amount_check') THEN
    ALTER TABLE public.billing_card_transfers
      ADD CONSTRAINT billing_card_transfers_amount_check
      CHECK (net_minor > 0 AND tax_minor >= 0 AND amount_minor = net_minor + tax_minor);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_card_transfers_currency_check') THEN
    ALTER TABLE public.billing_card_transfers
      ADD CONSTRAINT billing_card_transfers_currency_check CHECK (currency ~ '^[A-Z]{3}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_card_transfers_reference_check') THEN
    ALTER TABLE public.billing_card_transfers
      ADD CONSTRAINT billing_card_transfers_reference_check
      CHECK (reference IS NULL OR reference ~ '^[0-9]{4,30}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_card_transfers_last4_check') THEN
    ALTER TABLE public.billing_card_transfers
      ADD CONSTRAINT billing_card_transfers_last4_check
      CHECK (payer_card_last4 IS NULL OR payer_card_last4 ~ '^[0-9]{4}$');
  END IF;
END $$;

-- One bank transfer tops up once: its tracking number cannot back a second
-- live request (a rejected or canceled one frees it).
CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_card_transfers_reference
  ON public.billing_card_transfers (reference)
  WHERE reference IS NOT NULL AND status IN ('pending', 'approved');
CREATE INDEX IF NOT EXISTS idx_billing_card_transfers_workspace
  ON public.billing_card_transfers (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_billing_card_transfers_pending
  ON public.billing_card_transfers (created_at) WHERE status = 'pending';

-- ─── 3. Approval ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.billing_card_transfer_approve(
  p_request_id  uuid,
  p_admin_id    uuid,
  p_net_minor   bigint,
  p_tax_minor   bigint,
  p_tax_percent numeric
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_req     public.billing_card_transfers;
  v_pay     public.billing_account_payments;
  v_settled jsonb;
  v_ref     text;
BEGIN
  SELECT * INTO v_req FROM public.billing_card_transfers WHERE id = p_request_id FOR UPDATE;
  IF v_req.id IS NULL THEN
    RAISE EXCEPTION 'card_transfer_not_found';
  END IF;
  IF v_req.status = 'approved' THEN
    RETURN jsonb_build_object(
      'replayed', true,
      'request_id', v_req.id,
      'payment_id', v_req.payment_id,
      'ledger_id', v_req.ledger_id
    );
  END IF;
  IF v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'card_transfer_not_pending';
  END IF;
  IF public.platform_edition() <> 'iran' THEN
    RAISE EXCEPTION 'card_transfer_not_available';
  END IF;
  IF p_net_minor IS NULL OR p_net_minor <= 0 OR p_tax_minor IS NULL OR p_tax_minor < 0 THEN
    RAISE EXCEPTION 'card_transfer_amount_invalid';
  END IF;

  v_ref := 'card_transfer:' || v_req.id::text;

  INSERT INTO public.billing_account_payments (
    workspace_id, provider, currency, amount_minor, net_minor, tax_minor, tax_percent,
    purpose, purpose_detail, status, provider_ref, created_by
  ) VALUES (
    v_req.workspace_id, 'manual', v_req.currency, p_net_minor + p_tax_minor, p_net_minor, p_tax_minor, p_tax_percent,
    'topup',
    jsonb_strip_nulls(jsonb_build_object(
      'card_transfer_id', v_req.id,
      'bank_reference', v_req.reference,
      'approved_by', p_admin_id
    )),
    'pending', v_ref, v_req.created_by
  ) RETURNING * INTO v_pay;

  PERFORM public.billing_account_record_verification(v_pay.id, v_pay.amount_minor, v_pay.currency, v_ref);
  v_settled := public.billing_account_settle_payment(v_pay.id);

  UPDATE public.billing_card_transfers
     SET status = 'approved',
         net_minor = p_net_minor,
         tax_minor = p_tax_minor,
         tax_percent = p_tax_percent,
         amount_minor = p_net_minor + p_tax_minor,
         payment_id = v_pay.id,
         ledger_id = NULLIF(v_settled->>'ledger_id', '')::uuid,
         reviewed_by = p_admin_id,
         reviewed_at = now(),
         updated_at = now()
   WHERE id = v_req.id;

  RETURN v_settled || jsonb_build_object('replayed', false, 'request_id', v_req.id);
END;
$$;

-- ─── Security: service_role only ───────────────────────────────────────────
ALTER TABLE public.billing_card_transfers ENABLE ROW LEVEL SECURITY;

DO $acl$
BEGIN
  REVOKE ALL ON TABLE public.billing_card_transfers FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public.billing_card_transfers FROM anon;
    REVOKE ALL ON FUNCTION public.billing_card_transfer_approve(uuid, uuid, bigint, bigint, numeric) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE public.billing_card_transfers FROM authenticated;
    REVOKE ALL ON FUNCTION public.billing_card_transfer_approve(uuid, uuid, bigint, bigint, numeric) FROM authenticated;
  END IF;
  REVOKE ALL ON FUNCTION public.billing_card_transfer_approve(uuid, uuid, bigint, bigint, numeric) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT ALL ON TABLE public.billing_card_transfers TO service_role;
    GRANT EXECUTE ON FUNCTION public.billing_card_transfer_approve(uuid, uuid, bigint, bigint, numeric) TO service_role;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'billing_card_transfers' AND policyname = 'service_role_only'
    ) THEN
      CREATE POLICY service_role_only ON public.billing_card_transfers
        FOR ALL TO service_role USING (true) WITH CHECK (true);
    END IF;
  END IF;
END $acl$;
