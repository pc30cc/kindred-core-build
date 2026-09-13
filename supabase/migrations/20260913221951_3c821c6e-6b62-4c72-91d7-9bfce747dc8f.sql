-- ============================================================================
-- 180_partition_operator_activity_samples.sql
--
-- Live size at migration time: 1,289 rows / 680 kB, growing ~294 rows/day and
-- scaling linearly with connected operators. Same reasoning as 178: a
-- single-transaction swap is sub-second today and impossible later.
--
-- UNIQUENESS: fully preserved. The business rule is UNIQUE
-- (workspace_id, user_id, bucket) and `bucket` IS the partition key, so
-- PostgreSQL accepts it as a partitioned unique constraint. The heartbeat
-- UPSERT (onConflict: workspace_id,user_id,bucket) keeps working unchanged.
-- Only the primary key gains the partition key: (bucket, id) instead of (id).
-- Nothing references this table by foreign key and no code reads a sample by
-- `id`.
-- ============================================================================

alter table public.operator_activity_samples rename to operator_activity_samples_legacy;
alter index public.operator_activity_samples_pkey rename to operator_activity_samples_legacy_pkey;
alter index public.operator_activity_samples_workspace_id_user_id_bucket_key
  rename to operator_activity_samples_legacy_ws_user_bucket_key;
alter index public.idx_operator_activity_bucket rename to idx_operator_activity_legacy_bucket;
alter index public.idx_operator_activity_user_bucket rename to idx_operator_activity_legacy_user_bucket;
alter index public.idx_operator_activity_ws_bucket rename to idx_operator_activity_legacy_ws_bucket;

create table public.operator_activity_samples (
  id           uuid        not null default gen_random_uuid(),
  workspace_id uuid        not null,
  user_id      uuid        not null,
  bucket       timestamptz not null,
  available    boolean     not null default true,
  created_at   timestamptz not null default now(),
  constraint operator_activity_samples_pkey primary key (bucket, id),
  constraint operator_activity_samples_workspace_id_user_id_bucket_key
    unique (workspace_id, user_id, bucket)
) partition by range (bucket);

grant all on public.operator_activity_samples to anon;
grant all on public.operator_activity_samples to authenticated;
grant all on public.operator_activity_samples to service_role;

alter table public.operator_activity_samples enable row level security;

create policy "members read workspace operator activity"
  on public.operator_activity_samples for select to authenticated
  using (is_workspace_member(workspace_id, auth.uid()));

-- Optimises the online-time report:
--   select user_id, bucket, available from operator_activity_samples
--   where workspace_id = $1 and bucket >= $2 order by bucket
create index idx_operator_activity_ws_bucket
  on public.operator_activity_samples (workspace_id, bucket desc);

-- Optimises the per-operator timeline:
--   ... where user_id = $1 and bucket >= $2 order by bucket desc
create index idx_operator_activity_user_bucket
  on public.operator_activity_samples (user_id, bucket desc);

-- The old standalone (bucket) index is deliberately NOT recreated: it existed
-- only to bound time-range scans, which partition pruning now does for free.
-- Recreating it would be a redundant index on the hottest write path.

do $$
declare
  m date;
  v_min date;
begin
  select coalesce(date_trunc('month', min(bucket))::date, date_trunc('month', now())::date)
    into v_min from public.operator_activity_samples_legacy;

  for m in
    select generate_series(v_min, (date_trunc('month', now()) + interval '2 months')::date, interval '1 month')::date
  loop
    perform public.partition_ensure_month('operator_activity_samples', m);
  end loop;
end;
$$;

create table public.operator_activity_samples_default
  partition of public.operator_activity_samples default;
alter table public.operator_activity_samples_default enable row level security;
revoke all on public.operator_activity_samples_default from anon, authenticated;

insert into public.operator_activity_samples (id, workspace_id, user_id, bucket, available, created_at)
select id, workspace_id, user_id, bucket, available, created_at
from public.operator_activity_samples_legacy;

do $$
declare
  v_old bigint; v_new bigint;
  v_old_min timestamptz; v_new_min timestamptz;
  v_old_max timestamptz; v_new_max timestamptz;
  v_old_ws bigint; v_new_ws bigint;
  v_default bigint; v_dupes bigint;
begin
  select count(*), min(bucket), max(bucket), count(distinct workspace_id)
    into v_old, v_old_min, v_old_max, v_old_ws from public.operator_activity_samples_legacy;
  select count(*), min(bucket), max(bucket), count(distinct workspace_id)
    into v_new, v_new_min, v_new_max, v_new_ws from public.operator_activity_samples;
  select count(*) into v_default from public.operator_activity_samples_default;
  select count(*) into v_dupes from (
    select id from public.operator_activity_samples group by id having count(*) > 1
  ) d;

  if v_old <> v_new then
    raise exception 'row_count_mismatch: legacy=% partitioned=%', v_old, v_new;
  end if;
  if v_old_min is distinct from v_new_min or v_old_max is distinct from v_new_max then
    raise exception 'bucket_range_mismatch: legacy=[%,%] partitioned=[%,%]', v_old_min, v_old_max, v_new_min, v_new_max;
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

  raise notice 'operator_activity_samples partitioned: % rows, range [%, %], % workspaces', v_new, v_new_min, v_new_max, v_new_ws;
end;
$$;

analyze public.operator_activity_samples;

comment on table public.operator_activity_samples is
  'Monthly RANGE-partitioned on bucket. Managed by public.partition_ensure_all(). Rollback copy: operator_activity_samples_legacy (retained deliberately).';
comment on table public.operator_activity_samples_legacy is
  'Pre-partitioning snapshot of operator_activity_samples, kept as a rollback fallback. Not written to. Do not drop without an explicit decision.';