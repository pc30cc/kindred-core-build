-- ============================================================
-- Phase 6-S5-R7.5.4 §4 — public schema is not customer-writable
-- ============================================================
--
-- Forward-only. No existing migration is edited and no function body changes.
--
-- PostgreSQL < 15 grants CREATE on schema `public` to PUBLIC by default, and a
-- hosted project may also have handed CREATE to the customer roles. A role that
-- can CREATE in `public` can shadow objects that SECURITY DEFINER functions
-- resolve through their `search_path`, so the privilege is revoked here.
--
-- USAGE is deliberately left intact: PostgREST needs it for anon/authenticated.
-- ============================================================

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

DO $lockdown$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', r);
      EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', r);
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA public TO service_role';
  END IF;
END
$lockdown$;
