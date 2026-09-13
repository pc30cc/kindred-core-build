-- ============================================================================
-- 176_partition_infrastructure.sql
-- PHASE 3 — Production-grade declarative partitioning: shared toolkit.
--
-- This migration partitions NOTHING. It installs the single canonical
-- partition-management component used by every later migration, the
-- background worker and the Super Admin diagnostics screen, so that
-- CREATE TABLE ... PARTITION OF logic never gets scattered across workers.
--
-- Every function is SECURITY DEFINER, pinned to search_path=public, and
-- executable ONLY by service_role. Nothing here drops or detaches a
-- partition: destructive partition lifecycle stays behind the existing
-- Data Retention workflow (which remains disabled by default).
-- ============================================================================

-- ── Discovery ───────────────────────────────────────────────────────────────
-- Every RANGE-partitioned public table whose partition key is a single
-- timestamp column. That definition IS the registry: a table becomes
-- "managed" simply by being partitioned this way.
create or replace function public.partition_managed_tables()
returns table (parent_table text, partition_key text, key_type text)
language sql
stable
security definer
set search_path = public
as $$
  select c.relname::text,
         a.attname::text,
         format_type(a.atttypid, a.atttypmod)::text
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join pg_partitioned_table p on p.partrelid = c.oid
  join pg_attribute a on a.attrelid = c.oid and a.attnum = p.partattrs[1]
  where n.nspname = 'public'
    and c.relkind = 'p'
    and p.partstrat = 'r'
    and p.partnatts = 1
    and a.atttypid in ('timestamptz'::regtype, 'timestamp'::regtype)
  order by c.relname;
$$;

-- ── Creation ────────────────────────────────────────────────────────────────
-- Idempotent: creating an existing month is a no-op returning its name.
create or replace function public.partition_ensure_month(_parent text, _month date)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_start date := date_trunc('month', _month)::date;
  v_end   date := (date_trunc('month', _month) + interval '1 month')::date;
  v_name  text;
begin
  if not exists (select 1 from public.partition_managed_tables() m where m.parent_table = _parent) then
    raise exception 'not_a_managed_partitioned_table: %', _parent using errcode = '22023';
  end if;

  v_name := _parent || '_' || to_char(v_start, 'YYYY_MM');

  if exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = v_name
  ) then
    return v_name;
  end if;

  execute format(
    'create table public.%I partition of public.%I for values from (%L) to (%L)',
    v_name, _parent, v_start::text, v_end::text
  );
  return v_name;
end;
$$;

-- Current month + `_months` future months. A missing future partition must
-- never break a production insert, so this is called on a schedule AND is
-- safe to call as often as you like.
create or replace function public.partition_ensure_future(_parent text, _months int default 2)
returns text[]
language plpgsql
security definer
set search_path = public
as $$
declare
  v_created text[] := '{}';
  v_name text;
  i int;
begin
  for i in 0 .. greatest(coalesce(_months, 2), 0) loop
    v_name := public.partition_ensure_month(_parent, (date_trunc('month', now()) + make_interval(months => i))::date);
    v_created := array_append(v_created, v_name);
  end loop;
  return v_created;
end;
$$;

-- Sweeps every managed table. This is what the background worker calls.
create or replace function public.partition_ensure_all(_months int default 2)
returns table (parent_table text, partitions text[])
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  for r in select m.parent_table from public.partition_managed_tables() m loop
    parent_table := r.parent_table;
    partitions := public.partition_ensure_future(r.parent_table, _months);
    return next;
  end loop;
end;
$$;

-- ── Inventory ───────────────────────────────────────────────────────────────
create or replace function public.partition_inventory()
returns table (
  parent_table   text,
  partition_name text,
  is_default     boolean,
  range_start    timestamptz,
  range_end      timestamptz,
  est_rows       bigint,
  total_bytes    bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with parts as (
    select p.relname::text as parent_table,
           c.relname::text as partition_name,
           c.oid            as part_oid,
           pg_get_expr(c.relpartbound, c.oid) as bound
    from pg_inherits i
    join pg_class p on p.oid = i.inhparent
    join pg_class c on c.oid = i.inhrelid
    join pg_namespace n on n.oid = p.relnamespace
    where n.nspname = 'public' and p.relkind = 'p'
  ), expanded as (
    select parts.parent_table,
           parts.partition_name,
           (parts.bound = 'DEFAULT') as is_default,
           nullif((regexp_match(parts.bound, $re$FROM \('([^']+)'\)$re$))[1], '')::timestamptz as range_start,
           nullif((regexp_match(parts.bound, $re$TO \('([^']+)'\)$re$))[1], '')::timestamptz as range_end,
           greatest(pg_class.reltuples, 0)::bigint as est_rows,
           pg_total_relation_size(parts.part_oid) as total_bytes
    from parts join pg_class on pg_class.oid = parts.part_oid
  )
  select expanded.parent_table, expanded.partition_name, expanded.is_default,
         expanded.range_start, expanded.range_end, expanded.est_rows, expanded.total_bytes
  from expanded
  order by expanded.parent_table, expanded.range_start nulls first, expanded.partition_name;
$$;

-- Exact row count for one partition. Separate from the inventory because
-- reltuples is an estimate and the DEFAULT partition must be reported exactly
-- (a single row there is an incident, not a statistic).
create or replace function public.partition_exact_count(_partition text)
returns bigint
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_n bigint;
begin
  if not exists (
    select 1 from pg_inherits i
    join pg_class c on c.oid = i.inhrelid
    join pg_class p on p.oid = i.inhparent
    join pg_namespace n on n.oid = p.relnamespace
    where n.nspname = 'public' and p.relkind = 'p' and c.relname = _partition
  ) then
    raise exception 'not_a_known_partition: %', _partition using errcode = '22023';
  end if;
  execute format('select count(*) from public.%I', _partition) into v_n;
  return v_n;
end;
$$;

-- ── Health ──────────────────────────────────────────────────────────────────
-- One row per managed table: everything the Super Admin screen and the
-- alerting layer need, in a single round trip.
create or replace function public.partition_health()
returns table (
  parent_table        text,
  partition_key       text,
  partition_count     int,
  current_partition   text,
  next_partition      text,
  next_partition_ready boolean,
  oldest_partition    text,
  oldest_start        timestamptz,
  newest_partition    text,
  newest_end          timestamptz,
  total_rows          bigint,
  total_bytes         bigint,
  largest_partition   text,
  largest_bytes       bigint,
  has_default         boolean,
  default_rows        bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  m record;
  v_cur  text;
  v_next text;
begin
  for m in select * from public.partition_managed_tables() loop
    parent_table  := m.parent_table;
    partition_key := m.partition_key;
    v_cur  := m.parent_table || '_' || to_char(date_trunc('month', now()), 'YYYY_MM');
    v_next := m.parent_table || '_' || to_char(date_trunc('month', now()) + interval '1 month', 'YYYY_MM');

    select count(*) filter (where not i.is_default),
           coalesce(sum(i.est_rows) filter (where not i.is_default), 0),
           coalesce(sum(i.total_bytes), 0)
      into partition_count, total_rows, total_bytes
      from public.partition_inventory() i where i.parent_table = m.parent_table;

    current_partition := case when exists (
      select 1 from public.partition_inventory() i
      where i.parent_table = m.parent_table and i.partition_name = v_cur) then v_cur end;
    next_partition := v_next;
    next_partition_ready := exists (
      select 1 from public.partition_inventory() i
      where i.parent_table = m.parent_table and i.partition_name = v_next);

    select i.partition_name, i.range_start into oldest_partition, oldest_start
      from public.partition_inventory() i
     where i.parent_table = m.parent_table and not i.is_default
     order by i.range_start asc limit 1;

    select i.partition_name, i.range_end into newest_partition, newest_end
      from public.partition_inventory() i
     where i.parent_table = m.parent_table and not i.is_default
     order by i.range_start desc limit 1;

    select i.partition_name, i.total_bytes into largest_partition, largest_bytes
      from public.partition_inventory() i
     where i.parent_table = m.parent_table and not i.is_default
     order by i.total_bytes desc limit 1;

    has_default := exists (
      select 1 from public.partition_inventory() i
      where i.parent_table = m.parent_table and i.is_default);

    default_rows := 0;
    if has_default then
      select public.partition_exact_count(i.partition_name) into default_rows
        from public.partition_inventory() i
       where i.parent_table = m.parent_table and i.is_default limit 1;
    end if;

    return next;
  end loop;
end;
$$;

-- ── Retention candidates (READ ONLY) ────────────────────────────────────────
-- Lists partitions whose ENTIRE range is older than the cutoff — i.e. the
-- partitions a future DETACH/DROP lifecycle could target. It does not detach,
-- drop, truncate or delete anything, and the DEFAULT partition is never a
-- candidate (mixed contents).
create or replace function public.partition_retention_candidates(_parent text, _cutoff timestamptz)
returns table (
  partition_name text,
  range_start    timestamptz,
  range_end      timestamptz,
  est_rows       bigint,
  total_bytes    bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select i.partition_name, i.range_start, i.range_end, i.est_rows, i.total_bytes
  from public.partition_inventory() i
  where i.parent_table = _parent
    and not i.is_default
    and i.range_end is not null
    and i.range_end <= _cutoff
  order by i.range_start;
$$;

-- ── Lockdown ────────────────────────────────────────────────────────────────
do $$
declare fn text;
begin
  foreach fn in array array[
    'partition_managed_tables()',
    'partition_ensure_month(text, date)',
    'partition_ensure_future(text, int)',
    'partition_ensure_all(int)',
    'partition_inventory()',
    'partition_exact_count(text)',
    'partition_health()',
    'partition_retention_candidates(text, timestamptz)'
  ] loop
    execute format('revoke all on function public.%s from public', fn);
    execute format('revoke all on function public.%s from anon', fn);
    execute format('revoke all on function public.%s from authenticated', fn);
    execute format('grant execute on function public.%s to service_role', fn);
  end loop;
end;
$$;

comment on function public.partition_ensure_all(int) is
  'Canonical WEBYAR partition manager entry point: ensures current + N future monthly partitions for every managed table. Idempotent, never destructive.';