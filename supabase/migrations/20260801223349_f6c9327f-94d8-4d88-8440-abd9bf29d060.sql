-- 1. Consume writes its audit row inside the same transaction as the state change.
CREATE OR REPLACE FUNCTION public.phone_verification_consume(
  _challenge_id uuid, _user_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r phone_verification_challenges%ROWTYPE; _verified_at timestamptz;
BEGIN
  UPDATE phone_verification_challenges
     SET consumed_at = now(), is_active = false, updated_at = now()
   WHERE id = _challenge_id AND user_id = _user_id AND consumed_at IS NULL
   RETURNING * INTO r;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','phone_challenge_not_found'); END IF;

  UPDATE phone_verification_challenges
     SET is_active = false, invalidated_at = now(), updated_at = now()
   WHERE user_id = _user_id AND is_active;

  INSERT INTO user_phone_verifications(user_id, phone_e164, country_code,
      phone_verified_at, verification_method, last_verified_at)
  VALUES (_user_id, r.phone_e164, 'IR', now(), 'sms_otp', now())
  ON CONFLICT (user_id) DO UPDATE SET
      phone_e164 = EXCLUDED.phone_e164,
      phone_verified_at = COALESCE(user_phone_verifications.phone_verified_at, now()),
      verification_method = COALESCE(user_phone_verifications.verification_method, 'sms_otp'),
      verified_by_admin_id = CASE WHEN user_phone_verifications.phone_verified_at IS NULL
                                  THEN NULL ELSE user_phone_verifications.verified_by_admin_id END,
      manual_verification_reason = CASE WHEN user_phone_verifications.phone_verified_at IS NULL
                                  THEN NULL ELSE user_phone_verifications.manual_verification_reason END,
      last_verified_at = now(),
      updated_at = now()
  RETURNING phone_verified_at INTO _verified_at;

  -- Mandatory, transactional audit: a verified state always has a trail.
  INSERT INTO audit_logs(action, entity_type, entity_id, user_id, new_value)
  VALUES ('phone_verification_verified', 'user_phone_verification', _user_id::text, _user_id,
          jsonb_build_object('method','sms_otp',
                             'purpose', r.purpose,
                             'phone_masked', public.mask_phone_e164(r.phone_e164),
                             'verified_at', _verified_at));

  RETURN jsonb_build_object('verifiedAt', _verified_at,
    'phoneMasked', public.mask_phone_e164(r.phone_e164));
END $$;

-- 2. Explicit cancel: changing the number kills the outstanding code server-side.
CREATE OR REPLACE FUNCTION public.phone_verification_cancel(
  _user_id uuid, _challenge_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _n int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('pv:' || _user_id::text, 0));

  UPDATE phone_verification_challenges
     SET is_active = false, invalidated_at = now(), updated_at = now()
   WHERE user_id = _user_id
     AND is_active
     AND consumed_at IS NULL
     AND (_challenge_id IS NULL OR id = _challenge_id);
  GET DIAGNOSTICS _n = ROW_COUNT;

  RETURN jsonb_build_object('ok', true, 'cancelled', _n);
END $$;

REVOKE ALL ON FUNCTION public.phone_verification_cancel(uuid,uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.phone_verification_cancel(uuid,uuid) TO service_role;

-- 3. Unknown filter values are rejected instead of silently widening the list.
CREATE OR REPLACE FUNCTION public.phone_status_matches(
  _phone text, _verified_at timestamptz, _filter text
) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
BEGIN
  CASE coalesce(_filter, 'all')
    WHEN 'all'        THEN RETURN true;
    WHEN 'verified'   THEN RETURN _phone IS NOT NULL AND _verified_at IS NOT NULL;
    WHEN 'unverified' THEN RETURN _phone IS NOT NULL AND _verified_at IS NULL;
    WHEN 'no_phone'   THEN RETURN _phone IS NULL;
    ELSE RAISE EXCEPTION 'invalid phone status filter';
  END CASE;
END $$;

REVOKE ALL ON FUNCTION public.phone_status_matches(text,timestamptz,text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.phone_status_matches(text,timestamptz,text) TO authenticated, service_role;

-- 4. Admin-facing state exposes who manually approved a number.
CREATE OR REPLACE FUNCTION public.phone_verification_state(_user_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH v AS (SELECT * FROM user_phone_verifications WHERE user_id = _user_id),
       c AS (SELECT * FROM phone_verification_challenges
              WHERE user_id = _user_id AND is_active AND expires_at > now()
                AND delivery_status = 'sent'
              ORDER BY created_at DESC LIMIT 1)
  SELECT jsonb_build_object(
    'userId', _user_id,
    'phone', (SELECT phone_e164 FROM v),
    'phoneMasked', public.mask_phone_e164((SELECT phone_e164 FROM v)),
    'country', (SELECT country_code FROM v),
    'verified', (SELECT phone_verified_at FROM v) IS NOT NULL,
    'verifiedAt', (SELECT phone_verified_at FROM v),
    'verificationMethod', (SELECT verification_method FROM v),
    'verifiedByAdminId', (SELECT verified_by_admin_id FROM v),
    'verifiedByAdminEmail', (SELECT p.email FROM profiles p
                              WHERE p.id = (SELECT verified_by_admin_id FROM v)),
    'manualVerificationReason', (SELECT manual_verification_reason FROM v),
    'hasActiveChallenge', EXISTS (SELECT 1 FROM c),
    'activeChallengeId', (SELECT id FROM c),
    'challengeExpiresInSeconds', (SELECT greatest(0, ceil(extract(epoch from (expires_at - now()))))::int FROM c),
    'lastSentAt', (SELECT max(sent_at) FROM phone_verification_challenges x WHERE x.user_id = _user_id),
    'lastCreatedAt', (SELECT max(created_at) FROM phone_verification_challenges x WHERE x.user_id = _user_id),
    'remainingAttempts', (SELECT greatest(max_attempts - attempt_count, 0) FROM c)
  )
$$;

-- 5. Widget domain management follows the same owner-phone gate as the rest of
--    the widget management surface. Reads are untouched.
DROP POLICY IF EXISTS "Admins+ can manage domains" ON public.workspace_domains;
CREATE POLICY "Admins+ manage ws domains (phone gated)"
  ON public.workspace_domains
  FOR ALL TO authenticated
  USING (get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::workspace_role,'admin'::workspace_role])
         AND public.workspace_owner_phone_verified(workspace_id))
  WITH CHECK (get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::workspace_role,'admin'::workspace_role])
         AND public.workspace_owner_phone_verified(workspace_id));