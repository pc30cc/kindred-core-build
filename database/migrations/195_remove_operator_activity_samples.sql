-- ============================================================================
-- 195_remove_operator_activity_samples.sql
--
-- Self-host mirror of the hosted migration
-- `20260917020000_remove_workspace_health_and_operator_activity.sql`.
--
-- The "Operator Activity" online-time report and the 5-minute per-operator
-- buckets behind it were removed from the application. This chain created that
-- table in 016 and seeded its retention policy in 169, so both are retired
-- here. Forward-only: 016 and 169 are left untouched.
--
-- The workspace-health half of the hosted migration has no counterpart here —
-- this chain never created `workspace_health_snapshots`,
-- `workspace_health_snapshot_compute()`, `enforcement_rules` or
-- `slo_definitions` — but 169 did seed retention policies for BOTH tables, so
-- both policy rows go.
--
-- LIVE PRESENCE IS NOT AFFECTED: it comes from the `operator_presence_live`
-- lease plus the ephemeral in-memory/Redis activity index, never from this
-- table. The heartbeat endpoint keeps refreshing both.
-- ============================================================================

-- Retention seeds first, so no policy is left pointing at a missing table.
-- data_retention_runs.policy_id is ON DELETE CASCADE.
DELETE FROM public.data_retention_policies
WHERE table_name IN ('operator_activity_samples', 'workspace_health_snapshots');

-- Drops the table with its indexes, RLS policies and grants.
DROP TABLE IF EXISTS public.operator_activity_samples;

DO $$
BEGIN
  IF to_regclass('public.operator_activity_samples') IS NOT NULL THEN
    RAISE EXCEPTION 'operator_activity_samples still present after drop';
  END IF;
  RAISE NOTICE 'operator activity samples removed (self-host chain)';
END;
$$;
