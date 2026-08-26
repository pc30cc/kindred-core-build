-- DB-level unique identity: no two first-party profiles may share the same
-- normalized (case-insensitive) email address.
--
-- profiles.email has never carried a uniqueness constraint in either
-- migration chain (the hosted baseline defines it as bare `TEXT NOT NULL`,
-- and no later migration adds one). server/routes/auth.ts's signup handler
-- already ASSUMED one — its comment on the profiles-insert error path
-- reads "Most likely a unique-email race with a concurrent signup for the
-- same address" — but that assumption was never backed by the schema: two
-- concurrent signups for the same (or same-but-differently-cased) email
-- could both pass the pre-check (findIdentityByEmail returning null for
-- both) and both INSERT successfully, leaving two profiles rows for one
-- email address. Beyond being a duplicate-identity bug, this actively
-- breaks every future login for that address: findIdentityByEmail's
-- .maybeSingle() throws once more than one row matches.
--
-- Preflight: refuse to add the constraint if any duplicate normalized-email
-- group already exists — this migration must never silently delete or
-- merge real user data. If it fails here, an operator must resolve the
-- conflict manually (merge the accounts or rename one) and re-run.
--
-- Signup (server/routes/auth.ts) and login lookup (findIdentityByEmail,
-- server/services/auth/identity.ts) already normalize with
-- `.trim().toLowerCase()` before every INSERT/SELECT, so this index is
-- consistent with, not a change to, how the application already reads and
-- writes profiles.email.
--
-- Self-host counterpart: database/migrations/032_profiles_email_unique.sql

DO $preflight$
DECLARE
  dupe_count integer;
  dupe_sample text;
BEGIN
  SELECT count(*) INTO dupe_count
  FROM (
    SELECT lower(email) AS norm_email
    FROM public.profiles
    WHERE email IS NOT NULL
    GROUP BY lower(email)
    HAVING count(*) > 1
  ) dupes;

  IF dupe_count > 0 THEN
    SELECT string_agg(norm_email, ', ') INTO dupe_sample
    FROM (
      SELECT lower(email) AS norm_email
      FROM public.profiles
      WHERE email IS NOT NULL
      GROUP BY lower(email)
      HAVING count(*) > 1
      ORDER BY norm_email
      LIMIT 20
    ) sample;

    RAISE EXCEPTION 'refusing to add unique(lower(profiles.email)) — % duplicate normalized-email group(s) already exist and must be resolved manually first (merge the duplicate accounts, or rename one email) before re-running this migration. Sample: %', dupe_count, dupe_sample;
  END IF;
END
$preflight$;

CREATE UNIQUE INDEX IF NOT EXISTS profiles_email_normalized_unique_idx
  ON public.profiles (lower(email));

-- ---------- in-migration proof ----------
DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'profiles' AND indexname = 'profiles_email_normalized_unique_idx'
  ) THEN
    RAISE EXCEPTION 'unique index on lower(profiles.email) was not created';
  END IF;
  RAISE NOTICE 'profiles.email is now unique case-insensitively';
END
$verify$;
