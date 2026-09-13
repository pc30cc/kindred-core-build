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
  return next 'CREATE SCHEMA IF NOT EXISTS extensions;';

  -- extensions (recreate in the same schema they live in on the source)
  for r in
    select e.extname, n.nspname
    from pg_extension e
    join pg_namespace n on n.oid = e.extnamespace
    where e.extname not in ('plpgsql', 'supabase_vault')
    order by e.extname
  loop
    return next format(
      'DO $do$ BEGIN CREATE EXTENSION IF NOT EXISTS %I WITH SCHEMA %I; EXCEPTION WHEN others THEN NULL; END $do$;',
      r.extname, r.nspname);
  end loop;

  -- enum types (skip anything owned by an extension)
  for r in
    select t.typname,
           string_agg(quote_literal(e.enumlabel), ', ' order by e.enumsortorder) as labels
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    join pg_enum e on e.enumtypid = t.oid
    where n.nspname = 'public'
      and not exists (select 1 from pg_depend d where d.objid = t.oid and d.deptype = 'e')
    group by t.typname
    order by t.typname
  loop
    return next format(
      'DO $do$ BEGIN CREATE TYPE public.%I AS ENUM (%s); EXCEPTION WHEN duplicate_object THEN NULL; END $do$;',
      r.typname, r.labels);
  end loop;

  -- domains
  for r in
    select t.typname, format_type(t.typbasetype, t.typtypmod) as base
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typtype = 'd'
      and not exists (select 1 from pg_depend d where d.objid = t.oid and d.deptype = 'e')
    order by t.typname
  loop
    return next format(
      'DO $do$ BEGIN CREATE DOMAIN public.%I AS %s; EXCEPTION WHEN duplicate_object THEN NULL; END $do$;',
      r.typname, r.base);
  end loop;

  -- ALL sequences (including serial/identity-owned ones: a plain CREATE TABLE
  -- with DEFAULT nextval(...) does not create them)
  for r in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'S'
      and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')
    order by 1
  loop
    return next format('CREATE SEQUENCE IF NOT EXISTS public.%I;', r.relname);
  end loop;

  -- functions, first pass: column defaults and generated expressions may call
  -- them, so they must exist before the tables (bodies referencing tables can
  -- fail here and are replayed again after the tables exist)
  for r in
    select pg_get_functiondef(p.oid) as def
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind in ('f', 'p')
      and p.proname not like 'admin_export_schema_ddl%'
      and p.prolang <> (select oid from pg_language where lanname = 'c')
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
    order by p.proname
  loop
    return next r.def || ';';
  end loop;

  -- tables + columns
  for r in
    select c.oid, c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')
    order by c.relname
  loop
    return next format('CREATE TABLE IF NOT EXISTS public.%I (%s);', r.relname, (
      select string_agg(
        format('%I %s%s%s',
          a.attname,
          format_type(a.atttypid, a.atttypmod),
          case
            when a.attgenerated = 's'
              then ' GENERATED ALWAYS AS (' || pg_get_expr(ad.adbin, ad.adrelid) || ') STORED'
            when a.attidentity in ('a','d')
              then ' GENERATED ' || case a.attidentity when 'a' then 'ALWAYS' else 'BY DEFAULT' end || ' AS IDENTITY'
            when ad.adbin is not null then ' DEFAULT ' || pg_get_expr(ad.adbin, ad.adrelid)
            else '' end,
          case when a.attnotnull and a.attgenerated = '' then ' NOT NULL' else '' end),
        ', ' order by a.attnum)
      from pg_attribute a
      left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
      where a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped
    ));
  end loop;

  -- missing columns for tables that already exist on the target
  for r in
    select cl.relname,
           a.attname,
           format_type(a.atttypid, a.atttypmod) as typ,
           case
             when a.attgenerated = 's'
               then ' GENERATED ALWAYS AS (' || pg_get_expr(ad.adbin, ad.adrelid) || ') STORED'
             when a.attidentity in ('a','d')
               then ' GENERATED ' || case a.attidentity when 'a' then 'ALWAYS' else 'BY DEFAULT' end || ' AS IDENTITY'
             when ad.adbin is not null then ' DEFAULT ' || pg_get_expr(ad.adbin, ad.adrelid)
             else '' end as extra
    from pg_class cl
    join pg_namespace n on n.oid = cl.relnamespace
    join pg_attribute a on a.attrelid = cl.oid and a.attnum > 0 and not a.attisdropped
    left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
    where n.nspname = 'public' and cl.relkind = 'r'
    order by cl.relname, a.attnum
  loop
    return next format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS %I %s%s;',
      r.relname, r.attname, r.typ, r.extra);
  end loop;

  -- link owned sequences back to their columns
  for r in
    select s.relname as seq, t.relname as tbl, a.attname as col
    from pg_class s
    join pg_namespace n on n.oid = s.relnamespace
    join pg_depend d on d.objid = s.oid and d.deptype in ('a','i')
    join pg_class t on t.oid = d.refobjid
    join pg_attribute a on a.attrelid = t.oid and a.attnum = d.refobjsubid
    where n.nspname = 'public' and s.relkind = 'S'
    order by s.relname
  loop
    return next format('ALTER SEQUENCE public.%I OWNED BY public.%I.%I;', r.seq, r.tbl, r.col);
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
    return next replace(r.def, 'CREATE UNIQUE INDEX ', 'CREATE UNIQUE INDEX IF NOT EXISTS ') || ';';
  end loop;

  -- functions, second pass (bodies that depend on tables/views)
  for r in
    select pg_get_functiondef(p.oid) as def
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind in ('f', 'p')
      and p.proname not like 'admin_export_schema_ddl%'
      and p.prolang <> (select oid from pg_language where lanname = 'c')
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
    order by p.proname
  loop
    return next r.def || ';';
  end loop;

  -- views (may reference functions, so they come after them)
  for r in
    select c.relname, pg_get_viewdef(c.oid, true) as def
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'v'
    order by c.relname
  loop
    return next format('CREATE OR REPLACE VIEW public.%I AS %s', r.relname, r.def);
  end loop;

  -- materialized views
  for r in
    select c.relname, pg_get_viewdef(c.oid, true) as def
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'm'
    order by c.relname
  loop
    return next format(
      'DO $do$ BEGIN CREATE MATERIALIZED VIEW public.%I AS %s; EXCEPTION WHEN duplicate_table THEN NULL; END $do$;',
      r.relname, r.def);
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
    select c.relname
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

  -- sequence + function grants
  for r in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'S'
    order by 1
  loop
    return next format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO authenticated, service_role;', r.relname);
  end loop;

  return;
end;
$$;

revoke all on function public.admin_export_schema_ddl(uuid) from public, anon, authenticated;
grant execute on function public.admin_export_schema_ddl(uuid) to service_role;