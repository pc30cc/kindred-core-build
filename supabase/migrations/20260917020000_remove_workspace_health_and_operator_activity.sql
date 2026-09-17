-- ============================================================================
-- 185_remove_workspace_health_and_operator_activity.sql
--
-- Removes two telemetry features whole, database side. The application code
-- that produced and consumed them is deleted in the same change, so nothing is
-- left reading or writing either table.
--
-- 1) WORKSPACE HEALTH SNAPSHOTS — a 0..100 score per workspace recomputed
--    every rollup tick from a 24h window. Retired with its admin dashboard
--    donut, System-page card, Reliability panel section, the
--    `/workspace-health` API, the SLO metric and the enforcement trigger.
--    Nothing deletes its rows today, so it grew without bound at ~288
--    rows/day/workspace for a score that is re-derivable from the rollups it
--    was computed from.
--
-- 2) OPERATOR ACTIVITY SAMPLES — 5-minute per-operator presence buckets behind
--    the "Operator Activity" online-time report. Retired with that settings
--    page, its CSV exports and its stats endpoint. Cost scaled linearly with
--    the operator count (288 rows/day each) for a report that is not used.
--
-- LIVE PRESENCE IS NOT AFFECTED. It never came from either table: teammate
-- presence is `operator_presence_live` (one lease row per operator, no
-- history) plus the ephemeral in-memory/Redis activity index. The heartbeat
-- endpoint keeps refreshing both. The one behaviour change is that on a
-- MULTI-NODE deployment with no OPERATOR_ACTIVITY_REDIS_URL/REALTIME_REDIS_URL
-- configured, an operator whose beat landed on another node now reads as
-- `away` instead of `active`; that coarse cross-node fallback was the only
-- read this file's tables served outside the removed reports. They can never
-- read as `offline`, and customer-facing availability is unaffected (it is
-- decided solely by manual status + personal schedule).
--
-- Not reversible from within the database: recovery would be a point-in-time
-- restore. Nothing else references either table — verified against pg_proc,
-- pg_class (views/matviews), pg_trigger and pg_constraint before writing this.
-- ============================================================================

-- ── 1. Configuration rows whose trigger/metric no longer exists ─────────────
-- slo_breach_events.slo_id and enforcement_actions.rule_id are both
-- ON DELETE CASCADE, so their history goes with the definitions.
delete from public.enforcement_rules where trigger_type = 'health_score';
delete from public.slo_definitions   where metric_key   = 'health_score';

-- The CHECK still advertised a trigger the engine can no longer evaluate;
-- narrow it so a future rule cannot be created against a dead code path.
alter table public.enforcement_rules drop constraint if exists enforcement_rules_trigger_type_check;
alter table public.enforcement_rules add constraint enforcement_rules_trigger_type_check
  check (trigger_type = any (array['slo_breach'::text, 'alert_rate'::text]));

-- ── 2. Retention policies for tables that are about to stop existing ────────
-- data_retention_runs.policy_id is ON DELETE CASCADE.
delete from public.data_retention_policies
where table_name in ('workspace_health_snapshots', 'operator_activity_samples');

-- ── 3. The producer function ────────────────────────────────────────────────
-- Its only callers were the reliability rollup ticker and the admin manual
-- rollup route, both updated in this change.
drop function if exists public.workspace_health_snapshot_compute();

-- ── 4. The tables themselves ────────────────────────────────────────────────
-- Monthly RANGE-partitioned: this drops every partition, index, RLS policy and
-- grant with the parent.
drop table if exists public.workspace_health_snapshots;
drop table if exists public.operator_activity_samples;

do $$
declare
  v_leftovers int;
begin
  select count(*) into v_leftovers
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and (c.relname like 'workspace_health_snapshots%' or c.relname like 'operator_activity_samples%');

  if v_leftovers <> 0 then
    raise exception 'orphaned_relations_remain: %', v_leftovers;
  end if;

  raise notice 'workspace health + operator activity removed; no relations left behind';
end;
$$;
