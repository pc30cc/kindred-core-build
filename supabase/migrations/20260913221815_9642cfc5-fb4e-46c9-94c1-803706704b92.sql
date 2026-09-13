-- ============================================================================
-- 178_partition_workspace_health_snapshots.sql
--
-- WHY A SINGLE-TRANSACTION SWAP IS SAFE HERE:
--   Live size at migration time: 2,262 rows / 936 kB, growing ~516 rows/day.
--   The copy is a sub-second sequential scan, so the ACCESS EXCLUSIVE window
--   is negligible. A dual-write/expand-contract dance would add far more
--   moving parts than it removes risk. This is the ONE moment in this table's
--   life where the cheap migration is available — taking it now is precisely
--   what avoids an unsafe rewrite at 100M rows later.
--
-- The old table is RENAMED, never dropped: `workspace_health_snapshots_legacy`
-- stays as a rollback fallback. Destructive removal is a separate, later task.
--
-- UNIQUENESS NOTE (explicit, not silent):
--   PostgreSQL requires every unique constraint on a partitioned table to
--   contain the partition key. The primary key therefore becomes
--   (captured_at, id) instead of (id). No foreign key references this table
--   and no code path looks a snapshot up by `id` alone (writers insert,
--   readers filter by workspace_id + captured_at), so no integrity guarantee
--   the application relies on is weakened. `id` keeps its gen_random_uuid()
--   default.
-- ============================================================================

alter table public.workspace_health_snapshots rename to workspace_health_snapshots_legacy;
alter index public.workspace_health_snapshots_pkey rename to workspace_health_snapshots_legacy_pkey;
alter index public.workspace_health_snapshots_recent_idx rename to workspace_health_snapshots_legacy_recent_idx;

create table public.workspace_health_snapshots (
  id           uuid        not null default gen_random_uuid(),
  workspace_id uuid        not null,
  captured_at  timestamptz not null default now(),
  health_score integer     not null,
  state        text        not null,
  components   jsonb       not null default '{}'::jsonb,
  inputs       jsonb       not null default '{}'::jsonb,
  constraint workspace_health_snapshots_pkey primary key (captured_at, id)
) partition by range (captured_at);

-- Grants replicate the previous ACL exactly; RLS remains the access authority.
grant all on public.workspace_health_snapshots to anon;
grant all on public.workspace_health_snapshots to authenticated;
grant all on public.workspace_health_snapshots to service_role;

alter table public.workspace_health_snapshots enable row level security;

create policy "Admins read workspace_health_snapshots"
  on public.workspace_health_snapshots for select to authenticated
  using (has_role(auth.uid(), 'admin'::app_role));

create policy "Admins write workspace_health_snapshots"
  on public.workspace_health_snapshots for all to authenticated
  using (has_role(auth.uid(), 'admin'::app_role))
  with check (has_role(auth.uid(), 'admin'::app_role));

create policy "Workspace members read own health"
  on public.workspace_health_snapshots for select to authenticated
  using (is_workspace_member(workspace_id, auth.uid()));

-- Optimises the only hot query: "latest health for workspace X over a window"
--   select ... from workspace_health_snapshots
--   where workspace_id = $1 and captured_at >= $2 order by captured_at desc
-- Combined with partition pruning this touches one or two partitions only.
-- No BRIN yet: at <1 MB per month a btree is strictly better; BRIN becomes
-- worth evaluating once a single partition exceeds a few hundred MB.
create index workspace_health_snapshots_recent_idx
  on public.workspace_health_snapshots (workspace_id, captured_at desc);

do $$
declare
  m date;
  v_min date;
begin
  select coalesce(date_trunc('month', min(captured_at))::date, date_trunc('month', now())::date)
    into v_min from public.workspace_health_snapshots_legacy;

  for m in
    select generate_series(v_min, (date_trunc('month', now()) + interval '2 months')::date, interval '1 month')::date
  loop
    perform public.partition_ensure_month('workspace_health_snapshots', m);
  end loop;
end;
$$;

-- Safety net so a row with an unexpected timestamp is never rejected. It must
-- stay EMPTY — partition_health() reports its exact row count and the
-- diagnostics layer alerts on anything landing here.
create table public.workspace_health_snapshots_default
  partition of public.workspace_health_snapshots default;

insert into public.workspace_health_snapshots (id, workspace_id, captured_at, health_score, state, components, inputs)
select id, workspace_id, captured_at, health_score, state, components, inputs
from public.workspace_health_snapshots_legacy;

do $$
declare
  v_old bigint; v_new bigint;
  v_old_min timestamptz; v_new_min timestamptz;
  v_old_max timestamptz; v_new_max timestamptz;
  v_old_ws bigint; v_new_ws bigint;
  v_default bigint; v_dupes bigint;
begin
  select count(*), min(captured_at), max(captured_at), count(distinct workspace_id)
    into v_old, v_old_min, v_old_max, v_old_ws from public.workspace_health_snapshots_legacy;
  select count(*), min(captured_at), max(captured_at), count(distinct workspace_id)
    into v_new, v_new_min, v_new_max, v_new_ws from public.workspace_health_snapshots;
  select count(*) into v_default from public.workspace_health_snapshots_default;
  select count(*) into v_dupes from (
    select id from public.workspace_health_snapshots group by id having count(*) > 1
  ) d;

  if v_old <> v_new then
    raise exception 'row_count_mismatch: legacy=% partitioned=%', v_old, v_new;
  end if;
  if v_old_min is distinct from v_new_min or v_old_max is distinct from v_new_max then
    raise exception 'timestamp_range_mismatch: legacy=[%,%] partitioned=[%,%]', v_old_min, v_old_max, v_new_min, v_new_max;
  end if;
  if v_old_ws <> v_new_ws then
    raise exception 'workspace_distribution_mismatch: legacy=% partitioned=%', v_old_ws, v_new_ws;
  end if;
  if v_default <> 0 then
    raise exception 'rows_landed_in_default_partition: %', v_default;
  end if;
  if v_dupes <> 0 then
    raise exception 'duplicate_ids_after_copy: %', v_dupes;
  end if;

  raise notice 'workspace_health_snapshots partitioned: % rows, range [%, %], % workspaces', v_new, v_new_min, v_new_max, v_new_ws;
end;
$$;

analyze public.workspace_health_snapshots;

comment on table public.workspace_health_snapshots is
  'Monthly RANGE-partitioned on captured_at. Managed by public.partition_ensure_all(). Rollback copy: workspace_health_snapshots_legacy (retained deliberately).';
comment on table public.workspace_health_snapshots_legacy is
  'Pre-partitioning snapshot of workspace_health_snapshots, kept as a rollback fallback. Not written to. Do not drop without an explicit decision.';