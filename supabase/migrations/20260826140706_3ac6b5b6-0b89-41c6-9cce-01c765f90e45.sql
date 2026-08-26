-- ===== hosted 20260820130000_profiles_email_canonicalize.sql =====
DO $preflight$
DECLARE
  dupe_count integer;
  dupe_sample text;
BEGIN
  SELECT count(*) INTO dupe_count
  FROM (
    SELECT lower(btrim(email)) AS norm_email
    FROM public.profiles
    WHERE email IS NOT NULL
    GROUP BY lower(btrim(email))
    HAVING count(*) > 1
  ) dupes;

  IF dupe_count > 0 THEN
    SELECT string_agg(norm_email, ', ') INTO dupe_sample
    FROM (
      SELECT lower(btrim(email)) AS norm_email
      FROM public.profiles
      WHERE email IS NOT NULL
      GROUP BY lower(btrim(email))
      HAVING count(*) > 1
      ORDER BY norm_email
      LIMIT 20
    ) sample;

    RAISE EXCEPTION '036: refusing to canonicalize profiles.email — % group(s) of currently-distinct rows would collide once whitespace is stripped and must be resolved manually first. Sample: %', dupe_count, dupe_sample;
  END IF;
END
$preflight$;

UPDATE public.profiles
SET email = lower(btrim(email)), updated_at = now()
WHERE email IS NOT NULL
  AND email <> lower(btrim(email));

DROP INDEX IF EXISTS public.profiles_email_normalized_unique_idx;
CREATE UNIQUE INDEX IF NOT EXISTS profiles_email_normalized_unique_idx
  ON public.profiles (lower(btrim(email)));

DO $verify$
DECLARE
  stale_count integer;
  index_def text;
BEGIN
  SELECT count(*) INTO stale_count
  FROM public.profiles
  WHERE email IS NOT NULL AND email <> lower(btrim(email));
  IF stale_count > 0 THEN
    RAISE EXCEPTION '036: % profiles.email row(s) still not canonicalized', stale_count;
  END IF;

  SELECT indexdef INTO index_def
  FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'profiles' AND indexname = 'profiles_email_normalized_unique_idx';
  IF index_def IS NULL OR index_def NOT ILIKE '%btrim%' THEN
    RAISE EXCEPTION '036: profiles_email_normalized_unique_idx is not defined on lower(btrim(email))';
  END IF;

  RAISE NOTICE '036: profiles.email canonicalized; unique index strengthened';
END
$verify$;

-- ===== hosted 20260820150000_profiles_email_canonical_check.sql =====
DO $preflight$
DECLARE
  noncanonical_count integer;
BEGIN
  SELECT count(*) INTO noncanonical_count
  FROM public.profiles
  WHERE email IS NOT NULL AND email <> lower(btrim(email));
  IF noncanonical_count > 0 THEN
    RAISE EXCEPTION '038: refusing to add profiles_email_canonical_check — % row(s) are not yet canonical', noncanonical_count;
  END IF;
END
$preflight$;

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_email_canonical_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_email_canonical_check
  CHECK (email IS NULL OR email = lower(btrim(email)));

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class r ON r.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = r.relnamespace
    WHERE n.nspname = 'public' AND r.relname = 'profiles'
      AND c.conname = 'profiles_email_canonical_check' AND c.contype = 'c'
  ) THEN
    RAISE EXCEPTION '038: profiles_email_canonical_check was not created';
  END IF;
  RAISE NOTICE '038: profiles.email constrained to canonical form';
END
$verify$;

-- ===== hosted 20260820140000_retire_legacy_signup_trigger.sql =====
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

DO $lockdown$
DECLARE
  sig text := to_regprocedure('public.provision_account_on_signup(uuid)')::text;
BEGIN
  IF sig IS NOT NULL THEN
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', sig);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', sig);
    END IF;
  END IF;
END
$lockdown$;

DO $verify$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n2 ON n2.oid = c.relnamespace
  WHERE n2.nspname = 'auth' AND c.relname = 'users'
    AND t.tgname = 'on_auth_user_created'
    AND NOT t.tgisinternal;
  IF n > 0 THEN
    RAISE EXCEPTION '037: on_auth_user_created trigger still present on auth.users';
  END IF;

  IF to_regclass('auth.users') IS NULL THEN
    RAISE EXCEPTION '037: auth.users was unexpectedly dropped — this migration must never drop it';
  END IF;

  RAISE NOTICE '037: legacy auth.users signup trigger retired';
END
$verify$;

-- ===== hosted 20260820160000_lock_create_workspace_atomic_and_idempotent_provisioning.sql =====
DO $lockdown$
DECLARE
  sig text := to_regprocedure('public.create_workspace_atomic(uuid,text,text,uuid)')::text;
BEGIN
  IF sig IS NOT NULL THEN
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', sig);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', sig);
    END IF;
  END IF;
END
$lockdown$;

DO $anon_close$
DECLARE
  sig text := to_regprocedure('public.is_account_member(uuid,uuid)')::text;
BEGIN
  IF sig IS NOT NULL THEN
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', sig);
  END IF;
END
$anon_close$;

CREATE OR REPLACE FUNCTION public.provision_account_on_signup(_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _profile profiles%ROWTYPE;
  _account_id uuid;
  _acc_slug text;
  _ws_slug text;
  _ws_name text;
  _ws_id uuid;
  _trial billing_plans%ROWTYPE;
  _trial_days integer;
BEGIN
  SELECT * INTO _profile FROM profiles WHERE id = _user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  IF EXISTS (SELECT 1 FROM account_members WHERE user_id = _user_id) THEN
    RETURN;
  END IF;

  _ws_name := COALESCE(NULLIF(TRIM(_profile.company_name), ''), COALESCE(_profile.full_name, 'My Workspace'));
  _acc_slug := generate_short_id('acc_');
  _ws_slug := generate_short_id('ws_');

  INSERT INTO accounts (name, slug, owner_id)
  VALUES (_ws_name, _acc_slug, _user_id)
  RETURNING id INTO _account_id;

  INSERT INTO account_members (account_id, user_id, role)
  VALUES (_account_id, _user_id, 'owner');

  _ws_id := create_workspace_atomic(_account_id, _ws_name, _ws_slug, _user_id);

  SELECT * INTO _trial FROM billing_plans
    WHERE slug = 'trial' AND is_active = true
    LIMIT 1;
  IF FOUND AND _ws_id IS NOT NULL THEN
    _trial_days := COALESCE(_trial.trial_days, 14);
    IF _trial_days < 1 THEN _trial_days := 14; END IF;
    INSERT INTO workspace_subscriptions (
      workspace_id, plan_id, provider_name, status,
      current_period_start, current_period_end, trial_end, metadata
    ) VALUES (
      _ws_id, _trial.id, 'system', 'trialing',
      now(), now() + (_trial_days || ' days')::interval,
      now() + (_trial_days || ' days')::interval,
      jsonb_build_object('source', 'signup_auto_trial', 'trial_days', _trial_days)
    )
    ON CONFLICT (workspace_id) DO NOTHING;
    INSERT INTO plan_change_log (workspace_id, old_plan_id, new_plan_id, change_type, metadata)
    VALUES (_ws_id, NULL, _trial.id, 'initial', jsonb_build_object('source', 'signup_auto_trial'));
  END IF;
END;
$function$;

DO $verify$
DECLARE
  sig text;
BEGIN
  sig := to_regprocedure('public.create_workspace_atomic(uuid,text,text,uuid)')::text;
  IF sig IS NOT NULL THEN
    IF has_function_privilege('anon', sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'anon can still execute create_workspace_atomic';
    END IF;
    IF has_function_privilege('authenticated', sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'authenticated can still execute create_workspace_atomic';
    END IF;
    IF NOT has_function_privilege('service_role', sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'service_role cannot execute create_workspace_atomic';
    END IF;
  END IF;

  sig := to_regprocedure('public.provision_account_on_signup(uuid)')::text;
  IF sig IS NOT NULL THEN
    IF has_function_privilege('anon', sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'anon can still execute provision_account_on_signup';
    END IF;
    IF has_function_privilege('authenticated', sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'authenticated can still execute provision_account_on_signup';
    END IF;
    IF NOT has_function_privilege('service_role', sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'service_role cannot execute provision_account_on_signup';
    END IF;
  END IF;

  sig := to_regprocedure('public.is_account_member(uuid,uuid)')::text;
  IF sig IS NOT NULL THEN
    IF NOT has_function_privilege('authenticated', sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'authenticated cannot execute is_account_member — RLS on accounts/account_members would break';
    END IF;
    IF has_function_privilege('anon', sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'anon can still execute is_account_member';
    END IF;
    IF NOT has_function_privilege('service_role', sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'service_role cannot execute is_account_member';
    END IF;
  END IF;

  RAISE NOTICE 'workspace-provisioning security+idempotency closure applied (hosted)';
END
$verify$;
