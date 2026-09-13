-- ============================================================================
-- 177_partition_discovery_fix.sql
-- Corrective, forward-only. 176 indexed pg_partitioned_table.partattrs as
-- 1-based; it is an int2vector, which is 0-based, so partition_managed_tables()
-- matched nothing and every helper refused to operate.
-- ============================================================================
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
  join pg_attribute a on a.attrelid = c.oid and a.attnum = p.partattrs[0]
  where n.nspname = 'public'
    and c.relkind = 'p'
    and p.partstrat = 'r'
    and p.partnatts = 1
    and a.atttypid in ('timestamptz'::regtype, 'timestamp'::regtype)
  order by c.relname;
$$;

revoke all on function public.partition_managed_tables() from public;
revoke all on function public.partition_managed_tables() from anon;
revoke all on function public.partition_managed_tables() from authenticated;
grant execute on function public.partition_managed_tables() to service_role;