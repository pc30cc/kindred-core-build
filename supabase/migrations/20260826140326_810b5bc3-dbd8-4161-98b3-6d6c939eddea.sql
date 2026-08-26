-- ===== hosted 20260819120100_auth_sessions_revoke_reason.sql =====
ALTER TABLE public.auth_sessions
  ADD COLUMN IF NOT EXISTS revoke_reason text;

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'auth_sessions' AND column_name = 'revoke_reason'
  ) THEN
    RAISE EXCEPTION 'auth_sessions.revoke_reason was not added';
  END IF;
  RAISE NOTICE 'auth_sessions.revoke_reason added';
END
$verify$;

-- ===== hosted 20260819130000_identity_root_profiles_not_auth_users.sql =====
-- Repoint every dependent FK from auth.users(id) to public.profiles(id),
-- then free profiles.id itself. Same constraint names / delete actions as
-- the reviewed migration; expressed as a driven loop instead of ten
-- copy-pasted blocks. Nothing is dropped except the old FK constraints.
DO $repoint$
DECLARE
  spec record;
  old_con text;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('workspaces', 'owner_id', 'workspaces_owner_id_profiles_fkey', 'CASCADE'),
      ('workspace_members', 'user_id', 'workspace_members_user_id_profiles_fkey', 'CASCADE'),
      ('user_roles', 'user_id', 'user_roles_user_id_profiles_fkey', 'CASCADE'),
      ('audit_logs', 'user_id', 'audit_logs_user_id_profiles_fkey', 'CASCADE'),
      ('conversations', 'assigned_to', 'conversations_assigned_to_profiles_fkey', 'SET NULL'),
      ('canned_responses', 'created_by', 'canned_responses_created_by_profiles_fkey', 'CASCADE'),
      ('user_notification_prefs', 'user_id', 'user_notification_prefs_user_id_profiles_fkey', 'CASCADE'),
      ('user_availability_prefs', 'user_id', 'user_availability_prefs_user_id_profiles_fkey', 'CASCADE'),
      ('user_phone_verifications', 'user_id', 'user_phone_verifications_user_id_profiles_fkey', 'CASCADE'),
      ('phone_verification_challenges', 'user_id', 'phone_verification_challenges_user_id_profiles_fkey', 'CASCADE')
    ) AS t(tbl, col, new_con, del_action)
  LOOP
    SELECT c.conname INTO old_con
    FROM pg_constraint c
    JOIN pg_class rel ON rel.oid = c.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    JOIN pg_class frel ON frel.oid = c.confrelid
    JOIN pg_namespace fnsp ON fnsp.oid = frel.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE c.contype = 'f' AND nsp.nspname = 'public' AND rel.relname = spec.tbl
      AND a.attname = spec.col AND fnsp.nspname = 'auth' AND frel.relname = 'users';

    IF old_con IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', spec.tbl, old_con);
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c
      JOIN pg_class rel ON rel.oid = c.conrelid
      JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
      WHERE c.contype = 'f' AND nsp.nspname = 'public'
        AND rel.relname = spec.tbl AND c.conname = spec.new_con
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES public.profiles(id) ON DELETE %s',
        spec.tbl, spec.new_con, spec.col, spec.del_action
      );
    END IF;
  END LOOP;

  -- profiles.id itself: drop its FK to auth.users(id) last.
  SELECT c.conname INTO old_con
  FROM pg_constraint c
  JOIN pg_class rel ON rel.oid = c.conrelid
  JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
  JOIN pg_class frel ON frel.oid = c.confrelid
  JOIN pg_namespace fnsp ON fnsp.oid = frel.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
  WHERE c.contype = 'f' AND nsp.nspname = 'public' AND rel.relname = 'profiles'
    AND a.attname = 'id' AND fnsp.nspname = 'auth' AND frel.relname = 'users';
  IF old_con IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.profiles DROP CONSTRAINT %I', old_con);
  END IF;
END
$repoint$;

DO $verify$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n
  FROM pg_constraint c
  JOIN pg_class rel ON rel.oid = c.conrelid
  JOIN pg_class frel ON frel.oid = c.confrelid
  JOIN pg_namespace fnsp ON fnsp.oid = frel.relnamespace
  WHERE c.contype = 'f' AND rel.relname = 'profiles' AND fnsp.nspname = 'auth' AND frel.relname = 'users';
  IF n <> 0 THEN
    RAISE EXCEPTION '026: profiles still has an FK to auth.users';
  END IF;

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

  IF to_regclass('auth.users') IS NULL THEN
    RAISE EXCEPTION '026: auth.users must NOT be dropped by this migration';
  END IF;

  RAISE NOTICE '026: identity root repointed to profiles(id)';
END
$verify$;
