create or replace function public.admin_export_column_meta(_actor_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  result jsonb;
begin
  if not public.has_role(_actor_user_id, 'admin') then
    raise exception 'forbidden';
  end if;

  select coalesce(jsonb_object_agg(t.relname, t.cols), '{}'::jsonb) into result
  from (
    select c.relname,
           coalesce((
             select jsonb_agg(jsonb_build_object(
                      'name', a.attname,
                      'type', format_type(a.atttypid, a.atttypmod),
                      'generated', (a.attgenerated <> '' or a.attidentity = 'a')
                    ) order by a.attnum)
               from pg_attribute a
              where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
           ), '[]'::jsonb) as cols
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
  ) t;

  return result;
end;
$fn$;

revoke all on function public.admin_export_column_meta(uuid) from public, anon;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function public.admin_export_column_meta(uuid) to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.admin_export_column_meta(uuid) to service_role;
  end if;
end $$;