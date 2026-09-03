-- 112_admin_schema_dump.sql
-- Full-database (schema + data) backup support for the platform admin panel.
-- admin_export_schema_ddl() reconstructs public-schema DDL from pg_catalog;
-- admin_apply_schema() replays it statement-by-statement on restore.

create or replace function public.admin_export_schema_ddl(_actor_user_id uuid)
returns setof text
language plpgsql
security definer
set search_path = public
set statement_timeout to '120s'
as $$
declare
  r record;
begin
  if not public.has_role(_actor_user_id, 'admin') then
    raise exception 'forbidden';
  end if;

  return next 'CREATE SCHEMA IF NOT EXISTS public;';

  -- enum types
  for r in
    select t.typname,
           string_agg(quote_literal(e.enumlabel), ', ' order by e.enumsortorder) as labels
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    join pg_enum e on e.enumtypid = t.oid
    where n.nspname = 'public'
    group by t.typname
    order by t.typname
  loop
    return next format(
      'DO $do$ BEGIN CREATE TYPE public.%I AS ENUM (%s); EXCEPTION WHEN duplicate_object THEN NULL; END $do$;',
      r.typname, r.labels);
  end loop;

  -- standalone sequences (identity/serial-owned ones are recreated with the table)
  for r in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'S'
      and not exists (
        select 1 from pg_depend d
        where d.objid = c.oid and d.deptype in ('a', 'i')
      )
    order by 1
  loop
    return next format('CREATE SEQUENCE IF NOT EXISTS public.%I;', r.relname);
  end loop;

  -- tables + columns
  for r in
    select c.oid, c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
    order by c.relname
  loop
    return next format('CREATE TABLE IF NOT EXISTS public.%I (%s);', r.relname, (
      select string_agg(
        format('%I %s%s%s',
          a.attname,
          format_type(a.atttypid, a.atttypmod),
          case when a.attidentity in ('a','d')
               then ' GENERATED ' || case a.attidentity when 'a' then 'ALWAYS' else 'BY DEFAULT' end || ' AS IDENTITY'
               when ad.adbin is not null then ' DEFAULT ' || pg_get_expr(ad.adbin, ad.adrelid)
               else '' end,
          case when a.attnotnull then ' NOT NULL' else '' end),
        ', ' order by a.attnum)
      from pg_attribute a
      left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
      where a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped
    ));
  end loop;

  -- constraints (pk / unique / fk / check), added after all tables exist
  for r in
    select c.conname, cl.relname, pg_get_constraintdef(c.oid) as def
    from pg_constraint c
    join pg_class cl on cl.oid = c.conrelid
    join pg_namespace n on n.oid = cl.relnamespace
    where n.nspname = 'public' and cl.relkind = 'r'
    order by case c.contype when 'p' then 0 when 'u' then 1 when 'c' then 2 else 3 end, cl.relname, c.conname
  loop
    return next format(
      'DO $do$ BEGIN ALTER TABLE public.%I ADD CONSTRAINT %I %s; EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL; END $do$;',
      r.relname, r.conname, r.def);
  end loop;

  -- indexes not backing a constraint
  for r in
    select replace(pg_get_indexdef(i.indexrelid), 'CREATE INDEX ', 'CREATE INDEX IF NOT EXISTS ') as def
    from pg_index i
    join pg_class ic on ic.oid = i.indexrelid
    join pg_class tc on tc.oid = i.indrelid
    join pg_namespace n on n.oid = tc.relnamespace
    where n.nspname = 'public' and tc.relkind = 'r'
      and not exists (select 1 from pg_constraint c where c.conindid = i.indexrelid)
    order by ic.relname
  loop
    return next r.def || ';';
  end loop;

  -- views
  for r in
    select c.relname, pg_get_viewdef(c.oid, true) as def
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'v'
    order by c.relname
  loop
    return next format('CREATE OR REPLACE VIEW public.%I AS %s', r.relname, r.def);
  end loop;

  -- functions
  for r in
    select pg_get_functiondef(p.oid) as def
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind in ('f', 'p')
      and p.proname not like 'admin_export_schema_ddl%'
    order by p.proname
  loop
    return next r.def || ';';
  end loop;

  -- triggers
  for r in
    select pg_get_triggerdef(t.oid) as def, t.tgname, cl.relname
    from pg_trigger t
    join pg_class cl on cl.oid = t.tgrelid
    join pg_namespace n on n.oid = cl.relnamespace
    where n.nspname = 'public' and not t.tgisinternal
    order by cl.relname, t.tgname
  loop
    return next format('DROP TRIGGER IF EXISTS %I ON public.%I;', r.tgname, r.relname);
    return next r.def || ';';
  end loop;

  -- row level security + policies
  for r in
    select c.relname, c.relrowsecurity
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
    order by c.relname
  loop
    return next format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', r.relname);
  end loop;

  for r in
    select p.policyname, p.tablename, p.permissive, p.roles, p.cmd, p.qual, p.with_check
    from pg_policies p
    where p.schemaname = 'public'
    order by p.tablename, p.policyname
  loop
    return next format('DROP POLICY IF EXISTS %I ON public.%I;', r.policyname, r.tablename);
    return next format(
      'CREATE POLICY %I ON public.%I AS %s FOR %s TO %s%s%s;',
      r.policyname, r.tablename,
      case when r.permissive = 'PERMISSIVE' then 'PERMISSIVE' else 'RESTRICTIVE' end,
      r.cmd,
      array_to_string(r.roles, ', '),
      case when r.qual is not null then ' USING (' || r.qual || ')' else '' end,
      case when r.with_check is not null then ' WITH CHECK (' || r.with_check || ')' else '' end);
  end loop;

  -- table grants
  for r in
    select distinct g.grantee, g.privilege_type, g.table_name
    from information_schema.role_table_grants g
    where g.table_schema = 'public'
      and g.grantee in ('anon', 'authenticated', 'service_role')
    order by g.table_name, g.grantee, g.privilege_type
  loop
    return next format('GRANT %s ON public.%I TO %I;', r.privilege_type, r.table_name, r.grantee);
  end loop;

  return;
end;
$$;

create or replace function public.admin_apply_schema(
  _actor_user_id uuid,
  _statements jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout to '300s'
as $$
declare
  _stmt text;
  _applied integer := 0;
  _failed jsonb := '[]'::jsonb;
begin
  if not public.has_role(_actor_user_id, 'admin') then
    raise exception 'forbidden';
  end if;
  if _statements is null or jsonb_typeof(_statements) <> 'array' then
    raise exception 'statements must be a json array';
  end if;

  for _stmt in select value::text from jsonb_array_elements_text(_statements) as value
  loop
    begin
      execute _stmt;
      _applied := _applied + 1;
    exception when others then
      _failed := _failed || jsonb_build_object(
        'statement', left(_stmt, 400),
        'error', sqlerrm
      );
    end;
  end loop;

  return jsonb_build_object('applied', _applied, 'failed_count', jsonb_array_length(_failed), 'failed', _failed);
end;
$$;

revoke all on function public.admin_export_schema_ddl(uuid) from public, anon, authenticated;
revoke all on function public.admin_apply_schema(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.admin_export_schema_ddl(uuid) to service_role;
grant execute on function public.admin_apply_schema(uuid, jsonb) to service_role;