-- ============================================================
-- 000a — the `auth` schema the chain names, on a plain PostgreSQL
-- ============================================================
--
-- Why this exists
-- ---------------
-- The application does not use Supabase Auth. Identity is first-party
-- (public.profiles + public.user_credentials + public.auth_sessions, issued by
-- the Express server), and no runtime path reads or writes `auth.*`.
--
-- The migration chain still NAMES the schema, because it was written against a
-- Supabase-shaped database and is forward-only:
--   * 001-003 declare FKs to auth.users(id) and a trigger on it (026 repoints
--     every FK to public.profiles and drops the trigger; none survive the
--     chain);
--   * 029 reads auth.users once, as a migration-time backfill;
--   * ~400 RLS policies and a handful of functions call auth.uid() — dormant
--     for the server, which connects as service_role (BYPASSRLS);
--   * 019 defines two RPCs over auth.sessions that nothing calls.
--
-- On stock PostgreSQL none of that exists, so 001 stopped at its first line
-- with `schema "auth" does not exist` unless GoTrue had migrated the database
-- first. This file supplies exactly what the chain names, with Supabase's own
-- semantics, so the chain applies on `postgres:16` with nothing else running.
--
-- Properties
-- ----------
--   * No-op on Supabase (hosted or self-hosted): every object is created only
--     when it is absent, so GoTrue's own schema, owned by
--     supabase_auth_admin, is never touched — not even CREATE OR REPLACE.
--   * auth.uid() / auth.role() / auth.jwt() read the same settings Supabase's
--     do (request.jwt.claim.* / request.jwt.claims), so a function body that
--     calls them behaves identically on both: NULL for the server's
--     connection, which carries no end-user JWT on either.
--   * auth.users / auth.sessions carry the columns the chain reads and no
--     rows. They are never an identity source.
--   * Self-contained: it does not depend on 000 having run first (a
--     locale-aware `sort` may order `000_` and `000a_` either way), so every
--     grant is guarded by the role existing.
--   * Idempotent; safe to re-run.
-- ============================================================

-- Checked by hand rather than CREATE SCHEMA IF NOT EXISTS: that form still
-- demands CREATE on the database before it notices the schema is there.
-- gen_random_uuid() is built in from PostgreSQL 13, so no extension is needed.
DO $auth_compat$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth') THEN
    CREATE SCHEMA auth;
  END IF;

  IF to_regclass('auth.users') IS NULL THEN
    CREATE TABLE auth.users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      aud varchar(255),
      role varchar(255),
      email varchar(255),
      encrypted_password varchar(255),
      email_confirmed_at timestamptz,
      confirmed_at timestamptz,
      last_sign_in_at timestamptz,
      phone text,
      raw_app_meta_data jsonb DEFAULT '{}'::jsonb,
      raw_user_meta_data jsonb DEFAULT '{}'::jsonb,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
    COMMENT ON TABLE auth.users IS
      'Compatibility stub (000a). Empty on purpose: identity lives in public.profiles.';
  END IF;

  IF to_regclass('auth.sessions') IS NULL THEN
    CREATE TABLE auth.sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      refreshed_at timestamp,
      not_after timestamptz,
      user_agent text,
      ip inet
    );
    COMMENT ON TABLE auth.sessions IS
      'Compatibility stub (000a). Sessions live in public.auth_sessions.';
  END IF;

  -- Supabase's definitions, verbatim in behaviour: the claim set PostgREST
  -- (or any caller) put in the session, else NULL.
  IF to_regprocedure('auth.uid()') IS NULL THEN
    CREATE FUNCTION auth.uid() RETURNS uuid
      LANGUAGE sql STABLE
      AS $fn$
        SELECT nullif(
          coalesce(
            current_setting('request.jwt.claim.sub', true),
            (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
          ),
          ''
        )::uuid
      $fn$;
  END IF;

  IF to_regprocedure('auth.role()') IS NULL THEN
    CREATE FUNCTION auth.role() RETURNS text
      LANGUAGE sql STABLE
      AS $fn$
        SELECT nullif(
          coalesce(
            current_setting('request.jwt.claim.role', true),
            (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
          ),
          ''
        )::text
      $fn$;
  END IF;

  IF to_regprocedure('auth.email()') IS NULL THEN
    CREATE FUNCTION auth.email() RETURNS text
      LANGUAGE sql STABLE
      AS $fn$
        SELECT nullif(
          coalesce(
            current_setting('request.jwt.claim.email', true),
            (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
          ),
          ''
        )::text
      $fn$;
  END IF;

  IF to_regprocedure('auth.jwt()') IS NULL THEN
    CREATE FUNCTION auth.jwt() RETURNS jsonb
      LANGUAGE sql STABLE
      AS $fn$
        SELECT coalesce(
          nullif(current_setting('request.jwt.claim', true), ''),
          nullif(current_setting('request.jwt.claims', true), '')
        )::jsonb
      $fn$;
  END IF;
END
$auth_compat$;

-- RLS policies call auth.uid() as whichever role evaluates them. On Supabase
-- the customer roles already hold USAGE on `auth`; grant the same here, and
-- only to roles that exist (see "Self-contained" above).
DO $auth_compat_grants$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT USAGE ON SCHEMA auth TO %I', r);
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION auth.uid(), auth.role(), auth.email(), auth.jwt() TO %I', r);
    END IF;
  END LOOP;
EXCEPTION
  -- On Supabase the schema belongs to supabase_auth_admin and these grants
  -- are already in place; a migration role that may not re-grant them has
  -- nothing to add.
  WHEN insufficient_privilege THEN
    RAISE NOTICE '000a: auth grants left as the platform set them';
END
$auth_compat_grants$;
