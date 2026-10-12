-- 268 — Billing v2 is archived: its tables move intact into the schema
-- billing_v2_archive, its functions, triggers and workspace_subscriptions
-- columns go (docs/billing/SIMPLE_BILLING.md, phase 7, PR 7B).
--
-- 267 moved every workspace into simple billing and stopped every reader of
-- v2 but one hold (process_due, renew, the saved card and the reminders
-- still asked billing_account_v2_next_period about a v2 period left to a
-- person). After a soak with every database's move report empty, this file:
--
--   1. Guards, before any change (each raises, and nothing is changed):
--        * 267 is applied (billing_v2_archive.migration_log, and the move's
--          functions while a v2 table is still in public);
--        * the move runs once more (billing_v2_migrate_to_simple(true)): it
--          picks up anything written between 267 and 7A's deploy;
--        * no needs_review item is open: `billing_v2_unmigrated: n item(s)`
--          with up to 20 of them. Resolve each (billing_v2_migrate_to_simple)
--          or waive it (billing_v2_migration_waive), then run this again;
--        * every money item the move logged is in the ledger: its admin
--          credit row exists, and per currency the log's total equals the
--          ledger's `admin:v2:` credits (workspaces deleted since are left
--          out: their ledger went with them).
--   2. Simple billing stops asking about v2: renew, card_apply_renewal,
--      reminder_candidates and process_due lose the condition (and the hold)
--      on billing_account_v2_next_period, which then goes;
--      billing_account_write_subscription no longer clears the columns that
--      go in 4; admin_reset_settings_tables no longer names v2 tables.
--   3. Every trigger on a v2 table, then every v2 function: billing_v2_*
--      (the move's three functions too: their work is done, and their log
--      stays), the v2 engine, wallet, legacy allowance, freeze guards,
--      notifications, enrolment and admin_reset_billing_data. Kept:
--      billing_touch_updated_at (billing_gateways), billing_purge_active,
--      expire_stale_trials, every billing_account_* / billing_card_* /
--      billing_lock* / billing_admin_* function. No CASCADE anywhere: an
--      object still using one of them stops the file.
--   4. The 9 v2 columns of workspace_subscriptions (design D11), with their
--      foreign keys and checks: current_period_id,
--      v2_allowance_effective_period_id, billing_engine_version,
--      billing_v2_effective_at, billing_anchor_at, next_invoice_at,
--      next_plan_id, pending_change_type, pending_change_currency.
--      billing_interval, trial_start, free_fallback_at, past_due_since,
--      grace_period_ends_at and canceled_at stay (they still have readers).
--   5. The 28 v2 tables move to billing_v2_archive with every row, index,
--      identity, check and foreign key between them (ALTER TABLE … SET
--      SCHEMA; nothing is copied or deleted). Before the move each loses its
--      policies and its foreign keys to tables that stay (workspaces,
--      billing_plans, workspace_subscriptions), so a workspace or plan delete
--      neither stops at an archived row nor cascades into one. After it no
--      application role (PUBLIC, anon, authenticated, service_role) can read
--      them; row level security stays on, with no policy.
--   6. Data:
--        * the email templates only billing v2 sent (subscription_activated,
--          wallet_deposit_received, ai_credit_purchased, trial_ending_soon,
--          trial_expired) are copied into billing_v2_archive.email_templates,
--          then deleted from public.email_templates;
--        * the retention policies of the archived tables are deleted (the
--          retention job reads public);
--        * plans with limits.included_ai_allowance_irr and no ai_allowance.IRR
--          get it (design D14): billing_plan_ai_allowance reads
--          ai_allowance.IRR first, so a plan's month is the same as before.
--   7. Backups: the role webyar_backup (the in-app pg_dump's login), when it
--      exists and does not already read everything through pg_read_all_data,
--      may read billing_v2_archive.
--   8. Post-checks (one exception lists every failure): no v2 table left in
--      public; no foreign key across the archive's edge; outside the archive
--      no function body, view, trigger or policy names an archived table, a
--      dropped column or a removed function, and no function or view depends
--      on an archived table; the application roles cannot reach the archive.
--
-- Restoring a table is `ALTER TABLE billing_v2_archive.x SET SCHEMA public`
-- by a person; the data comes back, the v2 engine does not. No migration may
-- drop the archive or its tables (src/test/ci/migrationDataDestruction.test.ts).
--
-- One transaction; lock_timeout 5s. ALTER TABLE workspace_subscriptions, the
-- trigger drops and the foreign keys dropped in 5 (their other ends are
-- workspaces, billing_plans and workspace_subscriptions) take short
-- exclusive locks until the COMMIT: a lock timeout rolls the whole file
-- back, run it again. Re-runnable: every step is guarded, and a
-- second run finds nothing to do. Dry run: the file with its final COMMIT;
-- turned into ROLLBACK;.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ─── 0. What this file archives and removes ───────────────────────────────
DROP TABLE IF EXISTS pg_temp.v2_archive_tables, pg_temp.v2_dropped_columns, pg_temp.v2_removed_functions;
CREATE TEMP TABLE v2_archive_tables (name text PRIMARY KEY) ON COMMIT DROP;
INSERT INTO pg_temp.v2_archive_tables (name) VALUES
  ('billing_payments'), ('billing_payment_intents'), ('billing_subscription_applications'),
  ('billing_invoices'), ('billing_invoice_lines'), ('billing_subscription_periods'),
  ('billing_invoice_applications'), ('billing_invoice_collections'), ('billing_wallet_accounts'),
  ('billing_wallet_ledger'), ('billing_wallet_deposits'), ('billing_payment_allocations'),
  ('billing_v2_audit'), ('billing_v2_rollout'), ('billing_v2_policy'), ('billing_v2_workspace_policy'),
  ('billing_v2_jobs'), ('billing_v2_worker_health'), ('billing_period_allowance_grants'),
  ('billing_entitlement_cycles'), ('billing_notification_jobs'), ('billing_retention_signals'),
  ('billing_currencies'), ('billing_exchange_rates'), ('billing_tax_rates'), ('billing_coupons'),
  ('billing_coupon_redemptions'), ('billing_usage_items');

CREATE TEMP TABLE v2_dropped_columns (name text PRIMARY KEY) ON COMMIT DROP;
INSERT INTO pg_temp.v2_dropped_columns (name) VALUES
  ('current_period_id'), ('v2_allowance_effective_period_id'), ('billing_engine_version'),
  ('billing_v2_effective_at'), ('billing_anchor_at'), ('next_invoice_at'), ('next_plan_id'),
  ('pending_change_type'), ('pending_change_currency');

-- Besides every billing_v2_* function.
CREATE TEMP TABLE v2_removed_functions (name text PRIMARY KEY) ON COMMIT DROP;
INSERT INTO pg_temp.v2_removed_functions (name) VALUES
  -- the core
  ('billing_activate_due_periods'), ('billing_activate_period'), ('billing_apply_invoice_effects'),
  ('billing_apply_subscription_payment'), ('billing_begin_collection'), ('billing_expire_stale_collections'),
  ('billing_recover_unapplied_invoices'), ('billing_release_collection'), ('billing_settle_invoice'),
  -- wallet and legacy allowance
  ('billing_wallet_admin_adjust'), ('billing_wallet_append'), ('billing_wallet_apply_deposit'),
  ('billing_wallet_lock'), ('billing_wallet_reconcile'), ('billing_wallet_refund'), ('billing_wallet_pay_invoice'),
  ('billing_legacy_allowance_active'), ('billing_retire_legacy_allowance'),
  -- freeze and append-only guards
  ('billing_invoice_line_freeze'), ('billing_engine_version_freeze'), ('billing_entitlement_cycle_freeze'),
  ('billing_invoice_freeze'), ('billing_period_freeze'), ('billing_invoice_application_block_mutation'),
  ('billing_wallet_ledger_block_mutation'), ('billing_allocation_block_mutation'),
  -- notifications, enrolment, reset
  ('billing_notify_payment_recorded'), ('billing_notify_subscription_lifecycle'), ('billing_notify_trial_ending'),
  ('billing_enroll_workspace'), ('admin_reset_billing_data'),
  -- 267's hold
  ('billing_account_v2_next_period');

-- ─── 1. Guards ────────────────────────────────────────────────────────────
DO $guard$
DECLARE
  v_left    integer;
  v_report  jsonb;
  v_review  jsonb;
  v_bad     text;
BEGIN
  IF to_regclass('billing_v2_archive.migration_log') IS NULL THEN
    RAISE EXCEPTION '268 needs 267_billing_v2_retire.sql (billing_v2_archive.migration_log)';
  END IF;
  SELECT count(*) INTO v_left FROM pg_temp.v2_archive_tables t WHERE to_regclass('public.' || t.name) IS NOT NULL;

  -- The move once more, then nothing may be left to a person.
  IF v_left > 0 THEN
    IF to_regprocedure('public.billing_v2_migrate_to_simple(boolean)') IS NULL THEN
      RAISE EXCEPTION '268 needs 267_billing_v2_retire.sql (billing_v2_migrate_to_simple): % v2 table(s) still in public', v_left;
    END IF;
    v_report := public.billing_v2_migrate_to_simple(true);
    RAISE NOTICE 'billing v2 move before the archive: %', v_report - 'actions' - 'needs_review'
      || jsonb_build_object('applied_now', v_report->'actions', 'needs_review', jsonb_array_length(v_report->'needs_review'));
    v_review := v_report->'needs_review';
    IF jsonb_array_length(v_review) > 0 THEN
      RAISE EXCEPTION 'billing_v2_unmigrated: % item(s): %', jsonb_array_length(v_review),
        (SELECT string_agg(format('%s %s (workspace %s, %s%s)', e->>'source_table', e->>'source_id', e->>'workspace_id',
                                  e->>'reason', coalesce(', ' || (e->>'amount_minor') || ' ' || (e->>'currency'), '')),
                           '; ' ORDER BY n)
           FROM jsonb_array_elements(v_review) WITH ORDINALITY AS a(e, n) WHERE n <= 20)
        USING HINT = 'Nothing was changed. Resolve each item (SELECT public.billing_v2_migrate_to_simple(false) lists them) '
                     'or waive it with public.billing_v2_migration_waive(table, id, reason), then apply 268 again.';
    END IF;
  END IF;

  -- Every money item the move logged is in the ledger, as the credit it made.
  SELECT string_agg(format('%s %s', l.source_table, l.source_id), ', ') INTO v_bad
    FROM billing_v2_archive.migration_log l
   WHERE l.action IN ('credit', 'prepay', 'activate', 'credit_replaced')
     AND EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = l.workspace_id)
     AND (NOT EXISTS (SELECT 1 FROM public.billing_account_ledger g
                       WHERE g.id = l.ledger_ids[1] AND g.kind = 'admin_credit'
                         AND g.amount_minor = l.amount_minor AND g.currency = l.currency
                         AND g.idempotency_key = 'admin:v2:' || l.source_table || ':' || l.source_id::text)
          OR EXISTS (SELECT 1 FROM unnest(l.ledger_ids) x(id)
                      WHERE NOT EXISTS (SELECT 1 FROM public.billing_account_ledger g WHERE g.id = x.id)));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'billing_v2_log_ledger_mismatch: logged money items without their ledger rows: %', v_bad;
  END IF;
  SELECT string_agg(format('%s: log %s, ledger %s', c.currency, c.logged, c.booked), '; ') INTO v_bad
    FROM (
      SELECT coalesce(a.currency, b.currency) AS currency, coalesce(a.total, 0) AS logged, coalesce(b.total, 0) AS booked
        FROM (SELECT l.currency, sum(l.amount_minor) AS total
                FROM billing_v2_archive.migration_log l
               WHERE l.action IN ('credit', 'prepay', 'activate', 'credit_replaced')
                 AND EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = l.workspace_id)
               GROUP BY l.currency) a
        FULL JOIN (SELECT g.currency, sum(g.amount_minor) AS total
                     FROM public.billing_account_ledger g
                    WHERE g.kind = 'admin_credit' AND g.idempotency_key LIKE 'admin:v2:%'
                    GROUP BY g.currency) b ON b.currency = a.currency
    ) c
   WHERE c.logged <> c.booked;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'billing_v2_log_ledger_mismatch: totals per currency differ: %', v_bad;
  END IF;
END
$guard$;

-- ─── 2a. No trigger on a v2 table ─────────────────────────────────────────
-- Their functions go in 3; the tables are written by nothing any more.
DO $triggers$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname, t.tgname
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relnamespace = 'public'::regnamespace
       AND c.relname IN (SELECT name FROM pg_temp.v2_archive_tables)
       AND NOT t.tgisinternal
     ORDER BY 1, 2
  LOOP
    EXECUTE format('DROP TRIGGER %I ON public.%I', r.tgname, r.relname);
  END LOOP;
END
$triggers$;

-- ─── 2b. Simple billing without billing_account_v2_next_period ────────────
-- Each is its latest definition (renew, card_apply_renewal and
-- reminder_candidates: 262; process_due: 267; checked with
-- pg_get_functiondef at 267) with only the v2 condition removed. CREATE OR
-- REPLACE keeps their grants.

-- 262's renewal without the v2 next period's ALREADY_RENEWED.
CREATE OR REPLACE FUNCTION public.billing_account_renew(
  p_workspace_id         uuid,
  p_actor                uuid DEFAULT NULL,
  p_expected_period_end  timestamptz DEFAULT NULL,
  p_expected_price_minor bigint DEFAULT NULL,
  p_price_override_minor bigint DEFAULT NULL
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
  IF v_acc.next_period_prepaid_minor IS NOT NULL THEN
    RAISE EXCEPTION 'billing_already_renewed';
  END IF;
  v_target := coalesce(v_acc.scheduled_plan_id, v_sub.plan_id);
  v_interval := coalesce(v_acc.scheduled_interval, v_sub.billing_interval, 'monthly');
  SELECT * INTO v_plan FROM public.billing_plans WHERE id = v_target;
  IF v_plan.is_free THEN
    RAISE EXCEPTION 'billing_renewal_to_free';
  END IF;
  v_price := CASE WHEN p_price_override_minor IS NOT NULL THEN p_price_override_minor
                  ELSE public.billing_plan_price(v_target, v_acc.currency, v_interval) END;
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

-- 262's card renewal without the v2 next period's already_renewed.
CREATE OR REPLACE FUNCTION public.billing_card_apply_renewal(
  p_payment public.billing_account_payments
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_card     public.billing_account_cards;
  v_acc      public.billing_accounts;
  v_sub      public.workspace_subscriptions;
  v_plan     public.billing_plans;
  v_target   uuid;
  v_interval text;
  v_price    bigint;
  v_charged  bigint;
BEGIN
  SELECT * INTO v_card FROM public.billing_account_cards WHERE id = p_payment.card_id;
  IF v_card.id IS NULL THEN
    RETURN jsonb_build_object('error', 'card_not_found');
  END IF;
  SELECT * INTO v_acc FROM public.billing_accounts WHERE workspace_id = p_payment.workspace_id FOR UPDATE;
  v_sub := public.billing_account_paid_subscription(p_payment.workspace_id);
  IF v_sub.id IS NULL THEN
    IF v_card.status IN ('canceling', 'canceled') AND v_card.cancel_reason = 'not_renewed'
       AND p_payment.purpose_detail ? 'plan_id' THEN
      v_interval := coalesce(p_payment.purpose_detail ->> 'billing_interval', 'monthly');
      v_price := public.billing_plan_price((p_payment.purpose_detail ->> 'plan_id')::uuid, v_acc.currency, v_interval);
      IF v_price IS NULL OR v_price <= 0 THEN
        RETURN jsonb_build_object('error', 'price_unavailable', 'late', true);
      END IF;
      IF p_payment.net_minor < v_price THEN
        RETURN jsonb_build_object('error', 'amount_below_price', 'late', true);
      END IF;
      RETURN public.billing_account_purchase_plan(
        p_payment.workspace_id, (p_payment.purpose_detail ->> 'plan_id')::uuid, v_interval,
        'payment:' || p_payment.id::text, NULL
      ) || jsonb_build_object('card', true, 'late', true);
    END IF;
    RETURN jsonb_build_object('error', 'no_paid_plan');
  END IF;
  IF v_card.status NOT IN ('active', 'past_due')
     OR v_acc.card_provider IS DISTINCT FROM v_card.provider
     OR v_acc.card_subscription_id IS DISTINCT FROM v_card.subscription_id THEN
    RETURN jsonb_build_object('error', 'card_not_live');
  END IF;
  IF NOT v_acc.auto_renew THEN
    RETURN jsonb_build_object('error', 'auto_renew_off');
  END IF;
  IF v_acc.next_period_prepaid_minor IS NOT NULL AND v_acc.next_period_start IS NOT DISTINCT FROM v_sub.current_period_end THEN
    RETURN jsonb_build_object('error', 'already_renewed');
  END IF;
  v_target := coalesce(v_acc.scheduled_plan_id, v_sub.plan_id);
  v_interval := coalesce(v_acc.scheduled_interval, v_sub.billing_interval, 'monthly');
  SELECT * INTO v_plan FROM public.billing_plans WHERE id = v_target;
  IF v_plan.is_free THEN
    RETURN jsonb_build_object('error', 'renewal_to_free');
  END IF;
  v_price := public.billing_plan_price(v_target, v_acc.currency, v_interval);
  IF v_price IS NULL OR v_price <= 0 THEN
    RETURN jsonb_build_object('error', 'price_unavailable');
  END IF;
  -- Charged for exactly this plan and interval: the item the reconciler set,
  -- whose price may not have caught up with a rise (Paddle's lock and our
  -- freeze before the charge). That price is the one spent.
  IF p_payment.purpose_detail ->> 'plan_id' = v_target::text
     AND p_payment.purpose_detail ->> 'billing_interval' = v_interval THEN
    v_charged := least(p_payment.net_minor, v_price);
  ELSIF p_payment.net_minor < v_price THEN
    RETURN jsonb_build_object('error', 'amount_below_price');
  END IF;
  RETURN public.billing_account_renew(
           p_payment.workspace_id, NULL, v_sub.current_period_end, coalesce(v_charged, v_price), v_charged)
    || jsonb_build_object('card', true);
END;
$$;

-- 262's renewal reminders without the v2 next period's exclusion.
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
     AND NOT coalesce(t.is_free, true)
     AND NOT (
       coalesce(a.auto_renew, false)
       AND coalesce(a.balance_minor, 0) >= coalesce(public.billing_plan_price(
             coalesce(a.scheduled_plan_id, s.plan_id),
             coalesce(a.currency, public.billing_region_currency()),
             coalesce(a.scheduled_interval, s.billing_interval, 'monthly')), 9223372036854775807)
     )
     AND NOT (
       coalesce(a.auto_renew, false)
       AND coalesce(public.billing_plan_price(
             coalesce(a.scheduled_plan_id, s.plan_id),
             coalesce(a.currency, public.billing_region_currency()),
             coalesce(a.scheduled_interval, s.billing_interval, 'monthly')), 0) > 0
       AND EXISTS (
         SELECT 1 FROM public.billing_account_cards c
          WHERE c.workspace_id = s.workspace_id AND c.status = 'active'
       )
     )
$$;

-- 267's due moment without its hold for a v2 period left to a person (the
-- guard in 1 made sure none is left).
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
BEGIN
  v_acc := public.billing_account_lock(p_workspace_id);
  v_sub := public.billing_account_paid_subscription(p_workspace_id);
  IF v_sub.id IS NULL OR v_sub.current_period_end > now() THEN
    RETURN jsonb_build_object('action', 'none');
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

-- 261's subscription writer without the columns dropped in 4 (it still
-- clears canceled_at, past_due_since, grace_period_ends_at and
-- free_fallback_at, which stay: design D11).
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

-- ─── 2c. Gone: the v2 next period ─────────────────────────────────────────
DROP FUNCTION IF EXISTS public.billing_account_v2_next_period(uuid);

-- ─── 2d. Settings kept by Super Admin's data reset, without v2 tables ─────
-- 137's list without the v2 configuration tables archived in 5.
CREATE OR REPLACE FUNCTION public.admin_reset_settings_tables()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT array[
    'platform_settings','platform_branding','platform_branding_localized',
    'platform_call_center_settings','platform_ai_agent_settings','platform_domains',
    'platform_sms_provider_config','app_runtime_config','feature_flags',
    'billing_plans','role_permissions','translations','legal_policy_versions',
    'email_settings','email_settings_localized','email_templates',
    'ai_models','ai_rate_cards','ai_rate_card_components','ai_sell_policies',
    'ai_exchange_rates','provider_configs','verification_purpose_settings',
    'widget_platform_settings','widget_settings','widget_prechat_settings',
    'workspaces','workspace_settings','workspace_members','workspace_branding',
    'workspace_branding_localized','workspace_domains','workspace_domains_extended',
    'workspace_departments','workspace_department_members','workspace_subscriptions',
    'workspace_limit_overrides','workspace_module_overrides','workspace_provider_settings',
    'workspace_seat_entitlement_mode','workspace_channel_overrides',
    'workspace_plugin_installations','call_center_settings','call_center_departments',
    'call_center_department_agents','channel_integrations','plugin_platform_state',
    'plugin_secrets','ai_agent_settings','enforcement_rules','auto_action_definitions',
    'slo_definitions','alert_rules',
    -- billing configuration (not transactional data)
    'billing_gateways','billing_provider_credentials'
  ]::text[]
$$;

-- ─── 3. The v2 functions ──────────────────────────────────────────────────
-- Every overload of every billing_v2_* function and of the list in 0. No
-- CASCADE: a trigger, default or view still using one stops the file.
DO $functions$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND (p.proname LIKE 'billing\_v2\_%' OR p.proname IN (SELECT name FROM pg_temp.v2_removed_functions))
     ORDER BY p.proname, p.oid
  LOOP
    EXECUTE format('DROP FUNCTION %s', r.sig);
  END LOOP;
END
$functions$;

-- ─── 4. The v2 columns of workspace_subscriptions ─────────────────────────
-- Their foreign keys (to billing_subscription_periods and billing_plans) and
-- the pending_change checks go with them. No CASCADE: a view or policy using
-- one stops the file.
ALTER TABLE public.workspace_subscriptions
  DROP COLUMN IF EXISTS current_period_id,
  DROP COLUMN IF EXISTS v2_allowance_effective_period_id,
  DROP COLUMN IF EXISTS billing_engine_version,
  DROP COLUMN IF EXISTS billing_v2_effective_at,
  DROP COLUMN IF EXISTS billing_anchor_at,
  DROP COLUMN IF EXISTS next_invoice_at,
  DROP COLUMN IF EXISTS next_plan_id,
  DROP COLUMN IF EXISTS pending_change_type,
  DROP COLUMN IF EXISTS pending_change_currency;

-- ─── 5. The v2 tables move, intact, into billing_v2_archive ───────────────
CREATE SCHEMA IF NOT EXISTS billing_v2_archive;
REVOKE ALL ON SCHEMA billing_v2_archive FROM PUBLIC, anon, authenticated, service_role;

DO $archive$
DECLARE
  v_rels   oid[];
  v_rel    oid;
  v_name   text;
  r        record;
  v_rows   bigint;
  v_counts jsonb := '{}'::jsonb;
  v_fks    jsonb := '[]'::jsonb;
BEGIN
  SELECT coalesce(array_agg(to_regclass('public.' || quote_ident(t.name))::oid), '{}') INTO v_rels
    FROM pg_temp.v2_archive_tables t
   WHERE to_regclass('public.' || quote_ident(t.name)) IS NOT NULL;

  FOREACH v_rel IN ARRAY v_rels LOOP
    SELECT relname INTO v_name FROM pg_class WHERE oid = v_rel;
    IF to_regclass('billing_v2_archive.' || quote_ident(v_name)) IS NOT NULL THEN
      RAISE EXCEPTION 'billing_v2_archive_conflict: public.% and billing_v2_archive.% both exist; a person decides which one is kept', v_name, v_name;
    END IF;
    -- Its policies: nobody but the owner reads it any more.
    FOR r IN SELECT polname FROM pg_policy WHERE polrelid = v_rel ORDER BY 1 LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', r.polname, v_name);
    END LOOP;
    -- Its foreign keys to tables that stay (workspaces, billing_plans,
    -- workspace_subscriptions): a delete there must neither stop at an
    -- archived row nor cascade into one. Those between v2 tables move with it.
    FOR r IN
      SELECT c.conname, pg_get_constraintdef(c.oid) AS def
        FROM pg_constraint c
       WHERE c.conrelid = v_rel AND c.contype = 'f' AND c.confrelid <> ALL (v_rels)
       ORDER BY 1
    LOOP
      v_fks := v_fks || jsonb_build_object('table', v_name, 'constraint', r.conname, 'definition', r.def);
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', v_name, r.conname);
    END LOOP;
  END LOOP;

  FOREACH v_rel IN ARRAY v_rels LOOP
    SELECT relname INTO v_name FROM pg_class WHERE oid = v_rel;
    EXECUTE format('SELECT count(*) FROM public.%I', v_name) INTO v_rows;
    v_counts := v_counts || jsonb_build_object(v_name, v_rows);
    EXECUTE format('ALTER TABLE public.%I SET SCHEMA billing_v2_archive', v_name);
  END LOOP;

  -- Whatever is in the archive (the move's log included): the owner only.
  FOR r IN
    SELECT c.relname FROM pg_class c
     WHERE c.relnamespace = 'billing_v2_archive'::regnamespace AND c.relkind IN ('r', 'p')
     ORDER BY 1
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE billing_v2_archive.%I FROM PUBLIC, anon, authenticated, service_role', r.relname);
  END LOOP;

  IF cardinality(v_rels) > 0 THEN
    RAISE NOTICE 'billing v2 archive: % table(s) moved with their rows %; foreign keys to public dropped: %',
      cardinality(v_rels), v_counts, v_fks;
  END IF;
END
$archive$;

-- ─── 6a. The email templates only billing v2 sent ─────────────────────────
-- Their senders (billing_notify_*, the v2 notification worker) are gone; the
-- simple billing mails are billing_*. Copied with every column, then deleted.
CREATE TABLE IF NOT EXISTS billing_v2_archive.email_templates (
  LIKE public.email_templates,
  archived_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);
ALTER TABLE billing_v2_archive.email_templates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE billing_v2_archive.email_templates FROM PUBLIC, anon, authenticated, service_role;

DO $templates$
DECLARE
  c_slugs constant text[] := ARRAY['subscription_activated', 'wallet_deposit_received', 'ai_credit_purchased',
                                   'trial_ending_soon', 'trial_expired'];
  v_cols  text;
  v_moved bigint;
BEGIN
  -- The columns both tables have (public's may grow later).
  SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) INTO v_cols
    FROM pg_attribute a
   WHERE a.attrelid = 'billing_v2_archive.email_templates'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND a.attname <> 'archived_at'
     AND EXISTS (SELECT 1 FROM pg_attribute p
                  WHERE p.attrelid = 'public.email_templates'::regclass AND p.attname = a.attname AND NOT p.attisdropped);
  EXECUTE format('INSERT INTO billing_v2_archive.email_templates (%s) SELECT %s FROM public.email_templates
                   WHERE slug = ANY ($1) ON CONFLICT (id) DO NOTHING', v_cols, v_cols)
    USING c_slugs;
  DELETE FROM public.email_templates t
   WHERE t.slug = ANY (c_slugs)
     AND EXISTS (SELECT 1 FROM billing_v2_archive.email_templates a WHERE a.id = t.id);
  GET DIAGNOSTICS v_moved = ROW_COUNT;
  IF v_moved > 0 THEN
    RAISE NOTICE 'billing v2 archive: % email template row(s) archived', v_moved;
  END IF;
END
$templates$;

-- ─── 6b. No retention policy for a table that left public ─────────────────
-- 169's rows for billing_invoices, billing_invoice_lines, billing_payments,
-- billing_payment_allocations, billing_subscription_periods and
-- billing_wallet_ledger (the retention job reads public.<table_name>).
DO $retention$
BEGIN
  IF to_regclass('public.data_retention_policies') IS NOT NULL THEN
    DELETE FROM public.data_retention_policies
     WHERE table_name IN (SELECT name FROM pg_temp.v2_archive_tables);
  END IF;
END
$retention$;

-- ─── 6c. The plan's AI month as ai_allowance.IRR (design D14) ─────────────
-- billing_plan_ai_allowance reads ai_allowance.IRR before
-- limits.included_ai_allowance_irr, so copying the second into the first
-- changes no plan's month. The limits key stays: it is also the
-- per-workspace override key (workspace_limit_overrides).
UPDATE public.billing_plans
   SET ai_allowance = coalesce(ai_allowance, '{}'::jsonb)
                      || jsonb_build_object('IRR', (limits->>'included_ai_allowance_irr')::bigint)
 WHERE NOT coalesce(ai_allowance, '{}'::jsonb) ? 'IRR'
   AND limits->>'included_ai_allowance_irr' ~ '^[0-9]{1,18}$';

-- ─── 7. The backup role reads the archive ─────────────────────────────────
-- The in-app backup is a full pg_dump as webyar_backup
-- (docs/operations/DATABASE_BACKUPS.md). As a member of pg_read_all_data
-- (with BYPASSRLS) it reads every schema already; otherwise it is given
-- this one. A database without the role is left as it is.
DO $backup$
BEGIN
  IF to_regrole('webyar_backup') IS NOT NULL
     AND NOT (to_regrole('pg_read_all_data') IS NOT NULL
              AND pg_has_role('webyar_backup', 'pg_read_all_data', 'USAGE')) THEN
    GRANT USAGE ON SCHEMA billing_v2_archive TO webyar_backup;
    GRANT SELECT ON ALL TABLES IN SCHEMA billing_v2_archive TO webyar_backup;
  END IF;
END
$backup$;

-- ─── 8. Post-checks ───────────────────────────────────────────────────────
-- Every object outside the archive (system schemas and extensions' own
-- functions aside) is checked; each failure is listed.
DO $post$
DECLARE
  v_tables  text;
  v_cols    text;
  v_funcs   text;
  v_any     text;
  v_fail    text[] := '{}';
  v_list    text;
  v_role    text;
BEGIN
  SELECT '\m(' || string_agg(name, '|') || ')\M' INTO v_tables FROM pg_temp.v2_archive_tables;
  SELECT '\m(' || string_agg(name, '|') || ')\M' INTO v_cols FROM pg_temp.v2_dropped_columns;
  SELECT '\m(billing_v2_(?!archive\M)[a-z0-9_]+|' || string_agg(name, '|') || ')\M' INTO v_funcs
    FROM pg_temp.v2_removed_functions;
  v_any := v_tables || '|' || v_cols || '|' || v_funcs;

  -- No v2 table in public.
  SELECT string_agg(name, ', ') INTO v_list FROM pg_temp.v2_archive_tables
   WHERE to_regclass('public.' || quote_ident(name)) IS NOT NULL;
  IF v_list IS NOT NULL THEN v_fail := v_fail || ('v2 tables still in public: ' || v_list); END IF;

  -- No v2 column left.
  SELECT string_agg(a.attname, ', ') INTO v_list FROM pg_attribute a
   WHERE a.attrelid = 'public.workspace_subscriptions'::regclass AND NOT a.attisdropped
     AND a.attname IN (SELECT name FROM pg_temp.v2_dropped_columns);
  IF v_list IS NOT NULL THEN v_fail := v_fail || ('workspace_subscriptions columns not dropped: ' || v_list); END IF;

  -- No v2 function left.
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_list FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND (p.proname LIKE 'billing\_v2\_%' OR p.proname IN (SELECT name FROM pg_temp.v2_removed_functions));
  IF v_list IS NOT NULL THEN v_fail := v_fail || ('v2 functions still defined: ' || v_list); END IF;

  -- No foreign key across the archive's edge, either way.
  SELECT string_agg(format('%s.%s -> %s', c.conrelid::regclass, c.conname, c.confrelid::regclass), ', ') INTO v_list
    FROM pg_constraint c
    JOIN pg_class a ON a.oid = c.conrelid
    JOIN pg_class b ON b.oid = c.confrelid
   WHERE c.contype = 'f'
     AND (a.relnamespace = 'billing_v2_archive'::regnamespace) <> (b.relnamespace = 'billing_v2_archive'::regnamespace);
  IF v_list IS NOT NULL THEN v_fail := v_fail || ('foreign keys across billing_v2_archive: ' || v_list); END IF;

  -- No function body outside the archive names an archived table, a dropped
  -- column or a removed function.
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) INTO v_list
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language l ON l.oid = p.prolang
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'billing_v2_archive')
     AND n.nspname NOT LIKE 'pg\_toast%' AND n.nspname NOT LIKE 'pg\_temp%'
     AND l.lanname NOT IN ('c', 'internal')
     AND NOT EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
     AND p.prosrc ~ v_any;
  IF v_list IS NOT NULL THEN v_fail := v_fail || ('functions naming billing v2: ' || v_list); END IF;

  -- No view, trigger or policy outside the archive does.
  SELECT string_agg(c.oid::regclass::text, ', ') INTO v_list
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('v', 'm')
     AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'billing_v2_archive')
     AND pg_get_viewdef(c.oid) ~ v_any;
  IF v_list IS NOT NULL THEN v_fail := v_fail || ('views naming billing v2: ' || v_list); END IF;

  SELECT string_agg(format('%s.%s', t.tgrelid::regclass, t.tgname), ', ') INTO v_list
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
   WHERE NOT t.tgisinternal AND c.relnamespace <> 'billing_v2_archive'::regnamespace
     AND pg_get_triggerdef(t.oid) ~ v_any;
  IF v_list IS NOT NULL THEN v_fail := v_fail || ('triggers naming billing v2: ' || v_list); END IF;

  SELECT string_agg(format('%s.%s', p.polrelid::regclass, p.polname), ', ') INTO v_list
    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
   WHERE c.relnamespace <> 'billing_v2_archive'::regnamespace
     AND (coalesce(pg_get_expr(p.polqual, p.polrelid), '') ~ v_any
          OR coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') ~ v_any);
  IF v_list IS NOT NULL THEN v_fail := v_fail || ('policies naming billing v2: ' || v_list); END IF;

  -- No function, view or default outside the archive depends on an archived
  -- table or its row type (SQL-standard bodies, argument and result types).
  SELECT string_agg(DISTINCT pg_describe_object(d.classid, d.objid, d.objsubid), ', ') INTO v_list
    FROM pg_depend d
    JOIN pg_class a ON a.relnamespace = 'billing_v2_archive'::regnamespace AND a.relkind IN ('r', 'p')
   WHERE ((d.refclassid = 'pg_class'::regclass AND d.refobjid = a.oid)
          OR (d.refclassid = 'pg_type'::regclass AND d.refobjid = a.reltype))
     AND d.deptype = 'n'
     AND (d.classid = 'pg_proc'::regclass
          OR (d.classid = 'pg_rewrite'::regclass
              AND NOT EXISTS (SELECT 1 FROM pg_rewrite w JOIN pg_class v ON v.oid = w.ev_class
                               WHERE w.oid = d.objid AND v.relnamespace = 'billing_v2_archive'::regnamespace))
          OR (d.classid = 'pg_attrdef'::regclass
              AND NOT EXISTS (SELECT 1 FROM pg_attrdef x JOIN pg_class v ON v.oid = x.adrelid
                               WHERE x.oid = d.objid AND v.relnamespace = 'billing_v2_archive'::regnamespace)));
  IF v_list IS NOT NULL THEN v_fail := v_fail || ('objects depending on archived tables: ' || v_list); END IF;

  -- The application roles reach nothing in the archive.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    CONTINUE WHEN to_regrole(v_role) IS NULL;
    IF has_schema_privilege(v_role, 'billing_v2_archive', 'USAGE') THEN
      v_fail := v_fail || format('%s has USAGE on billing_v2_archive', v_role);
    END IF;
    SELECT string_agg(c.relname, ', ') INTO v_list FROM pg_class c
     WHERE c.relnamespace = 'billing_v2_archive'::regnamespace AND c.relkind IN ('r', 'p')
       AND (has_table_privilege(v_role, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
            OR has_any_column_privilege(v_role, c.oid, 'SELECT, INSERT, UPDATE'));
    IF v_list IS NOT NULL THEN v_fail := v_fail || format('%s has privileges on billing_v2_archive.{%s}', v_role, v_list); END IF;
  END LOOP;

  IF cardinality(v_fail) > 0 THEN
    RAISE EXCEPTION 'billing_v2_archive_check_failed: %', array_to_string(v_fail, ' | ');
  END IF;
END
$post$;

COMMIT;
