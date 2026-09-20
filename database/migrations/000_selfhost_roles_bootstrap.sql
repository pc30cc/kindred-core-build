-- ============================================================
-- Phase 6-S5-R7.4 §10 — SELF-HOST ROLE BOOTSTRAP
-- ============================================================
--
-- Why this exists
-- ---------------
-- Migration 011 (and 010 before it) shipped to the hosted Supabase project,
-- so neither may be rewritten. Both — like the RLS policies in 001 — reference
-- the Supabase-managed roles `anon`, `authenticated` and `service_role`.
-- A plain PostgreSQL cluster has none of them, so the chain fails on the first
-- `GRANT ... TO service_role`.
--
-- This bootstrap creates those roles when (and only when) they are missing. It
-- is a no-op on hosted Supabase, where the roles already exist and are owned
-- by the platform.
--
-- Properties
-- ----------
--   * Idempotent — safe to re-run; never ALTERs an existing role.
--   * Least-privileged — NOLOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE,
--     NOINHERIT for the customer-facing roles. No blanket schema grants: every
--     privilege still has to be handed out explicitly by a later migration.
--   * Ordered first — the `000_` prefix makes every filename-ordered runner
--     (see database/README.md) apply it before 001.
-- ============================================================

DO $bootstrap$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;

  -- `service_role` is the trusted backend identity. It still gets no implicit
  -- privileges here; migrations grant exactly what it needs.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS;
  END IF;
END
$bootstrap$;

-- ============================================================
-- The image's blanket grants, taken back
-- ============================================================
--
-- The property stated above — "No blanket schema grants: every privilege
-- still has to be handed out explicitly by a later migration" — is true of
-- this file and was not true of the database it runs on.
--
-- supabase/postgres, the image `database/README.md` and the self-host CI job
-- both name, ships:
--
--     ALTER DEFAULT PRIVILEGES IN SCHEMA public
--       GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role
--
-- for the `postgres` and `supabase_admin` grantors alike. Default privileges
-- attach at CREATE time, so every table, sequence and function this chain
-- goes on to create arrives with ALL already granted to all three roles —
-- including `anon`, the role an unauthenticated browser reaches PostgREST
-- with. RLS is then the only thing between the public internet and the row.
--
-- The chain says otherwise in its own voice, and stopped rather than build
-- on a false premise: 043 refused with "service_role unexpectedly has INSERT
-- on public.accounts", 060 with "authenticated unexpectedly has INSERT on
-- public.kb_article_feedback". Both were right. Nine later migrations hand
-- `anon` and `authenticated` exactly the privileges they are meant to have,
-- so nothing here depends on the implicit set.
--
-- Revoking the defaults is what makes the rest of the chain's model real. It
-- is scoped to schema `public` and to these three roles: `postgres`,
-- `supabase_admin` and the Auth roles keep everything they have, so the
-- platform's own machinery is untouched.
--
-- No-op on a plain PostgreSQL cluster, which has no such defaults, and
-- no-op on a second run.
DO $revoke_implicit$
DECLARE
  grantor text;
  present text[];
BEGIN
  SELECT array_agg(rolname::text)
    INTO present
    FROM pg_roles
   WHERE rolname IN ('anon', 'authenticated', 'service_role');

  IF present IS NULL THEN
    RETURN;
  END IF;

  -- Whoever the image set defaults up as. Reading pg_default_acl rather than
  -- naming roles means a future image that uses a third grantor is covered
  -- without this file being touched again.
  FOR grantor IN
    SELECT DISTINCT pg_get_userbyid(defaclrole)
      FROM pg_default_acl
     WHERE defaclnamespace = 'public'::regnamespace
  LOOP
    BEGIN
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public '
        'REVOKE ALL ON TABLES FROM %s', grantor, array_to_string(present, ', '));
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public '
        'REVOKE ALL ON SEQUENCES FROM %s', grantor, array_to_string(present, ', '));
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public '
        'REVOKE ALL ON FUNCTIONS FROM %s', grantor, array_to_string(present, ', '));
      RAISE NOTICE '000: revoked default public privileges granted by %', grantor;
    EXCEPTION
      -- Not a member of that grantor. Say so rather than abort: the grantor
      -- that matters is the one the migrations themselves run as, and a
      -- privilege we do not hold is not one we can be handing out.
      WHEN insufficient_privilege THEN
        RAISE NOTICE '000: cannot alter default privileges for % — skipped', grantor;
    END;
  END LOOP;
END
$revoke_implicit$;
