-- ============================================================================
-- 179_partition_rls_hardening.sql
--
-- PostgREST exposes every partition as an independent relation. A partition
-- created with CREATE TABLE ... PARTITION OF inherits neither the parent's
-- grants nor its RLS flag, so although it has no grants today, leaving RLS
-- off is a latent hole (anything that later grants on it becomes a bypass of
-- the parent's workspace isolation).
--
-- Fix, applied in the ONE canonical place: partitions get RLS enabled and no
-- policies of their own. Reads through the parent keep using the parent's
-- policies (that is how PostgreSQL evaluates RLS for partitioned scans);
-- direct access to a partition is denied by default.
-- ============================================================================

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
  -- Direct-access lockdown. No policies here on purpose.
  execute format('alter table public.%I enable row level security', v_name);
  execute format('revoke all on public.%I from anon, authenticated', v_name);

  return v_name;
end;
$$;

revoke all on function public.partition_ensure_month(text, date) from public;
revoke all on function public.partition_ensure_month(text, date) from anon;
revoke all on function public.partition_ensure_month(text, date) from authenticated;
grant execute on function public.partition_ensure_month(text, date) to service_role;

-- Backfill the partitions that already exist (including DEFAULT partitions,
-- which partition_ensure_month never creates).
do $$
declare r record;
begin
  for r in
    select c.relname
    from pg_inherits i
    join pg_class c on c.oid = i.inhrelid
    join pg_class p on p.oid = i.inhparent
    join pg_namespace n on n.oid = p.relnamespace
    where n.nspname = 'public' and p.relkind = 'p'
  loop
    execute format('alter table public.%I enable row level security', r.relname);
    execute format('revoke all on public.%I from anon, authenticated', r.relname);
  end loop;
end;
$$;