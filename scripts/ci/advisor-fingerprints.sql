-- Workspace Invitations v5.1 — Section H
--
-- Emits ONE stable advisor fingerprint per line (psql -At) so CI can diff the
-- live database against `security/advisor-baseline.json`. Read-only.
--
-- It also hard-fails, inside the same run, on the two invitation-specific ACL
-- invariants that must never regress:
--   * no `wi_*` / invitation RPC executable by PUBLIC, anon or authenticated
--   * no invitation table granted to anon or authenticated

\set ON_ERROR_STOP on

DO $$
DECLARE
  leaked text;
BEGIN
  SELECT string_agg(format('%s(%s) -> %s', p.proname, pg_get_function_identity_arguments(p.oid), r.rolname), ', ')
    INTO leaked
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace,
         (VALUES ('anon'), ('authenticated'), ('public')) AS r(rolname)
   WHERE n.nspname = 'public'
     AND (p.proname LIKE 'wi\_%' OR p.proname LIKE '%invitation_job%' OR p.proname LIKE '%invitation_otp%')
     AND has_function_privilege(r.rolname, p.oid, 'execute');
  IF leaked IS NOT NULL THEN
    RAISE EXCEPTION 'PRIVILEGED INVITATION RPC EXECUTABLE BY UNTRUSTED ROLE: %', leaked;
  END IF;
END $$;

DO $$
DECLARE
  leaked text;
BEGIN
  SELECT string_agg(format('%s -> %s', c.relname, r.rolname), ', ')
    INTO leaked
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace,
         (VALUES ('anon'), ('authenticated')) AS r(rolname)
   WHERE n.nspname = 'public'
     AND c.relkind = 'r'
     AND c.relname LIKE 'workspace\_invitation%'
     AND has_table_privilege(r.rolname, c.oid, 'SELECT, INSERT, UPDATE, DELETE');
  IF leaked IS NOT NULL THEN
    RAISE EXCEPTION 'INVITATION TABLE REACHABLE BY UNTRUSTED ROLE: %', leaked;
  END IF;
END $$;

SELECT fingerprint FROM (
  SELECT '0008_rls_enabled_no_policy:public.' || c.relname AS fingerprint
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
     AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)
  UNION ALL
  SELECT '0014_extension_in_public:' || e.extname
    FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
   WHERE n.nspname = 'public'
  UNION ALL
  SELECT CASE r.rolname
           WHEN 'anon' THEN '0028_anon_security_definer_function_executable:public.'
           ELSE '0029_authenticated_security_definer_function_executable:public.'
         END || p.proname
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
         (VALUES ('anon'), ('authenticated')) AS r(rolname)
   WHERE n.nspname = 'public' AND p.prosecdef
     AND has_function_privilege(r.rolname, p.oid, 'execute')
) s
GROUP BY fingerprint
ORDER BY fingerprint;
