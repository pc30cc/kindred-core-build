-- 111: chunked backup to avoid statement timeout
create or replace function public.admin_list_export_tables(
  _actor_user_id uuid,
  _scope text default 'all'
)
returns setof text
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.has_role(_actor_user_id, 'admin') then
    raise exception 'forbidden';
  end if;
  if _scope not in ('all', 'data', 'full') then
    raise exception 'invalid scope';
  end if;

  return query
    select c.relname::text
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and (_scope = 'all' or c.relname::text in (select public.admin_reset_target_tables(_scope)))
    order by 1;
end;
$$;

create or replace function public.admin_export_table(
  _actor_user_id uuid,
  _table text,
  _limit integer default 1000,
  _offset integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout to '120s'
as $$
declare
  _rows jsonb;
begin
  if not public.has_role(_actor_user_id, 'admin') then
    raise exception 'forbidden';
  end if;
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relname::text = _table
  ) then
    raise exception 'unknown table %', _table;
  end if;
  if _limit is null or _limit <= 0 or _limit > 5000 then
    _limit := 1000;
  end if;

  execute format(
    'select coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb) from (select * from public.%I order by 1 offset %s limit %s) t',
    _table, greatest(coalesce(_offset, 0), 0), _limit
  ) into _rows;

  return _rows;
end;
$$;

alter function public.admin_export_database(uuid, text) set statement_timeout to '300s';
alter function public.admin_restore_database(uuid, jsonb) set statement_timeout to '300s';
alter function public.admin_purge_database(uuid, text) set statement_timeout to '300s';

revoke all on function public.admin_list_export_tables(uuid, text) from public, anon, authenticated;
revoke all on function public.admin_export_table(uuid, text, integer, integer) from public, anon, authenticated;
grant execute on function public.admin_list_export_tables(uuid, text) to service_role;
grant execute on function public.admin_export_table(uuid, text, integer, integer) to service_role;