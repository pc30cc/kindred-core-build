-- 292 — WebYar: an account in US dollars, paid with crypto (Apirone, USDT on
-- TRON) (owner, 2026-11-01: temporary, for Apple's App Review; to be removed
-- later).
--
-- In the Iranian edition a workspace whose dashboard is not in Persian pays
-- in US dollars through Apirone; a Persian dashboard pays in Toman through
-- the Iranian gateways as before. The account's currency follows the
-- dashboard's language only while the account has not moved money (the
-- browser asks for it, PUT /api/billing/account/:ws/currency); once money
-- moved it stays (billing_account_settle_payment, 264, as before).
--
-- 1. billing_account_choose_currency(workspace, currency): the Iranian
--    edition only, IRR or USD. Creates the account in that currency when it
--    has none; switches an open account (zero balance, no ledger row, no
--    payment that may still be credited, no card-to-card request waiting);
--    refuses otherwise with billing_account_currency_locked or
--    billing_account_payment_pending.
-- 2. billing_account_set_received_amount(payment, amount): Apirone only. A
--    crypto payment credits what finally arrived, which may differ from the
--    invoice: before the confirmation is recorded
--    (billing_account_record_verification refuses any other amount), the
--    payment's amount and net become the received amount (no VAT: USD has
--    none in Iran), the quoted one is kept in
--    purpose_detail.quoted_amount_minor. The purpose is unchanged: at
--    settlement it is bought only when the balance covers it (an
--    underpayment stays in the balance; an overpayment buys it and keeps
--    the rest).
--
-- Server-only: both functions are SECURITY DEFINER, executable by
-- service_role alone. Re-runnable (CREATE OR REPLACE). It writes no data: no
-- row is inserted, changed or deleted by the migration itself; nothing is
-- dropped. RESPOK (International) never calls them: the first refuses
-- outside the Iranian edition, and Apirone is refused there
-- (shared/edition.ts).
--
-- Applied by hand on WebYar BEFORE the merge of the code that calls them
-- (CLAUDE.md, Migrations): a dry run of this file inside BEGIN … ROLLBACK
-- first; by its migrator on RESPOK, on push. Needs 257 (platform_edition),
-- 259 (accounts, payments, ledger) and 274 (card-to-card requests). Like 284
-- to 288, it sets lock_timeout 5s itself.

SET lock_timeout = '5s';

DO $guard$
BEGIN
  IF to_regprocedure('public.platform_edition()') IS NULL
     OR to_regprocedure('public.billing_account_ensure(uuid, text)') IS NULL
     OR to_regclass('public.billing_account_payments') IS NULL
     OR to_regclass('public.billing_account_ledger') IS NULL
     OR to_regclass('public.billing_card_transfers') IS NULL THEN
    RAISE EXCEPTION '292 needs 257, 259 and 274 (platform_edition, billing accounts or card-to-card requests are missing)';
  END IF;
END $guard$;

-- ─── 1. The account's currency, while it has not moved money ──────────────
-- An attempt that may still be credited: a confirmation recorded but not
-- settled, a pending checkout within its hour (server ACCOUNT_PAYMENT_TTL_MS),
-- or an Apirone payment that has not succeeded, whatever its status, within
-- two hours of its creation (GATEWAY_ENDED_PAYMENT_WINDOW_MS: its invoice
-- lives an hour, may be paid at its end and confirmed after it, and only
-- Apirone ends it). Switching under it would credit money in the other
-- currency.
CREATE OR REPLACE FUNCTION public.billing_account_choose_currency(
  p_workspace_id uuid,
  p_currency     text
) RETURNS public.billing_accounts
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_currency text := upper(coalesce(p_currency, ''));
  v_acc      public.billing_accounts;
BEGIN
  IF public.platform_edition() IS DISTINCT FROM 'iran' OR v_currency NOT IN ('IRR', 'USD') THEN
    RAISE EXCEPTION 'billing_account_currency_not_allowed';
  END IF;

  PERFORM public.billing_account_ensure(p_workspace_id, v_currency);
  SELECT * INTO v_acc FROM public.billing_accounts WHERE workspace_id = p_workspace_id FOR UPDATE;
  IF v_acc.currency = v_currency THEN
    RETURN v_acc;
  END IF;

  IF v_acc.balance_minor <> 0
     OR EXISTS (SELECT 1 FROM public.billing_account_ledger WHERE workspace_id = p_workspace_id) THEN
    RAISE EXCEPTION 'billing_account_currency_locked';
  END IF;
  IF EXISTS (
       SELECT 1 FROM public.billing_account_payments
        WHERE workspace_id = p_workspace_id
          AND status <> 'succeeded'
          AND (verified_at IS NOT NULL
               OR (status = 'pending' AND created_at > now() - interval '1 hour')
               OR (provider = 'apirone' AND created_at > now() - interval '2 hours')))
     OR EXISTS (
       SELECT 1 FROM public.billing_card_transfers
        WHERE workspace_id = p_workspace_id AND status = 'pending') THEN
    RAISE EXCEPTION 'billing_account_payment_pending';
  END IF;

  UPDATE public.billing_accounts
     SET currency = v_currency, updated_at = now()
   WHERE workspace_id = p_workspace_id
   RETURNING * INTO v_acc;
  RETURN v_acc;
END;
$$;

COMMENT ON FUNCTION public.billing_account_choose_currency(uuid, text) IS
  'Iranian edition only (292): the account''s currency, IRR or USD, chosen while it has not moved money (zero balance, no ledger row, no payment that may still be credited, no pending card-to-card request); else billing_account_currency_locked / billing_account_payment_pending. Creates the account in that currency when it has none.';

-- ─── 2. What a crypto payment finally received ────────────────────────────
CREATE OR REPLACE FUNCTION public.billing_account_set_received_amount(
  p_payment_id   uuid,
  p_amount_minor bigint
) RETURNS public.billing_account_payments
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_pay public.billing_account_payments;
BEGIN
  IF p_amount_minor IS NULL OR p_amount_minor <= 0 THEN
    RAISE EXCEPTION 'billing_payment_bad_amount';
  END IF;
  SELECT * INTO v_pay FROM public.billing_account_payments WHERE id = p_payment_id FOR UPDATE;
  IF v_pay.id IS NULL THEN
    RAISE EXCEPTION 'billing_payment_not_found';
  END IF;
  -- Only Apirone's amount is what arrived; every other gateway's is fixed.
  IF v_pay.provider <> 'apirone' THEN
    RAISE EXCEPTION 'billing_payment_amount_fixed';
  END IF;
  IF v_pay.status = 'succeeded' OR v_pay.verified_at IS NOT NULL THEN
    RAISE EXCEPTION 'billing_payment_already_verified';
  END IF;
  IF v_pay.tax_minor <> 0 THEN
    RAISE EXCEPTION 'billing_payment_has_tax';
  END IF;
  IF v_pay.amount_minor = p_amount_minor THEN
    RETURN v_pay;
  END IF;

  UPDATE public.billing_account_payments
     SET amount_minor = p_amount_minor,
         net_minor = p_amount_minor,
         purpose_detail = CASE
           WHEN coalesce(purpose_detail, '{}'::jsonb) ? 'quoted_amount_minor' THEN purpose_detail
           ELSE coalesce(purpose_detail, '{}'::jsonb) || jsonb_build_object('quoted_amount_minor', v_pay.amount_minor)
         END,
         updated_at = now()
   WHERE id = p_payment_id
   RETURNING * INTO v_pay;
  RETURN v_pay;
END;
$$;

COMMENT ON FUNCTION public.billing_account_set_received_amount(uuid, bigint) IS
  'Apirone only (292): before its confirmation is recorded, a payment''s amount and net become what the gateway finally received (no VAT); the quoted amount is kept in purpose_detail.quoted_amount_minor. Refuses a settled or confirmed payment, one with VAT, and an amount <= 0.';

-- ─── 3. Access: the backend (service_role) only ──────────────────────────
DO $acl$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.billing_account_choose_currency(uuid, text)',
    'public.billing_account_set_received_amount(uuid, bigint)'
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

RESET lock_timeout;
