-- ============================================================
-- THE COLUMNS THIS CHAIN USED AND NEVER ADDED
--
-- The backfill either side of 20260904112112 created nineteen tables this
-- directory was missing. It did not fix the other half of the same gap:
-- billing_v2 also ADDs columns to tables that already existed, and none of
-- those ALTERs are here either. Most visibly,
-- workspace_subscriptions.grace_period_ends_at — the column the whole dunning
-- and grace-period path turns on — is added by database/migrations/113 and by
-- nothing in supabase/migrations.
--
-- It stayed hidden because the function backfill sets check_function_bodies
-- = off, which it has to: that substrate is mutually recursive and cannot be
-- created in dependency order. With body checking off, a plpgsql function
-- referencing a column that does not exist is created happily and only fails
-- when something calls it. The metrics migration is LANGUAGE sql, whose body
-- IS resolved at creation, and it is what finally made the chain say so:
--
--     ERROR: column "grace_period_ends_at" does not exist
--
-- WHAT IS HERE
--
-- Twenty-six columns across eight tables, taken by comparing a database built
-- from database/migrations against one built from this directory — the real
-- difference between two replayed schemas, not a reading of the SQL. Types and
-- defaults are copied from the self-host side.
--
-- WHERE IT SITS
--
-- After every table in this directory exists and before the function backfill
-- that reads the columns. The obvious place looked like beside the table
-- backfill at 20260904112111, and a replay said otherwise: commerce_products
-- is not created until later, so the ALTER for it failed there. These columns
-- belong to tables spread across the whole chain, so the only position that
-- works for all of them is after the last of them.
--
-- Every statement is ADD COLUMN IF NOT EXISTS, so this is a no-op on any
-- database that already has them, the live one included. No column is made NOT
-- NULL here: where the self-host chain has that, it sets it after a backfill
-- the corresponding migration does, and this file exists to close a schema
-- gap, not to reach into rows.
-- ============================================================

ALTER TABLE public.billing_payment_intents ADD COLUMN IF NOT EXISTS billing_engine_version text DEFAULT 'v1'::text;
ALTER TABLE public.billing_payment_intents ADD COLUMN IF NOT EXISTS expected_amount_irr bigint;
ALTER TABLE public.billing_payment_intents ADD COLUMN IF NOT EXISTS invoice_id uuid;
ALTER TABLE public.billing_payment_intents ADD COLUMN IF NOT EXISTS wallet_deposit_id uuid;

ALTER TABLE public.billing_payments ADD COLUMN IF NOT EXISTS invoice_id uuid;
ALTER TABLE public.billing_payments ADD COLUMN IF NOT EXISTS reconciliation_reason text;
ALTER TABLE public.billing_payments ADD COLUMN IF NOT EXISTS reconciliation_state text DEFAULT 'settled'::text;

ALTER TABLE public.commerce_products ADD COLUMN IF NOT EXISTS last_seen_at timestamp with time zone;
ALTER TABLE public.commerce_sync_cursors ADD COLUMN IF NOT EXISTS sweep_epoch timestamp with time zone;
ALTER TABLE public.platform_branding ADD COLUMN IF NOT EXISTS lock_ui_preferences boolean DEFAULT false;
ALTER TABLE public.push_dispatch_log ADD COLUMN IF NOT EXISTS platform text;
ALTER TABLE public.push_dispatch_log ADD COLUMN IF NOT EXISTS suppressed_reason text;
ALTER TABLE public.widget_settings ADD COLUMN IF NOT EXISTS show_powered_by boolean DEFAULT true;

ALTER TABLE public.workspace_subscriptions ADD COLUMN IF NOT EXISTS billing_anchor_at timestamp with time zone;
ALTER TABLE public.workspace_subscriptions ADD COLUMN IF NOT EXISTS billing_engine_version text DEFAULT 'v1'::text;
ALTER TABLE public.workspace_subscriptions ADD COLUMN IF NOT EXISTS billing_v2_effective_at timestamp with time zone;
ALTER TABLE public.workspace_subscriptions ADD COLUMN IF NOT EXISTS canceled_at timestamp with time zone;
ALTER TABLE public.workspace_subscriptions ADD COLUMN IF NOT EXISTS current_period_id uuid;
ALTER TABLE public.workspace_subscriptions ADD COLUMN IF NOT EXISTS free_fallback_at timestamp with time zone;
ALTER TABLE public.workspace_subscriptions ADD COLUMN IF NOT EXISTS grace_period_ends_at timestamp with time zone;
ALTER TABLE public.workspace_subscriptions ADD COLUMN IF NOT EXISTS next_invoice_at timestamp with time zone;
ALTER TABLE public.workspace_subscriptions ADD COLUMN IF NOT EXISTS next_plan_id uuid;
ALTER TABLE public.workspace_subscriptions ADD COLUMN IF NOT EXISTS past_due_since timestamp with time zone;
ALTER TABLE public.workspace_subscriptions ADD COLUMN IF NOT EXISTS pending_change_type text;
ALTER TABLE public.workspace_subscriptions ADD COLUMN IF NOT EXISTS trial_start timestamp with time zone;
ALTER TABLE public.workspace_subscriptions ADD COLUMN IF NOT EXISTS v2_allowance_effective_period_id uuid;

-- ---------- proof ----------
DO $verify$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(t || '.' || c, ', ' ORDER BY t, c) INTO missing
    FROM (VALUES
      ('billing_payment_intents','billing_engine_version'),('billing_payment_intents','expected_amount_irr'),
      ('billing_payment_intents','invoice_id'),('billing_payment_intents','wallet_deposit_id'),
      ('billing_payments','invoice_id'),('billing_payments','reconciliation_reason'),
      ('billing_payments','reconciliation_state'),('commerce_products','last_seen_at'),
      ('commerce_sync_cursors','sweep_epoch'),('platform_branding','lock_ui_preferences'),
      ('push_dispatch_log','platform'),('push_dispatch_log','suppressed_reason'),
      ('widget_settings','show_powered_by'),
      ('workspace_subscriptions','billing_anchor_at'),('workspace_subscriptions','billing_engine_version'),
      ('workspace_subscriptions','billing_v2_effective_at'),('workspace_subscriptions','canceled_at'),
      ('workspace_subscriptions','current_period_id'),('workspace_subscriptions','free_fallback_at'),
      ('workspace_subscriptions','grace_period_ends_at'),('workspace_subscriptions','next_invoice_at'),
      ('workspace_subscriptions','next_plan_id'),('workspace_subscriptions','past_due_since'),
      ('workspace_subscriptions','pending_change_type'),('workspace_subscriptions','trial_start'),
      ('workspace_subscriptions','v2_allowance_effective_period_id')
    ) AS want(t, c)
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = want.t AND column_name = want.c);

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'billing engine columns still missing: %', missing;
  END IF;

  RAISE NOTICE 'billing engine columns: all 26 present on all 8 tables';
END
$verify$;
