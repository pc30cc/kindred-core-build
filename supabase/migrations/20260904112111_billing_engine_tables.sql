-- ============================================================
-- THE BILLING ENGINE TABLES THIS CHAIN USED AND NEVER CREATED (1 of 2)
--
-- supabase/migrations reached 20260904112112 and inserted into
-- public.billing_v2_rollout, a table it never creates. A replay from scratch
-- died there, 282 files into 401:
--
--     ERROR: relation "public.billing_v2_rollout" does not exist
--
-- That was not one missing table. Against a database built from
-- database/migrations, this directory is missing the invoice-driven billing
-- engine entirely -- including public.billing_invoices itself, which nine of
-- its own migrations reference and none of them create:
--
--   13 billing tables   invoices, lines, applications, collections, payment
--                       allocations, subscription periods, entitlement
--                       cycles, period allowance grants, wallet accounts,
--                       deposits and ledger, notification jobs, retention
--                       signals
--    6 billing_v2       rollout, policy, workspace_policy, jobs, audit,
--                       worker_health
--   71 functions        22 billing_*, 49 billing_v2_*
--   13 triggers         the freeze and append-only guards on the above
--
-- The live database has all of it, applied outside the chain. The chain
-- never learned about any of it.
--
-- WHY THIS IS SPLIT IN TWO
--
-- The substrate straddles 20260904112112. That file needs
-- billing_v2_rollout to exist before it runs, but it is also where
-- billing_coupons and billing_currencies are created -- and billing_invoices
-- carries a foreign key to billing_coupons. Nothing can create both sides at
-- one point in the chain.
--
-- So the tables land here, before their first use, with primary keys,
-- indexes, RLS and grants but no foreign keys. The foreign keys, check
-- constraints, functions and triggers land at the end of the chain, where
-- every table they reference exists. Neither half is useful alone and the
-- second half verifies the whole.
--
-- WHERE THE DEFINITIONS COME FROM
--
-- Not retyped. Read out of a database built by applying database/migrations
-- in full to a pristine supabase/postgres -- the self-host chain, which does
-- create this substrate and whose behaviour the billingEngineV2 and
-- billingV2Phase* pg suites cover -- and emitted with pg_get_constraintdef,
-- pg_indexes and pg_policy.
--
-- WHY IT IS GUARDED
--
-- The self-host chain and the live hosted database have drifted: of the
-- billing_v2 functions they share, 18 are byte-identical and 30 have
-- different bodies, and the live database carries 9 functions and 2 columns
-- neither chain creates. This file refuses to run anywhere the substrate
-- already exists, so a push can never quietly rewrite live billing logic.
-- ============================================================

DO $guard$
BEGIN
  IF to_regclass('public.billing_invoices') IS NOT NULL
     OR to_regclass('public.billing_v2_rollout') IS NOT NULL THEN
    RAISE EXCEPTION
      'billing substrate already exists here. This file backfills a chain '
      'that never created it, from the self-host chain, which has drifted '
      'from the live database (30 functions differ). Reconcile deliberately '
      'rather than by applying this.';
  END IF;
END
$guard$;

CREATE TABLE IF NOT EXISTS public.billing_entitlement_cycles (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  subscription_id uuid NOT NULL,
  subscription_period_id uuid NOT NULL,
  cycle_index integer NOT NULL,
  cycle_start timestamp with time zone NOT NULL,
  cycle_end timestamp with time zone NOT NULL,
  status text NOT NULL DEFAULT 'scheduled'::text,
  ai_allowance_irr bigint NOT NULL DEFAULT 0,
  allowance_state text NOT NULL DEFAULT 'pending'::text,
  allowance_lot_id uuid,
  allowance_granted_at timestamp with time zone,
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamp with time zone NOT NULL DEFAULT now(),
  last_error text,
  activated_at timestamp with time zone,
  completed_at timestamp with time zone,
  billing_engine_version text NOT NULL DEFAULT 'v2'::text,
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.billing_invoice_applications (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  application_type text NOT NULL,
  application_status text NOT NULL DEFAULT 'pending'::text,
  period_id uuid,
  result_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  applied_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  attempt_count integer NOT NULL DEFAULT 0,
  lease_until timestamp with time zone,
  next_attempt_at timestamp with time zone NOT NULL DEFAULT now(),
  last_error text,
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.billing_invoice_collections (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  channel text NOT NULL,
  amount_irr bigint NOT NULL,
  payment_intent_id uuid,
  status text NOT NULL DEFAULT 'active'::text,
  command_key text NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  released_at timestamp with time zone,
  release_reason text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.billing_invoice_lines (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL,
  line_type text NOT NULL,
  description text NOT NULL,
  quantity integer NOT NULL DEFAULT 1,
  unit_amount_irr bigint NOT NULL DEFAULT 0,
  amount_irr bigint NOT NULL DEFAULT 0,
  plan_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.billing_invoices (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  subscription_id uuid,
  invoice_number text NOT NULL,
  document_type text NOT NULL DEFAULT 'invoice'::text,
  invoice_type text NOT NULL,
  status text NOT NULL DEFAULT 'draft'::text,
  currency text NOT NULL DEFAULT 'IRR'::text,
  subtotal_irr bigint NOT NULL DEFAULT 0,
  discount_irr bigint NOT NULL DEFAULT 0,
  tax_irr bigint NOT NULL DEFAULT 0,
  total_irr bigint NOT NULL DEFAULT 0,
  amount_paid_irr bigint NOT NULL DEFAULT 0,
  amount_due_irr bigint NOT NULL DEFAULT 0,
  issued_at timestamp with time zone,
  due_at timestamp with time zone,
  paid_at timestamp with time zone,
  past_due_at timestamp with time zone,
  voided_at timestamp with time zone,
  period_start timestamp with time zone,
  period_end timestamp with time zone,
  plan_id uuid,
  plan_name_snapshot text,
  billing_interval text,
  effect_snapshot jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  billing_engine_version text NOT NULL DEFAULT 'v2'::text,
  tax_rate_percent numeric(6,3) NOT NULL DEFAULT 0,
  coupon_id uuid,
  coupon_code text
);
CREATE TABLE IF NOT EXISTS public.billing_notification_jobs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  invoice_id uuid,
  subscription_id uuid,
  notification_type text NOT NULL,
  channel text NOT NULL,
  locale text,
  scheduled_at timestamp with time zone NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending'::text,
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  lease_until timestamp with time zone,
  next_attempt_at timestamp with time zone NOT NULL DEFAULT now(),
  last_error text,
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  sent_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.billing_payment_allocations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  payment_id uuid,
  wallet_ledger_entry_id uuid,
  amount_irr bigint NOT NULL,
  command_key text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.billing_period_allowance_grants (
  period_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  allowance_irr bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending'::text,
  lot_id uuid,
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamp with time zone NOT NULL DEFAULT now(),
  last_error text,
  granted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.billing_retention_signals (
  workspace_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'pending'::text,
  reason text NOT NULL,
  signaled_at timestamp with time zone NOT NULL DEFAULT now(),
  cleared_at timestamp with time zone,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE IF NOT EXISTS public.billing_subscription_periods (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  subscription_id uuid,
  plan_id uuid,
  invoice_id uuid,
  billing_interval text NOT NULL DEFAULT 'monthly'::text,
  period_start timestamp with time zone NOT NULL,
  period_end timestamp with time zone NOT NULL,
  status text NOT NULL DEFAULT 'scheduled'::text,
  source text NOT NULL DEFAULT 'invoice'::text,
  activated_at timestamp with time zone,
  completed_at timestamp with time zone,
  plan_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  limits_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ai_allowance_irr bigint NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  billing_engine_version text NOT NULL DEFAULT 'v2'::text
);
CREATE TABLE IF NOT EXISTS public.billing_v2_audit (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid,
  event text NOT NULL,
  actor_id uuid,
  reason text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.billing_v2_jobs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  job_type text NOT NULL,
  dedupe_key text NOT NULL,
  workspace_id uuid,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending'::text,
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 8,
  lease_until timestamp with time zone,
  next_attempt_at timestamp with time zone NOT NULL DEFAULT now(),
  last_error text,
  result jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.billing_v2_policy (
  id boolean NOT NULL DEFAULT true,
  invoice_lead_time_days integer NOT NULL DEFAULT 10,
  invoice_due_offset_days integer NOT NULL DEFAULT 0,
  wallet_auto_pay_default boolean NOT NULL DEFAULT true,
  collection_ttl_seconds integer NOT NULL DEFAULT 300,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  wallet_deposit_presets_irr bigint[] NOT NULL DEFAULT ARRAY[(5000000)::bigint, (10000000)::bigint, (20000000)::bigint, (50000000)::bigint],
  wallet_deposit_allow_custom boolean NOT NULL DEFAULT true,
  wallet_deposit_min_irr bigint NOT NULL DEFAULT 500000,
  wallet_deposit_max_irr bigint NOT NULL DEFAULT '5000000000'::bigint,
  reminder_days_before_due integer[] NOT NULL DEFAULT '{5,1}'::integer[],
  grace_period_days integer NOT NULL DEFAULT 3,
  fallback_plan_id uuid,
  send_invoice_issued_email boolean NOT NULL DEFAULT true,
  send_invoice_issued_sms boolean NOT NULL DEFAULT false,
  notify_on_due boolean NOT NULL DEFAULT true,
  notify_on_past_due boolean NOT NULL DEFAULT true,
  notify_on_fallback boolean NOT NULL DEFAULT true,
  notification_max_attempts integer NOT NULL DEFAULT 5,
  notification_retry_seconds integer NOT NULL DEFAULT 900,
  notification_max_per_hour integer NOT NULL DEFAULT 20
);
CREATE TABLE IF NOT EXISTS public.billing_v2_rollout (
  workspace_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'legacy'::text,
  region text,
  shadow_enabled_at timestamp with time zone,
  cutover_pending_at timestamp with time zone,
  activated_at timestamp with time zone,
  activated_by uuid,
  last_blockers jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.billing_v2_worker_health (
  worker text NOT NULL,
  last_run_at timestamp with time zone,
  last_success_at timestamp with time zone,
  last_failure_at timestamp with time zone,
  last_error text,
  last_batch_size integer NOT NULL DEFAULT 0,
  consecutive_failures integer NOT NULL DEFAULT 0,
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.billing_v2_workspace_policy (
  workspace_id uuid NOT NULL,
  invoice_lead_time_days integer,
  wallet_auto_pay_enabled boolean,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  reminder_days_before_due integer[],
  send_invoice_issued_sms boolean,
  notifications_enabled boolean
);
CREATE TABLE IF NOT EXISTS public.billing_wallet_accounts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  currency text NOT NULL DEFAULT 'IRR'::text,
  available_balance_irr bigint NOT NULL DEFAULT 0,
  frozen boolean NOT NULL DEFAULT false,
  auto_pay_enabled boolean,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.billing_wallet_deposits (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  document_number text NOT NULL,
  document_type text NOT NULL DEFAULT 'wallet_deposit'::text,
  amount_irr bigint NOT NULL,
  currency text NOT NULL DEFAULT 'IRR'::text,
  status text NOT NULL DEFAULT 'pending'::text,
  payment_intent_id uuid,
  payment_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  paid_at timestamp with time zone,
  billing_engine_version text NOT NULL DEFAULT 'v2'::text
);
CREATE TABLE IF NOT EXISTS public.billing_wallet_ledger (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  entry_type text NOT NULL,
  amount_irr bigint NOT NULL,
  balance_after_irr bigint NOT NULL,
  invoice_id uuid,
  payment_id uuid,
  wallet_deposit_id uuid,
  command_key text NOT NULL,
  reason text,
  actor_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.billing_entitlement_cycles DROP CONSTRAINT IF EXISTS billing_entitlement_cycles_pkey;
ALTER TABLE public.billing_entitlement_cycles ADD CONSTRAINT billing_entitlement_cycles_pkey PRIMARY KEY (id);
ALTER TABLE public.billing_entitlement_cycles DROP CONSTRAINT IF EXISTS uq_billing_entitlement_cycles_start;
ALTER TABLE public.billing_entitlement_cycles ADD CONSTRAINT uq_billing_entitlement_cycles_start UNIQUE (subscription_period_id, cycle_start);
ALTER TABLE public.billing_entitlement_cycles DROP CONSTRAINT IF EXISTS uq_billing_entitlement_cycles_index;
ALTER TABLE public.billing_entitlement_cycles ADD CONSTRAINT uq_billing_entitlement_cycles_index UNIQUE (subscription_period_id, cycle_index);
ALTER TABLE public.billing_invoice_applications DROP CONSTRAINT IF EXISTS billing_invoice_applications_pkey;
ALTER TABLE public.billing_invoice_applications ADD CONSTRAINT billing_invoice_applications_pkey PRIMARY KEY (id);
ALTER TABLE public.billing_invoice_collections DROP CONSTRAINT IF EXISTS billing_invoice_collections_pkey;
ALTER TABLE public.billing_invoice_collections ADD CONSTRAINT billing_invoice_collections_pkey PRIMARY KEY (id);
ALTER TABLE public.billing_invoice_lines DROP CONSTRAINT IF EXISTS billing_invoice_lines_pkey;
ALTER TABLE public.billing_invoice_lines ADD CONSTRAINT billing_invoice_lines_pkey PRIMARY KEY (id);
ALTER TABLE public.billing_invoices DROP CONSTRAINT IF EXISTS billing_invoices_pkey;
ALTER TABLE public.billing_invoices ADD CONSTRAINT billing_invoices_pkey PRIMARY KEY (id);
ALTER TABLE public.billing_notification_jobs DROP CONSTRAINT IF EXISTS billing_notification_jobs_pkey;
ALTER TABLE public.billing_notification_jobs ADD CONSTRAINT billing_notification_jobs_pkey PRIMARY KEY (id);
ALTER TABLE public.billing_payment_allocations DROP CONSTRAINT IF EXISTS billing_payment_allocations_pkey;
ALTER TABLE public.billing_payment_allocations ADD CONSTRAINT billing_payment_allocations_pkey PRIMARY KEY (id);
ALTER TABLE public.billing_period_allowance_grants DROP CONSTRAINT IF EXISTS billing_period_allowance_grants_pkey;
ALTER TABLE public.billing_period_allowance_grants ADD CONSTRAINT billing_period_allowance_grants_pkey PRIMARY KEY (period_id);
ALTER TABLE public.billing_retention_signals DROP CONSTRAINT IF EXISTS billing_retention_signals_pkey;
ALTER TABLE public.billing_retention_signals ADD CONSTRAINT billing_retention_signals_pkey PRIMARY KEY (workspace_id);
ALTER TABLE public.billing_subscription_periods DROP CONSTRAINT IF EXISTS billing_subscription_periods_pkey;
ALTER TABLE public.billing_subscription_periods ADD CONSTRAINT billing_subscription_periods_pkey PRIMARY KEY (id);
ALTER TABLE public.billing_v2_audit DROP CONSTRAINT IF EXISTS billing_v2_audit_pkey;
ALTER TABLE public.billing_v2_audit ADD CONSTRAINT billing_v2_audit_pkey PRIMARY KEY (id);
ALTER TABLE public.billing_v2_jobs DROP CONSTRAINT IF EXISTS billing_v2_jobs_pkey;
ALTER TABLE public.billing_v2_jobs ADD CONSTRAINT billing_v2_jobs_pkey PRIMARY KEY (id);
ALTER TABLE public.billing_v2_policy DROP CONSTRAINT IF EXISTS billing_v2_policy_pkey;
ALTER TABLE public.billing_v2_policy ADD CONSTRAINT billing_v2_policy_pkey PRIMARY KEY (id);
ALTER TABLE public.billing_v2_rollout DROP CONSTRAINT IF EXISTS billing_v2_rollout_pkey;
ALTER TABLE public.billing_v2_rollout ADD CONSTRAINT billing_v2_rollout_pkey PRIMARY KEY (workspace_id);
ALTER TABLE public.billing_v2_worker_health DROP CONSTRAINT IF EXISTS billing_v2_worker_health_pkey;
ALTER TABLE public.billing_v2_worker_health ADD CONSTRAINT billing_v2_worker_health_pkey PRIMARY KEY (worker);
ALTER TABLE public.billing_v2_workspace_policy DROP CONSTRAINT IF EXISTS billing_v2_workspace_policy_pkey;
ALTER TABLE public.billing_v2_workspace_policy ADD CONSTRAINT billing_v2_workspace_policy_pkey PRIMARY KEY (workspace_id);
ALTER TABLE public.billing_wallet_accounts DROP CONSTRAINT IF EXISTS billing_wallet_accounts_pkey;
ALTER TABLE public.billing_wallet_accounts ADD CONSTRAINT billing_wallet_accounts_pkey PRIMARY KEY (id);
ALTER TABLE public.billing_wallet_deposits DROP CONSTRAINT IF EXISTS billing_wallet_deposits_pkey;
ALTER TABLE public.billing_wallet_deposits ADD CONSTRAINT billing_wallet_deposits_pkey PRIMARY KEY (id);
ALTER TABLE public.billing_wallet_ledger DROP CONSTRAINT IF EXISTS billing_wallet_ledger_pkey;
ALTER TABLE public.billing_wallet_ledger ADD CONSTRAINT billing_wallet_ledger_pkey PRIMARY KEY (id);
CREATE INDEX IF NOT EXISTS ix_billing_entitlement_cycles_due ON public.billing_entitlement_cycles USING btree (cycle_start) WHERE (status = 'scheduled'::text);
CREATE INDEX IF NOT EXISTS ix_billing_entitlement_cycles_grant_retry ON public.billing_entitlement_cycles USING btree (next_attempt_at) WHERE ((status = 'active'::text) AND (allowance_state = ANY (ARRAY['pending'::text, 'failed'::text])));
CREATE UNIQUE INDEX uq_billing_entitlement_cycles_active_ws ON public.billing_entitlement_cycles USING btree (workspace_id) WHERE (status = 'active'::text);
CREATE INDEX IF NOT EXISTS ix_billing_entitlement_cycles_workspace ON public.billing_entitlement_cycles USING btree (workspace_id, cycle_start DESC);
CREATE INDEX IF NOT EXISTS ix_billing_invoice_applications_workspace ON public.billing_invoice_applications USING btree (workspace_id, applied_at DESC);
CREATE UNIQUE INDEX uq_billing_invoice_applications_invoice ON public.billing_invoice_applications USING btree (invoice_id);
CREATE INDEX IF NOT EXISTS ix_billing_invoice_applications_recovery ON public.billing_invoice_applications USING btree (next_attempt_at) WHERE (application_status <> 'applied'::text);
CREATE UNIQUE INDEX uq_billing_invoice_collections_command ON public.billing_invoice_collections USING btree (command_key);
CREATE INDEX IF NOT EXISTS ix_billing_invoice_collections_expiry ON public.billing_invoice_collections USING btree (expires_at) WHERE (status = 'active'::text);
CREATE UNIQUE INDEX uq_billing_invoice_collections_active ON public.billing_invoice_collections USING btree (invoice_id) WHERE (status = 'active'::text);
CREATE INDEX IF NOT EXISTS ix_billing_invoice_lines_invoice ON public.billing_invoice_lines USING btree (invoice_id, sort_order);
CREATE INDEX IF NOT EXISTS ix_billing_invoices_status_due ON public.billing_invoices USING btree (status, due_at) WHERE (status = ANY (ARRAY['open'::text, 'partially_paid'::text, 'past_due'::text]));
CREATE UNIQUE INDEX uq_billing_invoices_number ON public.billing_invoices USING btree (invoice_number);
CREATE UNIQUE INDEX uq_billing_invoices_subscription_period ON public.billing_invoices USING btree (subscription_id, invoice_type, period_start) WHERE ((subscription_id IS NOT NULL) AND (period_start IS NOT NULL) AND (status <> ALL (ARRAY['void'::text, 'expired'::text])));
CREATE INDEX IF NOT EXISTS ix_billing_invoices_workspace_created ON public.billing_invoices USING btree (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_billing_notification_jobs_claimable ON public.billing_notification_jobs USING btree (next_attempt_at) WHERE (status = ANY (ARRAY['pending'::text, 'processing'::text]));
CREATE UNIQUE INDEX uq_billing_notification_jobs_idem ON public.billing_notification_jobs USING btree (idempotency_key);
CREATE INDEX IF NOT EXISTS ix_billing_notification_jobs_invoice ON public.billing_notification_jobs USING btree (invoice_id) WHERE (invoice_id IS NOT NULL);
CREATE UNIQUE INDEX uq_billing_payment_allocations_payment ON public.billing_payment_allocations USING btree (invoice_id, payment_id) WHERE (payment_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS ix_billing_payment_allocations_invoice ON public.billing_payment_allocations USING btree (invoice_id, created_at);
CREATE UNIQUE INDEX uq_billing_payment_allocations_command ON public.billing_payment_allocations USING btree (command_key);
CREATE INDEX IF NOT EXISTS ix_billing_period_allowance_pending ON public.billing_period_allowance_grants USING btree (next_attempt_at) WHERE (status = ANY (ARRAY['pending'::text, 'failed'::text]));
CREATE UNIQUE INDEX uq_billing_subscription_periods_active ON public.billing_subscription_periods USING btree (workspace_id) WHERE (status = 'active'::text);
CREATE INDEX IF NOT EXISTS ix_billing_subscription_periods_workspace ON public.billing_subscription_periods USING btree (workspace_id, period_start DESC);
CREATE UNIQUE INDEX uq_billing_subscription_periods_invoice ON public.billing_subscription_periods USING btree (invoice_id) WHERE (invoice_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS ix_billing_subscription_periods_due_activation ON public.billing_subscription_periods USING btree (period_start) WHERE (status = 'scheduled'::text);
CREATE INDEX IF NOT EXISTS ix_billing_v2_audit_event ON public.billing_v2_audit USING btree (event, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_billing_v2_audit_workspace ON public.billing_v2_audit USING btree (workspace_id, created_at DESC);
CREATE UNIQUE INDEX uq_billing_v2_jobs_dedupe ON public.billing_v2_jobs USING btree (job_type, dedupe_key);
CREATE INDEX IF NOT EXISTS ix_billing_v2_jobs_claimable ON public.billing_v2_jobs USING btree (job_type, next_attempt_at) WHERE (status = ANY (ARRAY['pending'::text, 'processing'::text]));
CREATE UNIQUE INDEX uq_billing_wallet_accounts_workspace ON public.billing_wallet_accounts USING btree (workspace_id);
CREATE INDEX IF NOT EXISTS ix_billing_wallet_deposits_workspace ON public.billing_wallet_deposits USING btree (workspace_id, created_at DESC);
CREATE UNIQUE INDEX uq_billing_wallet_deposits_document ON public.billing_wallet_deposits USING btree (document_number);
CREATE UNIQUE INDEX uq_billing_wallet_ledger_command ON public.billing_wallet_ledger USING btree (command_key);
CREATE INDEX IF NOT EXISTS ix_billing_wallet_ledger_workspace ON public.billing_wallet_ledger USING btree (workspace_id, created_at DESC);
ALTER TABLE public.billing_entitlement_cycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_invoice_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_invoice_collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_notification_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_payment_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_period_allowance_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_retention_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_subscription_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_v2_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_v2_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_v2_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_v2_rollout ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_v2_worker_health ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_v2_workspace_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_wallet_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_wallet_deposits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_wallet_ledger ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_entitlement_cycles_service_only ON public.billing_entitlement_cycles;
CREATE POLICY billing_entitlement_cycles_service_only ON public.billing_entitlement_cycles FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS service_role_only ON public.billing_invoice_applications;
CREATE POLICY service_role_only ON public.billing_invoice_applications FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS service_role_only ON public.billing_invoice_collections;
CREATE POLICY service_role_only ON public.billing_invoice_collections FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS service_role_only ON public.billing_invoice_lines;
CREATE POLICY service_role_only ON public.billing_invoice_lines FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS service_role_only ON public.billing_invoices;
CREATE POLICY service_role_only ON public.billing_invoices FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS billing_notification_jobs_service_only ON public.billing_notification_jobs;
CREATE POLICY billing_notification_jobs_service_only ON public.billing_notification_jobs FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS service_role_only ON public.billing_payment_allocations;
CREATE POLICY service_role_only ON public.billing_payment_allocations FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS billing_period_allowance_service_only ON public.billing_period_allowance_grants;
CREATE POLICY billing_period_allowance_service_only ON public.billing_period_allowance_grants FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS billing_retention_signals_service_only ON public.billing_retention_signals;
CREATE POLICY billing_retention_signals_service_only ON public.billing_retention_signals FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS service_role_only ON public.billing_subscription_periods;
CREATE POLICY service_role_only ON public.billing_subscription_periods FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS billing_v2_audit_service_only ON public.billing_v2_audit;
CREATE POLICY billing_v2_audit_service_only ON public.billing_v2_audit FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS billing_v2_jobs_service_only ON public.billing_v2_jobs;
CREATE POLICY billing_v2_jobs_service_only ON public.billing_v2_jobs FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS billing_v2_policy_service_only ON public.billing_v2_policy;
CREATE POLICY billing_v2_policy_service_only ON public.billing_v2_policy FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS billing_v2_rollout_service_only ON public.billing_v2_rollout;
CREATE POLICY billing_v2_rollout_service_only ON public.billing_v2_rollout FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS billing_v2_worker_health_service_only ON public.billing_v2_worker_health;
CREATE POLICY billing_v2_worker_health_service_only ON public.billing_v2_worker_health FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS billing_v2_workspace_policy_service_only ON public.billing_v2_workspace_policy;
CREATE POLICY billing_v2_workspace_policy_service_only ON public.billing_v2_workspace_policy FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS service_role_only ON public.billing_wallet_accounts;
CREATE POLICY service_role_only ON public.billing_wallet_accounts FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS service_role_only ON public.billing_wallet_deposits;
CREATE POLICY service_role_only ON public.billing_wallet_deposits FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS service_role_only ON public.billing_wallet_ledger;
CREATE POLICY service_role_only ON public.billing_wallet_ledger FOR ALL TO service_role USING (true) WITH CHECK (true);
GRANT ALL ON public.billing_entitlement_cycles TO service_role;
GRANT ALL ON public.billing_invoice_applications TO service_role;
GRANT ALL ON public.billing_invoice_collections TO service_role;
GRANT ALL ON public.billing_invoice_lines TO service_role;
GRANT ALL ON public.billing_invoices TO service_role;
GRANT ALL ON public.billing_notification_jobs TO service_role;
GRANT ALL ON public.billing_payment_allocations TO service_role;
GRANT ALL ON public.billing_period_allowance_grants TO service_role;
GRANT ALL ON public.billing_retention_signals TO service_role;
GRANT ALL ON public.billing_subscription_periods TO service_role;
GRANT ALL ON public.billing_v2_audit TO service_role;
GRANT ALL ON public.billing_v2_jobs TO service_role;
GRANT ALL ON public.billing_v2_policy TO service_role;
GRANT ALL ON public.billing_v2_rollout TO service_role;
GRANT ALL ON public.billing_v2_worker_health TO service_role;
GRANT ALL ON public.billing_v2_workspace_policy TO service_role;
GRANT ALL ON public.billing_wallet_accounts TO service_role;
GRANT ALL ON public.billing_wallet_deposits TO service_role;
GRANT ALL ON public.billing_wallet_ledger TO service_role;
