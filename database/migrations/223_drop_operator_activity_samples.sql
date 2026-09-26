-- ============================================================
-- 223: DROP operator_activity_samples
--
-- Hosted mirror: supabase/migrations/20260926130000_drop_operator_activity_samples.sql
-- (functionally identical; registered in
-- src/test/integration/migrationMirrorParity.test.ts).
--
-- The 5-minute analytics buckets behind the retired "Operator Activity"
-- online-time report. Production dropped the table on 2026-09-17, by hand,
-- as remove_workspace_health_and_operator_activity; neither chain recorded
-- that, so a database built from this repository still had it — monthly
-- partitioned on the hosted chain (20260913221951), with the
-- pre-partitioning copy operator_activity_samples_legacy — and a retention
-- policy for it. Nothing has written it since production dropped it, and its
-- last reader, the coarse fallback in
-- server/services/widget/operatorActivity.ts (which answered 404 twice after
-- every backend start), is removed in the same change.
--
-- Idempotent, and a no-op where the table is already gone (production). The
-- rows were telemetry only; recovery would be a point-in-time restore.
-- ============================================================

-- The retention worker must not keep a policy for a table that is gone.
-- data_retention_runs.policy_id is ON DELETE CASCADE.
DO $$
BEGIN
  IF to_regclass('public.data_retention_policies') IS NOT NULL THEN
    DELETE FROM public.data_retention_policies
     WHERE table_name = 'operator_activity_samples';
  END IF;
END
$$;

-- Dropping the parent drops every partition, index, RLS policy and grant
-- with it. Partition maintenance (partition_managed_tables) discovers
-- partitioned tables from the catalog, so it simply stops seeing this one.
DROP TABLE IF EXISTS public.operator_activity_samples;
DROP TABLE IF EXISTS public.operator_activity_samples_legacy;

DO $$
DECLARE
  v_left text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname)
    INTO v_left
    FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace
     AND c.relname LIKE 'operator\_activity\_samples%';
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'operator_activity_samples leftovers remain: %', v_left;
  END IF;
END
$$;
