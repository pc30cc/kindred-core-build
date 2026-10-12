-- 270 — The Super Admin credit/debit rate limit, enforced in the booking
-- (docs/billing/SIMPLE_BILLING.md, phase 6 "Credit and debit").
--
-- The backend counted an admin's admin_credit / admin_debit rows of the last
-- hour before calling billing_account_admin_adjust, so requests sent at the
-- same time (each for another workspace, which the workspace row lock does
-- not serialize) all read the same count and all booked. The function now
-- takes a per-admin transaction lock (pg_advisory_xact_lock on the actor),
-- counts that admin's changes of the last hour and refuses the change past
-- 30 with `billing_adjust_rate_limited` (the backend answers 429
-- TOO_MANY_ADJUSTMENTS, as its own check does). A replay of a booked command
-- key is answered before the count, so it still replays at the limit. A NULL
-- actor (267's move) is not limited.
--
-- 266's body otherwise unchanged; same signature, so the backend's calls and
-- 266's grants stay. One transaction; lock_timeout 5s (no table is locked:
-- CREATE OR REPLACE FUNCTION only). Re-runnable. Server-only: service_role
-- alone may execute it. Dry run: the file with its final COMMIT; turned into
-- ROLLBACK;.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.billing_account_admin_adjust(
  p_workspace_id           uuid,
  p_amount_minor           bigint,
  p_currency               text,
  p_reason                 text,
  p_actor_id               uuid,
  p_command_key            text,
  p_category               text   DEFAULT 'other',
  p_expected_balance_minor bigint DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_acc     public.billing_accounts;
  v_entry   public.billing_account_ledger;
  v_balance bigint;
  v_reason  text := btrim(coalesce(p_reason, ''));
  v_kind    text;
  v_cap     bigint;
BEGIN
  IF p_amount_minor IS NULL OR p_amount_minor = 0 THEN
    RAISE EXCEPTION 'billing_adjust_zero';
  END IF;
  IF coalesce(p_command_key, '') = '' THEN
    RAISE EXCEPTION 'billing_adjust_missing_key';
  END IF;
  IF p_category IS NULL
     OR p_category NOT IN ('goodwill', 'compensation', 'correction', 'migration', 'test', 'other') THEN
    RAISE EXCEPTION 'billing_adjust_bad_category';
  END IF;
  IF char_length(v_reason) < 3 OR char_length(v_reason) > 500 THEN
    RAISE EXCEPTION 'billing_adjust_reason_required';
  END IF;
  -- TOPUP_LIMITS.max (shared/simpleBilling.ts); another currency has the
  -- cents-based cap.
  v_cap := CASE upper(coalesce(p_currency, ''))
    WHEN 'IRR' THEN 10000000000
    WHEN 'USD' THEN 5000000
    WHEN 'TRY' THEN 200000000
    WHEN 'EUR' THEN 5000000
    WHEN 'GBP' THEN 5000000
    ELSE 5000000
  END;
  IF abs(p_amount_minor) > v_cap THEN
    RAISE EXCEPTION 'billing_adjust_too_large';
  END IF;
  v_kind := CASE WHEN p_amount_minor > 0 THEN 'admin_credit' ELSE 'admin_debit' END;

  PERFORM public.billing_account_ensure(p_workspace_id, p_currency);
  SELECT * INTO v_acc FROM public.billing_accounts WHERE workspace_id = p_workspace_id FOR UPDATE;

  -- A replay is the same charge: same workspace, direction and amount.
  SELECT * INTO v_entry FROM public.billing_account_ledger WHERE idempotency_key = 'admin:' || p_command_key;
  IF v_entry.id IS NOT NULL THEN
    IF v_entry.workspace_id <> p_workspace_id
       OR v_entry.kind <> v_kind
       OR v_entry.amount_minor <> p_amount_minor THEN
      RAISE EXCEPTION 'billing_adjust_key_reused';
    END IF;
    RETURN jsonb_build_object('replayed', true, 'ledger_id', v_entry.id, 'balance_minor', v_entry.balance_after);
  END IF;

  -- The per-admin rate limit (ADJUST_RATE_LIMIT in shared/simpleBillingAdmin.ts:
  -- 30 changes per admin per hour), here so it holds for requests sent at the
  -- same time too. The admin's lock is held to the end of the transaction, so
  -- the count and the booking below are one step per admin. Taken after the
  -- workspace's row lock, and nothing else takes it, so no lock cycle. A NULL
  -- actor (a migration, 267) is not an admin and is not limited.
  IF p_actor_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('billing_account_admin_adjust:' || p_actor_id::text, 0));
    IF (SELECT count(*) FROM public.billing_account_ledger l
         WHERE l.actor_id = p_actor_id
           AND l.kind IN ('admin_credit', 'admin_debit')
           AND l.created_at >= clock_timestamp() - interval '1 hour') >= 30 THEN
      RAISE EXCEPTION 'billing_adjust_rate_limited';
    END IF;
  END IF;

  IF v_acc.currency <> upper(p_currency) THEN
    RAISE EXCEPTION 'billing_account_currency_mismatch';
  END IF;
  IF p_expected_balance_minor IS NOT NULL AND v_acc.balance_minor <> p_expected_balance_minor THEN
    RAISE EXCEPTION 'billing_adjust_balance_changed';
  END IF;
  v_balance := v_acc.balance_minor + p_amount_minor;
  IF v_balance < 0 THEN
    RAISE EXCEPTION 'billing_insufficient_balance';
  END IF;

  INSERT INTO public.billing_account_ledger (
    workspace_id, kind, amount_minor, balance_after, currency,
    description, actor_id, idempotency_key
  ) VALUES (
    p_workspace_id, v_kind, p_amount_minor, v_balance, v_acc.currency,
    jsonb_build_object('reason', v_reason, 'category', p_category),
    p_actor_id,
    'admin:' || p_command_key
  ) RETURNING * INTO v_entry;

  UPDATE public.billing_accounts
     SET balance_minor = v_balance, updated_at = now()
   WHERE workspace_id = p_workspace_id;

  RETURN jsonb_build_object('replayed', false, 'ledger_id', v_entry.id, 'balance_minor', v_balance);
END;
$$;

DO $acl$
DECLARE f text := 'public.billing_account_admin_adjust(uuid, bigint, text, text, uuid, text, text, bigint)';
BEGIN
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
END $acl$;

DO $post$
BEGIN
  IF position('billing_adjust_rate_limited' IN pg_get_functiondef(
       'public.billing_account_admin_adjust(uuid, bigint, text, text, uuid, text, text, bigint)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'billing_adjust_rate_limit_check_failed: the adjust does not enforce the rate limit';
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE proname = 'billing_account_admin_adjust'
        AND pronamespace = 'public'::regnamespace) <> 1 THEN
    RAISE EXCEPTION 'billing_adjust_rate_limit_check_failed: billing_account_admin_adjust is overloaded';
  END IF;
END $post$;

COMMIT;
