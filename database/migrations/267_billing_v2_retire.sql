-- 267 — Billing v2 is retired: every workspace moves into simple billing
-- (docs/billing/SIMPLE_BILLING.md, phase 7, PR 7A).
--
-- What it does, in one transaction:
--   1. Preconditions: 265 (billing_lock_cutoff) and 266 (the 8-argument
--      billing_account_admin_adjust) are applied, or the file raises.
--   2. The schema billing_v2_archive and its table migration_log: one row per
--      v2 item the move acted on (or a person waived), UNIQUE per source row.
--      268 later moves the v2 tables themselves into this schema.
--   3. Simple billing stops reading v2:
--        billing_account_process_due   no longer activates a v2 `scheduled`
--                                      period (the move prepays it instead;
--                                      both together would give the customer
--                                      the period and the money back); a v2
--                                      period the move left to a person holds
--                                      the workspace as it is instead;
--        billing_account_v2_next_period names only a v2 next period the move
--                                      left to a person (needs_review): renew,
--                                      card_apply_renewal and
--                                      reminder_candidates keep refusing a
--                                      second charge for it until it is
--                                      resolved or waived; signature and
--                                      grants kept for the code from before 7A;
--        billing_account_grant_month   a v2 AI lot blocks a month only when it
--                                      was granted within the period funded,
--                                      so a period that replaced a v2 one (a
--                                      Super Admin assignment) gets its month;
--        app_review_seed_workspace     grants its plan through simple billing
--                                      instead of building a v2 period.
--   4. Three functions, executable by the migration owner (postgres) only:
--        billing_v2_migration_plan(p_workspace_id uuid DEFAULT NULL)
--          what the move would do with each v2 item: an action, or
--          `needs_review` (with details.reason), or `ignored` (with
--          details.category). Items already in migration_log are left out.
--        billing_v2_migrate_to_simple(p_apply boolean DEFAULT false)
--          false: the dry-run report. true: performs every actionable item,
--          each in its own sub-transaction, and logs it. The report is
--          {edition, apply, applied, already_done, waived, ignored:{category:n},
--           actions:[...], needs_review:[...], totals:{credited_minor, prepaid_minor}}.
--        billing_v2_migration_waive(p_source_table, p_source_id, p_reason, p_actor)
--          a person decided an open needs_review item (both NULL: all of them).
--   5. The move runs: billing_v2_migrate_to_simple(true). Its report is
--      printed as a NOTICE.
--   6. The v2 triggers on live tables go: the two that enrol every new
--      workspace into v2 (billing_v2_rollout, billing_wallet_accounts, an
--      audit row) and the one that refuses calendar AI allowance lots. Their
--      functions stay until 268. They are dropped last, so the short
--      exclusive lock on `workspaces` is held only until the COMMIT.
--
-- The move's rules (design §2.2-2.4):
--   * Money is credited only in the `iran` edition, in IRR, to an account in
--     IRR or to a new one. Never converted. In `international` every v2 money
--     item is needs_review. A credit is billing_account_admin_adjust(ws, X,
--     'IRR', reason, NULL, 'v2:<table>:<id>', 'migration'): an admin_credit
--     with category `migration` and ledger key `admin:v2:<table>:<id>`.
--   * The balance holds net money: from an invoice, subtotal - discount.
--   * A wallet balance that matches its ledger is credited; an unapplied
--     payment is credited at its invoice's net share (or amount - refunds).
--   * A `scheduled` v2 period paid by invoice is prepaid (contiguous, in the
--     future), activated (already due and still running), or credited (its
--     subscription was replaced or canceled, or the period already ended
--     without ever starting); anything else is needs_review.
--   * Subscriptions leave v2's states through billing_account_write_subscription
--     (change 'v2_migration'): past_due / free_fallback / canceled become
--     active or expired, canceled-at-period-end turns auto-renew off, a
--     pending downgrade becomes the account's scheduled change.
--   * An intent whose money v2 recorded (a linked payment that received it,
--     or its deposit in the v2 wallet) is ignored: that payment or wallet is
--     the money item. Other processing intents, succeeded intents with no
--     payment, fresh pending intents and paid invoices never applied are
--     needs_review; the report carries each item's details.
-- No v2 row is changed or deleted: the move only adds simple-billing rows and
-- log rows. needs_review items are left untouched for a person (268 refuses
-- to archive while any is open).
--
-- Compatible with the code from before 7A: every function it calls still
-- exists, the v2 tables are unchanged, the old admin grant still activates a
-- v2 period (the move ignores an active period).
--
-- Re-runnable: every step is guarded or a no-op the second time; a second
-- move finds everything in the log.
--
-- Dry run: apply the file with its final COMMIT; turned into ROLLBACK; and
-- read the NOTICE. Locks: the trigger drops need a short exclusive lock on
-- `workspaces` and `workspace_ai_balance_lots`; the file sets lock_timeout
-- to 5s, and a timeout rolls the whole file back (re-run it).

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ─── 1. Preconditions ─────────────────────────────────────────────────────
DO $pre$
BEGIN
  IF to_regprocedure('public.billing_account_admin_adjust(uuid,bigint,text,text,uuid,text,text,bigint)') IS NULL THEN
    RAISE EXCEPTION '267 needs 266_simple_billing_admin.sql (billing_account_admin_adjust with 8 arguments)';
  END IF;
  IF to_regprocedure('public.billing_lock_cutoff(uuid,text,uuid)') IS NULL THEN
    RAISE EXCEPTION '267 needs 265_billing_computed_locks.sql (billing_lock_cutoff)';
  END IF;
END
$pre$;

-- ─── 2. The archive schema and the move's log ─────────────────────────────
CREATE SCHEMA IF NOT EXISTS billing_v2_archive;
REVOKE ALL ON SCHEMA billing_v2_archive FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS billing_v2_archive.migration_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_table  text NOT NULL,
  source_id     uuid NOT NULL,
  workspace_id  uuid,
  action        text NOT NULL CHECK (action IN ('credit', 'prepay', 'activate', 'credit_replaced',
                                                'normalize', 'schedule_change', 'auto_renew_off', 'waived')),
  amount_minor  bigint,
  currency      text,
  ledger_ids    uuid[] NOT NULL DEFAULT '{}',
  details       jsonb NOT NULL DEFAULT '{}',
  actor_id      uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_table, source_id)
);
ALTER TABLE billing_v2_archive.migration_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE billing_v2_archive.migration_log FROM PUBLIC, anon, authenticated, service_role;

-- ─── 3a. process_due without v2 ───────────────────────────────────────────
-- 262's body (unchanged by 263-266, checked with pg_get_functiondef at 266)
-- without the block that activated a v2 `scheduled` period and its v_v2.
-- In its place: a v2 period still waiting for a person holds the workspace
-- (3b). 268 removes that hold with the function it calls.
CREATE OR REPLACE FUNCTION public.billing_account_process_due(p_workspace_id uuid)
RETURNS jsonb
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
  v_card     public.billing_account_cards;
  v_held     uuid;
BEGIN
  v_acc := public.billing_account_lock(p_workspace_id);
  v_sub := public.billing_account_paid_subscription(p_workspace_id);
  IF v_sub.id IS NULL OR v_sub.current_period_end > now() THEN
    RETURN jsonb_build_object('action', 'none');
  END IF;

  -- A next period paid through billing v2 that the move left to a person
  -- (billing_account_v2_next_period): the workspace stays as it is (its
  -- subscription still reads active) until that person decides. Neither a
  -- second charge from the balance nor a drop to Free.
  v_held := public.billing_account_v2_next_period(p_workspace_id);
  IF v_held IS NOT NULL THEN
    RETURN jsonb_build_object('action', 'none', 'reason', 'v2_period_needs_review', 'period_id', v_held);
  END IF;

  -- A prepayment made for another period (the period was replaced) returns.
  PERFORM public.billing_account_release_stale_prepaid(p_workspace_id);
  SELECT * INTO v_acc FROM public.billing_accounts WHERE workspace_id = p_workspace_id FOR UPDATE;
  -- The live card, if any (262).
  SELECT * INTO v_card FROM public.billing_account_cards
   WHERE workspace_id = p_workspace_id AND status IN ('active', 'past_due')
   FOR UPDATE;

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
      'amount_minor', v_acc.next_period_prepaid_minor, 'balance_minor', v_acc.balance_minor,
      'prepaid_card', v_card.id IS NOT NULL
    );
  END IF;

  -- With a live card only the card renews (its payment would have been the
  -- prepaid next period above): the balance is never spent unasked.
  IF v_card.id IS NOT NULL THEN
    v_reason := CASE WHEN coalesce(v_plan.is_free, true) THEN 'changed_to_free'
                     WHEN v_acc.auto_renew THEN 'card_not_paid'
                     ELSE 'not_renewed' END;
  ELSIF NOT coalesce(v_plan.is_free, true) AND v_acc.auto_renew THEN
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

  -- The card stops with the plan: marked canceling (which also takes it off
  -- the account and turns auto-renew off) before the subscription is
  -- written; the server cancels it at Paddle at once (card_cancel). Only a
  -- card that did not pay is 'not_renewed': its late payment buys the plan
  -- again (billing_card_apply_renewal).
  IF v_card.id IS NOT NULL THEN
    PERFORM public.billing_card_set_status(
      v_card.id, 'canceling', CASE WHEN v_reason = 'card_not_paid' THEN 'not_renewed' ELSE 'plan_ended' END
    );
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
  ) || CASE WHEN v_card.id IS NOT NULL THEN jsonb_build_object('card_cancel', jsonb_build_object(
         'card_id', v_card.id, 'provider', v_card.provider, 'subscription_id', v_card.subscription_id))
       ELSE '{}'::jsonb END;
END;
$$;

-- ─── 3b. The v2 next period: only one the move left to a person ─────────
-- Same signature, attributes and grants (CREATE OR REPLACE keeps them), so
-- the callers from 261/262 and the server code from before 7A keep working.
-- A v2 `scheduled` period the move acted on (prepaid, activated, credited)
-- or a person waived is in migration_log: it no longer counts, the simple
-- billing's own rows carry it. One the move could not decide (needs_review,
-- or an item whose apply failed) still counts until a person resolves it:
-- renew and the card refuse a second charge (billing_already_renewed), no
-- reminder is sent, and process_due holds the workspace as it is (below)
-- instead of renewing it from the balance or dropping it to Free. A period
-- on the free plan with no money never counted. The answer comes from the
-- move's own plan, the one function that reads v2 tables; only a period row
-- carries details.period_id. 268 removes the callers' conditions and then
-- the function.
CREATE OR REPLACE FUNCTION public.billing_account_v2_next_period(p_workspace_id uuid)
RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_workspace_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT pl.source_id INTO v_id
    FROM public.billing_v2_migration_plan(p_workspace_id) pl
   WHERE pl.details ? 'period_id' AND pl.action <> 'ignored'
   ORDER BY (pl.details->>'period_start')::timestamptz, pl.source_id
   LIMIT 1;
  RETURN v_id;
END;
$$;

-- ─── 3c. The App Review workspace's plan, through simple billing ──────────
-- 249's body; only the grant changes (a subscription written as Super Admin
-- writes one, and the month's AI credit), and its unused v_period goes.
CREATE OR REPLACE FUNCTION public.app_review_seed_workspace(_p jsonb, _plan uuid)
RETURNS uuid
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_owner uuid := (_p->>'owner')::uuid;
  v_acct  uuid;
  v_ws    uuid;
  v_sub   public.workspace_subscriptions%ROWTYPE;
  v_table text;
BEGIN
  SELECT id INTO v_ws FROM public.workspaces WHERE slug = 'ws_appreview';
  IF v_ws IS NULL THEN
    SELECT id INTO v_acct FROM public.accounts WHERE owner_id = v_owner ORDER BY created_at LIMIT 1;
    IF v_acct IS NULL THEN
      INSERT INTO public.accounts (name, slug, owner_id)
      VALUES ('Webyar Demo', 'acc_appreview', v_owner) RETURNING id INTO v_acct;
    END IF;
    INSERT INTO public.account_members (account_id, user_id, role) VALUES (v_acct, v_owner, 'owner')
    ON CONFLICT (account_id, user_id) DO NOTHING;
    v_ws := public.create_workspace_atomic(v_acct, 'Webyar Demo', 'ws_appreview', v_owner);
  END IF;
  UPDATE public.workspaces
     SET name = 'Webyar Demo', default_locale = 'en', panel_locale = 'en', widget_locale = 'en'
   WHERE id = v_ws;

  INSERT INTO public.workspace_members (workspace_id, user_id, role)
  VALUES (v_ws, (_p->>'me')::uuid, 'admin'), (v_ws, (_p->>'mate')::uuid, 'agent')
  ON CONFLICT (workspace_id, user_id) DO UPDATE
     SET role = EXCLUDED.role, suspended_at = NULL, suspended_by = NULL, suspend_reason = NULL;

  -- Granted as Super Admin would: the subscription until 2099 and the
  -- month's AI credit (granted once per month).
  SELECT * INTO v_sub FROM public.workspace_subscriptions WHERE workspace_id = v_ws;
  IF v_sub.plan_id IS DISTINCT FROM _plan OR v_sub.current_period_end IS NULL
     OR v_sub.current_period_end < now() + interval '1 year' THEN
    PERFORM public.billing_account_write_subscription(v_ws, _plan, 'yearly', now(),
      timestamptz '2099-12-31 00:00:00+00', 'active', 'admin_grant', NULL, '{"source":"app_review"}');
    PERFORM public.billing_account_grant_month(v_ws, _plan, now(), timestamptz '2099-12-31 00:00:00+00');
  END IF;

  FOREACH v_table IN ARRAY ARRAY['team_messages', 'conversation_notes', 'conversations', 'web_analytics_events',
                                 'visitor_page_views', 'visitor_presence', 'visitor_sessions', 'contacts',
                                 'canned_responses', 'workspace_department_members', 'workspace_departments']
  LOOP
    EXECUTE format('DELETE FROM public.%I WHERE workspace_id = $1', v_table) USING v_ws;
  END LOOP;

  WITH d AS (
    INSERT INTO public.workspace_departments (workspace_id, name, enabled, chat_enabled, audio_enabled, video_enabled, sort_order)
    VALUES (v_ws, 'Sales', true, true, true, true, 1), (v_ws, 'Support', true, true, true, true, 2)
    RETURNING id, name
  )
  INSERT INTO public.workspace_department_members (department_id, workspace_id, user_id)
  SELECT d.id, v_ws, (_p->>m.who)::uuid
    FROM d JOIN (VALUES ('Sales', 'me'), ('Support', 'me'), ('Sales', 'owner'), ('Support', 'mate')) m(name, who)
      ON m.name = d.name;
  RETURN v_ws;
END;
$$;

-- ─── 3d. The month's AI credit after a replaced v2 period ─────────────────
-- 261's billing_account_grant_month (unchanged by 262-266), with one change:
-- a billing v2 period or cycle lot blocks the month only when it was granted
-- within the period being funded. Before, any v2 lot overlapping the month
-- blocked it, so a Super Admin assignment (or anything else that starts a
-- new period) over a running v2 month granted nothing until that lot's
-- period had passed. A v2 period that simply runs on (the subscription's
-- dates are the v2 period's) is still never funded twice.
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
  -- count. Only a lot granted within this period counts (267): billing v2
  -- granted a period's lots when it started it (never before its start), so
  -- a lot granted before p_period_start belongs to a period this one
  -- replaced, such as the v2 month running when a Super Admin assigns a
  -- plan. That lot stays the customer's, and the new period is funded too,
  -- as billing v2 did.
  IF p_source = 'plan' AND EXISTS (
    SELECT 1 FROM public.workspace_ai_balance_lots
     WHERE workspace_id = p_workspace_id
       AND source_type = 'PLAN_ALLOWANCE'
       AND coalesce(allowance_source, 'plan') = 'plan'
       AND (billing_cycle_id LIKE 'period:%'
            OR (billing_cycle_id LIKE 'cycle:%' AND billing_cycle_id NOT LIKE 'cycle:account:%'))
       AND created_at >= p_period_start
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

-- ─── 4a. The plan: what the move does with each v2 item ───────────────────
-- The only function that reads v2 tables and v2 columns. Every section is
-- guarded by to_regclass (and the subscription section by its v2 columns),
-- so after 268 archives the tables it returns nothing.
--
-- action:  credit | prepay | activate | credit_replaced        (money)
--          normalize | schedule_change | auto_renew_off        (subscription)
--          needs_review (details.reason) | ignored (details.category)
-- Rows come out in apply order, section by section: subscriptions, scheduled
-- periods, then money (wallets, payments), then the review-only sources
-- (intents, invoices); the move keeps that order within a workspace. Money
-- rows carry details.credit_reason, the reason their ledger credit gets, so
-- the move itself names no v2 table (268 checks function bodies for them).
CREATE OR REPLACE FUNCTION public.billing_v2_migration_plan(p_workspace_id uuid DEFAULT NULL)
RETURNS TABLE (
  source_table text,
  source_id    uuid,
  workspace_id uuid,
  action       text,
  amount_minor bigint,
  currency     text,
  details      jsonb
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  -- 266's cap on one IRR admin credit.
  c_cap  constant bigint := 10000000000;
  v_iran boolean := public.platform_edition() = 'iran';
BEGIN
  -- ── Subscriptions (§2.4) ──
  IF to_regclass('public.workspace_subscriptions') IS NOT NULL
     AND EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid = 'public.workspace_subscriptions'::regclass
                    AND attname = 'pending_change_type' AND NOT attisdropped)
     AND EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid = 'public.workspace_subscriptions'::regclass
                    AND attname = 'billing_engine_version' AND NOT attisdropped) THEN
    RETURN QUERY
    WITH s AS (
      SELECT s.*,
             CASE
               WHEN s.status = 'free_fallback' THEN 'expired'
               WHEN s.status = 'past_due' THEN
                 CASE WHEN s.free_fallback_at IS NOT NULL OR s.current_period_end IS NULL
                           OR s.current_period_end <= now()
                      THEN 'expired' ELSE 'active' END
               WHEN s.status = 'canceled' THEN
                 CASE WHEN coalesce(s.cancel_at_period_end, false) AND s.current_period_end > now()
                      THEN 'active' ELSE 'expired' END
               ELSE s.status
             END AS eff,
             a.scheduled_plan_id AS acc_sched
        FROM public.workspace_subscriptions s
        LEFT JOIN public.billing_accounts a ON a.workspace_id = s.workspace_id
       WHERE (p_workspace_id IS NULL OR s.workspace_id = p_workspace_id)
         AND (s.billing_engine_version = 'v2'
              OR s.status IN ('past_due', 'free_fallback', 'canceled', 'unpaid', 'incomplete', 'paused', 'suspended')
              OR s.pending_change_type IS NOT NULL)
         AND NOT EXISTS (SELECT 1 FROM billing_v2_archive.migration_log l
                          WHERE l.source_table = 'workspace_subscriptions' AND l.source_id = s.id)
    ), c AS (
      SELECT s.*,
             CASE WHEN s.status IN ('past_due', 'free_fallback', 'canceled') THEN s.eff END AS target,
             (s.eff = 'active' AND (s.pending_change_type = 'cancel' OR coalesce(s.cancel_at_period_end, false)))
               AS renew_off,
             (s.eff = 'active' AND s.pending_change_type = 'downgrade' AND s.next_plan_id IS NOT NULL
               AND s.next_plan_id IS DISTINCT FROM s.plan_id) AS wants_sched
        FROM s
    ), k AS (
      SELECT c.*,
             CASE
               WHEN c.status IN ('unpaid', 'incomplete', 'paused', 'suspended') THEN 'needs_review'
               WHEN c.plan_id IS NULL THEN 'needs_review'
               WHEN c.target IS NOT NULL THEN 'normalize'
               WHEN c.wants_sched AND c.acc_sched IS NULL THEN 'schedule_change'
               WHEN c.renew_off THEN 'auto_renew_off'
               ELSE 'ignored'
             END AS act
        FROM c
    )
    SELECT 'workspace_subscriptions'::text, k.id, k.workspace_id, k.act, NULL::bigint, NULL::text,
           jsonb_strip_nulls(jsonb_build_object(
             'reason', CASE
               WHEN k.status IN ('unpaid', 'incomplete', 'paused', 'suspended') THEN 'subscription_status_' || k.status
               WHEN k.plan_id IS NULL THEN 'subscription_without_plan' END,
             'category', CASE WHEN k.act = 'ignored' THEN
               CASE WHEN k.pending_change_type = 'upgrade' THEN 'subscription_pending_upgrade'
                    WHEN k.wants_sched THEN 'subscription_schedule_kept'
                    ELSE 'subscription_unchanged' END END,
             'old_status', k.status,
             'new_status', coalesce(k.target, k.status),
             'auto_renew_off', k.renew_off,
             'scheduled_plan_id', CASE WHEN k.wants_sched AND k.acc_sched IS NULL THEN k.next_plan_id END,
             'scheduled_interval', CASE WHEN k.wants_sched AND k.acc_sched IS NULL THEN k.billing_interval END,
             'schedule_kept', CASE WHEN k.wants_sched AND k.acc_sched IS NOT NULL THEN k.acc_sched END,
             'plan_id', k.plan_id,
             'billing_interval', k.billing_interval,
             'period_start', k.current_period_start,
             'period_end', k.current_period_end,
             'v2', jsonb_build_object(
               'billing_engine_version', k.billing_engine_version,
               'current_period_id', k.current_period_id,
               'next_plan_id', k.next_plan_id,
               'pending_change_type', k.pending_change_type,
               'cancel_at_period_end', k.cancel_at_period_end,
               'canceled_at', k.canceled_at,
               'past_due_since', k.past_due_since,
               'free_fallback_at', k.free_fallback_at)
           ))
      FROM k
     ORDER BY k.workspace_id;
  END IF;

  -- ── Scheduled periods (§2.3) ──
  IF to_regclass('public.billing_subscription_periods') IS NOT NULL
     AND to_regclass('public.billing_invoices') IS NOT NULL THEN
    RETURN QUERY
    WITH p AS (
      SELECT pr.*,
             i.status AS inv_status, i.currency AS inv_currency, i.subtotal_irr, i.discount_irr,
             pl.is_free AS plan_free,
             s.id AS s_id, s.status AS s_status, s.plan_id AS s_plan, s.billing_interval AS s_interval,
             s.current_period_end AS s_end, sp.is_free AS s_plan_free,
             CASE
               WHEN s.status = 'free_fallback' THEN 'expired'
               WHEN s.status = 'past_due' THEN
                 CASE WHEN s.free_fallback_at IS NOT NULL OR s.current_period_end IS NULL
                           OR s.current_period_end <= now()
                      THEN 'expired' ELSE 'active' END
               WHEN s.status = 'canceled' THEN
                 CASE WHEN coalesce(s.cancel_at_period_end, false) AND s.current_period_end > now()
                      THEN 'active' ELSE 'expired' END
               ELSE s.status
             END AS eff,
             cur.period_end AS cur_end,
             a.currency AS acc_currency, a.next_period_prepaid_minor AS acc_prepaid, a.scheduled_plan_id AS acc_sched
        FROM public.billing_subscription_periods pr
        LEFT JOIN public.billing_invoices i ON i.id = pr.invoice_id
        LEFT JOIN public.billing_plans pl ON pl.id = pr.plan_id
        LEFT JOIN public.workspace_subscriptions s ON s.workspace_id = pr.workspace_id
        LEFT JOIN public.billing_plans sp ON sp.id = s.plan_id
        LEFT JOIN public.billing_subscription_periods cur ON cur.id = s.current_period_id
        LEFT JOIN public.billing_accounts a ON a.workspace_id = pr.workspace_id
       WHERE pr.status = 'scheduled'
         AND (p_workspace_id IS NULL OR pr.workspace_id = p_workspace_id)
         AND NOT EXISTS (SELECT 1 FROM billing_v2_archive.migration_log l
                          WHERE l.source_table = 'billing_subscription_periods' AND l.source_id = pr.id)
    ), x AS (
      SELECT p.*,
             CASE WHEN p.inv_status = 'paid' THEN p.subtotal_irr - p.discount_irr END AS amt,
             (p.s_end IS NOT NULL AND abs(extract(epoch FROM (p.period_start - p.s_end))) <= 60) AS contiguous,
             (p.cur_end IS NOT NULL AND abs(extract(epoch FROM (p.period_start - p.cur_end))) <= 60) AS follows_current,
             (p.s_id IS NULL OR p.s_end IS NULL OR p.s_end <= now() OR p.eff = 'expired') AS s_ended
        FROM p
    ), k AS (
      SELECT x.*,
             CASE
               WHEN x.amt IS NULL AND coalesce(x.plan_free, false) THEN 'ignored:period_free_plan'
               WHEN x.amt IS NULL THEN 'needs_review:period_without_payment'
               WHEN x.inv_currency IS DISTINCT FROM 'IRR' THEN 'needs_review:invoice_currency'
               WHEN x.amt <= 0 THEN 'needs_review:period_zero_amount'
               WHEN x.plan_id IS NULL OR coalesce(x.plan_free, false) THEN 'needs_review:period_paid_free_plan'
               WHEN x.amt > c_cap THEN 'needs_review:amount_over_cap'
               WHEN NOT v_iran THEN 'needs_review:edition_international'
               WHEN x.acc_currency IS NOT NULL AND x.acc_currency <> 'IRR' THEN 'needs_review:account_currency'
               WHEN x.acc_prepaid IS NOT NULL THEN 'needs_review:account_has_prepaid_period'
               WHEN x.s_status IN ('unpaid', 'incomplete', 'paused', 'suspended') THEN 'needs_review:subscription_needs_review'
               WHEN x.period_start > now() THEN
                 CASE
                   WHEN x.s_status = 'canceled' THEN 'credit_replaced:subscription_canceled'
                   WHEN x.contiguous AND x.eff = 'active' AND NOT coalesce(x.s_plan_free, true) THEN
                     CASE WHEN x.acc_sched IS NOT NULL AND x.acc_sched IS DISTINCT FROM x.plan_id
                          THEN 'needs_review:account_has_scheduled_change'
                          ELSE 'prepay' END
                   WHEN x.s_id IS NOT NULL AND x.eff = 'active' AND x.s_end > now()
                        AND NOT x.contiguous AND NOT x.follows_current THEN 'credit_replaced'
                   ELSE 'needs_review:period_not_contiguous'
                 END
               ELSE
                 CASE
                   -- Already over: it was never started (v2 started a period
                   -- only for an active subscription), so the customer had
                   -- none of it. The money returns to the balance; nothing is
                   -- activated for dates that have passed.
                   WHEN x.period_end <= now() THEN
                     CASE WHEN x.s_ended OR NOT x.follows_current THEN 'credit_replaced:period_elapsed'
                          ELSE 'needs_review:period_dates_disagree' END
                   -- The customer canceled: the move does not turn the
                   -- subscription back on; the money returns to the balance.
                   WHEN x.s_status = 'canceled' THEN 'credit_replaced:subscription_canceled'
                   WHEN x.contiguous OR (x.s_ended AND x.follows_current) THEN 'activate'
                   WHEN NOT x.follows_current THEN 'credit_replaced'
                   ELSE 'needs_review:period_dates_disagree'
                 END
             END AS verdict
        FROM x
    )
    SELECT 'billing_subscription_periods'::text, k.id, k.workspace_id,
           split_part(k.verdict, ':', 1),
           k.amt, CASE WHEN k.amt IS NOT NULL THEN 'IRR' END,
           jsonb_strip_nulls(jsonb_build_object(
             'reason', CASE WHEN k.verdict LIKE 'needs_review:%' THEN split_part(k.verdict, ':', 2) END,
             'category', CASE WHEN k.verdict LIKE 'ignored:%' THEN split_part(k.verdict, ':', 2) END,
             'credit_cause', CASE WHEN k.verdict LIKE 'credit_replaced:%' THEN split_part(k.verdict, ':', 2) END,
             'period_id', k.id,
             'plan_id', k.plan_id,
             'billing_interval', k.billing_interval,
             'period_start', k.period_start,
             'period_end', k.period_end,
             'source', k.source,
             'invoice_id', k.invoice_id,
             'invoice_status', k.inv_status,
             'vat_basis', CASE WHEN k.amt IS NOT NULL THEN 'subtotal_minus_discount' END,
             'subtotal_irr', k.subtotal_irr,
             'discount_irr', k.discount_irr,
             'subscription_id', k.s_id,
             'subscription_plan_id', k.s_plan,
             'subscription_interval', k.s_interval,
             'subscription_period_end', k.s_end,
             'subscription_status', k.eff,
             'credit_reason', CASE split_part(k.verdict, ':', 1)
               WHEN 'prepay' THEN 'Billing v2 prepaid next period'
               WHEN 'activate' THEN 'Billing v2 prepaid next period'
               WHEN 'credit_replaced' THEN
                 CASE split_part(k.verdict, ':', 2)
                   WHEN 'period_elapsed' THEN 'Billing v2 next period, never started'
                   WHEN 'subscription_canceled' THEN 'Billing v2 next period, subscription canceled'
                   ELSE 'Billing v2 next period, replaced' END END
           ))
      FROM k
     ORDER BY k.workspace_id;
  END IF;

  -- ── Wallets (§2.2) ──
  IF to_regclass('public.billing_wallet_accounts') IS NOT NULL
     AND to_regclass('public.billing_wallet_ledger') IS NOT NULL THEN
    RETURN QUERY
    WITH w AS (
      SELECT w.*,
             (SELECT coalesce(sum(l.amount_irr), 0) FROM public.billing_wallet_ledger l
               WHERE l.workspace_id = w.workspace_id) AS ledger_sum,
             EXISTS (SELECT 1 FROM public.billing_wallet_ledger l
                      WHERE l.workspace_id = w.workspace_id
                        AND l.balance_after_irr = w.available_balance_irr
                        AND l.created_at = (SELECT max(l2.created_at) FROM public.billing_wallet_ledger l2
                                             WHERE l2.workspace_id = w.workspace_id)) AS latest_matches,
             a.currency AS acc_currency
        FROM public.billing_wallet_accounts w
        LEFT JOIN public.billing_accounts a ON a.workspace_id = w.workspace_id
       WHERE (p_workspace_id IS NULL OR w.workspace_id = p_workspace_id)
         AND NOT EXISTS (SELECT 1 FROM billing_v2_archive.migration_log l
                          WHERE l.source_table = 'billing_wallet_accounts' AND l.source_id = w.id)
    ), k AS (
      SELECT w.*,
             CASE
               WHEN w.available_balance_irr <= 0 THEN 'ignored:wallet_empty'
               WHEN w.currency IS DISTINCT FROM 'IRR' THEN 'needs_review:wallet_currency'
               WHEN w.ledger_sum <> w.available_balance_irr OR NOT w.latest_matches THEN 'needs_review:wallet_ledger_mismatch'
               WHEN w.frozen THEN 'needs_review:wallet_frozen'
               WHEN w.available_balance_irr > c_cap THEN 'needs_review:amount_over_cap'
               WHEN NOT v_iran THEN 'needs_review:edition_international'
               WHEN w.acc_currency IS NOT NULL AND w.acc_currency <> 'IRR' THEN 'needs_review:account_currency'
               ELSE 'credit'
             END AS verdict
        FROM w
    )
    SELECT 'billing_wallet_accounts'::text, k.id, k.workspace_id, split_part(k.verdict, ':', 1),
           k.available_balance_irr, k.currency,
           jsonb_strip_nulls(jsonb_build_object(
             'reason', CASE WHEN k.verdict LIKE 'needs_review:%' THEN split_part(k.verdict, ':', 2) END,
             'category', CASE WHEN k.verdict LIKE 'ignored:%' THEN split_part(k.verdict, ':', 2) END,
             'ledger_sum_irr', k.ledger_sum,
             'frozen', k.frozen,
             'credit_reason', CASE WHEN k.verdict = 'credit' THEN 'Billing v2 wallet balance' END
           ))
      FROM k
     ORDER BY k.workspace_id;
  END IF;

  -- ── Payments (§2.2, D7) ──
  IF to_regclass('public.billing_payments') IS NOT NULL
     AND to_regclass('public.billing_invoices') IS NOT NULL
     AND to_regclass('public.billing_invoice_applications') IS NOT NULL
     AND to_regclass('public.billing_subscription_periods') IS NOT NULL THEN
    RETURN QUERY
    WITH b AS (
      SELECT b.*,
             i.id AS inv_id, i.subtotal_irr, i.discount_irr, i.total_irr,
             (i.id IS NOT NULL AND i.status = 'paid'
               AND i.invoice_type IN ('new_subscription', 'subscription_renewal', 'plan_upgrade', 'ai_credit_purchase')
               AND NOT EXISTS (SELECT 1 FROM public.billing_invoice_applications ap
                                WHERE ap.invoice_id = i.id AND ap.application_status = 'applied')
               AND NOT EXISTS (SELECT 1 FROM public.billing_subscription_periods sp WHERE sp.invoice_id = i.id))
               AS inv_unapplied,
             b.amount - coalesce(b.refund_amount, 0) AS gross,
             a.currency AS acc_currency
        FROM public.billing_payments b
        LEFT JOIN public.billing_invoices i ON i.id = b.invoice_id
        LEFT JOIN public.billing_accounts a ON a.workspace_id = b.workspace_id
       WHERE (p_workspace_id IS NULL OR b.workspace_id = p_workspace_id)
         AND NOT EXISTS (SELECT 1 FROM billing_v2_archive.migration_log l
                          WHERE l.source_table = 'billing_payments' AND l.source_id = b.id)
    ), n AS (
      SELECT b.*,
             CASE
               WHEN b.inv_id IS NULL THEN b.gross
               WHEN b.total_irr > 0 THEN floor(b.gross::numeric * (b.subtotal_irr - b.discount_irr) / b.total_irr)::bigint
             END AS net,
             (b.status IN ('succeeded', 'partially_refunded') AND b.reconciliation_state = 'unapplied') AS open_money
        FROM b
    ), k AS (
      SELECT n.*,
             CASE
               WHEN NOT n.open_money THEN
                 'ignored:payment_' || CASE WHEN n.status IN ('failed', 'pending', 'refunded') THEN n.status
                                            ELSE n.reconciliation_state END
               WHEN n.currency IS DISTINCT FROM 'IRR' THEN 'needs_review:payment_currency'
               WHEN n.inv_unapplied THEN 'needs_review:invoice_paid_not_applied'
               WHEN n.net IS NULL THEN 'needs_review:invoice_total_zero'
               WHEN n.net <= 0 THEN 'ignored:payment_nothing_left'
               WHEN n.net > c_cap THEN 'needs_review:amount_over_cap'
               WHEN NOT v_iran THEN 'needs_review:edition_international'
               WHEN n.acc_currency IS NOT NULL AND n.acc_currency <> 'IRR' THEN 'needs_review:account_currency'
               ELSE 'credit'
             END AS verdict
        FROM n
    )
    SELECT 'billing_payments'::text, k.id, k.workspace_id, split_part(k.verdict, ':', 1),
           CASE WHEN k.open_money THEN coalesce(k.net, k.gross) ELSE k.amount END, k.currency,
           jsonb_strip_nulls(jsonb_build_object(
             'reason', CASE WHEN k.verdict LIKE 'needs_review:%' THEN split_part(k.verdict, ':', 2) END,
             'category', CASE WHEN k.verdict LIKE 'ignored:%' THEN split_part(k.verdict, ':', 2) END,
             'status', k.status,
             'reconciliation_state', k.reconciliation_state,
             'amount', k.amount,
             'refund_amount', k.refund_amount,
             'invoice_id', k.inv_id,
             'vat_basis', CASE WHEN k.open_money THEN
               CASE WHEN k.inv_id IS NULL THEN 'amount_minus_refunds' ELSE 'invoice_net_share' END END,
             'credit_reason', CASE WHEN k.verdict = 'credit' THEN 'Billing v2 unapplied payment' END
           ))
      FROM k
     ORDER BY k.workspace_id;
  END IF;

  -- ── Payment intents (review only) ──
  -- An intent's money is counted once. When the gateway's money reached v2
  -- as a payment linked to the intent (the callback recorded it, then failed
  -- to apply it and left the intent `processing`), that payment is the item
  -- the move credits or reviews; when it reached the v2 wallet as the
  -- intent's own deposit, the wallet is. The intent is then ignored, with the
  -- link in its details. Only an intent whose money v2 never recorded is
  -- needs_review (a person checks the gateway).
  IF to_regclass('public.billing_payment_intents') IS NOT NULL
     AND to_regclass('public.billing_payments') IS NOT NULL
     AND to_regclass('public.billing_invoices') IS NOT NULL
     AND to_regclass('public.billing_wallet_ledger') IS NOT NULL THEN
    RETURN QUERY
    WITH t AS (
      SELECT t.*,
             lp.id AS lp_id, lp.status AS lp_status, lp.reconciliation_state AS lp_recon,
             (SELECT l.action FROM billing_v2_archive.migration_log l
               WHERE l.source_table = 'billing_payments' AND l.source_id = lp.id) AS lp_logged,
             i.status AS inv_status,
             (t.wallet_deposit_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM public.billing_wallet_ledger wl
                WHERE wl.wallet_deposit_id = t.wallet_deposit_id AND wl.entry_type = 'deposit')) AS deposit_credited
        FROM public.billing_payment_intents t
        LEFT JOIN LATERAL (
          SELECT b.id, b.status, b.reconciliation_state FROM public.billing_payments b
           WHERE b.payment_intent_id = t.id
           ORDER BY (b.status IN ('succeeded', 'partially_refunded', 'refunded')) DESC, b.created_at DESC, b.id
           LIMIT 1) lp ON true
        LEFT JOIN public.billing_invoices i ON i.id = t.invoice_id
       WHERE (p_workspace_id IS NULL OR t.workspace_id = p_workspace_id)
         AND NOT EXISTS (SELECT 1 FROM billing_v2_archive.migration_log l
                          WHERE l.source_table = 'billing_payment_intents' AND l.source_id = t.id)
    ), k AS (
      SELECT t.*,
             CASE
               WHEN t.status IN ('processing', 'succeeded')
                    AND t.lp_status IN ('succeeded', 'partially_refunded', 'refunded')
                 THEN 'ignored:intent_paid_via_payment'
               WHEN t.status IN ('processing', 'succeeded') AND t.deposit_credited
                 THEN 'ignored:intent_paid_via_wallet_deposit'
               WHEN t.status = 'processing' THEN 'needs_review:intent_processing'
               WHEN t.status = 'succeeded' AND t.lp_id IS NULL
                 THEN 'needs_review:intent_succeeded_without_payment'
               WHEN t.status = 'pending' AND t.created_at > now() - interval '1 day' THEN 'needs_review:intent_pending_recent'
               ELSE 'ignored:intent_' || t.status
             END AS verdict
        FROM t
    )
    SELECT 'billing_payment_intents'::text, k.id, k.workspace_id, split_part(k.verdict, ':', 1),
           coalesce(k.final_amount_irr, k.amount_irr), 'IRR'::text,
           jsonb_strip_nulls(jsonb_build_object(
             'reason', CASE WHEN k.verdict LIKE 'needs_review:%' THEN split_part(k.verdict, ':', 2) END,
             'category', CASE WHEN k.verdict LIKE 'ignored:%' THEN split_part(k.verdict, ':', 2) END,
             'status', k.status,
             'provider', k.provider_name,
             'provider_ref', k.provider_ref,
             'purchase_type', k.purchase_type,
             'created_at', k.created_at,
             'linked_payment_id', k.lp_id,
             'linked_payment_status', k.lp_status,
             'linked_payment_reconciliation_state', k.lp_recon,
             'linked_payment_migration_action', k.lp_logged,
             'invoice_id', k.invoice_id,
             'invoice_status', k.inv_status,
             'wallet_deposit_id', k.wallet_deposit_id,
             'wallet_deposit_credited', CASE WHEN k.wallet_deposit_id IS NOT NULL THEN k.deposit_credited END
           ))
      FROM k
     ORDER BY k.workspace_id;
  END IF;

  -- ── Invoices (review only) ──
  IF to_regclass('public.billing_invoices') IS NOT NULL
     AND to_regclass('public.billing_invoice_applications') IS NOT NULL
     AND to_regclass('public.billing_subscription_periods') IS NOT NULL THEN
    RETURN QUERY
    WITH k AS (
      SELECT i.*,
             CASE
               WHEN i.status = 'paid'
                    AND i.invoice_type IN ('new_subscription', 'subscription_renewal', 'plan_upgrade', 'ai_credit_purchase')
                    AND NOT EXISTS (SELECT 1 FROM public.billing_invoice_applications ap
                                     WHERE ap.invoice_id = i.id AND ap.application_status = 'applied')
                    AND NOT EXISTS (SELECT 1 FROM public.billing_subscription_periods sp WHERE sp.invoice_id = i.id)
                 THEN 'needs_review:invoice_paid_not_applied'
               ELSE 'ignored:invoice_' || i.status
             END AS verdict
        FROM public.billing_invoices i
       WHERE (p_workspace_id IS NULL OR i.workspace_id = p_workspace_id)
         AND NOT EXISTS (SELECT 1 FROM billing_v2_archive.migration_log l
                          WHERE l.source_table = 'billing_invoices' AND l.source_id = i.id)
    )
    SELECT 'billing_invoices'::text, k.id, k.workspace_id, split_part(k.verdict, ':', 1),
           k.subtotal_irr - k.discount_irr, k.currency,
           jsonb_strip_nulls(jsonb_build_object(
             'reason', CASE WHEN k.verdict LIKE 'needs_review:%' THEN split_part(k.verdict, ':', 2) END,
             'category', CASE WHEN k.verdict LIKE 'ignored:%' THEN split_part(k.verdict, ':', 2) END,
             'invoice_number', k.invoice_number,
             'invoice_type', k.invoice_type,
             'status', k.status,
             'vat_basis', 'subtotal_minus_discount'
           ))
      FROM k
     ORDER BY k.workspace_id;
  END IF;
END;
$$;

-- ─── 4b. The move ─────────────────────────────────────────────────────────
-- Per workspace (in id order): with p_apply, a workspace with something to do
-- takes the account lock first (simple billing's lock order) and its plan is
-- read again under it, so an item acts on what is true now. Its items then run in order
-- (subscription, scheduled period, money), each in its own sub-transaction:
-- an error rolls that item back and reports it as needs_review with the
-- error; the workspace's later items are then reported, not run. Every
-- applied item writes one log row, so a second run finds nothing to do.
CREATE OR REPLACE FUNCTION public.billing_v2_migrate_to_simple(p_apply boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_all        jsonb;
  v_rows       jsonb;
  v_ws         uuid;
  v_failed     boolean;
  r            record;
  v_res        jsonb;
  v_debit      public.billing_account_ledger;
  v_sub        public.workspace_subscriptions;
  v_ledger     uuid[];
  v_item       jsonb;
  v_applied    integer := 0;
  v_ignored    jsonb := '{}'::jsonb;
  v_review     jsonb := '[]'::jsonb;
  v_actions    jsonb := '[]'::jsonb;
  v_credited   bigint := 0;
  v_prepaid    bigint := 0;
  v_cat        text;
  v_reason     text;
BEGIN
  -- One snapshot of the whole plan; a workspace with something to do is
  -- read again under its lock.
  SELECT coalesce(jsonb_agg(to_jsonb(pl) - 'ord' ORDER BY pl.ord), '[]'::jsonb) INTO v_all
    FROM public.billing_v2_migration_plan(NULL) WITH ORDINALITY
         AS pl(source_table, source_id, workspace_id, action, amount_minor, currency, details, ord);

  FOR v_ws IN
    SELECT DISTINCT (e->>'workspace_id')::uuid FROM jsonb_array_elements(v_all) e ORDER BY 1
  LOOP
    SELECT jsonb_agg(e ORDER BY n) INTO v_rows
      FROM jsonb_array_elements(v_all) WITH ORDINALITY AS a(e, n)
     WHERE (e->>'workspace_id')::uuid = v_ws;
    IF p_apply AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_rows) e
                            WHERE e->>'action' NOT IN ('needs_review', 'ignored')) THEN
      PERFORM public.billing_account_lock(v_ws);
      SELECT coalesce(jsonb_agg(to_jsonb(pl) - 'ord' ORDER BY pl.ord), '[]'::jsonb) INTO v_rows
        FROM public.billing_v2_migration_plan(v_ws) WITH ORDINALITY
         AS pl(source_table, source_id, workspace_id, action, amount_minor, currency, details, ord);
    END IF;
    v_failed := false;

    FOR r IN
      -- The plan's own order: subscription, scheduled period, money.
      SELECT x.source_table, x.source_id, x.workspace_id, x.action, x.amount_minor, x.currency, x.details
        FROM jsonb_array_elements(v_rows) WITH ORDINALITY AS a(e, n),
             jsonb_to_record(a.e) AS x(source_table text, source_id uuid, workspace_id uuid,
                                       action text, amount_minor bigint, currency text, details jsonb)
       ORDER BY a.n
    LOOP
      v_item := jsonb_build_object(
        'source_table', r.source_table, 'source_id', r.source_id, 'workspace_id', r.workspace_id,
        'action', r.action, 'amount_minor', r.amount_minor, 'currency', r.currency);

      IF r.action = 'ignored' THEN
        v_cat := coalesce(r.details->>'category', 'other');
        v_ignored := v_ignored || jsonb_build_object(v_cat, coalesce((v_ignored->>v_cat)::integer, 0) + 1);
        CONTINUE;
      END IF;

      IF r.action = 'needs_review' THEN
        v_review := v_review || jsonb_build_array(
          (v_item - 'action') || jsonb_build_object('reason', r.details->>'reason', 'details', r.details));
        CONTINUE;
      END IF;

      IF NOT p_apply THEN
        v_actions := v_actions || jsonb_build_array(v_item);
        IF r.action IN ('credit', 'prepay', 'activate', 'credit_replaced') THEN
          v_credited := v_credited + r.amount_minor;
        END IF;
        IF r.action IN ('prepay', 'activate') THEN
          v_prepaid := v_prepaid + r.amount_minor;
        END IF;
        CONTINUE;
      END IF;

      IF v_failed THEN
        v_review := v_review || jsonb_build_array(
          (v_item - 'action') || jsonb_build_object('reason', 'earlier_item_failed', 'planned_action', r.action));
        CONTINUE;
      END IF;

      BEGIN
        v_ledger := '{}';

        IF r.action IN ('normalize', 'schedule_change', 'auto_renew_off') THEN
          SELECT * INTO v_sub FROM public.workspace_subscriptions WHERE id = r.source_id FOR UPDATE;
          PERFORM public.billing_account_write_subscription(
            r.workspace_id, v_sub.plan_id, v_sub.billing_interval,
            v_sub.current_period_start, v_sub.current_period_end,
            r.details->>'new_status', 'v2_migration', NULL,
            jsonb_build_object('source', 'billing_v2_migration', 'v2', r.details->'v2',
                               'auto_renew_off', (r.details->>'auto_renew_off')::boolean,
                               'scheduled_plan_id', r.details->'scheduled_plan_id'));
          IF coalesce((r.details->>'auto_renew_off')::boolean, false) THEN
            UPDATE public.billing_accounts SET auto_renew = false, updated_at = now()
             WHERE workspace_id = r.workspace_id;
          END IF;
          IF r.details ? 'scheduled_plan_id' THEN
            UPDATE public.billing_accounts
               SET scheduled_plan_id = (r.details->>'scheduled_plan_id')::uuid,
                   scheduled_interval = r.details->>'scheduled_interval',
                   updated_at = now()
             WHERE workspace_id = r.workspace_id;
          END IF;

        ELSE
          -- Money: an admin credit in IRR (iran only; the plan made sure),
          -- category `migration`, keyed by the source row.
          v_reason := r.details->>'credit_reason';
          IF public.platform_edition() <> 'iran' OR r.currency IS DISTINCT FROM 'IRR' THEN
            RAISE EXCEPTION 'billing_v2_move_not_iran_irr';
          END IF;
          v_res := public.billing_account_admin_adjust(
            r.workspace_id, r.amount_minor, 'IRR', v_reason, NULL,
            'v2:' || r.source_table || ':' || r.source_id::text, 'migration');
          v_ledger := v_ledger || (v_res->>'ledger_id')::uuid;

          IF r.action IN ('prepay', 'activate') THEN
            v_debit := public.billing_account_debit(
              r.workspace_id, 'renewal', r.amount_minor,
              (r.details->>'plan_id')::uuid, r.details->>'billing_interval',
              (r.details->>'period_start')::timestamptz, (r.details->>'period_end')::timestamptz,
              jsonb_build_object('source', 'billing_v2_migration', 'period_id', r.source_id),
              NULL, 'v2:prepay:' || r.source_id::text);
            v_ledger := v_ledger || v_debit.id;
          END IF;

          IF r.action = 'prepay' THEN
            UPDATE public.billing_accounts
               SET next_period_prepaid_minor = r.amount_minor,
                   next_period_start = (r.details->>'subscription_period_end')::timestamptz,
                   scheduled_plan_id = nullif((r.details->>'plan_id')::uuid, (r.details->>'subscription_plan_id')::uuid),
                   scheduled_interval = nullif(r.details->>'billing_interval', r.details->>'subscription_interval'),
                   updated_at = now()
             WHERE workspace_id = r.workspace_id;
          ELSIF r.action = 'activate' THEN
            PERFORM public.billing_account_write_subscription(
              r.workspace_id, (r.details->>'plan_id')::uuid, r.details->>'billing_interval',
              (r.details->>'period_start')::timestamptz, (r.details->>'period_end')::timestamptz,
              'active', 'renewal', NULL,
              jsonb_build_object('source', 'billing_v2_migration', 'period_id', r.source_id));
            PERFORM public.billing_account_grant_month(
              r.workspace_id, (r.details->>'plan_id')::uuid,
              (r.details->>'period_start')::timestamptz, (r.details->>'period_end')::timestamptz);
          END IF;
        END IF;

        INSERT INTO billing_v2_archive.migration_log
          (source_table, source_id, workspace_id, action, amount_minor, currency, ledger_ids, details)
        VALUES (r.source_table, r.source_id, r.workspace_id, r.action, r.amount_minor, r.currency, v_ledger, r.details);

        v_applied := v_applied + 1;
        v_actions := v_actions || jsonb_build_array(v_item);
        IF r.action IN ('credit', 'prepay', 'activate', 'credit_replaced') THEN
          v_credited := v_credited + r.amount_minor;
        END IF;
        IF r.action IN ('prepay', 'activate') THEN
          v_prepaid := v_prepaid + r.amount_minor;
        END IF;
      EXCEPTION WHEN OTHERS THEN
        v_failed := true;
        v_review := v_review || jsonb_build_array(
          (v_item - 'action') || jsonb_build_object('reason', 'apply_failed', 'planned_action', r.action, 'error', SQLERRM));
      END;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object(
    'edition', public.platform_edition(),
    'apply', p_apply,
    'applied', v_applied,
    'already_done', (SELECT count(*) FROM billing_v2_archive.migration_log WHERE action <> 'waived') - v_applied,
    'waived', (SELECT count(*) FROM billing_v2_archive.migration_log WHERE action = 'waived'),
    'ignored', v_ignored,
    'actions', v_actions,
    'needs_review', v_review,
    'totals', jsonb_build_object('credited_minor', v_credited, 'prepaid_minor', v_prepaid)
  );
END;
$$;

-- ─── 4c. A person's decision on a needs_review item ───────────────────────
-- One item (both arguments given) or every open item (both NULL; used for
-- RESPOK's clone residue). An item already in the log is a no-op; an item
-- that is not an open needs_review item is refused.
CREATE OR REPLACE FUNCTION public.billing_v2_migration_waive(
  p_source_table text,
  p_source_id    uuid,
  p_reason       text,
  p_actor        uuid DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_reason text := btrim(coalesce(p_reason, ''));
  r        record;
  v_found  boolean := false;
BEGIN
  IF char_length(v_reason) < 3 THEN
    RAISE EXCEPTION 'billing_v2_waive_reason_required';
  END IF;
  IF (p_source_table IS NULL) <> (p_source_id IS NULL) THEN
    RAISE EXCEPTION 'billing_v2_waive_bad_item';
  END IF;
  IF p_source_table IS NOT NULL AND EXISTS (
    SELECT 1 FROM billing_v2_archive.migration_log l
     WHERE l.source_table = p_source_table AND l.source_id = p_source_id
  ) THEN
    RETURN;
  END IF;

  FOR r IN
    SELECT pl.* FROM public.billing_v2_migration_plan(NULL) pl
     WHERE pl.action = 'needs_review'
       AND (p_source_table IS NULL OR (pl.source_table = p_source_table AND pl.source_id = p_source_id))
  LOOP
    v_found := true;
    INSERT INTO billing_v2_archive.migration_log
      (source_table, source_id, workspace_id, action, amount_minor, currency, details, actor_id)
    VALUES (r.source_table, r.source_id, r.workspace_id, 'waived', r.amount_minor, r.currency,
            jsonb_build_object('reason', v_reason, 'review_reason', r.details->>'reason', 'item', r.details),
            p_actor)
    ON CONFLICT (source_table, source_id) DO NOTHING;
  END LOOP;

  IF p_source_table IS NOT NULL AND NOT v_found THEN
    RAISE EXCEPTION 'billing_v2_waive_not_open:%:%', p_source_table, p_source_id;
  END IF;
END;
$$;

-- Only the migration owner (postgres, an operator) reaches the three.
REVOKE ALL ON FUNCTION public.billing_v2_migration_plan(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.billing_v2_migrate_to_simple(boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.billing_v2_migration_waive(text, uuid, text, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- ─── 5. The move ──────────────────────────────────────────────────────────
DO $move$
DECLARE
  r jsonb;
BEGIN
  r := public.billing_v2_migrate_to_simple(true);
  RAISE NOTICE 'billing v2 move: %', r;
END
$move$;

-- ─── 6. No more v2 triggers on live tables ────────────────────────────────
-- Last, so their exclusive locks are held only until the COMMIT below.
DROP TRIGGER IF EXISTS trg_billing_enroll_workspace ON public.workspaces;
DROP TRIGGER IF EXISTS trg_billing_v2_seed_new_workspace ON public.workspaces;
DROP TRIGGER IF EXISTS trg_billing_v2_block_legacy_allowance ON public.workspace_ai_balance_lots;

COMMIT;
