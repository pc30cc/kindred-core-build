-- ===== 024_user_credentials.sql =====
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
GRANT ALL ON public.user_credentials TO anon;
GRANT ALL ON public.user_credentials TO authenticated;
GRANT ALL ON public.user_credentials TO service_role;
DROP POLICY IF EXISTS "No direct access to user credentials" ON public.user_credentials;
CREATE POLICY "No direct access to user credentials"
  ON public.user_credentials FOR ALL TO anon, authenticated
  USING (false);
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
    RAISE EXCEPTION '024: anon lacks the expected table-level GRANT (RLS would then be unreachable/moot)';
  END IF;
  RAISE NOTICE '024: user_credentials created, RLS-locked to service_role only';
END
$verify$;

-- ===== 027_profiles_phone.sql =====
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS phone TEXT;
DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'phone'
  ) THEN
    RAISE EXCEPTION 'profiles.phone column missing after migration';
  END IF;
END
$verify$;

-- ===== 029_backfill_legacy_email_verification.sql =====
UPDATE public.user_credentials uc
SET email_verified_at = au.email_confirmed_at,
    updated_at = now()
FROM auth.users au
WHERE au.id = uc.user_id
  AND uc.email_verified_at IS NULL
  AND au.email_confirmed_at IS NOT NULL;

INSERT INTO public.user_credentials (user_id, email_verified_at)
SELECT p.id, au.email_confirmed_at
FROM public.profiles p
JOIN auth.users au ON au.id = p.id
WHERE au.email_confirmed_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.user_credentials uc WHERE uc.user_id = p.id
  )
ON CONFLICT (user_id) DO NOTHING;

DO $verify$
DECLARE
  still_null_but_confirmed integer;
BEGIN
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

-- ===== 030_atomic_auth_token_redemption.sql =====
CREATE OR REPLACE FUNCTION public.redeem_password_reset_token(
  _token_hash text,
  _new_password_hash text
)
RETURNS TABLE(redeemed_user_id uuid, redeemed_email text, redeemed_sessions_revoked integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _claimed_user_id uuid;
  _claimed_email text;
  _revoked_count integer;
BEGIN
  UPDATE public.auth_reset_tokens t
  SET used_at = now()
  WHERE t.token_hash = _token_hash
    AND t.used_at IS NULL
    AND t.revoked_at IS NULL
    AND t.expires_at > now()
  RETURNING t.user_id, t.email
  INTO _claimed_user_id, _claimed_email;

  IF _claimed_user_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.user_credentials (user_id, password_hash, password_algo, password_set_at, failed_login_count)
  VALUES (_claimed_user_id, _new_password_hash, 'argon2id', now(), 0)
  ON CONFLICT (user_id) DO UPDATE
    SET password_hash = EXCLUDED.password_hash,
        password_algo = EXCLUDED.password_algo,
        password_set_at = EXCLUDED.password_set_at,
        failed_login_count = 0,
        updated_at = now();

  UPDATE public.auth_sessions s
  SET revoked_at = now(), revoke_reason = 'password_reset'
  WHERE s.user_id = _claimed_user_id
    AND s.revoked_at IS NULL;
  GET DIAGNOSTICS _revoked_count = ROW_COUNT;

  RETURN QUERY SELECT _claimed_user_id, _claimed_email, _revoked_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.redeem_email_verify_token(
  _token_hash text
)
RETURNS TABLE(redeemed_user_id uuid, redeemed_email text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _claimed_user_id uuid;
  _claimed_email text;
BEGIN
  UPDATE public.auth_verify_tokens t
  SET used_at = now()
  WHERE t.token_hash = _token_hash
    AND t.used_at IS NULL
    AND t.revoked_at IS NULL
    AND t.expires_at > now()
  RETURNING t.user_id, t.email
  INTO _claimed_user_id, _claimed_email;

  IF _claimed_user_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.user_credentials (user_id, email_verified_at)
  VALUES (_claimed_user_id, now())
  ON CONFLICT (user_id) DO UPDATE
    SET email_verified_at = now(),
        updated_at = now();

  RETURN QUERY SELECT _claimed_user_id, _claimed_email;
END;
$$;

DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.redeem_password_reset_token(text,text)',
    'public.redeem_email_verify_token(text)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END $$;

DO $verify$
BEGIN
  IF to_regprocedure('public.redeem_password_reset_token(text,text)') IS NULL THEN
    RAISE EXCEPTION '030: redeem_password_reset_token was not created';
  END IF;
  IF to_regprocedure('public.redeem_email_verify_token(text)') IS NULL THEN
    RAISE EXCEPTION '030: redeem_email_verify_token was not created';
  END IF;
  IF has_function_privilege('anon', 'public.redeem_password_reset_token(text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION '030: anon can execute redeem_password_reset_token';
  END IF;
  IF has_function_privilege('authenticated', 'public.redeem_password_reset_token(text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION '030: authenticated can execute redeem_password_reset_token';
  END IF;
  IF has_function_privilege('anon', 'public.redeem_email_verify_token(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '030: anon can execute redeem_email_verify_token';
  END IF;
  IF has_function_privilege('authenticated', 'public.redeem_email_verify_token(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '030: authenticated can execute redeem_email_verify_token';
  END IF;
  RAISE NOTICE '030: atomic auth token redemption functions created, locked to service_role';
END
$verify$;