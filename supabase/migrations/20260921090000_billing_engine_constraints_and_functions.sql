-- ============================================================
-- THE BILLING ENGINE THIS CHAIN USED AND NEVER CREATED (2 of 2)
--
-- Part 1 (20260904112111) created the nineteen tables just before the first
-- migration that needs one, with primary keys, indexes, RLS and grants only.
-- It could not add the foreign keys: billing_invoices references
-- billing_coupons, which the very next file creates.
--
-- This is the rest, at the end of the chain where every referenced table
-- exists: 81 foreign key and check constraints, 71 functions and the 13
-- freeze and append-only triggers that protect the financial tables.
--
-- Definitions read out of a database built from database/migrations with
-- pg_get_functiondef, pg_get_constraintdef and pg_get_triggerdef -- not
-- retyped -- and verified by replaying this chain from empty.
-- ============================================================

-- WHAT IS DELIBERATELY NOT HERE
--
-- Three functions this substrate would otherwise carry are left to the
-- migrations that already create them, because those are newer:
-- billing_v2_block_legacy_allowance_grant (20260907081217),
-- billing_v2_resolve_billing_recipient (20260910181804) and
-- billing_v2_schedule_invoice_notifications (20260904195630). This file runs
-- last, so including them would silently replace the hosted chain's own
-- versions with the self-host ones -- and for
-- billing_v2_block_legacy_allowance_grant that is a real behavioural
-- difference, not a reformatting.
--
-- ─── foreign keys and check constraints ──────────────────────────────────
ALTER TABLE public.billing_entitlement_cycles DROP CONSTRAINT IF EXISTS billing_entitlement_cycles_subscription_period_id_fkey;
ALTER TABLE public.billing_entitlement_cycles ADD CONSTRAINT billing_entitlement_cycles_subscription_period_id_fkey FOREIGN KEY (subscription_period_id) REFERENCES billing_subscription_periods(id) ON DELETE CASCADE;
ALTER TABLE public.billing_entitlement_cycles DROP CONSTRAINT IF EXISTS billing_entitlement_cycles_workspace_id_fkey;
ALTER TABLE public.billing_entitlement_cycles ADD CONSTRAINT billing_entitlement_cycles_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE public.billing_invoice_applications DROP CONSTRAINT IF EXISTS billing_invoice_applications_invoice_id_fkey;
ALTER TABLE public.billing_invoice_applications ADD CONSTRAINT billing_invoice_applications_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES billing_invoices(id) ON DELETE CASCADE;
ALTER TABLE public.billing_invoice_applications DROP CONSTRAINT IF EXISTS billing_invoice_applications_period_id_fkey;
ALTER TABLE public.billing_invoice_applications ADD CONSTRAINT billing_invoice_applications_period_id_fkey FOREIGN KEY (period_id) REFERENCES billing_subscription_periods(id) ON DELETE SET NULL;
ALTER TABLE public.billing_invoice_applications DROP CONSTRAINT IF EXISTS billing_invoice_applications_workspace_id_fkey;
ALTER TABLE public.billing_invoice_applications ADD CONSTRAINT billing_invoice_applications_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE public.billing_invoice_collections DROP CONSTRAINT IF EXISTS billing_invoice_collections_invoice_id_fkey;
ALTER TABLE public.billing_invoice_collections ADD CONSTRAINT billing_invoice_collections_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES billing_invoices(id) ON DELETE CASCADE;
ALTER TABLE public.billing_invoice_collections DROP CONSTRAINT IF EXISTS billing_invoice_collections_payment_intent_id_fkey;
ALTER TABLE public.billing_invoice_collections ADD CONSTRAINT billing_invoice_collections_payment_intent_id_fkey FOREIGN KEY (payment_intent_id) REFERENCES billing_payment_intents(id) ON DELETE SET NULL;
ALTER TABLE public.billing_invoice_collections DROP CONSTRAINT IF EXISTS billing_invoice_collections_workspace_id_fkey;
ALTER TABLE public.billing_invoice_collections ADD CONSTRAINT billing_invoice_collections_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE public.billing_invoice_lines DROP CONSTRAINT IF EXISTS billing_invoice_lines_invoice_id_fkey;
ALTER TABLE public.billing_invoice_lines ADD CONSTRAINT billing_invoice_lines_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES billing_invoices(id) ON DELETE CASCADE;
ALTER TABLE public.billing_invoice_lines DROP CONSTRAINT IF EXISTS billing_invoice_lines_plan_id_fkey;
ALTER TABLE public.billing_invoice_lines ADD CONSTRAINT billing_invoice_lines_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES billing_plans(id);
ALTER TABLE public.billing_invoices DROP CONSTRAINT IF EXISTS billing_invoices_coupon_id_fkey;
ALTER TABLE public.billing_invoices ADD CONSTRAINT billing_invoices_coupon_id_fkey FOREIGN KEY (coupon_id) REFERENCES billing_coupons(id) ON DELETE SET NULL;
ALTER TABLE public.billing_invoices DROP CONSTRAINT IF EXISTS billing_invoices_plan_id_fkey;
ALTER TABLE public.billing_invoices ADD CONSTRAINT billing_invoices_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES billing_plans(id);
ALTER TABLE public.billing_invoices DROP CONSTRAINT IF EXISTS billing_invoices_subscription_id_fkey;
ALTER TABLE public.billing_invoices ADD CONSTRAINT billing_invoices_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES workspace_subscriptions(id) ON DELETE SET NULL;
ALTER TABLE public.billing_invoices DROP CONSTRAINT IF EXISTS billing_invoices_workspace_id_fkey;
ALTER TABLE public.billing_invoices ADD CONSTRAINT billing_invoices_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE public.billing_notification_jobs DROP CONSTRAINT IF EXISTS billing_notification_jobs_invoice_id_fkey;
ALTER TABLE public.billing_notification_jobs ADD CONSTRAINT billing_notification_jobs_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES billing_invoices(id) ON DELETE CASCADE;
ALTER TABLE public.billing_notification_jobs DROP CONSTRAINT IF EXISTS billing_notification_jobs_subscription_id_fkey;
ALTER TABLE public.billing_notification_jobs ADD CONSTRAINT billing_notification_jobs_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES workspace_subscriptions(id) ON DELETE SET NULL;
ALTER TABLE public.billing_notification_jobs DROP CONSTRAINT IF EXISTS billing_notification_jobs_workspace_id_fkey;
ALTER TABLE public.billing_notification_jobs ADD CONSTRAINT billing_notification_jobs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE public.billing_payment_allocations DROP CONSTRAINT IF EXISTS billing_payment_allocations_invoice_id_fkey;
ALTER TABLE public.billing_payment_allocations ADD CONSTRAINT billing_payment_allocations_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES billing_invoices(id) ON DELETE CASCADE;
ALTER TABLE public.billing_payment_allocations DROP CONSTRAINT IF EXISTS billing_payment_allocations_payment_id_fkey;
ALTER TABLE public.billing_payment_allocations ADD CONSTRAINT billing_payment_allocations_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES billing_payments(id) ON DELETE SET NULL;
ALTER TABLE public.billing_payment_allocations DROP CONSTRAINT IF EXISTS billing_payment_allocations_wallet_ledger_entry_id_fkey;
ALTER TABLE public.billing_payment_allocations ADD CONSTRAINT billing_payment_allocations_wallet_ledger_entry_id_fkey FOREIGN KEY (wallet_ledger_entry_id) REFERENCES billing_wallet_ledger(id) ON DELETE SET NULL;
ALTER TABLE public.billing_payment_allocations DROP CONSTRAINT IF EXISTS billing_payment_allocations_workspace_id_fkey;
ALTER TABLE public.billing_payment_allocations ADD CONSTRAINT billing_payment_allocations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE public.billing_period_allowance_grants DROP CONSTRAINT IF EXISTS billing_period_allowance_grants_period_id_fkey;
ALTER TABLE public.billing_period_allowance_grants ADD CONSTRAINT billing_period_allowance_grants_period_id_fkey FOREIGN KEY (period_id) REFERENCES billing_subscription_periods(id) ON DELETE CASCADE;
ALTER TABLE public.billing_period_allowance_grants DROP CONSTRAINT IF EXISTS billing_period_allowance_grants_workspace_id_fkey;
ALTER TABLE public.billing_period_allowance_grants ADD CONSTRAINT billing_period_allowance_grants_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE public.billing_retention_signals DROP CONSTRAINT IF EXISTS billing_retention_signals_workspace_id_fkey;
ALTER TABLE public.billing_retention_signals ADD CONSTRAINT billing_retention_signals_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE public.billing_subscription_periods DROP CONSTRAINT IF EXISTS billing_subscription_periods_invoice_id_fkey;
ALTER TABLE public.billing_subscription_periods ADD CONSTRAINT billing_subscription_periods_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES billing_invoices(id) ON DELETE SET NULL;
ALTER TABLE public.billing_subscription_periods DROP CONSTRAINT IF EXISTS billing_subscription_periods_plan_id_fkey;
ALTER TABLE public.billing_subscription_periods ADD CONSTRAINT billing_subscription_periods_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES billing_plans(id);
ALTER TABLE public.billing_subscription_periods DROP CONSTRAINT IF EXISTS billing_subscription_periods_subscription_id_fkey;
ALTER TABLE public.billing_subscription_periods ADD CONSTRAINT billing_subscription_periods_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES workspace_subscriptions(id) ON DELETE CASCADE;
ALTER TABLE public.billing_subscription_periods DROP CONSTRAINT IF EXISTS billing_subscription_periods_workspace_id_fkey;
ALTER TABLE public.billing_subscription_periods ADD CONSTRAINT billing_subscription_periods_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE public.billing_v2_audit DROP CONSTRAINT IF EXISTS billing_v2_audit_workspace_id_fkey;
ALTER TABLE public.billing_v2_audit ADD CONSTRAINT billing_v2_audit_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE public.billing_v2_jobs DROP CONSTRAINT IF EXISTS billing_v2_jobs_workspace_id_fkey;
ALTER TABLE public.billing_v2_jobs ADD CONSTRAINT billing_v2_jobs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE public.billing_v2_policy DROP CONSTRAINT IF EXISTS billing_v2_policy_fallback_plan_id_fkey;
ALTER TABLE public.billing_v2_policy ADD CONSTRAINT billing_v2_policy_fallback_plan_id_fkey FOREIGN KEY (fallback_plan_id) REFERENCES billing_plans(id);
ALTER TABLE public.billing_v2_rollout DROP CONSTRAINT IF EXISTS billing_v2_rollout_workspace_id_fkey;
ALTER TABLE public.billing_v2_rollout ADD CONSTRAINT billing_v2_rollout_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE public.billing_v2_workspace_policy DROP CONSTRAINT IF EXISTS billing_v2_workspace_policy_workspace_id_fkey;
ALTER TABLE public.billing_v2_workspace_policy ADD CONSTRAINT billing_v2_workspace_policy_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE public.billing_wallet_accounts DROP CONSTRAINT IF EXISTS billing_wallet_accounts_workspace_id_fkey;
ALTER TABLE public.billing_wallet_accounts ADD CONSTRAINT billing_wallet_accounts_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE public.billing_wallet_deposits DROP CONSTRAINT IF EXISTS billing_wallet_deposits_payment_id_fkey;
ALTER TABLE public.billing_wallet_deposits ADD CONSTRAINT billing_wallet_deposits_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES billing_payments(id) ON DELETE SET NULL;
ALTER TABLE public.billing_wallet_deposits DROP CONSTRAINT IF EXISTS billing_wallet_deposits_payment_intent_id_fkey;
ALTER TABLE public.billing_wallet_deposits ADD CONSTRAINT billing_wallet_deposits_payment_intent_id_fkey FOREIGN KEY (payment_intent_id) REFERENCES billing_payment_intents(id) ON DELETE SET NULL;
ALTER TABLE public.billing_wallet_deposits DROP CONSTRAINT IF EXISTS billing_wallet_deposits_workspace_id_fkey;
ALTER TABLE public.billing_wallet_deposits ADD CONSTRAINT billing_wallet_deposits_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE public.billing_wallet_ledger DROP CONSTRAINT IF EXISTS billing_wallet_ledger_deposit_fkey;
ALTER TABLE public.billing_wallet_ledger ADD CONSTRAINT billing_wallet_ledger_deposit_fkey FOREIGN KEY (wallet_deposit_id) REFERENCES billing_wallet_deposits(id) ON DELETE SET NULL;
ALTER TABLE public.billing_wallet_ledger DROP CONSTRAINT IF EXISTS billing_wallet_ledger_invoice_id_fkey;
ALTER TABLE public.billing_wallet_ledger ADD CONSTRAINT billing_wallet_ledger_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES billing_invoices(id) ON DELETE SET NULL;
ALTER TABLE public.billing_wallet_ledger DROP CONSTRAINT IF EXISTS billing_wallet_ledger_payment_id_fkey;
ALTER TABLE public.billing_wallet_ledger ADD CONSTRAINT billing_wallet_ledger_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES billing_payments(id) ON DELETE SET NULL;
ALTER TABLE public.billing_wallet_ledger DROP CONSTRAINT IF EXISTS billing_wallet_ledger_workspace_id_fkey;
ALTER TABLE public.billing_wallet_ledger ADD CONSTRAINT billing_wallet_ledger_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE public.billing_entitlement_cycles DROP CONSTRAINT IF EXISTS billing_entitlement_cycles_allowance_state_check;
ALTER TABLE public.billing_entitlement_cycles ADD CONSTRAINT billing_entitlement_cycles_allowance_state_check CHECK ((allowance_state = ANY (ARRAY['pending'::text, 'granted'::text, 'skipped'::text, 'failed'::text])));
ALTER TABLE public.billing_entitlement_cycles DROP CONSTRAINT IF EXISTS billing_entitlement_cycles_engine_check;
ALTER TABLE public.billing_entitlement_cycles ADD CONSTRAINT billing_entitlement_cycles_engine_check CHECK ((billing_engine_version = ANY (ARRAY['v1'::text, 'v2'::text])));
ALTER TABLE public.billing_entitlement_cycles DROP CONSTRAINT IF EXISTS billing_entitlement_cycles_status_check;
ALTER TABLE public.billing_entitlement_cycles ADD CONSTRAINT billing_entitlement_cycles_status_check CHECK ((status = ANY (ARRAY['scheduled'::text, 'active'::text, 'completed'::text, 'canceled'::text])));
ALTER TABLE public.billing_entitlement_cycles DROP CONSTRAINT IF EXISTS billing_entitlement_cycles_window_check;
ALTER TABLE public.billing_entitlement_cycles ADD CONSTRAINT billing_entitlement_cycles_window_check CHECK ((cycle_end > cycle_start));
ALTER TABLE public.billing_invoice_applications DROP CONSTRAINT IF EXISTS billing_invoice_applications_status_check;
ALTER TABLE public.billing_invoice_applications ADD CONSTRAINT billing_invoice_applications_status_check CHECK ((application_status = ANY (ARRAY['pending'::text, 'processing'::text, 'applied'::text, 'failed'::text])));
ALTER TABLE public.billing_invoice_collections DROP CONSTRAINT IF EXISTS billing_invoice_collections_amount_check;
ALTER TABLE public.billing_invoice_collections ADD CONSTRAINT billing_invoice_collections_amount_check CHECK ((amount_irr > 0));
ALTER TABLE public.billing_invoice_collections DROP CONSTRAINT IF EXISTS billing_invoice_collections_channel_check;
ALTER TABLE public.billing_invoice_collections ADD CONSTRAINT billing_invoice_collections_channel_check CHECK ((channel = ANY (ARRAY['gateway'::text, 'wallet'::text, 'admin'::text])));
ALTER TABLE public.billing_invoice_collections DROP CONSTRAINT IF EXISTS billing_invoice_collections_status_check;
ALTER TABLE public.billing_invoice_collections ADD CONSTRAINT billing_invoice_collections_status_check CHECK ((status = ANY (ARRAY['active'::text, 'consumed'::text, 'released'::text, 'expired'::text])));
ALTER TABLE public.billing_invoice_lines DROP CONSTRAINT IF EXISTS billing_invoice_lines_type_check;
ALTER TABLE public.billing_invoice_lines ADD CONSTRAINT billing_invoice_lines_type_check CHECK ((line_type = ANY (ARRAY['plan'::text, 'upgrade_proration'::text, 'addon'::text, 'ai_credit'::text, 'discount'::text, 'tax'::text, 'credit'::text, 'manual_adjustment'::text])));
ALTER TABLE public.billing_invoices DROP CONSTRAINT IF EXISTS billing_invoices_amounts_check;
ALTER TABLE public.billing_invoices ADD CONSTRAINT billing_invoices_amounts_check CHECK (((subtotal_irr >= 0) AND (discount_irr >= 0) AND (tax_irr >= 0) AND (total_irr >= 0) AND (amount_paid_irr >= 0) AND (amount_due_irr >= 0) AND (amount_paid_irr <= total_irr) AND ((amount_paid_irr + amount_due_irr) = total_irr)));
ALTER TABLE public.billing_invoices DROP CONSTRAINT IF EXISTS billing_invoices_engine_version_check;
ALTER TABLE public.billing_invoices ADD CONSTRAINT billing_invoices_engine_version_check CHECK ((billing_engine_version = ANY (ARRAY['v1'::text, 'v2'::text])));
ALTER TABLE public.billing_invoices DROP CONSTRAINT IF EXISTS billing_invoices_interval_check;
ALTER TABLE public.billing_invoices ADD CONSTRAINT billing_invoices_interval_check CHECK (((billing_interval IS NULL) OR (billing_interval = ANY (ARRAY['monthly'::text, 'yearly'::text]))));
ALTER TABLE public.billing_invoices DROP CONSTRAINT IF EXISTS billing_invoices_status_check;
ALTER TABLE public.billing_invoices ADD CONSTRAINT billing_invoices_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'open'::text, 'partially_paid'::text, 'paid'::text, 'past_due'::text, 'void'::text, 'expired'::text, 'refunded'::text])));
ALTER TABLE public.billing_invoices DROP CONSTRAINT IF EXISTS billing_invoices_type_check;
ALTER TABLE public.billing_invoices ADD CONSTRAINT billing_invoices_type_check CHECK ((invoice_type = ANY (ARRAY['new_subscription'::text, 'subscription_renewal'::text, 'plan_upgrade'::text, 'addon'::text, 'manual'::text, 'ai_credit_purchase'::text])));
ALTER TABLE public.billing_notification_jobs DROP CONSTRAINT IF EXISTS billing_notification_jobs_channel_check;
ALTER TABLE public.billing_notification_jobs ADD CONSTRAINT billing_notification_jobs_channel_check CHECK ((channel = ANY (ARRAY['email'::text, 'sms'::text])));
ALTER TABLE public.billing_notification_jobs DROP CONSTRAINT IF EXISTS billing_notification_jobs_status_check;
ALTER TABLE public.billing_notification_jobs ADD CONSTRAINT billing_notification_jobs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'sent'::text, 'failed'::text, 'canceled'::text, 'skipped_no_recipient'::text])));
ALTER TABLE public.billing_notification_jobs DROP CONSTRAINT IF EXISTS billing_notification_jobs_type_check;
ALTER TABLE public.billing_notification_jobs ADD CONSTRAINT billing_notification_jobs_type_check CHECK ((notification_type = ANY (ARRAY['invoice_issued'::text, 'invoice_reminder'::text, 'invoice_due'::text, 'wallet_autopay_insufficient'::text, 'invoice_past_due'::text, 'payment_received'::text, 'subscription_restored'::text, 'subscription_free_fallback'::text, 'subscription_activated'::text, 'subscription_renewed'::text, 'wallet_deposit_received'::text, 'ai_credit_purchased'::text, 'trial_ending_soon'::text, 'trial_expired'::text])));
ALTER TABLE public.billing_payment_allocations DROP CONSTRAINT IF EXISTS billing_payment_allocations_amount_check;
ALTER TABLE public.billing_payment_allocations ADD CONSTRAINT billing_payment_allocations_amount_check CHECK ((amount_irr > 0));
ALTER TABLE public.billing_payment_allocations DROP CONSTRAINT IF EXISTS billing_payment_allocations_source_check;
ALTER TABLE public.billing_payment_allocations ADD CONSTRAINT billing_payment_allocations_source_check CHECK (((payment_id IS NOT NULL) OR (wallet_ledger_entry_id IS NOT NULL)));
ALTER TABLE public.billing_period_allowance_grants DROP CONSTRAINT IF EXISTS billing_period_allowance_status_check;
ALTER TABLE public.billing_period_allowance_grants ADD CONSTRAINT billing_period_allowance_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'granted'::text, 'skipped'::text, 'failed'::text])));
ALTER TABLE public.billing_retention_signals DROP CONSTRAINT IF EXISTS billing_retention_signals_state_check;
ALTER TABLE public.billing_retention_signals ADD CONSTRAINT billing_retention_signals_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'cleared'::text])));
ALTER TABLE public.billing_subscription_periods DROP CONSTRAINT IF EXISTS billing_subscription_periods_engine_version_check;
ALTER TABLE public.billing_subscription_periods ADD CONSTRAINT billing_subscription_periods_engine_version_check CHECK ((billing_engine_version = ANY (ARRAY['v1'::text, 'v2'::text])));
ALTER TABLE public.billing_subscription_periods DROP CONSTRAINT IF EXISTS billing_subscription_periods_source_check;
ALTER TABLE public.billing_subscription_periods ADD CONSTRAINT billing_subscription_periods_source_check CHECK ((source = ANY (ARRAY['invoice'::text, 'legacy_migration'::text, 'free_plan'::text, 'trial'::text, 'admin'::text, 'free_fallback'::text])));
ALTER TABLE public.billing_subscription_periods DROP CONSTRAINT IF EXISTS billing_subscription_periods_status_check;
ALTER TABLE public.billing_subscription_periods ADD CONSTRAINT billing_subscription_periods_status_check CHECK ((status = ANY (ARRAY['scheduled'::text, 'active'::text, 'completed'::text, 'canceled'::text])));
ALTER TABLE public.billing_subscription_periods DROP CONSTRAINT IF EXISTS billing_subscription_periods_window_check;
ALTER TABLE public.billing_subscription_periods ADD CONSTRAINT billing_subscription_periods_window_check CHECK (((period_end > period_start) AND (ai_allowance_irr >= 0)));
ALTER TABLE public.billing_v2_jobs DROP CONSTRAINT IF EXISTS billing_v2_jobs_status_check;
ALTER TABLE public.billing_v2_jobs ADD CONSTRAINT billing_v2_jobs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'succeeded'::text, 'failed'::text])));
ALTER TABLE public.billing_v2_jobs DROP CONSTRAINT IF EXISTS billing_v2_jobs_type_check;
ALTER TABLE public.billing_v2_jobs ADD CONSTRAINT billing_v2_jobs_type_check CHECK ((job_type = ANY (ARRAY['renewal_invoice'::text, 'wallet_autopay'::text, 'period_activation'::text, 'free_period'::text, 'dunning_due'::text, 'grace_expiry'::text])));
ALTER TABLE public.billing_v2_policy DROP CONSTRAINT IF EXISTS billing_v2_policy_deposit_sane;
ALTER TABLE public.billing_v2_policy ADD CONSTRAINT billing_v2_policy_deposit_sane CHECK (((wallet_deposit_min_irr > 0) AND (wallet_deposit_max_irr >= wallet_deposit_min_irr)));
ALTER TABLE public.billing_v2_policy DROP CONSTRAINT IF EXISTS billing_v2_policy_dunning_sane;
ALTER TABLE public.billing_v2_policy ADD CONSTRAINT billing_v2_policy_dunning_sane CHECK ((((grace_period_days >= 0) AND (grace_period_days <= 30)) AND ((notification_max_attempts >= 1) AND (notification_max_attempts <= 20)) AND ((notification_retry_seconds >= 60) AND (notification_retry_seconds <= 86400)) AND ((notification_max_per_hour >= 1) AND (notification_max_per_hour <= 500)) AND (COALESCE(array_length(reminder_days_before_due, 1), 0) <= 6)));
ALTER TABLE public.billing_v2_policy DROP CONSTRAINT IF EXISTS billing_v2_policy_sane;
ALTER TABLE public.billing_v2_policy ADD CONSTRAINT billing_v2_policy_sane CHECK ((((invoice_lead_time_days >= 0) AND (invoice_lead_time_days <= 60)) AND ((invoice_due_offset_days >= '-60'::integer) AND (invoice_due_offset_days <= 60)) AND ((collection_ttl_seconds >= 30) AND (collection_ttl_seconds <= 3600))));
ALTER TABLE public.billing_v2_policy DROP CONSTRAINT IF EXISTS billing_v2_policy_singleton;
ALTER TABLE public.billing_v2_policy ADD CONSTRAINT billing_v2_policy_singleton CHECK (id);
ALTER TABLE public.billing_v2_rollout DROP CONSTRAINT IF EXISTS billing_v2_rollout_state_check;
ALTER TABLE public.billing_v2_rollout ADD CONSTRAINT billing_v2_rollout_state_check CHECK ((state = ANY (ARRAY['legacy'::text, 'shadow'::text, 'v2_cutover_pending'::text, 'v2_active'::text])));
ALTER TABLE public.billing_v2_workspace_policy DROP CONSTRAINT IF EXISTS billing_v2_workspace_policy_sane;
ALTER TABLE public.billing_v2_workspace_policy ADD CONSTRAINT billing_v2_workspace_policy_sane CHECK (((invoice_lead_time_days IS NULL) OR ((invoice_lead_time_days >= 0) AND (invoice_lead_time_days <= 60))));
ALTER TABLE public.billing_wallet_accounts DROP CONSTRAINT IF EXISTS billing_wallet_accounts_balance_check;
ALTER TABLE public.billing_wallet_accounts ADD CONSTRAINT billing_wallet_accounts_balance_check CHECK ((available_balance_irr >= 0));
ALTER TABLE public.billing_wallet_deposits DROP CONSTRAINT IF EXISTS billing_wallet_deposits_amount_check;
ALTER TABLE public.billing_wallet_deposits ADD CONSTRAINT billing_wallet_deposits_amount_check CHECK ((amount_irr > 0));
ALTER TABLE public.billing_wallet_deposits DROP CONSTRAINT IF EXISTS billing_wallet_deposits_engine_version_check;
ALTER TABLE public.billing_wallet_deposits ADD CONSTRAINT billing_wallet_deposits_engine_version_check CHECK ((billing_engine_version = ANY (ARRAY['v1'::text, 'v2'::text])));
ALTER TABLE public.billing_wallet_deposits DROP CONSTRAINT IF EXISTS billing_wallet_deposits_status_check;
ALTER TABLE public.billing_wallet_deposits ADD CONSTRAINT billing_wallet_deposits_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'paid'::text, 'failed'::text, 'expired'::text, 'canceled'::text])));
ALTER TABLE public.billing_wallet_ledger DROP CONSTRAINT IF EXISTS billing_wallet_ledger_balance_check;
ALTER TABLE public.billing_wallet_ledger ADD CONSTRAINT billing_wallet_ledger_balance_check CHECK (((balance_after_irr >= 0) AND (amount_irr <> 0)));
ALTER TABLE public.billing_wallet_ledger DROP CONSTRAINT IF EXISTS billing_wallet_ledger_type_check;
ALTER TABLE public.billing_wallet_ledger ADD CONSTRAINT billing_wallet_ledger_type_check CHECK ((entry_type = ANY (ARRAY['deposit'::text, 'invoice_payment'::text, 'refund'::text, 'credit'::text, 'debit'::text, 'admin_adjustment'::text, 'chargeback'::text])));

-- ─── functions ───────────────────────────────────────────────────────────
-- Bodies are not name-resolved at creation: this substrate is mutually
-- recursive and no strict dependency order exists.
SET check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.billing_activate_due_periods(p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r RECORD; v_count INTEGER := 0;
BEGIN
  FOR r IN
    SELECT id FROM public.billing_subscription_periods
     WHERE status = 'scheduled' AND period_start <= now()
     ORDER BY period_start
     LIMIT GREATEST(COALESCE(p_limit, 50), 1)
  LOOP
    PERFORM public.billing_activate_period(r.id);
    v_count := v_count + 1;
  END LOOP;
  RETURN jsonb_build_object('activated', v_count);
END;
$function$
;
REVOKE ALL ON FUNCTION public.billing_activate_due_periods(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_activate_due_periods(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_allocation_block_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF public.billing_purge_active() THEN RETURN COALESCE(NEW, OLD); END IF;
  RAISE EXCEPTION 'payment_allocation_append_only';
END;
$function$
;
REVOKE ALL ON FUNCTION public.billing_allocation_block_mutation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_allocation_block_mutation() TO anon;
GRANT EXECUTE ON FUNCTION public.billing_allocation_block_mutation() TO authenticated;
GRANT EXECUTE ON FUNCTION public.billing_allocation_block_mutation() TO service_role;

CREATE OR REPLACE FUNCTION public.billing_engine_version_freeze()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF public.billing_purge_active() THEN RETURN COALESCE(NEW, OLD); END IF;
  IF NEW.billing_engine_version IS DISTINCT FROM OLD.billing_engine_version THEN
    RAISE EXCEPTION 'billing_engine_version_immutable:%:%',
      TG_TABLE_NAME, OLD.billing_engine_version;
  END IF;
  RETURN NEW;
END;
$function$
;
REVOKE ALL ON FUNCTION public.billing_engine_version_freeze() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_engine_version_freeze() TO anon;
GRANT EXECUTE ON FUNCTION public.billing_engine_version_freeze() TO authenticated;
GRANT EXECUTE ON FUNCTION public.billing_engine_version_freeze() TO service_role;

CREATE OR REPLACE FUNCTION public.billing_entitlement_cycle_freeze()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF public.billing_purge_active() THEN RETURN COALESCE(NEW, OLD); END IF;
  IF NEW.subscription_period_id IS DISTINCT FROM OLD.subscription_period_id
     OR NEW.subscription_id IS DISTINCT FROM OLD.subscription_id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.cycle_index IS DISTINCT FROM OLD.cycle_index
     OR NEW.cycle_start IS DISTINCT FROM OLD.cycle_start
     OR NEW.cycle_end IS DISTINCT FROM OLD.cycle_end
     OR NEW.ai_allowance_irr IS DISTINCT FROM OLD.ai_allowance_irr
     OR NEW.snapshot IS DISTINCT FROM OLD.snapshot
     OR NEW.billing_engine_version IS DISTINCT FROM OLD.billing_engine_version THEN
    RAISE EXCEPTION 'billing_entitlement_cycle_immutable:%', OLD.id;
  END IF;
  RETURN NEW;
END;
$function$
;
REVOKE ALL ON FUNCTION public.billing_entitlement_cycle_freeze() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_entitlement_cycle_freeze() TO anon;
GRANT EXECUTE ON FUNCTION public.billing_entitlement_cycle_freeze() TO authenticated;
GRANT EXECUTE ON FUNCTION public.billing_entitlement_cycle_freeze() TO service_role;

CREATE OR REPLACE FUNCTION public.billing_expire_stale_collections(p_invoice_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_count INTEGER;
BEGIN
  UPDATE public.billing_invoice_collections
     SET status = 'expired', released_at = now(), release_reason = 'expired'
   WHERE status = 'active'
     AND expires_at <= now()
     AND (p_invoice_id IS NULL OR invoice_id = p_invoice_id);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$
;
REVOKE ALL ON FUNCTION public.billing_expire_stale_collections(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_expire_stale_collections(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_invoice_application_block_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF public.billing_purge_active() THEN RETURN COALESCE(NEW, OLD); END IF;
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
$function$
;
REVOKE ALL ON FUNCTION public.billing_invoice_application_block_mutation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_invoice_application_block_mutation() TO anon;
GRANT EXECUTE ON FUNCTION public.billing_invoice_application_block_mutation() TO authenticated;
GRANT EXECUTE ON FUNCTION public.billing_invoice_application_block_mutation() TO service_role;

CREATE OR REPLACE FUNCTION public.billing_invoice_freeze()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF public.billing_purge_active() THEN RETURN COALESCE(NEW, OLD); END IF;
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
$function$
;
REVOKE ALL ON FUNCTION public.billing_invoice_freeze() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_invoice_freeze() TO anon;
GRANT EXECUTE ON FUNCTION public.billing_invoice_freeze() TO authenticated;
GRANT EXECUTE ON FUNCTION public.billing_invoice_freeze() TO service_role;

CREATE OR REPLACE FUNCTION public.billing_invoice_line_freeze()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_status TEXT;
  v_invoice UUID;
BEGIN
  IF public.billing_purge_active() THEN RETURN COALESCE(NEW, OLD); END IF;
  v_invoice := COALESCE(NEW.invoice_id, OLD.invoice_id);
  SELECT status INTO v_status FROM public.billing_invoices WHERE id = v_invoice;
  IF v_status IS NOT NULL AND v_status <> 'draft' THEN
    RAISE EXCEPTION 'invoice_lines_immutable:%', v_invoice
      USING HINT = 'Invoice lines are frozen once the invoice is issued.';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$function$
;
REVOKE ALL ON FUNCTION public.billing_invoice_line_freeze() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_invoice_line_freeze() TO anon;
GRANT EXECUTE ON FUNCTION public.billing_invoice_line_freeze() TO authenticated;
GRANT EXECUTE ON FUNCTION public.billing_invoice_line_freeze() TO service_role;

CREATE OR REPLACE FUNCTION public.billing_legacy_allowance_active(p_workspace_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(
    (SELECT v2_allowance_effective_period_id IS NULL
       FROM public.workspace_subscriptions
      WHERE workspace_id = p_workspace_id),
    true
  );
$function$
;
REVOKE ALL ON FUNCTION public.billing_legacy_allowance_active(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_legacy_allowance_active(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_period_freeze()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF public.billing_purge_active() THEN RETURN COALESCE(NEW, OLD); END IF;
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
$function$
;
REVOKE ALL ON FUNCTION public.billing_period_freeze() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_period_freeze() TO anon;
GRANT EXECUTE ON FUNCTION public.billing_period_freeze() TO authenticated;
GRANT EXECUTE ON FUNCTION public.billing_period_freeze() TO service_role;

CREATE OR REPLACE FUNCTION public.billing_recover_unapplied_invoices(p_limit integer DEFAULT 25)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r         RECORD;
  v_ok      INTEGER := 0;
  v_failed  INTEGER := 0;
BEGIN
  FOR r IN
    SELECT i.id
      FROM public.billing_invoices i
      LEFT JOIN public.billing_invoice_applications a ON a.invoice_id = i.id
     WHERE i.status = 'paid'
       AND (a.id IS NULL OR (a.application_status <> 'applied' AND a.next_attempt_at <= now()))
     ORDER BY i.paid_at NULLS FIRST
     LIMIT GREATEST(COALESCE(p_limit, 25), 1)
  LOOP
    BEGIN
      PERFORM public.billing_apply_invoice_effects(r.id);
      v_ok := v_ok + 1;
    EXCEPTION WHEN OTHERS THEN
      -- The failed attempt's own work is rolled back to this savepoint; the
      -- failure record below is what survives.
      v_failed := v_failed + 1;
      UPDATE public.billing_invoice_applications
         SET application_status = 'failed',
             last_error         = left(SQLERRM, 500),
             lease_until        = NULL,
             next_attempt_at    = now() + interval '5 minutes'
       WHERE invoice_id = r.id AND application_status <> 'applied';
    END;
  END LOOP;
  RETURN jsonb_build_object('applied', v_ok, 'failed', v_failed);
END;
$function$
;
REVOKE ALL ON FUNCTION public.billing_recover_unapplied_invoices(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_recover_unapplied_invoices(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_release_collection(p_collection_id uuid, p_reason text DEFAULT 'released'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_col public.billing_invoice_collections;
BEGIN
  UPDATE public.billing_invoice_collections
     SET status = 'released', released_at = now(), release_reason = COALESCE(p_reason, 'released')
   WHERE id = p_collection_id AND status = 'active'
  RETURNING * INTO v_col;
  RETURN jsonb_build_object('collection_id', p_collection_id, 'released', v_col.id IS NOT NULL);
END;
$function$
;
REVOKE ALL ON FUNCTION public.billing_release_collection(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_release_collection(uuid,text) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_retire_legacy_allowance(p_workspace_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE lot RECORD; v_free NUMERIC; v_entry UUID; n INTEGER := 0;
BEGIN
  PERFORM public.ai_wallet_lock(p_workspace_id);
  FOR lot IN
    SELECT * FROM public.workspace_ai_balance_lots
     WHERE workspace_id = p_workspace_id
       AND source_type = 'PLAN_ALLOWANCE'
       AND state IN ('ACTIVE', 'EXPIRING')
       AND billing_cycle_id IS NOT NULL
       AND billing_cycle_id NOT LIKE 'period:%'    -- legacy calendar lots only
       AND remaining_amount > 0
     FOR UPDATE
  LOOP
    v_free := lot.remaining_amount - lot.reserved_amount;
    IF v_free > 0 THEN
      INSERT INTO public.workspace_ai_ledger(workspace_id, entry_type, amount, billing_cycle_id, reason)
      VALUES (lot.workspace_id, 'EXPIRATION', -v_free, lot.billing_cycle_id, 'legacy_allowance_superseded')
      RETURNING id INTO v_entry;
      INSERT INTO public.workspace_ai_ledger_allocations(ledger_entry_id, lot_id, amount)
      VALUES (v_entry, lot.id, v_free);
    END IF;
    UPDATE public.workspace_ai_balance_lots
       SET remaining_amount = lot.reserved_amount,
           state = CASE WHEN lot.reserved_amount > 0 THEN 'EXPIRING' ELSE 'EXPIRED' END,
           updated_at = now()
     WHERE id = lot.id;
    n := n + 1;
  END LOOP;
  IF n > 0 THEN PERFORM public.ai_wallet_project(p_workspace_id); END IF;
  RETURN n;
END;
$function$
;
REVOKE ALL ON FUNCTION public.billing_retire_legacy_allowance(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_retire_legacy_allowance(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_settle_invoice(p_invoice_id uuid, p_amount_irr bigint, p_source text, p_command_key text, p_payment_id uuid DEFAULT NULL::uuid, p_wallet_entry_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inv    public.billing_invoices;
  v_alloc  public.billing_payment_allocations;
  v_col    public.billing_invoice_collections;
  v_paid   BIGINT;
  v_due    BIGINT;
  v_status TEXT;
BEGIN
  IF p_command_key IS NULL OR length(p_command_key) = 0 THEN
    RAISE EXCEPTION 'settlement_command_key_required';
  END IF;
  IF p_amount_irr IS NULL OR p_amount_irr <= 0 THEN
    RAISE EXCEPTION 'settlement_amount_invalid';
  END IF;

  SELECT * INTO v_alloc FROM public.billing_payment_allocations WHERE command_key = p_command_key;
  IF v_alloc.id IS NOT NULL THEN
    SELECT * INTO v_inv FROM public.billing_invoices WHERE id = v_alloc.invoice_id;
    RETURN jsonb_build_object(
      'invoice_id', v_inv.id, 'status', v_inv.status,
      'amount_paid_irr', v_inv.amount_paid_irr, 'amount_due_irr', v_inv.amount_due_irr,
      'allocation_id', v_alloc.id, 'fully_paid', v_inv.status = 'paid', 'replayed', true
    );
  END IF;

  SELECT * INTO v_inv FROM public.billing_invoices WHERE id = p_invoice_id FOR UPDATE;
  IF v_inv.id IS NULL THEN
    RAISE EXCEPTION 'unknown_invoice:%', p_invoice_id;
  END IF;
  IF v_inv.status NOT IN ('open', 'partially_paid', 'past_due') THEN
    RAISE EXCEPTION 'invoice_not_payable:%:%', v_inv.id, v_inv.status
      USING HINT = 'Money that arrives for a non-payable invoice must be parked as unapplied, never silently consumed.';
  END IF;

  PERFORM public.billing_expire_stale_collections(v_inv.id);

  -- The reservation — not the momentary amount_due — is the amount authority
  -- for a channel that reserved the invoice.
  SELECT * INTO v_col FROM public.billing_invoice_collections
   WHERE invoice_id = v_inv.id AND status = 'active' FOR UPDATE;

  IF v_col.id IS NOT NULL THEN
    IF v_col.channel <> p_source THEN
      RAISE EXCEPTION 'invoice_collection_conflict:%:%:%', v_inv.id, v_col.channel, p_source
        USING HINT = 'Another channel holds the collection reservation for this invoice.';
    END IF;
    IF p_amount_irr <> v_col.amount_irr THEN
      RAISE EXCEPTION 'invoice_amount_mismatch:%:%:%', v_inv.id, v_col.amount_irr, p_amount_irr;
    END IF;
  ELSIF p_source = 'gateway' AND p_amount_irr <> v_inv.amount_due_irr THEN
    RAISE EXCEPTION 'invoice_amount_mismatch:%:%:%', v_inv.id, v_inv.amount_due_irr, p_amount_irr;
  END IF;

  IF p_amount_irr > v_inv.amount_due_irr THEN
    RAISE EXCEPTION 'invoice_overpayment:%:%:%', v_inv.id, v_inv.amount_due_irr, p_amount_irr;
  END IF;

  INSERT INTO public.billing_payment_allocations (
    invoice_id, workspace_id, payment_id, wallet_ledger_entry_id, amount_irr, command_key
  ) VALUES (
    v_inv.id, v_inv.workspace_id, p_payment_id, p_wallet_entry_id, p_amount_irr, p_command_key
  )
  RETURNING * INTO v_alloc;

  v_paid := v_inv.amount_paid_irr + p_amount_irr;
  v_due  := v_inv.total_irr - v_paid;
  v_status := CASE WHEN v_due = 0 THEN 'paid' ELSE 'partially_paid' END;

  UPDATE public.billing_invoices
     SET amount_paid_irr = v_paid,
         amount_due_irr  = v_due,
         status          = v_status,
         paid_at         = CASE WHEN v_due = 0 THEN COALESCE(paid_at, now()) ELSE paid_at END,
         past_due_at     = CASE WHEN v_due = 0 THEN NULL ELSE past_due_at END,
         updated_at      = now()
   WHERE id = v_inv.id;

  IF v_col.id IS NOT NULL THEN
    UPDATE public.billing_invoice_collections
       SET status = CASE WHEN v_due = 0 THEN 'consumed' ELSE 'consumed' END,
           released_at = now(), release_reason = 'settled'
     WHERE id = v_col.id;
  END IF;

  IF p_payment_id IS NOT NULL THEN
    UPDATE public.billing_payments
       SET invoice_id = v_inv.id,
           reconciliation_state = 'settled',
           reconciliation_reason = NULL
     WHERE id = p_payment_id;
  END IF;

  -- CRASH SAFETY: the work item for the effects is created in the SAME
  -- transaction that made the invoice paid. A process that dies right after
  -- this commit leaves a durable `pending` row for the recovery loop.
  IF v_due = 0 THEN
    INSERT INTO public.billing_invoice_applications (
      invoice_id, workspace_id, application_type, application_status
    ) VALUES (
      v_inv.id, v_inv.workspace_id,
      COALESCE(v_inv.effect_snapshot->>'action_type', v_inv.invoice_type),
      'pending'
    )
    ON CONFLICT (invoice_id) DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'invoice_id', v_inv.id, 'status', v_status,
    'amount_paid_irr', v_paid, 'amount_due_irr', v_due,
    'allocation_id', v_alloc.id, 'fully_paid', v_due = 0, 'replayed', false
  );
END;
$function$
;
REVOKE ALL ON FUNCTION public.billing_settle_invoice(uuid,bigint,text,text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_settle_invoice(uuid,bigint,text,text,uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_v2_activate(p_workspace_id uuid, p_actor_id uuid DEFAULT NULL::uuid, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_state      TEXT;
  v_readiness  JSONB;
  v_sub        public.workspace_subscriptions;
  v_plan       public.billing_plans;
  v_period     UUID;
  v_drained    INTEGER := 0;
  v_created    BOOLEAN := false;
  v_allowance  BIGINT := 0;
  v_source     TEXT;
  v_interval   TEXT;
  v_start      TIMESTAMPTZ;
  v_end        TIMESTAMPTZ;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('billing_v2_rollout:' || p_workspace_id::text, 0));

  SELECT state INTO v_state FROM public.billing_v2_rollout
   WHERE workspace_id = p_workspace_id FOR UPDATE;
  v_state := COALESCE(v_state, 'legacy');

  -- 30. Idempotent: activating an already-active workspace changes nothing.
  IF v_state = 'v2_active' THEN
    INSERT INTO public.billing_v2_audit (workspace_id, event, actor_id, reason)
    VALUES (p_workspace_id, 'billing_v2_activation_replayed', p_actor_id, p_reason);
    RETURN jsonb_build_object('state', 'v2_active', 'activated', false, 'replayed', true);
  END IF;

  SELECT * INTO v_sub FROM public.workspace_subscriptions
   WHERE workspace_id = p_workspace_id FOR UPDATE;

  v_readiness := public.billing_v2_evaluate_cutover(p_workspace_id);
  IF NOT (v_readiness ->> 'ready')::boolean THEN
    INSERT INTO public.billing_v2_audit (workspace_id, event, actor_id, reason, details)
    VALUES (p_workspace_id, 'billing_v2_cutover_blocked', p_actor_id, p_reason, v_readiness);
    RAISE EXCEPTION 'billing_v2_cutover_blocked:%', v_readiness::text;
  END IF;

  -- 8. Unbound legacy intents (no gateway reference — checkout never really
  -- started) are canceled EXPLICITLY and audited. Bound ones already blocked.
  WITH drained AS (
    UPDATE public.billing_payment_intents
       SET status = 'canceled',
           failure_reason = 'billing_v2_cutover_drain',
           updated_at = now()
     WHERE workspace_id = p_workspace_id
       AND billing_engine_version = 'v1'
       AND status = 'pending'
       AND provider_ref IS NULL
     RETURNING id)
  SELECT count(*) INTO v_drained FROM drained;

  IF v_drained > 0 THEN
    INSERT INTO public.billing_v2_audit (workspace_id, event, actor_id, reason, details)
    VALUES (p_workspace_id, 'billing_v2_legacy_intent_drained', p_actor_id, p_reason,
            jsonb_build_object('canceled_unbound_intents', v_drained));
  END IF;

  INSERT INTO public.billing_wallet_accounts (workspace_id)
  VALUES (p_workspace_id) ON CONFLICT (workspace_id) DO NOTHING;

  -- 21/22/23/24. A period must exist. An existing ACTIVE period (including the
  -- Phase A legacy_migration one) stays authoritative and is NEVER recreated:
  -- the first V2-created period is the NEXT one.
  SELECT id INTO v_period FROM public.billing_subscription_periods
   WHERE workspace_id = p_workspace_id AND status = 'active' LIMIT 1;

  IF v_period IS NULL THEN
    SELECT * INTO v_plan FROM public.billing_plans
     WHERE id = v_sub.plan_id;
    IF v_plan.id IS NULL THEN
      SELECT * INTO v_plan FROM public.billing_plans
       WHERE is_free = true AND is_active = true ORDER BY sort_order LIMIT 1;
    END IF;

    v_source   := CASE WHEN COALESCE(v_sub.status, '') = 'trialing' THEN 'trial' ELSE 'free_plan' END;
    v_interval := COALESCE(v_sub.billing_interval, 'monthly');
    v_start    := COALESCE(
                    CASE WHEN v_source = 'trial' THEN v_sub.trial_start ELSE NULL END,
                    v_sub.current_period_start, now());
    v_end      := COALESCE(
                    CASE WHEN v_source = 'trial' THEN v_sub.trial_end ELSE NULL END,
                    NULLIF(GREATEST(COALESCE(v_sub.current_period_end, now()), now() + interval '1 second'), NULL));
    IF v_end <= now() OR v_source = 'free_plan' THEN
      v_start := now();
      v_end   := now() + interval '1 month';
    END IF;

    -- Free/Trial periods carry a real snapshot but NEVER an invoice, a payment
    -- or a wallet debit: no zero-value invoice is ever created.
    v_allowance := GREATEST(COALESCE(
      (v_plan.limits ->> 'included_ai_allowance_irr')::BIGINT,
      (v_plan.limits ->> 'ai_credits_per_month')::BIGINT, 0), 0);

    INSERT INTO public.billing_subscription_periods (
      workspace_id, subscription_id, plan_id, invoice_id, billing_interval,
      period_start, period_end, status, source,
      plan_snapshot, limits_snapshot, ai_allowance_irr, billing_engine_version)
    VALUES (
      p_workspace_id, v_sub.id, v_plan.id, NULL, v_interval,
      v_start, v_end, 'scheduled', v_source,
      COALESCE(to_jsonb(v_plan), '{}'::jsonb), COALESCE(v_plan.limits, '{}'::jsonb),
      v_allowance, 'v2')
    RETURNING id INTO v_period;

    PERFORM public.billing_activate_period(v_period);
    v_created := true;
  END IF;

  PERFORM public.billing_v2_set_state(p_workspace_id, 'v2_active', p_actor_id, p_reason);

  UPDATE public.billing_v2_rollout
     SET last_blockers = '[]'::jsonb, updated_at = now()
   WHERE workspace_id = p_workspace_id;

  INSERT INTO public.billing_v2_audit (workspace_id, event, actor_id, reason, details)
  VALUES (p_workspace_id, 'billing_v2_activated', p_actor_id, p_reason,
          jsonb_build_object(
            'from_state', v_state,
            'classification', v_readiness ->> 'classification',
            'period_id', v_period,
            'period_created', v_created,
            'drained_unbound_intents', v_drained));

  RETURN jsonb_build_object(
    'state', 'v2_active', 'activated', true, 'replayed', false,
    'from_state', v_state,
    'period_id', v_period, 'period_created', v_created,
    'drained_unbound_intents', v_drained,
    'classification', v_readiness ->> 'classification');
END;
$function$
;
REVOKE ALL ON FUNCTION public.billing_v2_activate(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_v2_activate(uuid,uuid,text) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_v2_add_interval(p_ts timestamp with time zone, p_interval text, p_count integer DEFAULT 1)
 RETURNS timestamp with time zone
 LANGUAGE sql
 IMMUTABLE
AS $function$
  -- Postgres month arithmetic is calendar-safe (Jan 31 + 1 month = Feb 28/29),
  -- which is exactly the contract periods.ts implements in TypeScript.
  SELECT CASE WHEN p_interval = 'yearly'
              THEN p_ts + make_interval(years => GREATEST(COALESCE(p_count, 1), 1))
              ELSE p_ts + make_interval(months => GREATEST(COALESCE(p_count, 1), 1))
         END;
$function$
;
REVOKE ALL ON FUNCTION public.billing_v2_add_interval(timestamp with time zone,text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_v2_add_interval(timestamp with time zone,text,integer) TO anon;
GRANT EXECUTE ON FUNCTION public.billing_v2_add_interval(timestamp with time zone,text,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.billing_v2_add_interval(timestamp with time zone,text,integer) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_v2_apply_free_fallback(p_workspace_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_sub      public.workspace_subscriptions;
  v_policy   JSONB;
  v_plan     public.billing_plans;
  v_plan_id  UUID;
  v_period   public.billing_subscription_periods;
  v_start    TIMESTAMPTZ;
  v_allow    BIGINT;
  v_expired  INTEGER := 0;
BEGIN
  SELECT * INTO v_sub FROM public.workspace_subscriptions
   WHERE workspace_id = p_workspace_id FOR UPDATE;
  IF v_sub.id IS NULL THEN RETURN jsonb_build_object('skipped', 'no_subscription'); END IF;
  IF v_sub.status = 'free_fallback' THEN
    RETURN jsonb_build_object('skipped', 'already_free_fallback');
  END IF;
  IF v_sub.status <> 'past_due' OR v_sub.grace_period_ends_at IS NULL THEN
    RETURN jsonb_build_object('skipped', 'not_in_grace');
  END IF;
  -- DB clock is the only authority for the deadline.
  IF v_sub.grace_period_ends_at > now() THEN
    RETURN jsonb_build_object('skipped', 'grace_active');
  END IF;

  -- FINAL recheck: any settled money before this instant cancels the fallback.
  IF NOT EXISTS (
    SELECT 1 FROM public.billing_invoices
     WHERE workspace_id = p_workspace_id
       AND status IN ('open', 'partially_paid', 'past_due')
       AND amount_due_irr > 0
       AND due_at IS NOT NULL AND due_at <= now()
  ) THEN
    PERFORM public.billing_v2_restore_subscription(p_workspace_id);
    RETURN jsonb_build_object('skipped', 'nothing_unpaid');
  END IF;

  v_policy := public.billing_v2_policy_for(p_workspace_id);
  -- NO guessing. Downgrading a paying customer onto a plan nobody configured
  -- is worse than failing loudly: the job retries, the workspace stays in
  -- past_due (service intact) and the platform owner gets a visible error.
  v_plan_id := NULLIF(v_policy->>'fallback_plan_id', '')::uuid;
  IF v_plan_id IS NULL THEN
    RAISE EXCEPTION 'fallback_plan_not_configured'
      USING HINT = 'Set billing_v2_policy.fallback_plan_id before grace can expire.';
  END IF;
  SELECT * INTO v_plan FROM public.billing_plans WHERE id = v_plan_id;

  -- An unfunded scheduled period (the renewal nobody paid for) is canceled,
  -- never activated — and it must go before the fallback period is inserted,
  -- because only one scheduled period per workspace may exist.
  UPDATE public.billing_subscription_periods
     SET status = 'canceled', completed_at = now()
   WHERE workspace_id = p_workspace_id AND status = 'scheduled';

  -- The free period starts at the fallback instant, not at the unpaid window.
  v_start := now();
  v_allow := GREATEST(ROUND(COALESCE((v_plan.limits->>'ai_credits_per_month')::numeric, 0))::bigint, 0);

  INSERT INTO public.billing_subscription_periods (
    workspace_id, subscription_id, plan_id, invoice_id, billing_interval,
    period_start, period_end, status, source, plan_snapshot, limits_snapshot, ai_allowance_irr
  ) VALUES (
    p_workspace_id, v_sub.id, v_plan.id, NULL, 'monthly',
    v_start, public.billing_v2_add_interval(v_start, 'monthly', 1), 'scheduled', 'free_fallback',
    to_jsonb(v_plan), COALESCE(v_plan.limits, '{}'::jsonb), v_allow
  ) RETURNING * INTO v_period;

  PERFORM public.billing_activate_period(v_period.id);

  -- Unpaid documents are closed as expired — never deleted, never paid.
  UPDATE public.billing_invoices
     SET status = 'expired', updated_at = now(),
         metadata = metadata || jsonb_build_object('expired_reason', 'nonpayment_after_grace')
   WHERE workspace_id = p_workspace_id
     AND status IN ('open', 'partially_paid', 'past_due')
     AND amount_due_irr > 0;
  GET DIAGNOSTICS v_expired = ROW_COUNT;

  UPDATE public.workspace_subscriptions
     SET status = 'free_fallback',
         free_fallback_at = now(),
         past_due_since = NULL,
         grace_period_ends_at = NULL,
         pending_change_type = NULL,
         next_plan_id = NULL,
         updated_at = now()
   WHERE id = v_sub.id;

  INSERT INTO public.billing_retention_signals (workspace_id, state, reason, details)
  VALUES (p_workspace_id, 'pending', 'free_fallback_nonpayment',
          jsonb_build_object('subscription_id', v_sub.id, 'fallback_plan_id', v_plan_id))
  ON CONFLICT (workspace_id) DO UPDATE
    SET state = 'pending', reason = 'free_fallback_nonpayment',
        signaled_at = now(), cleared_at = NULL,
        details = EXCLUDED.details;

  INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
  VALUES
    (p_workspace_id, 'grace_expired', 'unpaid',
     jsonb_build_object('subscription_id', v_sub.id)),
    (p_workspace_id, 'subscription_free_fallback', 'grace_expired',
     jsonb_build_object('plan_id', v_plan_id, 'period_id', v_period.id)),
    (p_workspace_id, 'invoice_expired_after_nonpayment', 'grace_expired',
     jsonb_build_object('invoices_expired', v_expired));

  IF (v_policy->>'notify_on_fallback')::boolean THEN
    PERFORM public.billing_v2_enqueue_notification(
      p_workspace_id, 'subscription_free_fallback', 'email', NULL, now(),
      jsonb_build_object('plan_name', v_plan.name),
      v_sub.id::text || ':' || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI'));
    PERFORM public.billing_v2_enqueue_notification(
      p_workspace_id, 'subscription_free_fallback', 'sms', NULL, now(), '{}'::jsonb,
      v_sub.id::text || ':' || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI'));
  END IF;

  RETURN jsonb_build_object('free_fallback', true, 'plan_id', v_plan_id,
                            'period_id', v_period.id, 'invoices_expired', v_expired);
END;
$function$
;
REVOKE ALL ON FUNCTION public.billing_v2_apply_free_fallback(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_v2_apply_free_fallback(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_v2_apply_period_allowance(p_period_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_period public.billing_subscription_periods;
  v_sync   JSONB;
BEGIN
  SELECT * INTO v_period FROM public.billing_subscription_periods WHERE id = p_period_id;
  IF v_period.id IS NULL THEN RAISE EXCEPTION 'unknown_period:%', p_period_id; END IF;
  IF v_period.status <> 'active' THEN
    RETURN jsonb_build_object('period_id', p_period_id, 'skipped', 'period_not_active');
  END IF;

  v_sync := public.billing_v2_sync_period_cycles(p_period_id);
  UPDATE public.billing_period_allowance_grants
     SET status = 'skipped', granted_at = COALESCE(granted_at, now()), last_error = NULL
   WHERE period_id = p_period_id AND status IN ('pending', 'failed');

  RETURN jsonb_build_object('period_id', p_period_id,
                            'lot_id', (v_sync->'grant'->>'lot_id')::uuid,
                            'cycle_id', (v_sync->>'active_cycle_id')::uuid,
                            'delegated_to', 'entitlement_cycle',
                            'replayed', COALESCE((v_sync->'grant'->>'replayed')::boolean, false));
END;
$function$
;
REVOKE ALL ON FUNCTION public.billing_v2_apply_period_allowance(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_v2_apply_period_allowance(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_v2_assert_single_scheduled_period()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_ws UUID; v_count INTEGER;
BEGIN
  v_ws := COALESCE(NEW.workspace_id, OLD.workspace_id);
  SELECT count(*) INTO v_count FROM public.billing_subscription_periods
   WHERE workspace_id = v_ws AND status = 'scheduled';
  IF v_count > 1 THEN
    RAISE EXCEPTION 'multiple_scheduled_periods:%:%', v_ws, v_count;
  END IF;
  RETURN NULL;
END;
$function$
;
REVOKE ALL ON FUNCTION public.billing_v2_assert_single_scheduled_period() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_v2_assert_single_scheduled_period() TO anon;
GRANT EXECUTE ON FUNCTION public.billing_v2_assert_single_scheduled_period() TO authenticated;
GRANT EXECUTE ON FUNCTION public.billing_v2_assert_single_scheduled_period() TO service_role;

CREATE OR REPLACE FUNCTION public.billing_v2_block_direct_subscription_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_consistent BOOLEAN;
BEGIN
  IF public.billing_purge_active() THEN RETURN COALESCE(NEW, OLD); END IF;
  IF public.billing_v2_state(NEW.workspace_id) <> 'v2_active' THEN
    RETURN NEW;
  END IF;

  -- Only the commercial-authority columns are guarded. Operational updates
  -- (status transitions, dunning markers, metadata) stay allowed.
  IF NEW.plan_id IS NOT DISTINCT FROM OLD.plan_id
     AND NEW.current_period_start IS NOT DISTINCT FROM OLD.current_period_start
     AND NEW.current_period_end IS NOT DISTINCT FROM OLD.current_period_end
     AND NEW.billing_interval IS NOT DISTINCT FROM OLD.billing_interval THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.billing_subscription_periods p
     WHERE p.id = NEW.current_period_id
       AND p.workspace_id = NEW.workspace_id
       AND p.status = 'active'
       AND p.period_start = NEW.current_period_start
       AND p.period_end   = NEW.current_period_end
       AND COALESCE(p.plan_id, NEW.plan_id) IS NOT DISTINCT FROM NEW.plan_id
  ) INTO v_consistent;

  IF NOT v_consistent THEN
    INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
    VALUES (NEW.workspace_id, 'billing_v2_legacy_path_rejected',
            'direct_subscription_mutation',
            jsonb_build_object(
              'old_plan_id', OLD.plan_id, 'new_plan_id', NEW.plan_id,
              'old_period_end', OLD.current_period_end,
              'new_period_end', NEW.current_period_end));
    RAISE EXCEPTION 'billing_v2_direct_subscription_mutation_forbidden:%', NEW.workspace_id;
  END IF;

  RETURN NEW;
END;
$function$
;
REVOKE ALL ON FUNCTION public.billing_v2_block_direct_subscription_mutation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_v2_block_direct_subscription_mutation() TO anon;
GRANT EXECUTE ON FUNCTION public.billing_v2_block_direct_subscription_mutation() TO authenticated;
GRANT EXECUTE ON FUNCTION public.billing_v2_block_direct_subscription_mutation() TO service_role;

CREATE OR REPLACE FUNCTION public.billing_v2_block_period_keyed_grant()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF public.billing_purge_active() THEN RETURN COALESCE(NEW, OLD); END IF;
  IF NEW.status = 'granted'
     AND COALESCE(OLD.status, '') <> 'granted'
     AND EXISTS (SELECT 1 FROM public.billing_entitlement_cycles c
                  WHERE c.subscription_period_id = NEW.period_id) THEN
    RAISE EXCEPTION 'billing_v2_period_keyed_grant_forbidden:%', NEW.period_id
      USING HINT = 'Grant the plan AI allowance through billing_entitlement_cycles (plan_allowance_cycle:<cycle_id>).';
  END IF;
  RETURN NEW;
END;
$function$
;
REVOKE ALL ON FUNCTION public.billing_v2_block_period_keyed_grant() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_v2_block_period_keyed_grant() TO anon;
GRANT EXECUTE ON FUNCTION public.billing_v2_block_period_keyed_grant() TO authenticated;
GRANT EXECUTE ON FUNCTION public.billing_v2_block_period_keyed_grant() TO service_role;

CREATE OR REPLACE FUNCTION public.billing_v2_cancel_invoice_notifications(p_invoice_id uuid, p_reason text DEFAULT 'invoice_closed'::text, p_types text[] DEFAULT ARRAY['invoice_issued'::text, 'invoice_reminder'::text, 'invoice_due'::text, 'invoice_past_due'::text])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_n INTEGER;
BEGIN
  UPDATE public.billing_notification_jobs
     SET status = 'canceled', lease_until = NULL,
         last_error = left(p_reason, 200), updated_at = now()
   WHERE invoice_id = p_invoice_id
     AND status IN ('pending', 'processing')
     AND notification_type = ANY (p_types);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$function$
;
REVOKE ALL ON FUNCTION public.billing_v2_cancel_invoice_notifications(uuid,text,text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_v2_cancel_invoice_notifications(uuid,text,text[]) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_v2_claim_jobs(p_job_type text, p_limit integer DEFAULT 25, p_lease_seconds integer DEFAULT 120)
 RETURNS SETOF billing_v2_jobs
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  UPDATE public.billing_v2_jobs j
     SET status = 'processing',
         attempt_count = j.attempt_count + 1,
         lease_until = now() + make_interval(secs => GREATEST(COALESCE(p_lease_seconds, 120), 30)),
         updated_at = now()
   WHERE j.id IN (
     SELECT c.id FROM public.billing_v2_jobs c
      WHERE c.job_type = p_job_type
        AND c.status IN ('pending', 'processing')
        AND c.next_attempt_at <= now()
        AND (c.lease_until IS NULL OR c.lease_until <= now())
      ORDER BY c.next_attempt_at
      FOR UPDATE SKIP LOCKED
      LIMIT GREATEST(COALESCE(p_limit, 25), 1)
   )
  RETURNING j.*;
$function$
;
REVOKE ALL ON FUNCTION public.billing_v2_claim_jobs(text,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_v2_claim_jobs(text,integer,integer) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_v2_claim_notification_jobs(p_limit integer DEFAULT 25, p_lease_seconds integer DEFAULT 120)
 RETURNS SETOF billing_notification_jobs
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  UPDATE public.billing_notification_jobs n
     SET status = 'processing',
         attempt_count = n.attempt_count + 1,
         lease_until = now() + make_interval(secs => GREATEST(COALESCE(p_lease_seconds, 120), 30)),
         updated_at = now()
   WHERE n.id IN (
     SELECT c.id FROM public.billing_notification_jobs c
      WHERE c.status IN ('pending', 'processing')
        AND c.scheduled_at <= now()
        AND c.next_attempt_at <= now()
        AND (c.lease_until IS NULL OR c.lease_until <= now())
      ORDER BY c.scheduled_at
      FOR UPDATE SKIP LOCKED
      LIMIT GREATEST(COALESCE(p_limit, 25), 1)
   )
  RETURNING n.*;
$function$
;
REVOKE ALL ON FUNCTION public.billing_v2_claim_notification_jobs(integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_v2_claim_notification_jobs(integer,integer) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_v2_complete_job(p_job_id uuid, p_result jsonb DEFAULT '{}'::jsonb)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  UPDATE public.billing_v2_jobs
     SET status = 'succeeded', lease_until = NULL, last_error = NULL,
         result = COALESCE(p_result, '{}'::jsonb), updated_at = now()
   WHERE id = p_job_id;
$function$
;
REVOKE ALL ON FUNCTION public.billing_v2_complete_job(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_v2_complete_job(uuid,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_v2_complete_notification_job(p_job_id uuid, p_status text DEFAULT 'sent'::text, p_error text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_job public.billing_notification_jobs;
BEGIN
  UPDATE public.billing_notification_jobs
     SET status = CASE WHEN p_status IN ('sent', 'skipped_no_recipient', 'canceled')
                       THEN p_status ELSE 'sent' END,
         sent_at = CASE WHEN p_status = 'sent' THEN now() ELSE sent_at END,
         lease_until = NULL, last_error = left(p_error, 300), updated_at = now()
   WHERE id = p_job_id
  RETURNING * INTO v_job;

  IF v_job.id IS NOT NULL THEN
    INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
    VALUES (v_job.workspace_id,
            CASE WHEN v_job.status = 'sent' THEN 'billing_notification_sent'
                 ELSE 'billing_notification_skipped' END,
            v_job.notification_type,
            jsonb_build_object('channel', v_job.channel, 'invoice_id', v_job.invoice_id));
  END IF;
END;
$function$
;
REVOKE ALL ON FUNCTION public.billing_v2_complete_notification_job(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_v2_complete_notification_job(uuid,text,text) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_v2_current_entitlement_cycle(p_workspace_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(
    (SELECT jsonb_build_object(
              'cycle_id', c.id,
              'cycle_index', c.cycle_index,
              'start', c.cycle_start,
              'end', c.cycle_end,
              'allowance_irr', c.ai_allowance_irr,
              'allowance_state', c.allowance_state,
              'period_id', c.subscription_period_id,
              'lot_id', c.allowance_lot_id,
              'remaining_irr', COALESCE((
                SELECT SUM(l.remaining_amount)::bigint FROM public.workspace_ai_balance_lots l
                 WHERE l.id = c.allowance_lot_id), 0))
       FROM public.billing_entitlement_cycles c
      WHERE c.workspace_id = p_workspace_id
        AND c.cycle_start <= now() AND c.cycle_end > now()
        AND c.status IN ('active', 'scheduled')
      ORDER BY (c.status = 'active') DESC, c.cycle_start DESC
      LIMIT 1),
    'null'::jsonb);
$function$
;
REVOKE ALL ON FUNCTION public.billing_v2_current_entitlement_cycle(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_v2_current_entitlement_cycle(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_v2_defer_job(p_job_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  UPDATE public.billing_v2_jobs
     SET status = 'pending',
         attempt_count = GREATEST(attempt_count - 1, 0),
         lease_until = NULL,
         next_attempt_at = now(),
         last_error = left(p_reason, 500),
         updated_at = now()
   WHERE id = p_job_id;
$function$
;
REVOKE ALL ON FUNCTION public.billing_v2_defer_job(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_v2_defer_job(uuid,text) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_v2_document_number()
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  letters TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  out     TEXT := '';
  i       INTEGER;
BEGIN
  -- CSPRNG, same alphabet/format as invoiceNumber.ts: ^[A-Z]{2}[0-9]{8}$
  FOR i IN 1..2 LOOP
    out := out || substr(letters, 1 + (get_byte(gen_random_bytes(1), 0) % length(letters)), 1);
  END LOOP;
  FOR i IN 1..8 LOOP
    out := out || (get_byte(gen_random_bytes(1), 0) % 10)::text;
  END LOOP;
  RETURN out;
END;
$function$
;
REVOKE ALL ON FUNCTION public.billing_v2_document_number() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_v2_document_number() TO service_role;

CREATE OR REPLACE FUNCTION public.billing_v2_dunning_metrics()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
    'open_invoices', (SELECT count(*) FROM public.billing_invoices WHERE status = 'open'),
    'past_due_invoices', (SELECT count(*) FROM public.billing_invoices WHERE status = 'past_due'),
    'past_due_amount_irr', (SELECT COALESCE(sum(amount_due_irr), 0)
                              FROM public.billing_invoices WHERE status = 'past_due'),
    'grace_subscriptions', (SELECT count(*) FROM public.workspace_subscriptions
                             WHERE status = 'past_due' AND grace_period_ends_at IS NOT NULL),
    'fallbacks_total', (SELECT count(*) FROM public.workspace_subscriptions
                         WHERE status = 'free_fallback'),
    'autopay_success', (SELECT count(*) FROM public.billing_v2_audit
                         WHERE event = 'wallet_autopay_succeeded'),
    'autopay_insufficient', (SELECT count(*) FROM public.billing_v2_audit
                              WHERE event = 'wallet_autopay_skipped_insufficient'),
    'notification_backlog', (SELECT count(*) FROM public.billing_notification_jobs
                              WHERE status IN ('pending', 'processing')),
    'notification_failures', (SELECT count(*) FROM public.billing_notification_jobs
                               WHERE status = 'failed'),
    'retention_signals_pending', (SELECT count(*) FROM public.billing_retention_signals
                                   WHERE state = 'pending'),
    'checked_at', now()
  );
$function$
;
REVOKE ALL ON FUNCTION public.billing_v2_dunning_metrics() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_v2_dunning_metrics() TO service_role;

CREATE OR REPLACE FUNCTION public.billing_v2_dunning_snapshot(p_invoice_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inv  public.billing_invoices;
  v_snap JSONB;
BEGIN
  SELECT * INTO v_inv FROM public.billing_invoices WHERE id = p_invoice_id;
  IF v_inv.id IS NULL THEN RETURN NULL; END IF;
  v_snap := v_inv.metadata->'dunning';
  IF v_snap IS NULL OR jsonb_typeof(v_snap) <> 'object' THEN
    -- Pre-Phase-E invoices carry no snapshot; live policy is the only honest
    -- answer for them, and it is never written back retroactively.
    RETURN public.billing_v2_policy_for(v_inv.workspace_id);
  END IF;
  RETURN v_snap;
END;
$function$
;
REVOKE ALL ON FUNCTION public.billing_v2_dunning_snapshot(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_v2_dunning_snapshot(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_v2_enqueue_job(p_job_type text, p_dedupe_key text, p_workspace_id uuid, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_id UUID;
BEGIN
  INSERT INTO public.billing_v2_jobs (job_type, dedupe_key, workspace_id, payload)
  VALUES (p_job_type, p_dedupe_key, p_workspace_id, COALESCE(p_payload, '{}'::jsonb))
  ON CONFLICT (job_type, dedupe_key) DO UPDATE
    SET updated_at = now()
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$
;
REVOKE ALL ON FUNCTION public.billing_v2_enqueue_job(text,text,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_v2_enqueue_job(text,text,uuid,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_v2_enqueue_notification(p_workspace_id uuid, p_type text, p_channel text, p_invoice_id uuid DEFAULT NULL::uuid, p_scheduled_at timestamp with time zone DEFAULT now(), p_payload jsonb DEFAULT '{}'::jsonb, p_suffix text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_policy JSONB;
  v_rcpt   JSONB;
  v_sub    UUID;
  v_key    TEXT;
  v_id     UUID;
  v_recent INTEGER;
BEGIN
  v_policy := public.billing_v2_policy_for(p_workspace_id);
  IF NOT (v_policy->>'notifications_enabled')::boolean THEN
    RETURN NULL;
  END IF;

  v_rcpt := public.billing_v2_resolve_billing_recipient(p_workspace_id);
  SELECT id INTO v_sub FROM public.workspace_subscriptions WHERE workspace_id = p_workspace_id;

  v_key := p_type || ':' || p_channel || ':' ||
           COALESCE(p_invoice_id::text, p_workspace_id::text) || ':' ||
           COALESCE(p_suffix, to_char(p_scheduled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'));

  -- Rate guard: never let a catch-up run flood one workspace.
  SELECT count(*) INTO v_recent FROM public.billing_notification_jobs
   WHERE workspace_id = p_workspace_id AND created_at > now() - interval '1 hour';
  IF v_recent >= (v_policy->>'notification_max_per_hour')::int THEN
    INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
    VALUES (p_workspace_id, 'billing_notification_rate_limited', p_type,
            jsonb_build_object('channel', p_channel, 'recent', v_recent));
    RETURN NULL;
  END IF;

  INSERT INTO public.billing_notification_jobs (
    workspace_id, invoice_id, subscription_id, notification_type, channel, locale,
    scheduled_at, next_attempt_at, max_attempts, idempotency_key, payload, status
  ) VALUES (
    p_workspace_id, p_invoice_id, v_sub, p_type, p_channel, v_rcpt->>'locale',
    p_scheduled_at, p_scheduled_at, (v_policy->>'notification_max_attempts')::int,
    v_key, COALESCE(p_payload, '{}'::jsonb),
    CASE
      WHEN p_channel = 'email' AND (v_rcpt->>'email') IS NULL THEN 'skipped_no_recipient'
      WHEN p_channel = 'sms'   AND (v_rcpt->>'phone') IS NULL THEN 'skipped_no_recipient'
      ELSE 'pending'
    END
  )
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$
;
REVOKE ALL ON FUNCTION public.billing_v2_enqueue_notification(uuid,text,text,uuid,timestamp with time zone,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_v2_enqueue_notification(uuid,text,text,uuid,timestamp with time zone,jsonb,text) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_v2_ensure_free_period(p_workspace_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_sub    public.workspace_subscriptions;
  v_plan   public.billing_plans;
  v_start  TIMESTAMPTZ;
  v_end    TIMESTAMPTZ;
  v_period public.billing_subscription_periods;
  v_allow  BIGINT;
BEGIN
  SELECT * INTO v_sub FROM public.workspace_subscriptions
   WHERE workspace_id = p_workspace_id FOR UPDATE;
  IF v_sub.id IS NULL OR v_sub.plan_id IS NULL THEN
    RETURN jsonb_build_object('skipped', 'no_subscription');
  END IF;

  SELECT * INTO v_plan FROM public.billing_plans WHERE id = v_sub.plan_id;
  IF v_plan.id IS NULL THEN RETURN jsonb_build_object('skipped', 'unknown_plan'); END IF;

  v_start := COALESCE(v_sub.next_invoice_at, v_sub.current_period_end, now());
  IF v_start > now() THEN
    RETURN jsonb_build_object('skipped', 'not_yet_due', 'next_at', v_start);
  END IF;
  v_end := public.billing_v2_add_interval(v_start, COALESCE(v_sub.billing_interval, 'monthly'), 1);

  IF EXISTS (SELECT 1 FROM public.billing_subscription_periods
              WHERE workspace_id = p_workspace_id
                AND status IN ('scheduled', 'active')
                AND period_start = v_start) THEN
    RETURN jsonb_build_object('skipped', 'period_exists');
  END IF;

  v_allow := GREATEST(ROUND(COALESCE((v_plan.limits->>'ai_credits_per_month')::numeric, 0))::bigint, 0);

  INSERT INTO public.billing_subscription_periods (
    workspace_id, subscription_id, plan_id, invoice_id, billing_interval,
    period_start, period_end, status, source, plan_snapshot, limits_snapshot, ai_allowance_irr
  ) VALUES (
    p_workspace_id, v_sub.id, v_plan.id, NULL, COALESCE(v_sub.billing_interval, 'monthly'),
    v_start, v_end, 'scheduled', 'free_plan',
    to_jsonb(v_plan), COALESCE(v_plan.limits, '{}'::jsonb), v_allow
  ) RETURNING * INTO v_period;

  UPDATE public.workspace_subscriptions
     SET next_invoice_at = v_end, updated_at = now() WHERE id = v_sub.id;

  PERFORM public.billing_activate_period(v_period.id);

  INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
  VALUES (p_workspace_id, 'free_period_activated', 'scheduler',
          jsonb_build_object('period_id', v_period.id, 'period_start', v_start, 'period_end', v_end));

  RETURN jsonb_build_object('period_id', v_period.id, 'free', true, 'replayed', false);
END;
$function$
;
REVOKE ALL ON FUNCTION public.billing_v2_ensure_free_period(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_v2_ensure_free_period(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_v2_ensure_period_cycles(p_period_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_period   public.billing_subscription_periods;
  v_prev     public.billing_entitlement_cycles;
  v_monthly  BIGINT;
  v_grants   BOOLEAN;
  v_start    TIMESTAMPTZ;
  v_end      TIMESTAMPTZ;
  v_anchor   TIMESTAMPTZ;
  v_base     TIMESTAMPTZ;
  v_step     INTEGER := 1;
  v_idx      INTEGER := 0;
  v_created  INTEGER := 0;
  v_amount   BIGINT;
  v_prev_m   BIGINT := 0;
  v_frac     NUMERIC;
  v_kind     TEXT;
BEGIN
  SELECT * INTO v_period FROM public.billing_subscription_periods
   WHERE id = p_period_id FOR UPDATE;
  IF v_period.id IS NULL THEN RAISE EXCEPTION 'unknown_period:%', p_period_id; END IF;
  IF v_period.status = 'canceled' THEN
    RETURN jsonb_build_object('period_id', p_period_id, 'skipped', 'period_canceled');
  END IF;

  v_monthly := public.billing_v2_period_monthly_allowance(v_period);
  v_grants  := public.billing_v2_period_cycles_grant(p_period_id);

  -- Mid-cycle start (immediate upgrade): reuse the live cycle's boundary as
  -- the grid anchor so the customer's AI month keeps its original rhythm.
  SELECT * INTO v_prev FROM public.billing_entitlement_cycles
   WHERE workspace_id = v_period.workspace_id
     AND subscription_period_id <> v_period.id
     AND cycle_start <= v_period.period_start
     AND cycle_end   >  v_period.period_start
   ORDER BY cycle_start DESC LIMIT 1;

  v_start := v_period.period_start;
  IF v_prev.id IS NOT NULL AND v_prev.cycle_end < v_period.period_end THEN
    v_base   := v_prev.cycle_end;
    v_step   := 0;
    v_prev_m := COALESCE((v_prev.snapshot->>'monthly_allowance_irr')::bigint, v_prev.ai_allowance_irr);
  ELSE
    v_base := v_start;
    v_step := 1;
  END IF;

  LOOP
    -- Every boundary is measured from the ORIGINAL anchor, never from the
    -- previous boundary: 31 Jan → 28 Feb → 31 Mar, with no month-end drift.
    -- (step 0 means "the anchor itself": billing_v2_add_interval floors its
    -- count at 1, so the identity step is taken explicitly.)
    v_anchor := CASE WHEN v_step = 0 THEN v_base
                     ELSE public.billing_v2_add_interval(v_base, 'monthly', v_step) END;
    v_end    := LEAST(v_anchor, v_period.period_end);
    EXIT WHEN v_end <= v_start;

    -- No slivers: when the next anchor would overshoot the period, the final
    -- cycle absorbs the remainder instead of spawning a few-hour 13th cycle.
    IF public.billing_v2_add_interval(v_base, 'monthly', v_step + 1) > v_period.period_end THEN
      v_end := v_period.period_end;
    END IF;


    IF v_idx = 0 AND v_prev.id IS NOT NULL THEN
      -- Prorated DELTA for the remainder of the running cycle. Never negative:
      -- an upgrade tops up, it never claws back what was already granted.
      v_frac := GREATEST(EXTRACT(EPOCH FROM (v_end - v_start)), 0)
                / NULLIF(EXTRACT(EPOCH FROM (v_prev.cycle_end - v_prev.cycle_start)), 0);
      v_amount := GREATEST(ROUND(GREATEST(v_monthly - v_prev_m, 0) * COALESCE(v_frac, 0))::bigint, 0);
      v_kind := 'prorated_upgrade_delta';
    ELSE
      v_amount := v_monthly;
      v_kind := 'full_monthly';
    END IF;

    INSERT INTO public.billing_entitlement_cycles (
      workspace_id, subscription_id, subscription_period_id, cycle_index,
      cycle_start, cycle_end, status, ai_allowance_irr, allowance_state, snapshot
    ) VALUES (
      v_period.workspace_id, v_period.subscription_id, v_period.id, v_idx,
      v_start, v_end, 'scheduled',
      CASE WHEN v_grants THEN v_amount ELSE 0 END,
      CASE WHEN v_grants AND v_amount > 0 THEN 'pending' ELSE 'skipped' END,
      jsonb_build_object(
        'kind', v_kind,
        'monthly_allowance_irr', v_monthly,
        'plan_id', v_period.plan_id,
        'billing_interval', v_period.billing_interval,
        'limits_snapshot', COALESCE(v_period.limits_snapshot, '{}'::jsonb),
        'period_source', v_period.source,
        'grant_authority', CASE WHEN v_grants THEN 'entitlement_cycle' ELSE 'legacy_period' END
      )
    )
    ON CONFLICT (subscription_period_id, cycle_index) DO NOTHING;

    IF FOUND THEN v_created := v_created + 1; END IF;

    v_start := v_end;
    v_step  := v_step + 1;
    v_idx   := v_idx + 1;
    EXIT WHEN v_start >= v_period.period_end OR v_idx > 24;  -- hard bound
  END LOOP;

  RETURN jsonb_build_object(
    'period_id', p_period_id, 'created', v_created, 'cycles', v_idx,
    'monthly_allowance_irr', v_monthly, 'grants', v_grants
  );
END;
$function$
;
REVOKE ALL ON FUNCTION public.billing_v2_ensure_period_cycles(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_v2_ensure_period_cycles(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_v2_evaluate_cutover(p_workspace_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_sub            public.workspace_subscriptions;
  v_blockers       JSONB := '[]'::jsonb;
  v_classification TEXT  := 'paid_active';
  v_plan_free      BOOLEAN := false;
  v_count          INTEGER;
  v_unbound        INTEGER := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.workspaces WHERE id = p_workspace_id) THEN
    RETURN jsonb_build_object('ready', false, 'blockers',
      jsonb_build_array(jsonb_build_object('code', 'unknown_workspace')));
  END IF;

  SELECT * INTO v_sub FROM public.workspace_subscriptions
   WHERE workspace_id = p_workspace_id;

  IF v_sub.workspace_id IS NULL THEN
    v_classification := 'free_no_subscription';
  ELSE
    SELECT COALESCE(is_free, false) INTO v_plan_free
      FROM public.billing_plans WHERE id = v_sub.plan_id;
    v_plan_free := COALESCE(v_plan_free, true);

    IF v_sub.status = 'trialing' THEN
      v_classification := 'trial';
    ELSIF v_plan_free THEN
      v_classification := 'free';
    END IF;

    -- 26. Never fabricate a period for a contract that already ended.
    IF NOT v_plan_free
       AND v_sub.current_period_end IS NOT NULL
       AND v_sub.current_period_end < now() THEN
      v_classification := 'expired_paid_period';
      v_blockers := v_blockers || jsonb_build_object(
        'code', 'subscription_period_expired',
        'detail', v_sub.current_period_end);
    END IF;

    -- 27. A pending plan change must be decided explicitly, never dropped.
    IF v_sub.pending_change_type IS NOT NULL THEN
      v_blockers := v_blockers || jsonb_build_object(
        'code', 'pending_plan_change',
        'detail', v_sub.pending_change_type);
    END IF;

    -- 24. A live paid contract must already own its Phase A legacy period.
    IF NOT v_plan_free AND v_sub.status IN ('active', 'past_due')
       AND NOT EXISTS (
         SELECT 1 FROM public.billing_subscription_periods
          WHERE workspace_id = p_workspace_id AND status = 'active') THEN
      v_blockers := v_blockers || jsonb_build_object('code', 'missing_legacy_migration_period');
    END IF;

    -- Handover marker must not already be set outside an activated rollout.
    IF v_sub.v2_allowance_effective_period_id IS NOT NULL
       AND public.billing_v2_state(p_workspace_id) <> 'v2_active' THEN
      v_blockers := v_blockers || jsonb_build_object('code', 'allowance_handover_inconsistent');
    END IF;
  END IF;

  -- 7/9/10. Legacy payment intent drain — anything non-terminal and bound is a
  -- hard blocker: its callback could otherwise arrive after activation.
  SELECT count(*) INTO v_count FROM public.billing_payment_intents
   WHERE workspace_id = p_workspace_id
     AND billing_engine_version = 'v1'
     AND status = 'processing';
  IF v_count > 0 THEN
    v_blockers := v_blockers || jsonb_build_object('code', 'legacy_intent_processing', 'count', v_count);
  END IF;

  SELECT count(*) INTO v_count FROM public.billing_payment_intents
   WHERE workspace_id = p_workspace_id
     AND billing_engine_version = 'v1'
     AND status = 'pending'
     AND provider_ref IS NOT NULL;
  IF v_count > 0 THEN
    v_blockers := v_blockers || jsonb_build_object('code', 'legacy_intent_bound', 'count', v_count);
  END IF;

  SELECT count(*) INTO v_unbound FROM public.billing_payment_intents
   WHERE workspace_id = p_workspace_id
     AND billing_engine_version = 'v1'
     AND status = 'pending'
     AND provider_ref IS NULL;

  -- Financial recovery must be clean before authority moves.
  SELECT count(*) INTO v_count FROM public.billing_payments
   WHERE workspace_id = p_workspace_id AND reconciliation_state = 'unapplied';
  IF v_count > 0 THEN
    v_blockers := v_blockers || jsonb_build_object('code', 'unreconciled_payment', 'count', v_count);
  END IF;

  SELECT count(*) INTO v_count FROM public.billing_invoices i
   WHERE i.workspace_id = p_workspace_id
     AND (i.status = 'partially_paid'
          OR (i.status = 'paid' AND NOT EXISTS (
                SELECT 1 FROM public.billing_invoice_applications a
                 WHERE a.invoice_id = i.id AND a.application_status = 'applied')));
  IF v_count > 0 THEN
    v_blockers := v_blockers || jsonb_build_object('code', 'unapplied_invoice_effects', 'count', v_count);
  END IF;

  SELECT count(*) INTO v_count FROM public.billing_invoice_collections
   WHERE workspace_id = p_workspace_id AND status = 'active' AND expires_at > now();
  IF v_count > 0 THEN
    v_blockers := v_blockers || jsonb_build_object('code', 'gateway_collection_in_flight', 'count', v_count);
  END IF;

  RETURN jsonb_build_object(
    'ready', jsonb_array_length(v_blockers) = 0,
    'blockers', v_blockers,
    'classification', v_classification,
    'state', public.billing_v2_state(p_workspace_id),
    'drainable_unbound_intents', v_unbound,
    'wallet_account', EXISTS (
      SELECT 1 FROM public.billing_wallet_accounts WHERE workspace_id = p_workspace_id)
  );
END;
$function$
;
REVOKE ALL ON FUNCTION public.billing_v2_evaluate_cutover(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_v2_evaluate_cutover(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_v2_fail_job(p_job_id uuid, p_error text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_job public.billing_v2_jobs;
BEGIN
  SELECT * INTO v_job FROM public.billing_v2_jobs WHERE id = p_job_id;
  IF v_job.id IS NULL THEN RETURN; END IF;

  UPDATE public.billing_v2_jobs
     SET status = CASE WHEN v_job.attempt_count >= v_job.max_attempts THEN 'failed' ELSE 'pending' END,
         lease_until = NULL,
         last_error = left(COALESCE(p_error, 'unknown'), 500),
         next_attempt_at = now() + LEAST(
           make_interval(mins => GREATEST(v_job.attempt_count, 1) * 5),
           interval '1 hour'
         ),
         updated_at = now()
   WHERE id = p_job_id;
END;
$function$
;
REVOKE ALL ON FUNCTION public.billing_v2_fail_job(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_v2_fail_job(uuid,text) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_v2_fail_notification_job(p_job_id uuid, p_error text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_job    public.billing_notification_jobs;
  v_policy JSONB;
BEGIN
  SELECT * INTO v_job FROM public.billing_notification_jobs WHERE id = p_job_id;
  IF v_job.id IS NULL THEN RETURN; END IF;
  v_policy := public.billing_v2_policy_for(v_job.workspace_id);

  UPDATE public.billing_notification_jobs
     SET status = CASE WHEN v_job.attempt_count >= v_job.max_attempts THEN 'failed' ELSE 'pending' END,
         lease_until = NULL,
         last_error = left(COALESCE(p_error, 'unknown'), 300),
         next_attempt_at = now() + make_interval(
           secs => LEAST((v_policy->>'notification_retry_seconds')::int
                         * GREATEST(v_job.attempt_count, 1), 21600)),
         updated_at = now()
   WHERE id = p_job_id;

  INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
  VALUES (v_job.workspace_id, 'billing_notification_failed', left(COALESCE(p_error, 'unknown'), 200),
          jsonb_build_object('channel', v_job.channel, 'type', v_job.notification_type,
                             'attempt', v_job.attempt_count));
END;
$function$
;
REVOKE ALL ON FUNCTION public.billing_v2_fail_notification_job(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_v2_fail_notification_job(uuid,text) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_v2_grant_cycle_allowance(p_cycle_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_cycle public.billing_entitlement_cycles;
  v_lot   UUID;
BEGIN
  SELECT * INTO v_cycle FROM public.billing_entitlement_cycles
   WHERE id = p_cycle_id FOR UPDATE;
  IF v_cycle.id IS NULL THEN RAISE EXCEPTION 'unknown_entitlement_cycle:%', p_cycle_id; END IF;

  IF v_cycle.allowance_state = 'granted' THEN
    INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
    VALUES (v_cycle.workspace_id, 'plan_allowance_grant_replayed', 'already_granted',
            jsonb_build_object('cycle_id', v_cycle.id, 'lot_id', v_cycle.allowance_lot_id));
    RETURN jsonb_build_object('cycle_id', v_cycle.id, 'lot_id', v_cycle.allowance_lot_id, 'replayed', true);
  END IF;

  IF v_cycle.status <> 'active' THEN
    RETURN jsonb_build_object('cycle_id', v_cycle.id, 'skipped', 'cycle_not_active');
  END IF;
  -- Downtime invariant: an already-expired cycle is never funded afterwards.
  IF v_cycle.cycle_end <= now() THEN
    UPDATE public.billing_entitlement_cycles
       SET allowance_state = 'skipped', last_error = 'cycle_expired'
     WHERE id = v_cycle.id;
    RETURN jsonb_build_object('cycle_id', v_cycle.id, 'skipped', 'cycle_expired');
  END IF;
  IF v_cycle.ai_allowance_irr <= 0 THEN
    UPDATE public.billing_entitlement_cycles
       SET allowance_state = 'skipped', allowance_granted_at = now()
     WHERE id = v_cycle.id;
    RETURN jsonb_build_object('cycle_id', v_cycle.id, 'skipped', 'no_allowance');
  END IF;

  BEGIN
    v_lot := public.ai_grant_allowance(
      v_cycle.workspace_id,
      v_cycle.ai_allowance_irr::numeric,
      'cycle:' || v_cycle.id::text,            -- billing_cycle_id (lot identity)
      'plan',
      v_cycle.cycle_end,                        -- expires with the cycle: no carry-over
      'plan_allowance_cycle:' || v_cycle.id::text
    );
  EXCEPTION WHEN OTHERS THEN
    UPDATE public.billing_entitlement_cycles
       SET allowance_state = 'failed', attempt_count = attempt_count + 1,
           last_error = left(SQLERRM, 500), next_attempt_at = now() + interval '5 minutes'
     WHERE id = v_cycle.id;
    RAISE;
  END;

  UPDATE public.billing_entitlement_cycles
     SET allowance_state = 'granted', allowance_lot_id = v_lot,
         allowance_granted_at = now(), attempt_count = attempt_count + 1, last_error = NULL
   WHERE id = v_cycle.id;

  -- Auditability of the lot's origin (source_type is PLAN_ALLOWANCE). The
  -- metadata column is optional across deployments, so this is best-effort.
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'workspace_ai_balance_lots'
                AND column_name = 'metadata') THEN
    EXECUTE 'UPDATE public.workspace_ai_balance_lots SET metadata = COALESCE(metadata, ''{}''::jsonb) || $1 WHERE id = $2'
      USING jsonb_build_object(
              'source_reference_type', 'ENTITLEMENT_CYCLE',
              'source_reference_id', v_cycle.id,
              'subscription_period_id', v_cycle.subscription_period_id), v_lot;
  END IF;

  INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
  VALUES (v_cycle.workspace_id, 'plan_allowance_granted', 'entitlement_cycle',
          jsonb_build_object('cycle_id', v_cycle.id, 'lot_id', v_lot,
                             'period_id', v_cycle.subscription_period_id,
                             'cycle_index', v_cycle.cycle_index,
                             'allowance_irr', v_cycle.ai_allowance_irr,
                             'expires_at', v_cycle.cycle_end));

  RETURN jsonb_build_object('cycle_id', v_cycle.id, 'lot_id', v_lot,
                            'allowance_irr', v_cycle.ai_allowance_irr, 'replayed', false);
END;
$function$
;
REVOKE ALL ON FUNCTION public.billing_v2_grant_cycle_allowance(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_v2_grant_cycle_allowance(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_v2_invoice_arm_dunning()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_policy JSONB;
BEGIN
  IF NEW.status <> 'open' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'open' THEN RETURN NEW; END IF;

  IF NEW.metadata->'dunning' IS NULL THEN
    v_policy := public.billing_v2_policy_for(NEW.workspace_id);
    UPDATE public.billing_invoices
       SET metadata = metadata || jsonb_build_object('dunning', jsonb_build_object(
             'grace_period_days',        (v_policy->>'grace_period_days')::int,
             'reminder_days_before_due', v_policy->'reminder_days_before_due',
             'fallback_plan_id',         v_policy->>'fallback_plan_id',
             'frozen_at',                to_jsonb(now())
           ))
     WHERE id = NEW.id;
  END IF;

  PERFORM public.billing_v2_schedule_invoice_notifications(NEW.id);
  RETURN NEW;
END;
$function$
;
REVOKE ALL ON FUNCTION public.billing_v2_invoice_arm_dunning() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.billing_v2_invoice_notification_sync()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_res JSONB;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status IN ('paid', 'void', 'expired') THEN
    PERFORM public.billing_v2_cancel_invoice_notifications(NEW.id, 'invoice_' || NEW.status);
  END IF;

  -- Recovery is path-independent: wallet auto-pay, a gateway callback or an
  -- operator marking the invoice paid all reach the same deterministic exit
  -- from dunning. Idempotent, and a no-op once the workspace fell back.
  IF NEW.status = 'paid' AND OLD.status IS DISTINCT FROM 'paid' THEN
    v_res := public.billing_v2_restore_subscription(NEW.workspace_id);
    IF v_res->>'skipped' = 'already_free_fallback' THEN
      -- Money after fallback is never a silent rollback to the paid plan; it
      -- is recorded so a human (or Phase F) can decide what it buys.
      INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
      VALUES (NEW.workspace_id, 'payment_after_free_fallback', 'no_auto_revival',
              jsonb_build_object('invoice_id', NEW.id, 'amount_irr', NEW.amount_paid_irr));
    END IF;
  END IF;
  RETURN NEW;
END;
$function$
;
REVOKE ALL ON FUNCTION public.billing_v2_invoice_notification_sync() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.billing_v2_issue_renewal_invoice(p_workspace_id uuid, p_force boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_sub       public.workspace_subscriptions;
  v_state     TEXT;
  v_policy    JSONB;
  v_lead      INTEGER;
  v_plan      public.billing_plans;
  v_target    UUID;
  v_interval  TEXT;
  v_start     TIMESTAMPTZ;
  v_end       TIMESTAMPTZ;
  v_price     BIGINT;
  v_allowance BIGINT;
  v_existing  public.billing_invoices;
  v_inv       public.billing_invoices;
  v_num       TEXT;
  v_tries     INTEGER := 0;
  v_snapshot  JSONB;
BEGIN
  SELECT * INTO v_sub FROM public.workspace_subscriptions
   WHERE workspace_id = p_workspace_id FOR UPDATE;
  IF v_sub.id IS NULL THEN
    RETURN jsonb_build_object('skipped', 'no_subscription');
  END IF;

  SELECT state INTO v_state FROM public.billing_v2_rollout WHERE workspace_id = p_workspace_id;
  IF COALESCE(v_state, 'legacy') <> 'v2_active' THEN
    RETURN jsonb_build_object('skipped', 'not_v2_active');
  END IF;

  IF v_sub.status = 'trialing' THEN
    RETURN jsonb_build_object('skipped', 'trial');
  END IF;
  IF v_sub.status NOT IN ('active', 'past_due') THEN
    RETURN jsonb_build_object('skipped', 'subscription_status:' || v_sub.status);
  END IF;
  IF v_sub.cancel_at_period_end OR v_sub.pending_change_type = 'cancel' THEN
    RETURN jsonb_build_object('skipped', 'canceling');
  END IF;

  -- Target contract: a pending plan change is what the NEXT period must bill.
  v_target := CASE
    WHEN v_sub.pending_change_type IN ('upgrade', 'downgrade') AND v_sub.next_plan_id IS NOT NULL
      THEN v_sub.next_plan_id
    ELSE v_sub.plan_id END;
  IF v_target IS NULL THEN
    RETURN jsonb_build_object('skipped', 'no_plan');
  END IF;

  SELECT * INTO v_plan FROM public.billing_plans WHERE id = v_target;
  IF v_plan.id IS NULL THEN
    RETURN jsonb_build_object('skipped', 'unknown_plan');
  END IF;

  v_interval := COALESCE(v_sub.billing_interval, 'monthly');
  v_start := COALESCE(v_sub.next_invoice_at, v_sub.current_period_end);
  IF v_start IS NULL THEN
    RETURN jsonb_build_object('skipped', 'no_anchor');
  END IF;
  v_end := public.billing_v2_add_interval(v_start, v_interval, 1);

  -- Prices live in billing_plans.prices as {CURRENCY: {monthly, yearly}}; the
  -- Iranian region bills in IRR.
  v_price := GREATEST(ROUND(COALESCE(
    (v_plan.prices->'IRR'->>v_interval)::numeric, 0))::bigint, 0);

  -- Free contract: no invoice at all, the free-period path owns it.
  IF v_price = 0 THEN
    RETURN public.billing_v2_ensure_free_period(p_workspace_id);
  END IF;

  v_policy := public.billing_v2_policy_for(p_workspace_id);
  v_lead := (v_policy->>'invoice_lead_time_days')::int;
  IF NOT p_force AND now() < v_start - make_interval(days => v_lead) THEN
    RETURN jsonb_build_object('skipped', 'not_yet_eligible', 'eligible_at', v_start - make_interval(days => v_lead));
  END IF;

  -- Never invoice a window that already has a service period.
  IF EXISTS (
    SELECT 1 FROM public.billing_subscription_periods
     WHERE workspace_id = p_workspace_id
       AND status IN ('scheduled', 'active')
       AND period_start = v_start
  ) THEN
    RETURN jsonb_build_object('skipped', 'period_exists');
  END IF;

  -- Idempotency: one live renewal invoice per (subscription, window).
  SELECT * INTO v_existing FROM public.billing_invoices
   WHERE subscription_id = v_sub.id
     AND invoice_type = 'subscription_renewal'
     AND period_start = v_start
     AND status NOT IN ('void', 'expired')
   ORDER BY created_at DESC LIMIT 1;

  IF v_existing.id IS NOT NULL THEN
    -- A paid invoice is never rewritten or voided.
    IF v_existing.status = 'paid'
       OR v_existing.amount_paid_irr > 0
       OR COALESCE((v_existing.effect_snapshot->>'target_plan_id')::uuid, v_existing.plan_id) = v_target
    THEN
      INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
      VALUES (p_workspace_id, 'renewal_invoice_issue_replayed', 'already_issued',
              jsonb_build_object('invoice_id', v_existing.id, 'period_start', v_start));
      RETURN jsonb_build_object('invoice_id', v_existing.id, 'replayed', true);
    END IF;

    -- Unpaid invoice whose target no longer matches the pending change: void
    -- it and issue a fresh document with the new snapshot.
    IF EXISTS (SELECT 1 FROM public.billing_invoice_collections
                WHERE invoice_id = v_existing.id AND status = 'active') THEN
      RETURN jsonb_build_object('skipped', 'collection_active', 'invoice_id', v_existing.id);
    END IF;
    UPDATE public.billing_invoices
       SET status = 'void', voided_at = now(),
           metadata = metadata || jsonb_build_object('void_reason', 'plan_change_before_payment')
     WHERE id = v_existing.id;
    INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
    VALUES (p_workspace_id, 'renewal_invoice_voided', 'plan_change_before_payment',
            jsonb_build_object('invoice_id', v_existing.id));
  END IF;

  v_allowance := GREATEST(ROUND(COALESCE((v_plan.limits->>'ai_credits_per_month')::numeric, 0))::bigint, 0);
  IF v_interval = 'yearly' THEN
    -- Existing V2 contract (issue.ts): a yearly period carries twelve months of
    -- allowance, granted ONCE for the period and expiring at period_end.
    v_allowance := v_allowance * 12;
  END IF;

  v_snapshot := jsonb_build_object(
    'action_type', CASE WHEN v_target = v_sub.plan_id THEN 'plan_renewal'
                        WHEN v_sub.pending_change_type = 'upgrade' THEN 'plan_upgrade'
                        ELSE 'plan_downgrade' END,
    'source_plan_id', v_sub.plan_id,
    'target_plan_id', v_target,
    'billing_interval', v_interval,
    'effective_at', v_start,
    'period_start', v_start,
    'period_end', v_end,
    'plan_snapshot', to_jsonb(v_plan),
    'limits_snapshot', COALESCE(v_plan.limits, '{}'::jsonb),
    'ai_allowance_irr', v_allowance,
    'proration', NULL
  );

  LOOP
    v_tries := v_tries + 1;
    v_num := public.billing_v2_document_number();
    BEGIN
      INSERT INTO public.billing_invoices (
        workspace_id, subscription_id, invoice_number, invoice_type, status,
        subtotal_irr, total_irr, amount_due_irr,
        plan_id, plan_name_snapshot, billing_interval,
        period_start, period_end, effect_snapshot, due_at, metadata
      ) VALUES (
        p_workspace_id, v_sub.id, v_num, 'subscription_renewal', 'draft',
        v_price, v_price, v_price,
        v_target, v_plan.name, v_interval,
        v_start, v_end, v_snapshot,
        v_start + make_interval(days => (v_policy->>'invoice_due_offset_days')::int),
        jsonb_build_object('source', 'renewal_scheduler')
      )
      RETURNING * INTO v_inv;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      IF v_tries >= 5 THEN RAISE; END IF;
    END;
  END LOOP;

  INSERT INTO public.billing_invoice_lines (
    invoice_id, line_type, description, quantity, unit_amount_irr, amount_irr, plan_id, sort_order
  ) VALUES (
    v_inv.id, 'plan',
    v_plan.name || ' — ' || CASE WHEN v_interval = 'yearly' THEN 'سالانه' ELSE 'ماهانه' END,
    1, v_price, v_price, v_target, 0
  );

  UPDATE public.billing_invoices
     SET status = 'open', issued_at = now()
   WHERE id = v_inv.id AND status = 'draft'
  RETURNING * INTO v_inv;

  -- The marker moves forward only after the document exists.
  UPDATE public.workspace_subscriptions
     SET next_invoice_at = v_end, updated_at = now()
   WHERE id = v_sub.id;

  INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
  VALUES (p_workspace_id, 'renewal_invoice_issued', 'scheduler',
          jsonb_build_object('invoice_id', v_inv.id, 'period_start', v_start,
                             'period_end', v_end, 'plan_id', v_target,
                             'interval', v_interval, 'amount_irr', v_price));

  RETURN jsonb_build_object(
    'invoice_id', v_inv.id, 'period_start', v_start, 'period_end', v_end,
    'amount_irr', v_price, 'replayed', false
  );
END;
$function$
;
REVOKE ALL ON FUNCTION public.billing_v2_issue_renewal_invoice(uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_v2_issue_renewal_invoice(uuid,boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_v2_note_worker_run(p_worker text, p_batch integer, p_failures integer, p_error text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  INSERT INTO public.billing_v2_worker_health AS h (
    worker, last_run_at, last_success_at, last_failure_at, last_error,
    last_batch_size, consecutive_failures, updated_at
  ) VALUES (
    p_worker, now(),
    CASE WHEN COALESCE(p_failures, 0) = 0 THEN now() END,
    CASE WHEN COALESCE(p_failures, 0) > 0 THEN now() END,
    left(p_error, 500), COALESCE(p_batch, 0),
    CASE WHEN COALESCE(p_failures, 0) > 0 THEN 1 ELSE 0 END, now()
  )
  ON CONFLICT (worker) DO UPDATE SET
    last_run_at = now(),
    last_success_at = CASE WHEN COALESCE(p_failures, 0) = 0 THEN now() ELSE h.last_success_at END,
    last_failure_at = CASE WHEN COALESCE(p_failures, 0) > 0 THEN now() ELSE h.last_failure_at END,
    last_error = CASE WHEN COALESCE(p_failures, 0) > 0 THEN left(p_error, 500) ELSE NULL END,
    last_batch_size = COALESCE(p_batch, 0),
    consecutive_failures = CASE WHEN COALESCE(p_failures, 0) > 0
                                THEN h.consecutive_failures + 1 ELSE 0 END,
    updated_at = now();
$function$
;
REVOKE ALL ON FUNCTION public.billing_v2_note_worker_run(text,integer,integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_v2_note_worker_run(text,integer,integer,text) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_v2_period_cycles_grant(p_period_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT NOT (
    EXISTS (SELECT 1 FROM public.billing_period_allowance_grants g
             WHERE g.period_id = p_period_id AND g.status = 'granted')
    OR EXISTS (SELECT 1 FROM public.billing_subscription_periods p
                WHERE p.id = p_period_id AND p.source = 'legacy_migration')
  );
$function$
;
REVOKE ALL ON FUNCTION public.billing_v2_period_cycles_grant(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_v2_period_cycles_grant(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_v2_period_monthly_allowance(p_period billing_subscription_periods)
 RETURNS bigint
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT GREATEST(ROUND(COALESCE(
           (p_period.limits_snapshot->>'ai_credits_per_month')::numeric,
           -- Pre-D0 fallback: a monthly period's total IS its monthly amount.
           CASE WHEN COALESCE(p_period.billing_interval, 'monthly') = 'monthly'
                THEN p_period.ai_allowance_irr ELSE p_period.ai_allowance_irr / 12.0 END,
           0))::numeric, 0)::bigint;
$function$
;
REVOKE ALL ON FUNCTION public.billing_v2_period_monthly_allowance(billing_subscription_periods) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_v2_period_monthly_allowance(billing_subscription_periods) TO anon;
GRANT EXECUTE ON FUNCTION public.billing_v2_period_monthly_allowance(billing_subscription_periods) TO authenticated;
GRANT EXECUTE ON FUNCTION public.billing_v2_period_monthly_allowance(billing_subscription_periods) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_v2_policy_for(p_workspace_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pol public.billing_v2_policy;
  v_ws  public.billing_v2_workspace_policy;
  v_wal BOOLEAN;
BEGIN
  SELECT * INTO v_pol FROM public.billing_v2_policy WHERE id;
  SELECT * INTO v_ws FROM public.billing_v2_workspace_policy WHERE workspace_id = p_workspace_id;
  SELECT auto_pay_enabled INTO v_wal FROM public.billing_wallet_accounts
   WHERE workspace_id = p_workspace_id;

  RETURN jsonb_build_object(
    'invoice_lead_time_days',
      COALESCE(v_ws.invoice_lead_time_days, v_pol.invoice_lead_time_days, 10),
    'invoice_due_offset_days', COALESCE(v_pol.invoice_due_offset_days, 0),
    'wallet_auto_pay',
      COALESCE(v_ws.wallet_auto_pay_enabled, v_wal, v_pol.wallet_auto_pay_default, true),
    'collection_ttl_seconds', COALESCE(v_pol.collection_ttl_seconds, 300),
    -- Phase E
    'reminder_days_before_due',
      to_jsonb(COALESCE(v_ws.reminder_days_before_due, v_pol.reminder_days_before_due, ARRAY[5, 1])),
    'grace_period_days', COALESCE(v_pol.grace_period_days, 3),
    'fallback_plan_id', v_pol.fallback_plan_id,
    'send_invoice_issued_email', COALESCE(v_pol.send_invoice_issued_email, true),
    'send_invoice_issued_sms',
      COALESCE(v_ws.send_invoice_issued_sms, v_pol.send_invoice_issued_sms, false),
    'notify_on_due', COALESCE(v_pol.notify_on_due, true),
    'notify_on_past_due', COALESCE(v_pol.notify_on_past_due, true),
    'notify_on_fallback', COALESCE(v_pol.notify_on_fallback, true),
    'notifications_enabled', COALESCE(v_ws.notifications_enabled, true),
    'notification_max_attempts', COALESCE(v_pol.notification_max_attempts, 5),
    'notification_retry_seconds', COALESCE(v_pol.notification_retry_seconds, 900),
    'notification_max_per_hour', COALESCE(v_pol.notification_max_per_hour, 20)
  );
END;
$function$
;
REVOKE ALL ON FUNCTION public.billing_v2_policy_for(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_v2_policy_for(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_v2_process_due_invoice(p_invoice_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inv    public.billing_invoices;
  v_sub    public.workspace_subscriptions;
  v_policy JSONB;
  v_res    JSONB;
  v_grace  TIMESTAMPTZ;
BEGIN
  PERFORM public.billing_expire_stale_collections(p_invoice_id);

  SELECT * INTO v_inv FROM public.billing_invoices WHERE id = p_invoice_id FOR UPDATE;
  IF v_inv.id IS NULL THEN RETURN jsonb_build_object('skipped', 'unknown_invoice'); END IF;

  -- (1) Recheck under the lock — the authority is the row, not the scan.
  IF v_inv.status = 'paid' OR v_inv.amount_due_irr <= 0 THEN
    PERFORM public.billing_v2_cancel_invoice_notifications(v_inv.id, 'invoice_paid');
    PERFORM public.billing_v2_restore_subscription(v_inv.workspace_id);
    RETURN jsonb_build_object('skipped', 'already_paid');
  END IF;
  IF v_inv.status IN ('void', 'expired', 'refunded') THEN
    RETURN jsonb_build_object('skipped', 'not_collectible:' || v_inv.status);
  END IF;
  IF v_inv.due_at IS NULL OR v_inv.due_at > now() THEN
    RETURN jsonb_build_object('skipped', 'not_due');
  END IF;

  -- (2) Live gateway collection: money may be in flight. NEVER assume paid.
  IF EXISTS (SELECT 1 FROM public.billing_invoice_collections
              WHERE invoice_id = v_inv.id AND status = 'active') THEN
    RETURN jsonb_build_object('skipped', 'collection_active');
  END IF;

  v_policy := public.billing_v2_policy_for(v_inv.workspace_id);

  -- (3) Wallet auto-pay.
  IF (v_policy->>'wallet_auto_pay')::boolean THEN
    v_res := public.billing_v2_wallet_autopay_invoice(v_inv.id);
    INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
    VALUES (v_inv.workspace_id, 'wallet_autopay_attempted', COALESCE(v_res->>'skipped', 'paid'),
            jsonb_build_object('invoice_id', v_inv.id));

    IF COALESCE((v_res->>'paid')::boolean, false) THEN
      PERFORM public.billing_v2_cancel_invoice_notifications(v_inv.id, 'invoice_paid');
      PERFORM public.billing_v2_enqueue_notification(
        v_inv.workspace_id, 'payment_received', 'email', v_inv.id, now(),
        jsonb_build_object('invoice_number', v_inv.invoice_number,
                           'amount_irr', v_inv.amount_due_irr, 'method', 'wallet'),
        v_inv.id::text);
      PERFORM public.billing_v2_restore_subscription(v_inv.workspace_id);
      RETURN jsonb_build_object('paid', true, 'via', 'wallet');
    END IF;

    IF v_res->>'skipped' = 'collection_active' THEN
      RETURN jsonb_build_object('skipped', 'collection_active');
    END IF;
    IF v_res->>'skipped' = 'insufficient_balance' THEN
      -- Insufficient wallet is a customer-actionable event; auto-pay being
      -- DISABLED is not a failure and produces no such message.
      PERFORM public.billing_v2_enqueue_notification(
        v_inv.workspace_id, 'wallet_autopay_insufficient', 'email', v_inv.id, now(),
        jsonb_build_object('invoice_number', v_inv.invoice_number,
                           'amount_irr', v_inv.amount_due_irr),
        v_inv.id::text);
    END IF;
  END IF;

  -- (4) Past due. Invoice vocabulary and subscription vocabulary, separately.
  UPDATE public.billing_invoices
     SET status = 'past_due', past_due_at = COALESCE(past_due_at, now()), updated_at = now()
   WHERE id = v_inv.id AND status IN ('open', 'partially_paid');

  SELECT * INTO v_sub FROM public.workspace_subscriptions
   WHERE workspace_id = v_inv.workspace_id FOR UPDATE;

  IF v_sub.id IS NOT NULL AND v_sub.status IN ('active', 'past_due') THEN
    -- The FROZEN contract decides the deadline, not today's policy.
    v_grace := COALESCE(v_sub.grace_period_ends_at,
                        now() + make_interval(days => COALESCE(
                          (public.billing_v2_dunning_snapshot(v_inv.id)->>'grace_period_days')::int,
                          (v_policy->>'grace_period_days')::int)));
    UPDATE public.workspace_subscriptions
       SET status = 'past_due',
           past_due_since = COALESCE(past_due_since, now()),
           grace_period_ends_at = v_grace,
           updated_at = now()
     WHERE id = v_sub.id;

    IF v_sub.status <> 'past_due' THEN
      INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
      VALUES (v_inv.workspace_id, 'subscription_past_due', 'grace_started',
              jsonb_build_object('subscription_id', v_sub.id, 'grace_period_ends_at', v_grace));
    END IF;
  END IF;

  INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
  VALUES (v_inv.workspace_id, 'invoice_past_due', 'unpaid_at_due',
          jsonb_build_object('invoice_id', v_inv.id, 'amount_due_irr', v_inv.amount_due_irr));

  IF (v_policy->>'notify_on_past_due')::boolean THEN
    PERFORM public.billing_v2_enqueue_notification(
      v_inv.workspace_id, 'invoice_past_due', 'email', v_inv.id, now(),
      jsonb_build_object('invoice_number', v_inv.invoice_number,
                         'amount_irr', v_inv.amount_due_irr,
                         'grace_period_ends_at', v_grace),
      v_inv.id::text);
    PERFORM public.billing_v2_enqueue_notification(
      v_inv.workspace_id, 'invoice_past_due', 'sms', v_inv.id, now(),
      jsonb_build_object('invoice_number', v_inv.invoice_number),
      v_inv.id::text);
  END IF;

  RETURN jsonb_build_object('past_due', true, 'grace_period_ends_at', v_grace);
END;
$function$
;
REVOKE ALL ON FUNCTION public.billing_v2_process_due_invoice(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_v2_process_due_invoice(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_v2_restore_subscription(p_workspace_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_sub    public.workspace_subscriptions;
  v_unpaid INTEGER;
BEGIN
  SELECT * INTO v_sub FROM public.workspace_subscriptions
   WHERE workspace_id = p_workspace_id FOR UPDATE;
  IF v_sub.id IS NULL THEN RETURN jsonb_build_object('skipped', 'no_subscription'); END IF;
  IF v_sub.status = 'free_fallback' THEN
    -- A late payment never silently revives a fallen-back subscription: the
    -- money becomes a new invoice/period decision, not a rollback.
    RETURN jsonb_build_object('skipped', 'already_free_fallback');
  END IF;
  IF v_sub.status <> 'past_due' AND v_sub.grace_period_ends_at IS NULL THEN
    RETURN jsonb_build_object('skipped', 'not_in_dunning');
  END IF;

  SELECT count(*) INTO v_unpaid FROM public.billing_invoices
   WHERE workspace_id = p_workspace_id
     AND status IN ('open', 'partially_paid', 'past_due')
     AND amount_due_irr > 0
     AND due_at IS NOT NULL AND due_at <= now();
  IF v_unpaid > 0 THEN
    RETURN jsonb_build_object('skipped', 'still_unpaid', 'open_due_invoices', v_unpaid);
  END IF;

  UPDATE public.workspace_subscriptions
     SET status = 'active', past_due_since = NULL, grace_period_ends_at = NULL,
         updated_at = now()
   WHERE id = v_sub.id;

  INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
  VALUES (p_workspace_id, 'subscription_restored', 'payment_during_grace',
          jsonb_build_object('subscription_id', v_sub.id));

  PERFORM public.billing_v2_enqueue_notification(
    p_workspace_id, 'subscription_restored', 'email', NULL, now(), '{}'::jsonb,
    v_sub.id::text || ':' || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI'));

  RETURN jsonb_build_object('restored', true);
END;
$function$
;
REVOKE ALL ON FUNCTION public.billing_v2_restore_subscription(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_v2_restore_subscription(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_v2_run_dunning(p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r          RECORD;
  j          public.billing_v2_jobs;
  v_res      JSONB;
  v_past_due INTEGER := 0;
  v_paid     INTEGER := 0;
  v_skipped  INTEGER := 0;
  v_failed   INTEGER := 0;
  v_last     TEXT;
BEGIN
  -- Reminder scheduling for every live renewal invoice of a V2 workspace.
  FOR r IN
    SELECT i.id
      FROM public.billing_invoices i
      JOIN public.billing_v2_rollout ro ON ro.workspace_id = i.workspace_id AND ro.state = 'v2_active'
     WHERE i.status IN ('open', 'partially_paid')
       AND i.amount_due_irr > 0
     ORDER BY i.due_at NULLS LAST
     LIMIT GREATEST(COALESCE(p_limit, 50), 1)
  LOOP
    PERFORM public.billing_v2_schedule_invoice_notifications(r.id);
  END LOOP;

  -- Due invoices become durable work items.
  FOR r IN
    SELECT i.id, i.workspace_id, i.amount_paid_irr
      FROM public.billing_invoices i
      JOIN public.billing_v2_rollout ro ON ro.workspace_id = i.workspace_id AND ro.state = 'v2_active'
     WHERE i.status IN ('open', 'partially_paid', 'past_due')
       AND i.amount_due_irr > 0
       AND i.due_at IS NOT NULL
       AND i.due_at <= now()
     ORDER BY i.due_at
     LIMIT GREATEST(COALESCE(p_limit, 50), 1)
  LOOP
    PERFORM public.billing_v2_enqueue_job(
      'dunning_due',
      r.id::text || ':' || r.amount_paid_irr::text,
      r.workspace_id,
      jsonb_build_object('invoice_id', r.id));
  END LOOP;

  FOR j IN SELECT * FROM public.billing_v2_claim_jobs('dunning_due', p_limit, 120) LOOP
    BEGIN
      v_res := public.billing_v2_process_due_invoice((j.payload->>'invoice_id')::uuid);
      IF COALESCE((v_res->>'paid')::boolean, false) THEN
        v_paid := v_paid + 1;
        PERFORM public.billing_v2_complete_job(j.id, v_res);
      ELSIF COALESCE((v_res->>'past_due')::boolean, false) THEN
        v_past_due := v_past_due + 1;
        PERFORM public.billing_v2_complete_job(j.id, v_res);
      ELSE
        v_skipped := v_skipped + 1;
        IF split_part(COALESCE(v_res->>'skipped', ''), ':', 1) IN ('collection_active', 'not_due') THEN
          PERFORM public.billing_v2_defer_job(j.id, v_res->>'skipped');
        ELSE
          PERFORM public.billing_v2_complete_job(j.id, v_res);
        END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      v_last := SQLERRM;
      PERFORM public.billing_v2_fail_job(j.id, SQLERRM);
      INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
      VALUES (j.workspace_id, 'dunning_failed', left(SQLERRM, 200),
              jsonb_build_object('job_id', j.id));
    END;
  END LOOP;

  PERFORM public.billing_v2_note_worker_run('dunning', v_past_due + v_paid + v_skipped, v_failed, v_last);
  RETURN jsonb_build_object('past_due', v_past_due, 'paid', v_paid,
                            'skipped', v_skipped, 'failed', v_failed);
END;
$function$
;
REVOKE ALL ON FUNCTION public.billing_v2_run_dunning(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_v2_run_dunning(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_v2_run_entitlement_cycles(p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r         RECORD;
  j         public.billing_v2_jobs;
  v_res     JSONB;
  v_active  INTEGER := 0;
  v_skipped INTEGER := 0;
  v_failed  INTEGER := 0;
  v_last    TEXT;
BEGIN
  -- Every active service period that has a cycle boundary to cross, plus any
  -- active period whose current cycle never got funded (crash recovery).
  FOR r IN
    SELECT DISTINCT p.id, p.workspace_id
      FROM public.billing_subscription_periods p
     WHERE p.status = 'active'
       AND (
         NOT EXISTS (SELECT 1 FROM public.billing_entitlement_cycles c
                      WHERE c.subscription_period_id = p.id)
         OR EXISTS (SELECT 1 FROM public.billing_entitlement_cycles c
                     WHERE c.subscription_period_id = p.id
                       AND ((c.status = 'scheduled' AND c.cycle_start <= now())
                            OR (c.status = 'active' AND c.cycle_end <= now())
                            OR (c.status = 'active' AND c.allowance_state IN ('pending', 'failed')
                                AND c.next_attempt_at <= now())))
       )
     ORDER BY p.id
     LIMIT GREATEST(COALESCE(p_limit, 50), 1)
  LOOP
    PERFORM public.billing_v2_enqueue_job(
      'entitlement_cycle',
      r.id::text || ':' || to_char(date_trunc('minute', now()) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI'),
      r.workspace_id,
      jsonb_build_object('period_id', r.id)
    );
  END LOOP;

  FOR j IN SELECT * FROM public.billing_v2_claim_jobs('entitlement_cycle', p_limit, 120) LOOP
    BEGIN
      v_res := public.billing_v2_sync_period_cycles((j.payload->>'period_id')::uuid);
      IF v_res ? 'skipped' THEN v_skipped := v_skipped + 1; ELSE v_active := v_active + 1; END IF;
      PERFORM public.billing_v2_complete_job(j.id, v_res);
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      v_last := SQLERRM;
      PERFORM public.billing_v2_fail_job(j.id, SQLERRM);
      INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
      VALUES (j.workspace_id, 'entitlement_cycle_failed', left(SQLERRM, 200),
              jsonb_build_object('job_id', j.id, 'period_id', j.payload->>'period_id'));
    END;
  END LOOP;

  PERFORM public.billing_v2_note_worker_run('entitlement_cycle', v_active + v_skipped, v_failed, v_last);
  RETURN jsonb_build_object('synced', v_active, 'skipped', v_skipped, 'failed', v_failed);
END;
$function$
;
REVOKE ALL ON FUNCTION public.billing_v2_run_entitlement_cycles(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_v2_run_entitlement_cycles(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_v2_run_grace_expiry(p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r           RECORD;
  j           public.billing_v2_jobs;
  v_res       JSONB;
  v_fallbacks INTEGER := 0;
  v_skipped   INTEGER := 0;
  v_failed    INTEGER := 0;
  v_last      TEXT;
BEGIN
  FOR r IN
    SELECT s.workspace_id, s.id AS sub_id, s.grace_period_ends_at
      FROM public.workspace_subscriptions s
      JOIN public.billing_v2_rollout ro ON ro.workspace_id = s.workspace_id AND ro.state = 'v2_active'
     WHERE s.status = 'past_due'
       AND s.grace_period_ends_at IS NOT NULL
       AND s.grace_period_ends_at <= now()
     ORDER BY s.grace_period_ends_at
     LIMIT GREATEST(COALESCE(p_limit, 50), 1)
  LOOP
    PERFORM public.billing_v2_enqueue_job(
      'grace_expiry',
      r.sub_id::text || ':' || to_char(r.grace_period_ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS'),
      r.workspace_id,
      jsonb_build_object('subscription_id', r.sub_id));
  END LOOP;

  FOR j IN SELECT * FROM public.billing_v2_claim_jobs('grace_expiry', p_limit, 120) LOOP
    BEGIN
      v_res := public.billing_v2_apply_free_fallback(j.workspace_id);
      IF COALESCE((v_res->>'free_fallback')::boolean, false) THEN
        v_fallbacks := v_fallbacks + 1;
      ELSE
        v_skipped := v_skipped + 1;
      END IF;
      PERFORM public.billing_v2_complete_job(j.id, v_res);
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      v_last := SQLERRM;
      PERFORM public.billing_v2_fail_job(j.id, SQLERRM);
      INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
      VALUES (j.workspace_id, 'grace_expiry_failed', left(SQLERRM, 200),
              jsonb_build_object('job_id', j.id));
    END;
  END LOOP;

  PERFORM public.billing_v2_note_worker_run('grace_expiry', v_fallbacks + v_skipped, v_failed, v_last);
  RETURN jsonb_build_object('fallbacks', v_fallbacks, 'skipped', v_skipped, 'failed', v_failed);
END;
$function$
;
REVOKE ALL ON FUNCTION public.billing_v2_run_grace_expiry(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_v2_run_grace_expiry(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_v2_run_invoice_scheduler(p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r         RECORD;
  j         public.billing_v2_jobs;
  v_res     JSONB;
  v_issued  INTEGER := 0;
  v_skipped INTEGER := 0;
  v_failed  INTEGER := 0;
  v_last    TEXT;
BEGIN
  FOR r IN
    SELECT s.workspace_id, s.id AS sub_id, COALESCE(s.next_invoice_at, s.current_period_end) AS anchor
      FROM public.workspace_subscriptions s
      JOIN public.billing_v2_rollout ro ON ro.workspace_id = s.workspace_id AND ro.state = 'v2_active'
     WHERE s.status IN ('active', 'past_due')
       AND COALESCE(s.next_invoice_at, s.current_period_end) IS NOT NULL
       AND COALESCE(s.next_invoice_at, s.current_period_end)
           - make_interval(days => (public.billing_v2_policy_for(s.workspace_id)->>'invoice_lead_time_days')::int)
           <= now()
       AND NOT EXISTS (
         SELECT 1 FROM public.billing_invoices i
          WHERE i.workspace_id = s.workspace_id
            AND i.status IN ('open', 'partially_paid', 'past_due')
            AND i.amount_due_irr > 0
            AND i.due_at IS NOT NULL AND i.due_at <= now())
     ORDER BY COALESCE(s.next_invoice_at, s.current_period_end)
     LIMIT GREATEST(COALESCE(p_limit, 50), 1)
  LOOP
    PERFORM public.billing_v2_enqueue_job(
      'renewal_invoice',
      r.sub_id::text || ':' || to_char(r.anchor AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS'),
      r.workspace_id,
      jsonb_build_object('subscription_id', r.sub_id, 'anchor', r.anchor));
  END LOOP;

  FOR j IN SELECT * FROM public.billing_v2_claim_jobs('renewal_invoice', p_limit, 120) LOOP
    BEGIN
      v_res := public.billing_v2_issue_renewal_invoice(j.workspace_id, false);
      IF v_res ? 'skipped' THEN
        v_skipped := v_skipped + 1;
        IF split_part(v_res->>'skipped', ':', 1) IN
             ('not_yet_eligible', 'collection_active', 'period_exists', 'not_yet_due') THEN
          PERFORM public.billing_v2_defer_job(j.id, v_res->>'skipped');
        ELSE
          PERFORM public.billing_v2_complete_job(j.id, v_res);
        END IF;
      ELSE
        v_issued := v_issued + 1;
        PERFORM public.billing_v2_complete_job(j.id, v_res);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      v_last := SQLERRM;
      PERFORM public.billing_v2_fail_job(j.id, SQLERRM);
      INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
      VALUES (j.workspace_id, 'renewal_invoice_failed', left(SQLERRM, 200),
              jsonb_build_object('job_id', j.id));
    END;
  END LOOP;

  PERFORM public.billing_v2_note_worker_run('renewal_invoice', v_issued + v_skipped, v_failed, v_last);
  RETURN jsonb_build_object('issued', v_issued, 'skipped', v_skipped, 'failed', v_failed);
END;
$function$
;
REVOKE ALL ON FUNCTION public.billing_v2_run_invoice_scheduler(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_v2_run_invoice_scheduler(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_v2_run_period_activation(p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r          RECORD;
  j          public.billing_v2_jobs;
  v_active   INTEGER := 0;
  v_skipped  INTEGER := 0;
  v_failed   INTEGER := 0;
  v_last     TEXT;
BEGIN
  FOR r IN
    SELECT p.id, p.workspace_id
      FROM public.billing_subscription_periods p
      LEFT JOIN public.billing_invoices i ON i.id = p.invoice_id
     WHERE p.status = 'scheduled'
       AND p.period_start <= now()
       AND (p.invoice_id IS NULL OR i.status = 'paid')
     ORDER BY p.period_start
     LIMIT GREATEST(COALESCE(p_limit, 50), 1)
  LOOP
    PERFORM public.billing_v2_enqueue_job(
      'period_activation', r.id::text, r.workspace_id,
      jsonb_build_object('period_id', r.id)
    );
  END LOOP;

  -- Recovery: active periods whose allowance never landed.
  FOR r IN
    SELECT g.period_id AS id, g.workspace_id
      FROM public.billing_period_allowance_grants g
     WHERE g.status IN ('pending', 'failed') AND g.next_attempt_at <= now()
     LIMIT GREATEST(COALESCE(p_limit, 50), 1)
  LOOP
    PERFORM public.billing_v2_enqueue_job(
      'period_activation', r.id::text, r.workspace_id,
      jsonb_build_object('period_id', r.id)
    );
  END LOOP;

  FOR j IN SELECT * FROM public.billing_v2_claim_jobs('period_activation', p_limit, 120) LOOP
    BEGIN
      IF EXISTS (SELECT 1 FROM public.billing_subscription_periods
                  WHERE id = (j.payload->>'period_id')::uuid AND status = 'scheduled') THEN
        PERFORM public.billing_activate_period((j.payload->>'period_id')::uuid);
        v_active := v_active + 1;
      ELSE
        PERFORM public.billing_v2_apply_period_allowance((j.payload->>'period_id')::uuid);
        v_skipped := v_skipped + 1;
      END IF;
      PERFORM public.billing_v2_complete_job(j.id, jsonb_build_object('period_id', j.payload->>'period_id'));
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      v_last := SQLERRM;
      PERFORM public.billing_v2_fail_job(j.id, SQLERRM);
      INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
      VALUES (j.workspace_id, 'period_activation_failed', left(SQLERRM, 200),
              jsonb_build_object('job_id', j.id, 'period_id', j.payload->>'period_id'));
    END;
  END LOOP;

  PERFORM public.billing_v2_note_worker_run('period_activation', v_active + v_skipped, v_failed, v_last);
  RETURN jsonb_build_object('activated', v_active, 'skipped', v_skipped, 'failed', v_failed);
END;
$function$
;
REVOKE ALL ON FUNCTION public.billing_v2_run_period_activation(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_v2_run_period_activation(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_v2_run_wallet_autopay(p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r         RECORD;
  j         public.billing_v2_jobs;
  v_res     JSONB;
  v_paid    INTEGER := 0;
  v_skipped INTEGER := 0;
  v_failed  INTEGER := 0;
  v_last    TEXT;
BEGIN
  PERFORM public.billing_expire_stale_collections(NULL);

  FOR r IN
    SELECT i.id, i.workspace_id, i.amount_paid_irr
      FROM public.billing_invoices i
      JOIN public.billing_v2_rollout ro ON ro.workspace_id = i.workspace_id AND ro.state = 'v2_active'
     WHERE i.status IN ('open', 'partially_paid', 'past_due')
       AND i.amount_due_irr > 0
       AND i.due_at IS NOT NULL
       AND i.due_at <= now()
     ORDER BY i.due_at
     LIMIT GREATEST(COALESCE(p_limit, 50), 1)
  LOOP
    PERFORM public.billing_v2_enqueue_job(
      'wallet_autopay',
      r.id::text || ':' || r.amount_paid_irr::text,
      r.workspace_id,
      jsonb_build_object('invoice_id', r.id)
    );
  END LOOP;

  FOR j IN SELECT * FROM public.billing_v2_claim_jobs('wallet_autopay', p_limit, 120) LOOP
    BEGIN
      v_res := public.billing_v2_wallet_autopay_invoice((j.payload->>'invoice_id')::uuid);
      IF v_res ? 'skipped' THEN
        v_skipped := v_skipped + 1;
        -- Transient reasons come back on the next run; terminal ones do not.
        IF split_part(v_res->>'skipped', ':', 1) IN
             ('collection_active', 'insufficient_balance', 'not_due') THEN
          PERFORM public.billing_v2_defer_job(j.id, v_res->>'skipped');
        ELSE
          PERFORM public.billing_v2_complete_job(j.id, v_res);
        END IF;
      ELSE
        v_paid := v_paid + 1;
        PERFORM public.billing_v2_complete_job(j.id, v_res);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      v_last := SQLERRM;
      PERFORM public.billing_v2_fail_job(j.id, SQLERRM);
      INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
      VALUES (j.workspace_id, 'wallet_autopay_failed', left(SQLERRM, 200),
              jsonb_build_object('job_id', j.id, 'invoice_id', j.payload->>'invoice_id'));
    END;
  END LOOP;

  PERFORM public.billing_v2_note_worker_run('wallet_autopay', v_paid + v_skipped, v_failed, v_last);
  RETURN jsonb_build_object('paid', v_paid, 'skipped', v_skipped, 'failed', v_failed);
END;
$function$
;
REVOKE ALL ON FUNCTION public.billing_v2_run_wallet_autopay(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_v2_run_wallet_autopay(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_v2_scheduler_health()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
    'workers', COALESCE((SELECT jsonb_agg(to_jsonb(h)) FROM public.billing_v2_worker_health h), '[]'::jsonb),
    'due_invoices', (SELECT count(*) FROM public.billing_invoices
                      WHERE status IN ('open','partially_paid','past_due')
                        AND amount_due_irr > 0 AND due_at IS NOT NULL AND due_at <= now()),
    'scheduled_periods_pending', (SELECT count(*) FROM public.billing_subscription_periods
                                   WHERE status = 'scheduled' AND period_start <= now()),
    'unapplied_active_periods', (SELECT count(*) FROM public.billing_period_allowance_grants
                                  WHERE status IN ('pending','failed')),
    'due_entitlement_cycles', (SELECT count(*) FROM public.billing_entitlement_cycles
                                WHERE status = 'scheduled' AND cycle_start <= now() AND cycle_end > now()),
    'unfunded_active_cycles', (SELECT count(*) FROM public.billing_entitlement_cycles
                                WHERE status = 'active' AND allowance_state IN ('pending','failed')),
    'failed_jobs', (SELECT count(*) FROM public.billing_v2_jobs WHERE status = 'failed'),
    -- Phase E
    'past_due_invoices', (SELECT count(*) FROM public.billing_invoices WHERE status = 'past_due'),
    'grace_subscriptions', (SELECT count(*) FROM public.workspace_subscriptions
                             WHERE status = 'past_due' AND grace_period_ends_at IS NOT NULL),
    'notification_backlog', (SELECT count(*) FROM public.billing_notification_jobs
                              WHERE status IN ('pending','processing')),
    'notification_failures', (SELECT count(*) FROM public.billing_notification_jobs
                               WHERE status = 'failed'),
    'retention_signals_pending', (SELECT count(*) FROM public.billing_retention_signals
                                   WHERE state = 'pending'),
    'checked_at', now()
  );
$function$
;
REVOKE ALL ON FUNCTION public.billing_v2_scheduler_health() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_v2_scheduler_health() TO service_role;

CREATE OR REPLACE FUNCTION public.billing_v2_set_state(p_workspace_id uuid, p_state text, p_actor_id uuid DEFAULT NULL::uuid, p_reason text DEFAULT NULL::text, p_break_glass boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_current TEXT;
  v_rank    JSONB := '{"legacy":0,"shadow":1,"v2_cutover_pending":2,"v2_active":3}'::jsonb;
BEGIN
  IF p_state NOT IN ('legacy', 'shadow', 'v2_cutover_pending', 'v2_active') THEN
    RAISE EXCEPTION 'billing_v2_unknown_state:%', p_state;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('billing_v2_rollout:' || p_workspace_id::text, 0));

  SELECT state INTO v_current FROM public.billing_v2_rollout
   WHERE workspace_id = p_workspace_id FOR UPDATE;
  v_current := COALESCE(v_current, 'legacy');

  IF v_current = p_state THEN
    RETURN jsonb_build_object('state', v_current, 'changed', false, 'replayed', true);
  END IF;

  -- Monotonic: never walk back, except through an explicit, audited
  -- break-glass rollback (never reachable from the normal admin API).
  IF (v_rank ->> p_state)::int < (v_rank ->> v_current)::int AND NOT p_break_glass THEN
    RAISE EXCEPTION 'billing_v2_rollback_forbidden:%:%', v_current, p_state;
  END IF;

  INSERT INTO public.billing_v2_rollout AS r (workspace_id, state, shadow_enabled_at,
                                              cutover_pending_at, activated_at, activated_by)
  VALUES (
    p_workspace_id, p_state,
    CASE WHEN p_state = 'shadow' THEN now() END,
    CASE WHEN p_state = 'v2_cutover_pending' THEN now() END,
    CASE WHEN p_state = 'v2_active' THEN now() END,
    CASE WHEN p_state = 'v2_active' THEN p_actor_id END)
  ON CONFLICT (workspace_id) DO UPDATE
     SET state = EXCLUDED.state,
         shadow_enabled_at  = COALESCE(r.shadow_enabled_at, EXCLUDED.shadow_enabled_at),
         cutover_pending_at = COALESCE(r.cutover_pending_at, EXCLUDED.cutover_pending_at),
         activated_at       = CASE WHEN EXCLUDED.state = 'v2_active'
                                   THEN COALESCE(r.activated_at, now()) ELSE r.activated_at END,
         activated_by       = COALESCE(EXCLUDED.activated_by, r.activated_by),
         updated_at         = now();

  INSERT INTO public.billing_v2_audit (workspace_id, event, actor_id, reason, details)
  VALUES (p_workspace_id,
          CASE WHEN p_state = 'shadow' THEN 'billing_v2_shadow_enabled'
               WHEN p_break_glass THEN 'billing_v2_break_glass_rollback'
               ELSE 'billing_v2_state_changed' END,
          p_actor_id, p_reason,
          jsonb_build_object('from', v_current, 'to', p_state, 'break_glass', p_break_glass));

  RETURN jsonb_build_object('state', p_state, 'changed', true, 'from', v_current);
END;
$function$
;
REVOKE ALL ON FUNCTION public.billing_v2_set_state(uuid,text,uuid,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_v2_set_state(uuid,text,uuid,text,boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_v2_state(p_workspace_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(
    (SELECT state FROM public.billing_v2_rollout WHERE workspace_id = p_workspace_id),
    'legacy');
$function$
;
REVOKE ALL ON FUNCTION public.billing_v2_state(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_v2_state(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_v2_sync_period_cycles(p_period_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_period  public.billing_subscription_periods;
  v_cycle   public.billing_entitlement_cycles;
  v_grant   JSONB := NULL;
  v_expired INTEGER := 0;
BEGIN
  SELECT * INTO v_period FROM public.billing_subscription_periods WHERE id = p_period_id;
  IF v_period.id IS NULL THEN RAISE EXCEPTION 'unknown_period:%', p_period_id; END IF;
  IF v_period.status <> 'active' THEN
    RETURN jsonb_build_object('period_id', p_period_id, 'skipped', 'period_not_active');
  END IF;

  PERFORM public.billing_v2_ensure_period_cycles(p_period_id);

  -- Close everything that is over — in this period and in any earlier one.
  WITH closed AS (
    UPDATE public.billing_entitlement_cycles
       SET status = 'completed', completed_at = COALESCE(completed_at, now()),
           allowance_state = CASE WHEN allowance_state IN ('pending', 'failed')
                                  THEN 'skipped' ELSE allowance_state END
     WHERE workspace_id = v_period.workspace_id
       AND status IN ('scheduled', 'active')
       AND cycle_end <= now()
    RETURNING 1)
  SELECT count(*) INTO v_expired FROM closed;

  -- Cycles of superseded periods stop when their period does: the live one is
  -- closed as history, the future ones never happen at all.
  UPDATE public.billing_entitlement_cycles
     SET status = CASE WHEN status = 'active' THEN 'completed' ELSE 'canceled' END,
         completed_at = CASE WHEN status = 'active' THEN now() ELSE completed_at END,
         allowance_state = CASE WHEN allowance_state IN ('pending', 'failed')
                                THEN 'skipped' ELSE allowance_state END
   WHERE workspace_id = v_period.workspace_id
     AND subscription_period_id <> v_period.id
     AND status IN ('scheduled', 'active')
     AND subscription_period_id IN (
       SELECT id FROM public.billing_subscription_periods
        WHERE workspace_id = v_period.workspace_id
          AND status NOT IN ('scheduled', 'active'));




  -- The one cycle that is live right now.
  SELECT * INTO v_cycle FROM public.billing_entitlement_cycles
   WHERE subscription_period_id = v_period.id
     AND cycle_start <= now() AND cycle_end > now()
     AND status IN ('scheduled', 'active')
   ORDER BY cycle_index
   LIMIT 1;

  IF v_cycle.id IS NULL THEN
    RETURN jsonb_build_object('period_id', p_period_id, 'expired_cycles', v_expired,
                              'active_cycle_id', NULL);
  END IF;

  IF v_cycle.status = 'scheduled' THEN
    UPDATE public.billing_entitlement_cycles
       SET status = 'active', activated_at = now()
     WHERE id = v_cycle.id;
    INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
    VALUES (v_cycle.workspace_id, 'entitlement_cycle_activated', v_period.source,
            jsonb_build_object('cycle_id', v_cycle.id, 'period_id', v_period.id,
                               'cycle_index', v_cycle.cycle_index,
                               'cycle_start', v_cycle.cycle_start, 'cycle_end', v_cycle.cycle_end));
  END IF;

  v_grant := public.billing_v2_grant_cycle_allowance(v_cycle.id);

  RETURN jsonb_build_object('period_id', p_period_id, 'active_cycle_id', v_cycle.id,
                            'expired_cycles', v_expired, 'grant', v_grant);
END;
$function$
;
REVOKE ALL ON FUNCTION public.billing_v2_sync_period_cycles(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_v2_sync_period_cycles(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_v2_wallet_autopay_invoice(p_invoice_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inv     public.billing_invoices;
  v_policy  JSONB;
  v_balance BIGINT;
  v_res     JSONB;
BEGIN
  PERFORM public.billing_expire_stale_collections(p_invoice_id);

  SELECT * INTO v_inv FROM public.billing_invoices WHERE id = p_invoice_id;
  IF v_inv.id IS NULL THEN RETURN jsonb_build_object('skipped', 'unknown_invoice'); END IF;
  IF v_inv.status NOT IN ('open', 'partially_paid', 'past_due') THEN
    RETURN jsonb_build_object('skipped', 'not_payable:' || v_inv.status);
  END IF;
  IF v_inv.amount_due_irr <= 0 THEN RETURN jsonb_build_object('skipped', 'nothing_due'); END IF;
  IF v_inv.due_at IS NULL OR v_inv.due_at > now() THEN
    RETURN jsonb_build_object('skipped', 'not_due');
  END IF;

  v_policy := public.billing_v2_policy_for(v_inv.workspace_id);
  IF NOT (v_policy->>'wallet_auto_pay')::boolean THEN
    RETURN jsonb_build_object('skipped', 'auto_pay_disabled');
  END IF;

  IF EXISTS (SELECT 1 FROM public.billing_invoice_collections
              WHERE invoice_id = v_inv.id AND status = 'active') THEN
    INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
    VALUES (v_inv.workspace_id, 'wallet_autopay_skipped_collection_active', 'collection_active',
            jsonb_build_object('invoice_id', v_inv.id));
    RETURN jsonb_build_object('skipped', 'collection_active');
  END IF;

  -- Wallet lock first: the balance we check is the balance we debit.
  PERFORM public.billing_wallet_lock(v_inv.workspace_id);
  SELECT available_balance_irr INTO v_balance FROM public.billing_wallet_accounts
   WHERE workspace_id = v_inv.workspace_id;

  IF COALESCE(v_balance, 0) < v_inv.amount_due_irr THEN
    -- NEVER a partial debit: either the invoice is fully paid or nothing moves.
    INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
    VALUES (v_inv.workspace_id, 'wallet_autopay_skipped_insufficient', 'insufficient_balance',
            jsonb_build_object('invoice_id', v_inv.id, 'due_irr', v_inv.amount_due_irr,
                               'balance_irr', COALESCE(v_balance, 0)));
    RETURN jsonb_build_object('skipped', 'insufficient_balance');
  END IF;

  -- Takes the collection reservation, debits, settles and applies — one txn.
  v_res := public.billing_wallet_pay_invoice(v_inv.id, NULL);

  INSERT INTO public.billing_v2_audit (workspace_id, event, reason, details)
  VALUES (v_inv.workspace_id, 'wallet_autopay_succeeded', 'scheduler',
          jsonb_build_object('invoice_id', v_inv.id, 'amount_irr', v_inv.amount_due_irr));

  RETURN v_res || jsonb_build_object('paid', true);
END;
$function$
;
REVOKE ALL ON FUNCTION public.billing_v2_wallet_autopay_invoice(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_v2_wallet_autopay_invoice(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_v2_wallet_deposit_config()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
    'presets_irr', to_jsonb(p.wallet_deposit_presets_irr),
    'allow_custom', p.wallet_deposit_allow_custom,
    'min_irr', p.wallet_deposit_min_irr,
    'max_irr', p.wallet_deposit_max_irr
  ) FROM public.billing_v2_policy p WHERE p.id;
$function$
;
REVOKE ALL ON FUNCTION public.billing_v2_wallet_deposit_config() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_v2_wallet_deposit_config() TO service_role;

CREATE OR REPLACE FUNCTION public.billing_wallet_admin_adjust(p_workspace_id uuid, p_amount_irr bigint, p_command_key text, p_reason text, p_actor_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_entry public.billing_wallet_ledger;
BEGIN
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'admin_adjustment_reason_required'
      USING HINT = 'Every manual money movement must carry an auditable reason and actor.';
  END IF;
  v_entry := public.billing_wallet_append(
    p_workspace_id, 'admin_adjustment', p_amount_irr, p_command_key, p_reason,
    NULL, NULL, NULL, p_actor_id
  );
  RETURN jsonb_build_object('entry_id', v_entry.id, 'balance_after_irr', v_entry.balance_after_irr);
END;
$function$
;
REVOKE ALL ON FUNCTION public.billing_wallet_admin_adjust(uuid,bigint,text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_wallet_admin_adjust(uuid,bigint,text,text,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_wallet_append(p_workspace_id uuid, p_entry_type text, p_amount_irr bigint, p_command_key text, p_reason text DEFAULT NULL::text, p_invoice_id uuid DEFAULT NULL::uuid, p_payment_id uuid DEFAULT NULL::uuid, p_deposit_id uuid DEFAULT NULL::uuid, p_actor_id uuid DEFAULT NULL::uuid, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS billing_wallet_ledger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_wallet  public.billing_wallet_accounts;
  v_entry   public.billing_wallet_ledger;
  v_balance BIGINT;
BEGIN
  IF p_command_key IS NULL OR length(p_command_key) = 0 THEN
    RAISE EXCEPTION 'wallet_command_key_required';
  END IF;

  -- Replay: return the original entry, move no money.
  SELECT * INTO v_entry FROM public.billing_wallet_ledger WHERE command_key = p_command_key;
  IF v_entry.id IS NOT NULL THEN
    RETURN v_entry;
  END IF;

  v_wallet := public.billing_wallet_lock(p_workspace_id);
  IF v_wallet.frozen AND p_amount_irr < 0 THEN
    RAISE EXCEPTION 'wallet_frozen:%', p_workspace_id;
  END IF;

  v_balance := v_wallet.available_balance_irr + p_amount_irr;
  IF v_balance < 0 THEN
    RAISE EXCEPTION 'wallet_insufficient_funds:%', p_workspace_id
      USING HINT = 'Wallet balance may never go negative. Fail closed and ask for a gateway payment.';
  END IF;

  INSERT INTO public.billing_wallet_ledger (
    workspace_id, entry_type, amount_irr, balance_after_irr,
    invoice_id, payment_id, wallet_deposit_id, command_key, reason, actor_id, metadata
  ) VALUES (
    p_workspace_id, p_entry_type, p_amount_irr, v_balance,
    p_invoice_id, p_payment_id, p_deposit_id, p_command_key, p_reason, p_actor_id,
    COALESCE(p_metadata, '{}'::jsonb)
  )
  RETURNING * INTO v_entry;

  UPDATE public.billing_wallet_accounts
     SET available_balance_irr = v_balance, updated_at = now()
   WHERE workspace_id = p_workspace_id;

  RETURN v_entry;
END;
$function$
;
REVOKE ALL ON FUNCTION public.billing_wallet_append(uuid,text,bigint,text,text,uuid,uuid,uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_wallet_append(uuid,text,bigint,text,text,uuid,uuid,uuid,uuid,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_wallet_apply_deposit(p_deposit_id uuid, p_amount_irr bigint, p_payment_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_dep   public.billing_wallet_deposits;
  v_entry public.billing_wallet_ledger;
BEGIN
  SELECT * INTO v_dep FROM public.billing_wallet_deposits WHERE id = p_deposit_id FOR UPDATE;
  IF v_dep.id IS NULL THEN
    RAISE EXCEPTION 'unknown_wallet_deposit:%', p_deposit_id;
  END IF;
  IF v_dep.status = 'paid' THEN
    SELECT * INTO v_entry FROM public.billing_wallet_ledger
     WHERE command_key = 'deposit:' || v_dep.id::text;
    RETURN jsonb_build_object('deposit_id', v_dep.id, 'entry_id', v_entry.id, 'replayed', true);
  END IF;
  IF v_dep.status <> 'pending' THEN
    RAISE EXCEPTION 'wallet_deposit_not_payable:%:%', v_dep.id, v_dep.status;
  END IF;
  IF p_amount_irr <> v_dep.amount_irr THEN
    RAISE EXCEPTION 'wallet_deposit_amount_mismatch:%:%:%', v_dep.id, v_dep.amount_irr, p_amount_irr;
  END IF;

  v_entry := public.billing_wallet_append(
    v_dep.workspace_id, 'deposit', v_dep.amount_irr,
    'deposit:' || v_dep.id::text, 'wallet_deposit',
    NULL, p_payment_id, v_dep.id
  );

  UPDATE public.billing_wallet_deposits
     SET status = 'paid', paid_at = now(), payment_id = COALESCE(p_payment_id, payment_id)
   WHERE id = v_dep.id;

  RETURN jsonb_build_object(
    'deposit_id', v_dep.id, 'entry_id', v_entry.id,
    'balance_after_irr', v_entry.balance_after_irr, 'replayed', false
  );
END;
$function$
;
REVOKE ALL ON FUNCTION public.billing_wallet_apply_deposit(uuid,bigint,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_wallet_apply_deposit(uuid,bigint,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_wallet_ledger_block_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF public.billing_purge_active() THEN RETURN COALESCE(NEW, OLD); END IF;
  RAISE EXCEPTION 'wallet_ledger_append_only'
    USING HINT = 'Correct a wallet entry with a new compensating entry, never by editing history.';
END;
$function$
;
REVOKE ALL ON FUNCTION public.billing_wallet_ledger_block_mutation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_wallet_ledger_block_mutation() TO anon;
GRANT EXECUTE ON FUNCTION public.billing_wallet_ledger_block_mutation() TO authenticated;
GRANT EXECUTE ON FUNCTION public.billing_wallet_ledger_block_mutation() TO service_role;

CREATE OR REPLACE FUNCTION public.billing_wallet_lock(p_workspace_id uuid)
 RETURNS billing_wallet_accounts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_row public.billing_wallet_accounts;
BEGIN
  INSERT INTO public.billing_wallet_accounts (workspace_id)
  VALUES (p_workspace_id)
  ON CONFLICT (workspace_id) DO NOTHING;

  SELECT * INTO v_row FROM public.billing_wallet_accounts
   WHERE workspace_id = p_workspace_id FOR UPDATE;
  RETURN v_row;
END;
$function$
;
REVOKE ALL ON FUNCTION public.billing_wallet_lock(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_wallet_lock(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_wallet_pay_invoice(p_invoice_id uuid, p_actor_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inv    public.billing_invoices;
  v_entry  public.billing_wallet_ledger;
  v_amount BIGINT;
  v_result JSONB;
BEGIN
  SELECT * INTO v_inv FROM public.billing_invoices WHERE id = p_invoice_id;
  IF v_inv.id IS NULL THEN
    RAISE EXCEPTION 'unknown_invoice:%', p_invoice_id;
  END IF;
  IF v_inv.status NOT IN ('open', 'partially_paid', 'past_due') THEN
    RAISE EXCEPTION 'invoice_not_payable:%:%', v_inv.id, v_inv.status;
  END IF;

  v_amount := v_inv.amount_due_irr;
  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'invoice_nothing_due:%', v_inv.id;
  END IF;

  -- Refuses while a gateway checkout holds the invoice: prevention, not
  -- after-the-fact reconciliation of a double collection.
  PERFORM public.billing_begin_collection(
    v_inv.id, 'wallet', v_amount,
    'wallet_collect:' || v_inv.id::text || ':' || v_inv.amount_paid_irr::text,
    NULL, 300
  );

  v_entry := public.billing_wallet_append(
    v_inv.workspace_id, 'invoice_payment', -v_amount,
    'invoice_payment:' || v_inv.id::text, 'wallet_invoice_payment',
    v_inv.id, NULL, NULL, p_actor_id
  );

  v_result := public.billing_settle_invoice(
    v_inv.id, v_amount, 'wallet',
    'wallet_settle:' || v_inv.id::text, NULL, v_entry.id
  );

  RETURN v_result || jsonb_build_object('wallet_entry_id', v_entry.id);
END;
$function$
;
REVOKE ALL ON FUNCTION public.billing_wallet_pay_invoice(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_wallet_pay_invoice(uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_wallet_reconcile(p_workspace_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_ledger BIGINT; v_cache BIGINT;
BEGIN
  SELECT COALESCE(SUM(amount_irr), 0) INTO v_ledger
    FROM public.billing_wallet_ledger WHERE workspace_id = p_workspace_id;
  SELECT COALESCE(available_balance_irr, 0) INTO v_cache
    FROM public.billing_wallet_accounts WHERE workspace_id = p_workspace_id;
  RETURN jsonb_build_object(
    'ledger_balance_irr', v_ledger,
    'cached_balance_irr', COALESCE(v_cache, 0),
    'drift_irr', COALESCE(v_cache, 0) - v_ledger,
    'consistent', COALESCE(v_cache, 0) = v_ledger
  );
END;
$function$
;
REVOKE ALL ON FUNCTION public.billing_wallet_reconcile(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_wallet_reconcile(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_wallet_refund(p_workspace_id uuid, p_amount_irr bigint, p_command_key text, p_reason text DEFAULT 'refund'::text, p_actor_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_entry public.billing_wallet_ledger;
BEGIN
  IF p_amount_irr <= 0 THEN RAISE EXCEPTION 'refund_amount_invalid'; END IF;
  v_entry := public.billing_wallet_append(
    p_workspace_id, 'refund', -p_amount_irr, p_command_key, p_reason,
    NULL, NULL, NULL, p_actor_id
  );
  RETURN jsonb_build_object('entry_id', v_entry.id, 'balance_after_irr', v_entry.balance_after_irr);
END;
$function$
;
REVOKE ALL ON FUNCTION public.billing_wallet_refund(uuid,bigint,text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_wallet_refund(uuid,bigint,text,text,uuid) TO service_role;

RESET check_function_bodies;

-- ─── triggers: the freeze and append-only guards ─────────────────────────
DROP TRIGGER IF EXISTS trg_billing_entitlement_cycle_freeze ON public.billing_entitlement_cycles;
CREATE TRIGGER trg_billing_entitlement_cycle_freeze BEFORE UPDATE ON public.billing_entitlement_cycles FOR EACH ROW EXECUTE FUNCTION billing_entitlement_cycle_freeze();
DROP TRIGGER IF EXISTS trg_billing_invoice_applications_append_only ON public.billing_invoice_applications;
CREATE TRIGGER trg_billing_invoice_applications_append_only BEFORE DELETE OR UPDATE ON public.billing_invoice_applications FOR EACH ROW EXECUTE FUNCTION billing_invoice_application_block_mutation();
DROP TRIGGER IF EXISTS trg_billing_invoice_line_freeze ON public.billing_invoice_lines;
CREATE TRIGGER trg_billing_invoice_line_freeze BEFORE INSERT OR DELETE OR UPDATE ON public.billing_invoice_lines FOR EACH ROW EXECUTE FUNCTION billing_invoice_line_freeze();
DROP TRIGGER IF EXISTS trg_billing_invoice_freeze ON public.billing_invoices;
CREATE TRIGGER trg_billing_invoice_freeze BEFORE UPDATE ON public.billing_invoices FOR EACH ROW EXECUTE FUNCTION billing_invoice_freeze();
DROP TRIGGER IF EXISTS trg_billing_invoices_engine_freeze ON public.billing_invoices;
CREATE TRIGGER trg_billing_invoices_engine_freeze BEFORE UPDATE ON public.billing_invoices FOR EACH ROW EXECUTE FUNCTION billing_engine_version_freeze();
DROP TRIGGER IF EXISTS trg_billing_v2_invoice_arm_dunning ON public.billing_invoices;
CREATE TRIGGER trg_billing_v2_invoice_arm_dunning AFTER INSERT OR UPDATE OF status ON public.billing_invoices FOR EACH ROW EXECUTE FUNCTION billing_v2_invoice_arm_dunning();
DROP TRIGGER IF EXISTS trg_billing_v2_invoice_notification_sync ON public.billing_invoices;
CREATE TRIGGER trg_billing_v2_invoice_notification_sync AFTER UPDATE ON public.billing_invoices FOR EACH ROW EXECUTE FUNCTION billing_v2_invoice_notification_sync();
DROP TRIGGER IF EXISTS trg_billing_payment_allocations_append_only ON public.billing_payment_allocations;
CREATE TRIGGER trg_billing_payment_allocations_append_only BEFORE DELETE OR UPDATE ON public.billing_payment_allocations FOR EACH ROW EXECUTE FUNCTION billing_allocation_block_mutation();
DROP TRIGGER IF EXISTS trg_billing_v2_block_period_keyed_grant ON public.billing_period_allowance_grants;
CREATE TRIGGER trg_billing_v2_block_period_keyed_grant BEFORE INSERT OR UPDATE ON public.billing_period_allowance_grants FOR EACH ROW EXECUTE FUNCTION billing_v2_block_period_keyed_grant();
DROP TRIGGER IF EXISTS trg_billing_period_freeze ON public.billing_subscription_periods;
CREATE TRIGGER trg_billing_period_freeze BEFORE UPDATE ON public.billing_subscription_periods FOR EACH ROW EXECUTE FUNCTION billing_period_freeze();
DROP TRIGGER IF EXISTS trg_billing_subscription_periods_engine_freeze ON public.billing_subscription_periods;
CREATE TRIGGER trg_billing_subscription_periods_engine_freeze BEFORE UPDATE ON public.billing_subscription_periods FOR EACH ROW EXECUTE FUNCTION billing_engine_version_freeze();
DROP TRIGGER IF EXISTS trg_billing_v2_single_scheduled_period ON public.billing_subscription_periods;
CREATE CONSTRAINT TRIGGER trg_billing_v2_single_scheduled_period AFTER INSERT OR UPDATE ON public.billing_subscription_periods DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION billing_v2_assert_single_scheduled_period();
DROP TRIGGER IF EXISTS trg_billing_wallet_deposits_engine_freeze ON public.billing_wallet_deposits;
CREATE TRIGGER trg_billing_wallet_deposits_engine_freeze BEFORE UPDATE ON public.billing_wallet_deposits FOR EACH ROW EXECUTE FUNCTION billing_engine_version_freeze();
DROP TRIGGER IF EXISTS trg_billing_wallet_ledger_append_only ON public.billing_wallet_ledger;
CREATE TRIGGER trg_billing_wallet_ledger_append_only BEFORE DELETE OR UPDATE ON public.billing_wallet_ledger FOR EACH ROW EXECUTE FUNCTION billing_wallet_ledger_block_mutation();

RESET check_function_bodies;

-- ─── proof, in the migration rather than three steps downstream ──────────
DO $verify$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(o, ', ' ORDER BY o) INTO missing FROM (
    SELECT t AS o FROM unnest(ARRAY[
      'billing_v2_rollout','billing_v2_policy','billing_v2_audit',
      'billing_v2_jobs','billing_v2_worker_health','billing_v2_workspace_policy'
    ]) AS t WHERE to_regclass('public.'||t) IS NULL
    UNION ALL
    SELECT f FROM unnest(ARRAY[
      'billing_v2_activate(uuid,uuid,text)',
      'billing_v2_claim_notification_jobs(integer,integer)',
      'billing_v2_complete_notification_job(uuid,text,text)',
      'billing_v2_current_entitlement_cycle(uuid)',
      'billing_v2_dunning_metrics()',
      'billing_v2_evaluate_cutover(uuid)',
      'billing_v2_fail_notification_job(uuid,text)',
      'billing_v2_issue_renewal_invoice(uuid,boolean)',
      'billing_v2_policy_for(uuid)',
      'billing_v2_scheduler_health()',
      'billing_v2_set_state(uuid,text,uuid,text,boolean)',
      'billing_v2_wallet_deposit_config()'
    ]) AS f WHERE to_regprocedure('public.'||f) IS NULL
  ) x;

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'billing_v2 substrate incomplete, missing: %', missing;
  END IF;

  RAISE NOTICE 'billing_v2 substrate: 6 tables and every RPC the server calls are present';
END
$verify$;
