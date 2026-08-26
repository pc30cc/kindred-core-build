-- 029 — One-time backfill: legacy GoTrue email-verification state into
-- user_credentials.email_verified_at.
--
-- CORRECTS A FALSE CLAIM made in an earlier remediation report, which
-- asserted migrated users' verification state was "already present" in
-- user_credentials.email_verified_at. It was not: 024_user_credentials.sql
-- creates the column with no backfill, 026 only repoints foreign keys, and
-- server/services/auth/identity.ts (identityFromProfileRow) reads
-- email_verified_at with zero legacy fallback — a `user_credentials` row
-- doesn't even exist yet for most migrated users (it's created lazily, on
-- first password-setup/verify-email/admin action), so every migrated user
-- currently reads back as UNVERIFIED regardless of their real GoTrue state.
--
-- This is a MIGRATION-TIME-ONLY read of auth.users — acceptable per the
-- auth-migration plan because migration-time dependency on GoTrue's schema
-- (while it's still physically present in the same Postgres instance) is
-- categorically different from a RUNTIME application dependency on it. No
-- application code path added or changed by this file reads auth.users;
-- server/services/auth/identity.ts is untouched.
--
-- Behavior:
--   auth.users.email_confirmed_at (source, read once here)
--           ↓  matched by profiles.id == auth.users.id (026's own premise)
--   user_credentials.email_verified_at (destination)
--
--   - A profile with no user_credentials row yet AND a verified auth.users
--     match: a row is INSERTED with only email_verified_at populated
--     (password_hash stays NULL — password-setup-required is unaffected).
--   - A profile with no user_credentials row and an UNVERIFIED or missing
--     auth.users match: no row is inserted (matches today's behavior — a
--     missing row already reads back as unverified).
--   - An EXISTING user_credentials row: only touched if its
--     email_verified_at IS NULL. A non-null value (already verified through
--     the new first-party verify-email flow, admin action, or a previous
--     run of this migration) is NEVER overwritten — this migration cannot
--     downgrade a verified-via-first-party-flow account back to NULL, and
--     is safe to re-run.
--
-- Idempotent: safe to run multiple times; the second run touches zero rows.

-- ---------- 1. Backfill existing user_credentials rows still NULL ----------
UPDATE public.user_credentials uc
SET email_verified_at = au.email_confirmed_at,
    updated_at = now()
FROM auth.users au
WHERE au.id = uc.user_id
  AND uc.email_verified_at IS NULL
  AND au.email_confirmed_at IS NOT NULL;

-- ---------- 2. Create rows for verified legacy users with no row yet ------
INSERT INTO public.user_credentials (user_id, email_verified_at)
SELECT p.id, au.email_confirmed_at
FROM public.profiles p
JOIN auth.users au ON au.id = p.id
WHERE au.email_confirmed_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.user_credentials uc WHERE uc.user_id = p.id
  )
ON CONFLICT (user_id) DO NOTHING;

-- ---------- in-migration proof ----------
DO $verify$
DECLARE
  still_null_but_confirmed integer;
BEGIN
  -- Every profile whose auth.users match is confirmed must now have a
  -- non-null email_verified_at (either pre-existing or just backfilled).
  SELECT count(*) INTO still_null_but_confirmed
  FROM public.profiles p
  JOIN auth.users au ON au.id = p.id
  LEFT JOIN public.user_credentials uc ON uc.user_id = p.id
  WHERE au.email_confirmed_at IS NOT NULL
    AND (uc.email_verified_at IS NULL OR uc.user_id IS NULL);

  IF still_null_but_confirmed <> 0 THEN
    RAISE EXCEPTION '029: % profile(s) with a confirmed auth.users match still read back unverified after backfill', still_null_but_confirmed;
  END IF;

  RAISE NOTICE '029: legacy email-verification backfill complete';
END
$verify$;
