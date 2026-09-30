\pset format unaligned
\pset tuples_only on
\pset fieldsep '\t'
select 'type', t.typname, coalesce((select string_agg(enumlabel, ',' order by enumsortorder) from pg_enum where enumtypid=t.oid), t.typtype::text)
  from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname='public' and t.typtype in ('e','c') and not exists (select 1 from pg_class c where c.reltype=t.oid and c.relkind<>'c');
select 'rel', c.relname, c.relkind::text || case when c.relrowsecurity then ' rls' else '' end from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p','v','m','S');
select 'col', c.relname||'.'||a.attname, format_type(a.atttypid,a.atttypmod)||case when a.attnotnull then ' NOT NULL' else '' end||coalesce(' DEFAULT '||pg_get_expr(d.adbin,d.adrelid),'')||case when a.attidentity<>'' then ' IDENTITY '||a.attidentity::text else '' end||case when a.attgenerated<>'' then ' GENERATED' else '' end
  from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
  where n.nspname='public' and c.relkind in ('r','p','v','m') and a.attnum>0 and not a.attisdropped;
select 'con', c.relname||'.'||co.conname, pg_get_constraintdef(co.oid) from pg_constraint co join pg_class c on c.oid=co.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public';
select 'idx', i.relname, pg_get_indexdef(i.oid) from pg_index x join pg_class i on i.oid=x.indexrelid join pg_namespace n on n.oid=i.relnamespace where n.nspname='public' and not exists (select 1 from pg_constraint co where co.conindid=i.oid and co.contype in ('p','u','x'));
select 'fn', p.proname||'('||pg_get_function_identity_arguments(p.oid)||')', md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind in ('f','p') and not exists (select 1 from pg_depend d where d.objid=p.oid and d.deptype='e');
select 'trg', c.relname||'.'||t.tgname, pg_get_triggerdef(t.oid) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal;
select 'pol', c.relname||'.'||p.polname, p.polcmd::text||' '||p.polpermissive::text||' '||array_to_string(array(select coalesce(r.rolname,'public') from unnest(p.polroles) ro left join pg_roles r on r.oid=ro order by 1),',')||' USING '||coalesce(pg_get_expr(p.polqual,p.polrelid),'-')||' CHECK '||coalesce(pg_get_expr(p.polwithcheck,p.polrelid),'-') from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public';
select 'relacl', c.relname, coalesce(array_to_string(array(select x from unnest(c.relacl) x order by x::text),' '),'default') from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p','v','m','S');
select 'fnacl', p.proname||'('||pg_get_function_identity_arguments(p.oid)||')', coalesce(array_to_string(array(select x from unnest(p.proacl) x order by x::text),' '),'default') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and not exists (select 1 from pg_depend d where d.objid=p.oid and d.deptype='e');
select 'pub', tablename, pubname from pg_publication_tables where schemaname='public';
select 'ext', extname, extversion from pg_extension;
