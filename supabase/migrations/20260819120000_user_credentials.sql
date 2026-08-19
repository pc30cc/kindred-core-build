-- 024 — First-party user credentials table (auth migration Phase 3/4).
--
-- Introduces the application-owned identity/credentials store that will
-- replace `auth.users.encrypted_password` as the root of password truth.
-- Deliberately a SEPARATE table from `profiles`, not new columns on it:
-- `profiles` already has client-facing RLS policies scoped to business data
-- (auth.uid() = id SELECT/UPDATE/INSERT) and a `password_hash` column living
-- there would depend on every one of those policies' column list staying
-- correctly restricted forever. This table instead follows the exact same
-- pattern already established for `auth_sessions`/`auth_reset_tokens`/
-- `auth_verify_tokens`: RLS enabled, zero rows visible to any client role,
-- service_role only.
--
-- `user_id` reuses the EXISTING `profiles.id` (which already equals the
-- existing `auth.users.id` UUID) rather than minting a new identifier — see
-- database/README.md's own "preserve existing UUIDs" convention already
-- used by 021 (contact_visitor_code) — so no business data (workspace
-- membership, audit history, ownership) needs remapping.
--
-- `password_hash IS NULL` is the single source of truth for "this user has
-- no first-party password yet" — covers both a brand-new first-party signup
-- mid-request (briefly, before the hash is written in the same transaction)
-- and an existing user migrated from Supabase Auth whose bcrypt hash was not
-- imported (see the auth-migration plan's Phase 5 decision: mark for
-- password setup rather than attempt a legacy-hash import). No separate
-- boolean is added to avoid two fields that could disagree.

CREATE TABLE IF NOT EXISTS public.user_credentials (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  password_hash text,
  password_algo text NOT NULL DEFAULT 'argon2id',
  password_set_at timestamptz,
  email_verified_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  failed_login_count integer NOT NULL DEFAULT 0,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_credentials ENABLE ROW LEVEL SECURITY;

-- Matches the auth_sessions/auth_reset_tokens/auth_verify_tokens convention:
-- table-level GRANT so PostgREST will even attempt the query, RLS denies
-- every row to every client role. service_role bypasses RLS by role
-- attribute (BYPASSRLS, see 000_selfhost_roles_bootstrap.sql) and needs no
-- policy of its own.
GRANT ALL ON public.user_credentials TO anon;
GRANT ALL ON public.user_credentials TO authenticated;
GRANT ALL ON public.user_credentials TO service_role;

DROP POLICY IF EXISTS "No direct access to user credentials" ON public.user_credentials;
CREATE POLICY "No direct access to user credentials"
  ON public.user_credentials FOR ALL TO anon, authenticated
  USING (false);

-- ---------- in-migration proof ----------
DO $verify$
DECLARE
  n integer;
BEGIN
  IF to_regclass('public.user_credentials') IS NULL THEN
    RAISE EXCEPTION '024: user_credentials table was not created';
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.user_credentials'::regclass) THEN
    RAISE EXCEPTION '024: RLS not enabled on user_credentials';
  END IF;

  SELECT count(*) INTO n FROM pg_policies
  WHERE tablename = 'user_credentials' AND policyname = 'No direct access to user credentials';
  IF n <> 1 THEN
    RAISE EXCEPTION '024: deny-all policy missing on user_credentials';
  END IF;

  IF has_table_privilege('anon', 'public.user_credentials', 'SELECT') IS NOT true THEN
    -- GRANT is present but RLS must still block every row; this asserts the
    -- grant itself landed (PostgREST needs it to even generate the query).
    RAISE EXCEPTION '024: anon lacks the expected table-level GRANT (RLS would then be unreachable/moot)';
  END IF;

  RAISE NOTICE '024: user_credentials created, RLS-locked to service_role only';
END
$verify$;
