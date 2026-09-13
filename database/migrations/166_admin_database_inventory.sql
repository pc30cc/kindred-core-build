-- 166_admin_database_inventory.sql
-- Exact structural + row-count inventory of the public schema, used by the
-- platform-admin "compare with self-hosted target" screen. The body must stay
-- byte-compatible with INVENTORY_SQL in
-- server/services/database/inventoryCompare.ts, which runs the same statement
-- against the target database.

create or replace function public.admin_database_inventory(_actor_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout to '180s'
as $fn$
declare
  result jsonb;
begin
  if not public.has_role(_actor_user_id, 'admin') then
    raise exception 'forbidden';
  end if;

  select jsonb_build_object(
    'tables', coalesce((
      select jsonb_object_agg(x.relname, jsonb_build_object('columns', x.cols, 'rows', x.nrows))
      from (
        select c.relname,
               (select coalesce(jsonb_object_agg(a.attname, format_type(a.atttypid, a.atttypmod)), '{}'::jsonb)
                  from pg_attribute a
                 where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped) as cols,
               coalesce(((xpath('/row/c/text()',
                 query_to_xml(format('select count(*) as c from public.%I', c.relname), false, true, '')))[1])::text::bigint, 0) as nrows
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r'
      ) x), '{}'::jsonb),
    'views', coalesce((select jsonb_agg(s.v order by s.v) from (
        select c.relname as v from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind in ('v','m')) s), '[]'::jsonb),
    'functions', coalesce((select jsonb_agg(s.v order by s.v) from (
        select p.oid::regprocedure::text as v from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public') s), '[]'::jsonb),
    'triggers', coalesce((select jsonb_agg(s.v order by s.v) from (
        select cl.relname || '.' || t.tgname as v
          from pg_trigger t join pg_class cl on cl.oid = t.tgrelid
          join pg_namespace n on n.oid = cl.relnamespace
         where n.nspname = 'public' and not t.tgisinternal) s), '[]'::jsonb),
    'policies', coalesce((select jsonb_agg(s.v order by s.v) from (
        select tablename || '.' || policyname as v from pg_policies where schemaname = 'public') s), '[]'::jsonb),
    'indexes', coalesce((select jsonb_agg(s.v order by s.v) from (
        select indexname as v from pg_indexes where schemaname = 'public') s), '[]'::jsonb),
    'sequences', coalesce((select jsonb_agg(s.v order by s.v) from (
        select c.relname as v from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'S') s), '[]'::jsonb),
    'enums', coalesce((select jsonb_object_agg(e.typname, e.labels) from (
        select tt.typname, jsonb_agg(en.enumlabel order by en.enumsortorder) as labels
          from pg_type tt join pg_namespace n on n.oid = tt.typnamespace
          join pg_enum en on en.enumtypid = tt.oid
         where n.nspname = 'public' group by tt.typname) e), '{}'::jsonb),
    'constraints', coalesce((select jsonb_agg(s.v order by s.v) from (
        select cl.relname || '.' || co.conname as v
          from pg_constraint co join pg_class cl on cl.oid = co.conrelid
          join pg_namespace n on n.oid = cl.relnamespace
         where n.nspname = 'public') s), '[]'::jsonb)
  ) into result;

  return result;
end;
$fn$;

revoke all on function public.admin_database_inventory(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function public.admin_database_inventory(uuid) to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.admin_database_inventory(uuid) to service_role;
  end if;
end $$;
