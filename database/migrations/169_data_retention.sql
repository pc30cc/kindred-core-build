-- Central Data Retention Policy (Phase 1).
--
-- One canonical, database-backed lifecycle model for every append-heavy
-- operational/telemetry table, plus an execution ledger. Financial and core
-- business tables are seeded as `permanent` and are protected from UI edits
-- by a server-side guard (see server/services/retention/retentionService.ts)
-- AND by the CHECK constraints below (a `permanent` policy can never carry a
-- retention window, so it can never delete anything).
--
-- Backend-only ACL, matching every other operational table in this project
-- (see 121_seo_audit_core.sql's header): the browser never carries a Supabase
-- Auth JWT, so RLS referencing auth.uid() would be dead code. All access goes
-- through the Express service-role client behind `requirePlatformAdmin`.
--
-- Idempotent: safe to re-run on a fresh or an existing database. Seeds use
-- ON CONFLICT DO NOTHING so operator-tuned values are never overwritten.

-- ─────────────────────────────────────────────────────────────────────────
-- Policies
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.data_retention_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_key text NOT NULL UNIQUE,
  table_name text NOT NULL,
  timestamp_column text NOT NULL,
  category text NOT NULL
    CHECK (category IN ('core', 'financial', 'audit', 'telemetry', 'analytics', 'seo', 'ai_debug', 'security')),
  retention_mode text NOT NULL
    CHECK (retention_mode IN ('permanent', 'rolling', 'latest_n_runs', 'archive_then_delete')),
  hot_retention_days integer,
  keep_last_n integer,
  partition_column text,
  archive_enabled boolean NOT NULL DEFAULT false,
  archive_after_days integer,
  delete_after_archive boolean NOT NULL DEFAULT false,
  workspace_overridable boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  batch_size integer NOT NULL DEFAULT 5000 CHECK (batch_size BETWEEN 100 AND 50000),
  description text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_run_at timestamptz,
  last_run_status text,
  last_rows_deleted integer,
  last_error text,
  next_run_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Invalid configurations can never be stored.
DO $$ BEGIN
  ALTER TABLE public.data_retention_policies
    ADD CONSTRAINT data_retention_mode_shape CHECK (
      CASE retention_mode
        -- permanent must not carry ANY deletion window
        WHEN 'permanent' THEN hot_retention_days IS NULL
                          AND keep_last_n IS NULL
                          AND archive_enabled = false
                          AND delete_after_archive = false
        WHEN 'rolling' THEN hot_retention_days IS NOT NULL AND hot_retention_days > 0
        WHEN 'latest_n_runs' THEN keep_last_n IS NOT NULL AND keep_last_n > 0
        WHEN 'archive_then_delete' THEN archive_enabled = true
                                   AND archive_after_days IS NOT NULL
                                   AND archive_after_days > 0
        ELSE false
      END
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_retention_policies_enabled
  ON public.data_retention_policies (enabled, category);

ALTER TABLE public.data_retention_policies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.data_retention_policies FROM anon, authenticated;
GRANT ALL ON public.data_retention_policies TO service_role;

COMMENT ON TABLE public.data_retention_policies IS
  'Canonical data lifecycle model. One row per managed table. `permanent` rows can never delete (enforced by data_retention_mode_shape).';

-- ─────────────────────────────────────────────────────────────────────────
-- Execution ledger
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.data_retention_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id uuid NOT NULL REFERENCES public.data_retention_policies(id) ON DELETE CASCADE,
  policy_key text NOT NULL,
  dry_run boolean NOT NULL DEFAULT false,
  triggered_by text NOT NULL DEFAULT 'scheduler',
  actor_user_id uuid,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'partial', 'failed', 'skipped')),
  rows_matched bigint NOT NULL DEFAULT 0,
  rows_archived bigint NOT NULL DEFAULT 0,
  rows_deleted bigint NOT NULL DEFAULT 0,
  bytes_archived bigint,
  batches integer NOT NULL DEFAULT 0,
  error text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_retention_runs_policy ON public.data_retention_runs (policy_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_retention_runs_status ON public.data_retention_runs (status, started_at DESC);

ALTER TABLE public.data_retention_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.data_retention_runs FROM anon, authenticated;
GRANT ALL ON public.data_retention_runs TO service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- Bounded-batch executors.
--
-- Generic dynamic-SQL delete is only reachable for a table/column pair that
-- is actually declared by an ENABLED, NON-permanent policy — the allowlist
-- lives in data_retention_policies itself, so no caller can ever aim this at
-- an arbitrary table (financial tables are `permanent` and thus rejected).
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.data_retention_count_expired(
  _policy_key text,
  _cutoff timestamptz
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  p public.data_retention_policies%ROWTYPE;
  n bigint;
BEGIN
  SELECT * INTO p FROM public.data_retention_policies WHERE policy_key = _policy_key;
  IF NOT FOUND THEN RAISE EXCEPTION 'retention_policy_not_found: %', _policy_key; END IF;
  IF p.retention_mode = 'permanent' THEN RETURN 0; END IF;

  EXECUTE format(
    'SELECT count(*) FROM public.%I WHERE %I < $1',
    p.table_name, p.timestamp_column
  ) INTO n USING _cutoff;
  RETURN COALESCE(n, 0);
END;
$$;

CREATE OR REPLACE FUNCTION public.data_retention_delete_batch(
  _policy_key text,
  _cutoff timestamptz,
  _batch_size integer
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  p public.data_retention_policies%ROWTYPE;
  deleted integer;
BEGIN
  SELECT * INTO p FROM public.data_retention_policies WHERE policy_key = _policy_key;
  IF NOT FOUND THEN RAISE EXCEPTION 'retention_policy_not_found: %', _policy_key; END IF;
  IF p.retention_mode = 'permanent' THEN
    RAISE EXCEPTION 'retention_policy_permanent: % must never delete', _policy_key;
  END IF;
  IF NOT p.enabled THEN
    RAISE EXCEPTION 'retention_policy_disabled: %', _policy_key;
  END IF;

  -- Bounded batch: never a full-table DELETE in one transaction.
  EXECUTE format(
    'WITH victims AS (
       SELECT ctid FROM public.%I WHERE %I < $1 ORDER BY %I ASC LIMIT $2
     )
     DELETE FROM public.%I t USING victims v WHERE t.ctid = v.ctid',
    p.table_name, p.timestamp_column, p.timestamp_column, p.table_name
  ) USING _cutoff, GREATEST(1, LEAST(_batch_size, 50000));

  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.data_retention_count_expired(text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.data_retention_delete_batch(text, timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.data_retention_count_expired(text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.data_retention_delete_batch(text, timestamptz, integer) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- Seed policies. Nothing here deletes historical data at migration time —
-- these only DECLARE intent; the retention service executes them later, and
-- every rolling policy is seeded DISABLED so an operator opts in explicitly.
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO public.data_retention_policies
  (policy_key, table_name, timestamp_column, category, retention_mode, hot_retention_days, keep_last_n, enabled, batch_size, description)
VALUES
  -- Permanent: financial + core business records. Never deletable.
  ('billing_wallet_ledger',        'billing_wallet_ledger',        'created_at', 'financial', 'permanent', NULL, NULL, true, 5000, 'Wallet ledger — permanent financial record'),
  ('billing_invoices',             'billing_invoices',             'created_at', 'financial', 'permanent', NULL, NULL, true, 5000, 'Invoices — permanent financial record'),
  ('billing_invoice_lines',        'billing_invoice_lines',        'created_at', 'financial', 'permanent', NULL, NULL, true, 5000, 'Invoice lines — permanent financial record'),
  ('billing_payments',             'billing_payments',             'created_at', 'financial', 'permanent', NULL, NULL, true, 5000, 'Payments — permanent financial record'),
  ('billing_payment_allocations',  'billing_payment_allocations',  'created_at', 'financial', 'permanent', NULL, NULL, true, 5000, 'Payment allocations — permanent financial record'),
  ('ai_run_settlements',           'ai_run_settlements',           'created_at', 'financial', 'permanent', NULL, NULL, true, 5000, 'AI run settlements — permanent financial record'),
  ('billing_subscription_periods', 'billing_subscription_periods', 'created_at', 'financial', 'permanent', NULL, NULL, true, 5000, 'Subscription periods — permanent financial record'),
  ('workspaces',                   'workspaces',                   'created_at', 'core',      'permanent', NULL, NULL, true, 5000, 'Workspaces — permanent business record'),
  ('profiles',                     'profiles',                     'created_at', 'core',      'permanent', NULL, NULL, true, 5000, 'User profiles — permanent business record'),
  ('conversations',                'conversations',                'created_at', 'core',      'permanent', NULL, NULL, true, 5000, 'Conversations — product-level retention not defined yet'),
  ('conversation_messages',        'conversation_messages',        'created_at', 'core',      'permanent', NULL, NULL, true, 5000, 'Messages — product-level retention not defined yet'),
  ('contacts',                     'contacts',                     'created_at', 'core',      'permanent', NULL, NULL, true, 5000, 'Contacts — product-level retention not defined yet'),
  ('knowledge_base_articles',      'knowledge_base_articles',      'created_at', 'core',      'permanent', NULL, NULL, true, 5000, 'KB source content — product-level retention not defined yet'),

  -- Long-term: audit / security. Seeded disabled; 365 days when enabled.
  ('audit_logs',                   'audit_logs',                   'created_at', 'audit',     'rolling', 365, NULL, false, 5000, 'Audit trail — long-term, configurable'),
  ('security_events',              'security_events',              'created_at', 'security',  'rolling', 365, NULL, false, 5000, 'Security events — long-term, configurable'),
  ('login_attempts',               'login_attempts',               'created_at', 'security',  'rolling',  90, NULL, false, 5000, 'Login attempts — operational security telemetry'),

  -- Rolling operational telemetry.
  ('workspace_health_snapshots',   'workspace_health_snapshots',   'created_at', 'telemetry', 'rolling',  30, NULL, false, 5000, 'Workspace health snapshots — 30 days'),
  ('operator_activity_samples',    'operator_activity_samples',    'created_at', 'telemetry', 'rolling',  30, NULL, false, 5000, 'Operator activity samples — 30 days'),
  ('business_metrics_hourly',      'business_metrics_hourly',      'created_at', 'analytics', 'rolling',  90, NULL, false, 5000, 'Hourly business metrics rollup — 90 days'),
  ('ai_agent_debug_events',        'ai_agent_debug_events',        'created_at', 'ai_debug',  'rolling',  90, NULL, false, 5000, 'AI agent debug/tracing events — 90 days'),
  ('ai_run_steps',                 'ai_run_steps',                 'created_at', 'ai_debug',  'rolling',  90, NULL, false, 5000, 'AI run step traces — 90 days'),

  -- SEO raw crawl detail: keep the latest N SUCCESSFUL crawls per site.
  ('seo_crawl_details',            'seo_crawls',                   'created_at', 'seo',       'latest_n_runs', NULL, 5, false, 2000, 'Raw SEO crawl observations/links — keep the latest 5 successful crawls per site')
ON CONFLICT (policy_key) DO NOTHING;

-- updated_at maintenance
CREATE OR REPLACE FUNCTION public.data_retention_touch() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_data_retention_policies_touch ON public.data_retention_policies;
CREATE TRIGGER trg_data_retention_policies_touch
  BEFORE UPDATE ON public.data_retention_policies
  FOR EACH ROW EXECUTE FUNCTION public.data_retention_touch();
