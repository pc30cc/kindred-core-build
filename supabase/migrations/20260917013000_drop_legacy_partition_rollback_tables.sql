-- ============================================================================
-- 184_drop_legacy_partition_rollback_tables.sql
--
-- Retires the two rollback copies left behind by migrations 178 and 180
-- (workspace_health_snapshots_legacy, operator_activity_samples_legacy).
--
-- Those migrations renamed rather than dropped the pre-partitioning tables and
-- recorded that removal required "an explicit decision". This migration IS that
-- decision; the evidence it rests on:
--
--   1. LOSSLESS. Every legacy row still exists, column-for-column, in the
--      partitioned table. Verified by EXCEPT in both directions immediately
--      before writing this migration: 2,262/2,262 and 1,290/1,290 rows present,
--      0 missing. The assertion below re-runs that proof inside the transaction,
--      so the drop aborts if anything has drifted since.
--   2. NO READERS. No foreign key, view, function, trigger or application code
--      path references either table. The only repo mention was the generated
--      Supabase type file, regenerated alongside this migration.
--   3. NOT WRITTEN TO. Both have been read-only since the 2026-09-13 swap;
--      live traffic goes to the partitioned tables (last write minutes ago).
--      The scan counters in pg_stat_user_tables are NOT evidence of current
--      reads: ALTER TABLE ... RENAME preserves the relation's OID, so those
--      counts are lifetime history accumulated while these tables WERE the
--      live ones. last_seq_scan on the health copy is the migration's own
--      copy step, to the second.
--   4. PARTITIONING IS SETTLED. Four days of live operation, both DEFAULT
--      partitions still at 0 rows, so the rollback path these copies existed
--      to serve is no longer a plausible need.
--
-- Reclaims ~1.6 MB. Indexes, RLS policies and grants are dropped with the
-- tables. Not reversible from within the database: recovery would be a
-- point-in-time restore.
-- ============================================================================

do $$
declare
  v_health_missing bigint;
  v_operator_missing bigint;
begin
  if to_regclass('public.workspace_health_snapshots_legacy') is null
     and to_regclass('public.operator_activity_samples_legacy') is null then
    raise notice 'legacy rollback tables already absent; nothing to drop';
    return;
  end if;

  select count(*) into v_health_missing from (
    select id, workspace_id, captured_at, health_score, state, components, inputs
      from public.workspace_health_snapshots_legacy
    except
    select id, workspace_id, captured_at, health_score, state, components, inputs
      from public.workspace_health_snapshots
  ) m;

  select count(*) into v_operator_missing from (
    select id, workspace_id, user_id, bucket, available, created_at
      from public.operator_activity_samples_legacy
    except
    select id, workspace_id, user_id, bucket, available, created_at
      from public.operator_activity_samples
  ) m;

  -- Refuse to drop a copy that still holds data the partitioned table lacks.
  if v_health_missing <> 0 then
    raise exception 'refusing_to_drop: % workspace_health_snapshots_legacy row(s) absent from the partitioned table', v_health_missing;
  end if;
  if v_operator_missing <> 0 then
    raise exception 'refusing_to_drop: % operator_activity_samples_legacy row(s) absent from the partitioned table', v_operator_missing;
  end if;

  raise notice 'rollback copies verified redundant; dropping';
end;
$$;

drop table if exists public.workspace_health_snapshots_legacy;
drop table if exists public.operator_activity_samples_legacy;

-- The surviving tables' comments still advertised the rollback copies.
comment on table public.workspace_health_snapshots is
  'Monthly RANGE-partitioned on captured_at. Managed by public.partition_ensure_all(). Pre-partitioning rollback copy dropped 2026-09-17 after row-for-row verification.';
comment on table public.operator_activity_samples is
  'Monthly RANGE-partitioned on bucket. Managed by public.partition_ensure_all(). Pre-partitioning rollback copy dropped 2026-09-17 after row-for-row verification.';
