-- D.3 — normalized public-schema fingerprint.
--
-- Emits one row per schema object with a normalized, environment-independent
-- digest so a self-host database and the hosted Supabase database can be
-- compared without transferring or mutating any data.
--
-- Normalization rules (environment noise, not schema drift):
--   * object owners are reduced to a role CLASS (superuser/admin vs app role)
--   * OIDs, sizes, statistics and comments are excluded
--   * ACLs keep only anon / authenticated / service_role grants
WITH tab AS (
  SELECT c.oid, c.relname
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
),
cols AS (
  SELECT t.relname,
         string_agg(format('%s:%s:%s:%s',
                    a.attname,
                    format_type(a.atttypid, a.atttypmod),
                    coalesce(pg_get_expr(d.adbin, d.adrelid), '-'),
                    CASE WHEN a.attnotnull THEN 'NN' ELSE 'NULL' END),
                    E'\n' ORDER BY a.attname) AS body
  FROM tab t
  JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  GROUP BY t.relname
),
cons AS (
  SELECT t.relname,
         string_agg(format('%s:%s:%s', co.conname, co.contype, pg_get_constraintdef(co.oid)),
                    E'\n' ORDER BY co.conname) AS body
  FROM tab t JOIN pg_constraint co ON co.conrelid = t.oid
  GROUP BY t.relname
),
idx AS (
  SELECT t.relname,
         string_agg(regexp_replace(pg_get_indexdef(i.indexrelid), ' USING ', ' USING '),
                    E'\n' ORDER BY pg_get_indexdef(i.indexrelid)) AS body
  FROM tab t JOIN pg_index i ON i.indrelid = t.oid
  GROUP BY t.relname
),
trg AS (
  SELECT t.relname,
         string_agg(format('%s:%s', g.tgname, pg_get_triggerdef(g.oid)), E'\n' ORDER BY g.tgname) AS body
  FROM tab t JOIN pg_trigger g ON g.tgrelid = t.oid AND NOT g.tgisinternal
  GROUP BY t.relname
),
pol AS (
  SELECT t.relname,
         string_agg(format('%s:%s:%s:%s:%s:%s', p.policyname, p.permissive,
                    array_to_string(p.roles, ','), p.cmd,
                    coalesce(p.qual, '-'), coalesce(p.with_check, '-')),
                    E'\n' ORDER BY p.policyname) AS body
  FROM tab t JOIN pg_policies p ON p.schemaname = 'public' AND p.tablename = t.relname
  GROUP BY t.relname
),
tacl AS (
  SELECT t.relname,
         string_agg(format('%s=%s', r, array_to_string(ARRAY(
           SELECT priv FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) priv
           WHERE has_table_privilege(r, t.oid, priv)), ',')), E'\n' ORDER BY r) AS body
  FROM tab t, unnest(ARRAY['anon','authenticated','service_role']) r
  GROUP BY t.relname
)
SELECT 'table:' || t.relname AS object,
       md5(concat_ws('|',
         coalesce(cols.body, ''), coalesce(cons.body, ''), coalesce(idx.body, ''),
         coalesce(trg.body, ''), coalesce(pol.body, ''), coalesce(tacl.body, ''),
         (SELECT format('rls=%s,force=%s', c.relrowsecurity, c.relforcerowsecurity)
            FROM pg_class c WHERE c.oid = t.oid))) AS digest
FROM tab t
LEFT JOIN cols ON cols.relname = t.relname
LEFT JOIN cons ON cons.relname = t.relname
LEFT JOIN idx ON idx.relname = t.relname
LEFT JOIN trg ON trg.relname = t.relname
LEFT JOIN pol ON pol.relname = t.relname
LEFT JOIN tacl ON tacl.relname = t.relname

UNION ALL

SELECT 'function:' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
       md5(concat_ws('|',
         pg_get_function_result(p.oid),
         CASE WHEN p.prosecdef THEN 'DEFINER' ELSE 'INVOKER' END,
         coalesce(array_to_string(p.proconfig, ','), '-'),
         p.provolatile,
         CASE WHEN pg_has_role(p.proowner, 'pg_read_all_settings', 'USAGE')
                OR (SELECT rolsuper FROM pg_roles WHERE oid = p.proowner) THEN 'privileged'
              ELSE (SELECT rolname FROM pg_roles WHERE oid = p.proowner) END,
         (SELECT string_agg(format('%s=%s', r, has_function_privilege(r, p.oid, 'EXECUTE')), ',' ORDER BY r)
            FROM unnest(ARRAY['anon','authenticated','service_role']) r)))
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'

UNION ALL

SELECT 'enum:' || t.typname,
       md5(string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder))
FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = 'public'
GROUP BY t.typname

ORDER BY 1;
