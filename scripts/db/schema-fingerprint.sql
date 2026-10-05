-- One row per schema object of `public` (plus the auth helpers the chain
-- calls) and a hash of its normalized definition: what the application
-- depends on, not just table and column names. Read-only.
--
-- Normalization removes only what legitimately differs between a Supabase
-- project and a database built from database/migrations:
--   * the schema of extension objects (`extensions.` on Supabase, `public.`
--     elsewhere) and redundant `public.` qualification;
--   * whitespace, comments inside function bodies, and constraint and index
--     NAMES (keyed by definition instead);
--   * privileges of the customer roles anon/authenticated (only the
--     service_role's rights are compared — see function_acl and grant).
--
--   psql "$URL" -qAtX -f scripts/db/schema-fingerprint.sql
-- prints  kind <TAB> group <TAB> key <TAB> md5(definition)
-- scripts/db/schema-diff.sh compares two databases with it.
WITH
ext AS (SELECT objid FROM pg_depend WHERE deptype = 'e'),
fp(kind, grp, key, def) AS (
  -- functions: signature → security, volatility, settings, language, result, body
  SELECT 'function', p.proname::text, p.oid::regprocedure::text,
         concat_ws(' | ', CASE WHEN p.prosecdef THEN 'definer' ELSE 'invoker' END, p.provolatile::text,
                   p.prokind::text, l.lanname::text, pg_get_function_result(p.oid),
                   (SELECT string_agg(c, ',' ORDER BY c) FROM unnest(p.proconfig) c),
                   regexp_replace(regexp_replace(p.prosrc, '/\*.*?\*/', '', 'g'), '--[^\n]*', '', 'g'))
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
   WHERE n.nspname = 'public' AND p.oid NOT IN (SELECT objid FROM ext)
  UNION ALL
  -- whether the role the application runs as may EXECUTE it. Customer-role
  -- (anon/authenticated) privileges are left out on purpose: Supabase grants
  -- them by default and 000 revokes them, and nothing in database-only
  -- operation acts as those roles.
  SELECT 'function_acl', p.proname::text, p.oid::regprocedure::text,
         has_function_privilege('service_role', p.oid, 'EXECUTE')::text
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.oid NOT IN (SELECT objid FROM ext)
  UNION ALL
  SELECT 'auth_function', p.proname::text, p.oid::regprocedure::text, pg_get_function_result(p.oid)
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'auth' AND p.proname IN ('uid', 'role', 'email', 'jwt')
  UNION ALL
  SELECT 'table', c.relname::text, c.relname::text,
         concat_ws(' | ', c.relkind::text, 'rls=' || c.relrowsecurity, 'force=' || c.relforcerowsecurity,
                   pg_get_partkeydef(c.oid))
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition AND c.oid NOT IN (SELECT objid FROM ext)
  UNION ALL
  SELECT 'column', c.relname::text, c.relname || '.' || a.attname,
         concat_ws(' | ', format_type(a.atttypid, a.atttypmod), CASE WHEN a.attnotnull THEN 'not null' END,
                   pg_get_expr(d.adbin, d.adrelid), nullif(a.attidentity::text, ''), nullif(a.attgenerated::text, ''))
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm') AND NOT c.relispartition AND c.oid NOT IN (SELECT objid FROM ext)
  UNION ALL
  SELECT 'constraint', cl.relname::text, cl.relname || ' ' || co.contype::text || ' ' || pg_get_constraintdef(co.oid), ''
    FROM pg_constraint co JOIN pg_class cl ON cl.oid = co.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
   WHERE n.nspname = 'public' AND NOT cl.relispartition
  UNION ALL
  SELECT 'index', c.relname::text, regexp_replace(pg_get_indexdef(i.indexrelid), '^CREATE (UNIQUE )?INDEX \S+ ON ', 'CREATE \1INDEX ON '), ''
    FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND NOT c.relispartition AND c.relkind IN ('r', 'p', 'm')
  UNION ALL
  SELECT 'trigger', c.relname::text, c.relname || '.' || t.tgname,
         concat_ws(' | ', t.tgenabled::text, regexp_replace(pg_get_triggerdef(t.oid), '^CREATE (CONSTRAINT )?TRIGGER \S+ ', ''))
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND NOT t.tgisinternal AND NOT c.relispartition
  UNION ALL
  SELECT 'view', c.relname::text, c.relname::text, c.relkind::text || ' | ' || pg_get_viewdef(c.oid)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm') AND c.oid NOT IN (SELECT objid FROM ext)
  UNION ALL
  SELECT 'policy', p.tablename::text, p.tablename || '.' || p.policyname,
         concat_ws(' | ', p.permissive, p.cmd, array_to_string(ARRAY(SELECT unnest(p.roles) ORDER BY 1), ','), p.qual, p.with_check)
    FROM pg_policies p WHERE p.schemaname = 'public'
  UNION ALL
  -- table privileges of the role the application runs as
  SELECT 'grant', c.relname::text, c.relname::text,
         array_to_string(ARRAY(SELECT pr FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) pr
                               WHERE has_table_privilege('service_role', c.oid, pr) ORDER BY 1), ',')
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S') AND NOT c.relispartition
     AND c.oid NOT IN (SELECT objid FROM ext)
  UNION ALL
  SELECT 'type', t.typname::text, t.typname::text,
         t.typtype::text || ' | ' || coalesce((SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid), '')
    FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
   WHERE n.nspname = 'public' AND t.typtype IN ('e', 'd') AND t.oid NOT IN (SELECT objid FROM ext)
  UNION ALL
  SELECT 'sequence', c.relname::text, c.relname::text, ''
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'S' AND c.oid NOT IN (SELECT objid FROM ext)
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype IN ('a', 'i'))
  UNION ALL
  SELECT 'extension', e.extname::text, e.extname::text, '' FROM pg_extension e WHERE e.extname <> 'plpgsql'
),
normalized AS (
  SELECT kind, grp,
         regexp_replace(regexp_replace(key, '\m(extensions|public)\.', '', 'g'), '\s+', ' ', 'g') AS key,
         md5(regexp_replace(regexp_replace(coalesce(def, ''), '\m(extensions|public)\.', '', 'g'), '\s+', ' ', 'g')) AS h
    FROM fp
)
SELECT kind || E'\t' || grp || E'\t' || key || E'\t' || h FROM normalized ORDER BY kind, grp, key, h;
