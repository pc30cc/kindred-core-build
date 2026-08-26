-- ===== hosted 20260819150000_admin_impersonation_tokens.sql =====
CREATE TABLE IF NOT EXISTS public.admin_impersonation_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_impersonation_tokens_target_idx
  ON public.admin_impersonation_tokens(target_user_id);

GRANT ALL ON public.admin_impersonation_tokens TO service_role;

ALTER TABLE public.admin_impersonation_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "No direct access to impersonation tokens" ON public.admin_impersonation_tokens;
CREATE POLICY "No direct access to impersonation tokens"
  ON public.admin_impersonation_tokens FOR ALL TO anon, authenticated
  USING (false);

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'admin_impersonation_tokens'
  ) THEN
    RAISE EXCEPTION 'admin_impersonation_tokens table missing after migration';
  END IF;
END
$verify$;

-- ===== hosted 20260819181000_change_password_revoke_sessions.sql =====
CREATE OR REPLACE FUNCTION public.change_password_and_revoke_sessions(
  _user_id uuid,
  _new_password_hash text,
  _except_session_id uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _revoked_count integer;
BEGIN
  UPDATE public.user_credentials
  SET password_hash = _new_password_hash,
      password_algo = 'argon2id',
      password_set_at = now(),
      updated_at = now()
  WHERE user_id = _user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'change_password_and_revoke_sessions: no user_credentials row for %', _user_id;
  END IF;

  UPDATE public.auth_sessions
  SET revoked_at = now(), revoke_reason = 'password_changed'
  WHERE user_id = _user_id
    AND revoked_at IS NULL
    AND (_except_session_id IS NULL OR id <> _except_session_id);
  GET DIAGNOSTICS _revoked_count = ROW_COUNT;

  RETURN _revoked_count;
END;
$$;

DO $$
BEGIN
  REVOKE ALL ON FUNCTION public.change_password_and_revoke_sessions(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.change_password_and_revoke_sessions(uuid, text, uuid) TO service_role;
END $$;

DO $verify$
BEGIN
  IF to_regprocedure('public.change_password_and_revoke_sessions(uuid,text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'change_password_and_revoke_sessions was not created';
  END IF;
  IF has_function_privilege('anon', 'public.change_password_and_revoke_sessions(uuid,text,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute change_password_and_revoke_sessions';
  END IF;
  IF has_function_privilege('authenticated', 'public.change_password_and_revoke_sessions(uuid,text,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated can execute change_password_and_revoke_sessions';
  END IF;
  RAISE NOTICE 'change_password_and_revoke_sessions created, locked to service_role';
END
$verify$;

-- ===== hosted 20260819190000_profiles_email_unique.sql =====
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

    RAISE EXCEPTION 'refusing to add unique(lower(profiles.email)) — % duplicate normalized-email group(s) already exist and must be resolved manually first. Sample: %', dupe_count, dupe_sample;
  END IF;
END
$preflight$;

CREATE UNIQUE INDEX IF NOT EXISTS profiles_email_normalized_unique_idx
  ON public.profiles (lower(email));

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
