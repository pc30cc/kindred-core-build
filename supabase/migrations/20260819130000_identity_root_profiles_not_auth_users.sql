-- 026 — Auth migration Phase 24: repoint every FK that currently targets
-- `auth.users(id)` to `public.profiles(id)` instead, then drop
-- `profiles.id`'s own FK to `auth.users(id)` — making `profiles` (paired
-- with `user_credentials`, 024) the free-standing, first-party identity
-- root this migration needs, with ZERO remapping of existing data: every
-- row that satisfies `X REFERENCES auth.users(id)` today already has a
-- matching `profiles.id` (profiles has always had its own FK to
-- auth.users(id), so the set of valid ids is identical), so repointing the
-- FK target changes nothing about which values are valid.
--
-- `auth.users` itself is NOT touched or dropped here — Supabase/PostgreSQL
-- remains in place per this migration's own instructions, and existing
-- rows there are untouched. This migration only removes the REQUIREMENT
-- that new application records depend on a row existing in that table.
--
-- Constraint names are looked up dynamically (pg_constraint) rather than
-- hardcoded, so this is robust to any naming drift from Postgres's default
-- auto-generated `<table>_<column>_fkey` convention.
--
-- Hosted scope: all 11 tables with an FK to auth.users (profiles,
-- user_roles, workspaces, workspace_members, conversations, audit_logs,
-- canned_responses, user_notification_prefs, user_availability_prefs,
-- user_phone_verifications, phone_verification_challenges). The self-host
-- chain's mirror (database/migrations/026_...sql) only covers the first 6 —
-- the other 5 are later hosted-only features that chain never received.

DO $repoint$
DECLARE
  old_con text;
BEGIN
  -- ---------- workspaces.owner_id (CASCADE) ----------
  SELECT c.conname INTO old_con
  FROM pg_constraint c
  JOIN pg_class rel ON rel.oid = c.conrelid
  JOIN pg_class frel ON frel.oid = c.confrelid
  JOIN pg_namespace fnsp ON fnsp.oid = frel.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
  WHERE c.contype = 'f' AND rel.relname = 'workspaces' AND a.attname = 'owner_id'
    AND fnsp.nspname = 'auth' AND frel.relname = 'users';
  IF old_con IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.workspaces DROP CONSTRAINT %I', old_con);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class rel ON rel.oid = c.conrelid
    WHERE c.contype = 'f' AND rel.relname = 'workspaces' AND c.conname = 'workspaces_owner_id_profiles_fkey'
  ) THEN
    ALTER TABLE public.workspaces
      ADD CONSTRAINT workspaces_owner_id_profiles_fkey FOREIGN KEY (owner_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
  END IF;

  -- ---------- workspace_members.user_id (CASCADE) ----------
  SELECT c.conname INTO old_con
  FROM pg_constraint c
  JOIN pg_class rel ON rel.oid = c.conrelid
  JOIN pg_class frel ON frel.oid = c.confrelid
  JOIN pg_namespace fnsp ON fnsp.oid = frel.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
  WHERE c.contype = 'f' AND rel.relname = 'workspace_members' AND a.attname = 'user_id'
    AND fnsp.nspname = 'auth' AND frel.relname = 'users';
  IF old_con IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.workspace_members DROP CONSTRAINT %I', old_con);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class rel ON rel.oid = c.conrelid
    WHERE c.contype = 'f' AND rel.relname = 'workspace_members' AND c.conname = 'workspace_members_user_id_profiles_fkey'
  ) THEN
    ALTER TABLE public.workspace_members
      ADD CONSTRAINT workspace_members_user_id_profiles_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
  END IF;

  -- ---------- user_roles.user_id (CASCADE) ----------
  SELECT c.conname INTO old_con
  FROM pg_constraint c
  JOIN pg_class rel ON rel.oid = c.conrelid
  JOIN pg_class frel ON frel.oid = c.confrelid
  JOIN pg_namespace fnsp ON fnsp.oid = frel.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
  WHERE c.contype = 'f' AND rel.relname = 'user_roles' AND a.attname = 'user_id'
    AND fnsp.nspname = 'auth' AND frel.relname = 'users';
  IF old_con IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.user_roles DROP CONSTRAINT %I', old_con);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class rel ON rel.oid = c.conrelid
    WHERE c.contype = 'f' AND rel.relname = 'user_roles' AND c.conname = 'user_roles_user_id_profiles_fkey'
  ) THEN
    ALTER TABLE public.user_roles
      ADD CONSTRAINT user_roles_user_id_profiles_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
  END IF;

  -- ---------- audit_logs.user_id (CASCADE) ----------
  SELECT c.conname INTO old_con
  FROM pg_constraint c
  JOIN pg_class rel ON rel.oid = c.conrelid
  JOIN pg_class frel ON frel.oid = c.confrelid
  JOIN pg_namespace fnsp ON fnsp.oid = frel.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
  WHERE c.contype = 'f' AND rel.relname = 'audit_logs' AND a.attname = 'user_id'
    AND fnsp.nspname = 'auth' AND frel.relname = 'users';
  IF old_con IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.audit_logs DROP CONSTRAINT %I', old_con);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class rel ON rel.oid = c.conrelid
    WHERE c.contype = 'f' AND rel.relname = 'audit_logs' AND c.conname = 'audit_logs_user_id_profiles_fkey'
  ) THEN
    ALTER TABLE public.audit_logs
      ADD CONSTRAINT audit_logs_user_id_profiles_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
  END IF;

  -- ---------- conversations.assigned_to (SET NULL — nullable, unlike the others) ----------
  SELECT c.conname INTO old_con
  FROM pg_constraint c
  JOIN pg_class rel ON rel.oid = c.conrelid
  JOIN pg_class frel ON frel.oid = c.confrelid
  JOIN pg_namespace fnsp ON fnsp.oid = frel.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
  WHERE c.contype = 'f' AND rel.relname = 'conversations' AND a.attname = 'assigned_to'
    AND fnsp.nspname = 'auth' AND frel.relname = 'users';
  IF old_con IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.conversations DROP CONSTRAINT %I', old_con);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class rel ON rel.oid = c.conrelid
    WHERE c.contype = 'f' AND rel.relname = 'conversations' AND c.conname = 'conversations_assigned_to_profiles_fkey'
  ) THEN
    ALTER TABLE public.conversations
      ADD CONSTRAINT conversations_assigned_to_profiles_fkey FOREIGN KEY (assigned_to) REFERENCES public.profiles(id) ON DELETE SET NULL;
  END IF;

  -- ---------- canned_responses.created_by (CASCADE) ----------
  SELECT c.conname INTO old_con
  FROM pg_constraint c
  JOIN pg_class rel ON rel.oid = c.conrelid
  JOIN pg_class frel ON frel.oid = c.confrelid
  JOIN pg_namespace fnsp ON fnsp.oid = frel.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
  WHERE c.contype = 'f' AND rel.relname = 'canned_responses' AND a.attname = 'created_by'
    AND fnsp.nspname = 'auth' AND frel.relname = 'users';
  IF old_con IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.canned_responses DROP CONSTRAINT %I', old_con);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class rel ON rel.oid = c.conrelid
    WHERE c.contype = 'f' AND rel.relname = 'canned_responses' AND c.conname = 'canned_responses_created_by_profiles_fkey'
  ) THEN
    ALTER TABLE public.canned_responses
      ADD CONSTRAINT canned_responses_created_by_profiles_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE CASCADE;
  END IF;

  -- ---------- user_notification_prefs.user_id (CASCADE) ----------
  SELECT c.conname INTO old_con
  FROM pg_constraint c
  JOIN pg_class rel ON rel.oid = c.conrelid
  JOIN pg_class frel ON frel.oid = c.confrelid
  JOIN pg_namespace fnsp ON fnsp.oid = frel.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
  WHERE c.contype = 'f' AND rel.relname = 'user_notification_prefs' AND a.attname = 'user_id'
    AND fnsp.nspname = 'auth' AND frel.relname = 'users';
  IF old_con IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.user_notification_prefs DROP CONSTRAINT %I', old_con);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class rel ON rel.oid = c.conrelid
    WHERE c.contype = 'f' AND rel.relname = 'user_notification_prefs' AND c.conname = 'user_notification_prefs_user_id_profiles_fkey'
  ) THEN
    ALTER TABLE public.user_notification_prefs
      ADD CONSTRAINT user_notification_prefs_user_id_profiles_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
  END IF;

  -- ---------- user_availability_prefs.user_id (CASCADE) ----------
  SELECT c.conname INTO old_con
  FROM pg_constraint c
  JOIN pg_class rel ON rel.oid = c.conrelid
  JOIN pg_class frel ON frel.oid = c.confrelid
  JOIN pg_namespace fnsp ON fnsp.oid = frel.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
  WHERE c.contype = 'f' AND rel.relname = 'user_availability_prefs' AND a.attname = 'user_id'
    AND fnsp.nspname = 'auth' AND frel.relname = 'users';
  IF old_con IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.user_availability_prefs DROP CONSTRAINT %I', old_con);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class rel ON rel.oid = c.conrelid
    WHERE c.contype = 'f' AND rel.relname = 'user_availability_prefs' AND c.conname = 'user_availability_prefs_user_id_profiles_fkey'
  ) THEN
    ALTER TABLE public.user_availability_prefs
      ADD CONSTRAINT user_availability_prefs_user_id_profiles_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
  END IF;

  -- ---------- user_phone_verifications.user_id (PRIMARY KEY, CASCADE) ----------
  SELECT c.conname INTO old_con
  FROM pg_constraint c
  JOIN pg_class rel ON rel.oid = c.conrelid
  JOIN pg_class frel ON frel.oid = c.confrelid
  JOIN pg_namespace fnsp ON fnsp.oid = frel.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
  WHERE c.contype = 'f' AND rel.relname = 'user_phone_verifications' AND a.attname = 'user_id'
    AND fnsp.nspname = 'auth' AND frel.relname = 'users';
  IF old_con IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.user_phone_verifications DROP CONSTRAINT %I', old_con);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class rel ON rel.oid = c.conrelid
    WHERE c.contype = 'f' AND rel.relname = 'user_phone_verifications' AND c.conname = 'user_phone_verifications_user_id_profiles_fkey'
  ) THEN
    ALTER TABLE public.user_phone_verifications
      ADD CONSTRAINT user_phone_verifications_user_id_profiles_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
  END IF;

  -- ---------- phone_verification_challenges.user_id (CASCADE) ----------
  SELECT c.conname INTO old_con
  FROM pg_constraint c
  JOIN pg_class rel ON rel.oid = c.conrelid
  JOIN pg_class frel ON frel.oid = c.confrelid
  JOIN pg_namespace fnsp ON fnsp.oid = frel.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
  WHERE c.contype = 'f' AND rel.relname = 'phone_verification_challenges' AND a.attname = 'user_id'
    AND fnsp.nspname = 'auth' AND frel.relname = 'users';
  IF old_con IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.phone_verification_challenges DROP CONSTRAINT %I', old_con);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class rel ON rel.oid = c.conrelid
    WHERE c.contype = 'f' AND rel.relname = 'phone_verification_challenges' AND c.conname = 'phone_verification_challenges_user_id_profiles_fkey'
  ) THEN
    ALTER TABLE public.phone_verification_challenges
      ADD CONSTRAINT phone_verification_challenges_user_id_profiles_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
  END IF;

  -- ---------- profiles.id itself: drop its FK to auth.users(id) last ----------
  -- (must be last: everything above had to already point at profiles, which
  -- required profiles rows to keep existing throughout — dropping this FK
  -- doesn't touch data, just the constraint, but ordering keeps the
  -- migration readable as "repoint dependents, then free the root")
  SELECT c.conname INTO old_con
  FROM pg_constraint c
  JOIN pg_class rel ON rel.oid = c.conrelid
  JOIN pg_class frel ON frel.oid = c.confrelid
  JOIN pg_namespace fnsp ON fnsp.oid = frel.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
  WHERE c.contype = 'f' AND rel.relname = 'profiles' AND a.attname = 'id'
    AND fnsp.nspname = 'auth' AND frel.relname = 'users';
  IF old_con IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.profiles DROP CONSTRAINT %I', old_con);
  END IF;
END
$repoint$;

-- ---------- in-migration proof ----------
DO $verify$
DECLARE
  n integer;
BEGIN
  -- profiles.id must have NO fk to auth.users left.
  SELECT count(*) INTO n
  FROM pg_constraint c
  JOIN pg_class rel ON rel.oid = c.conrelid
  JOIN pg_class frel ON frel.oid = c.confrelid
  JOIN pg_namespace fnsp ON fnsp.oid = frel.relnamespace
  WHERE c.contype = 'f' AND rel.relname = 'profiles' AND fnsp.nspname = 'auth' AND frel.relname = 'users';
  IF n <> 0 THEN
    RAISE EXCEPTION '026: profiles still has an FK to auth.users';
  END IF;

  -- Every dependent table must now reference profiles, not auth.users.
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class rel ON rel.oid = c.conrelid
    JOIN pg_class frel ON frel.oid = c.confrelid
    JOIN pg_namespace fnsp ON fnsp.oid = frel.relnamespace
    WHERE c.contype = 'f' AND fnsp.nspname = 'auth' AND frel.relname = 'users'
      AND rel.relname IN (
        'workspaces', 'workspace_members', 'user_roles', 'audit_logs', 'conversations',
        'canned_responses', 'user_notification_prefs', 'user_availability_prefs',
        'user_phone_verifications', 'phone_verification_challenges'
      )
  ) THEN
    RAISE EXCEPTION '026: at least one dependent table still has an FK to auth.users';
  END IF;

  RAISE NOTICE '026: identity root repointed to profiles(id); auth.users no longer a hard dependency for these 11 tables';
END
$verify$;
