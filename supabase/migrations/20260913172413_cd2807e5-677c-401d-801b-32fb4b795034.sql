create or replace function public.admin_export_function_ddl(_actor_user_id uuid, _name text)
returns setof text
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not public.has_role(_actor_user_id, 'admin') then
    raise exception 'forbidden';
  end if;

  return query
    select pg_get_functiondef(p.oid) || ';'
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = _name and p.prokind in ('f','p');
end;
$fn$;

revoke all on function public.admin_export_function_ddl(uuid, text) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.admin_export_function_ddl(uuid, text) to service_role;
  end if;
end $$;