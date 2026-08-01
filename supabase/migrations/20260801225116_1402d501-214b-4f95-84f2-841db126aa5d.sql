-- Phase 6-S3B-R3 — atomic verification, audited cancel, admin resend finalize

-- 1. ATOMIC VERIFY -----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.phone_verification_verify(
  _challenge_id uuid,
  _user_id uuid,
  _candidate_digest text,
  _actor_user_id uuid DEFAULT NULL,
  _workspace_id uuid DEFAULT NULL,
  _purpose text DEFAULT 'widget_access'
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r phone_verification_challenges%ROWTYPE; _verified_at timestamptz; _left int;
BEGIN
  IF _candidate_digest IS NULL OR _candidate_digest !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('error','phone_code_invalid');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('pv:' || _user_id::text, 0));

  SELECT * INTO r FROM phone_verification_challenges
   WHERE id = _challenge_id AND user_id = _user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','phone_challenge_not_found'); END IF;
  IF r.purpose IS DISTINCT FROM _purpose THEN
    RETURN jsonb_build_object('error','phone_challenge_not_found');
  END IF;
  IF r.consumed_at IS NOT NULL OR r.invalidated_at IS NOT NULL OR NOT r.is_active THEN
    RETURN jsonb_build_object('error','phone_challenge_not_found');
  END IF;
  IF r.delivery_status <> 'sent' THEN
    RETURN jsonb_build_object('error','phone_challenge_not_found');
  END IF;
  IF r.expires_at <= now() THEN
    UPDATE phone_verification_challenges
       SET is_active=false, invalidated_at=now(), updated_at=now() WHERE id = r.id;
    RETURN jsonb_build_object('error','phone_code_expired');
  END IF;
  IF r.attempt_count >= r.max_attempts THEN
    UPDATE phone_verification_challenges
       SET is_active=false, invalidated_at=now(), updated_at=now() WHERE id = r.id;
    RETURN jsonb_build_object('error','phone_attempts_exceeded');
  END IF;
  IF r.code_digest IS NULL OR r.code_digest !~ '^[0-9a-f]{64}$' THEN
    UPDATE phone_verification_challenges
       SET is_active=false, invalidated_at=now(), updated_at=now() WHERE id = r.id;
    RETURN jsonb_build_object('error','phone_code_invalid');
  END IF;

  -- Wrong code: burn one attempt, invalidate at the cap.
  IF r.code_digest <> _candidate_digest THEN
    UPDATE phone_verification_challenges
       SET attempt_count = attempt_count + 1,
           is_active = CASE WHEN attempt_count + 1 >= max_attempts THEN false ELSE true END,
           invalidated_at = CASE WHEN attempt_count + 1 >= max_attempts THEN now() ELSE invalidated_at END,
           updated_at = now()
     WHERE id = r.id
    RETURNING * INTO r;
    _left := greatest(r.max_attempts - r.attempt_count, 0);
    INSERT INTO audit_logs(action, entity_type, entity_id, user_id, workspace_id, new_value)
    VALUES ('phone_verification_code_failed','user_phone_verification', r.user_id::text,
            _actor_user_id, _workspace_id,
            jsonb_build_object('purpose', r.purpose,
                               'phone_masked', public.mask_phone_e164(r.phone_e164),
                               'attempts_left', _left,
                               'challenge_id', r.id));
    RETURN jsonb_build_object(
      'error', CASE WHEN _left = 0 THEN 'phone_attempts_exceeded' ELSE 'phone_code_invalid' END,
      'attemptsLeft', _left);
  END IF;

  -- Correct code: consume, verify the account, kill sibling challenges.
  UPDATE phone_verification_challenges
     SET consumed_at = now(), is_active = false, updated_at = now()
   WHERE id = r.id RETURNING * INTO r;

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

  -- Single canonical success event, same transaction as the state change.
  INSERT INTO audit_logs(action, entity_type, entity_id, user_id, workspace_id, new_value)
  VALUES ('phone_verification_succeeded','user_phone_verification', _user_id::text,
          _actor_user_id, _workspace_id,
          jsonb_build_object('purpose', r.purpose,
                             'verification_method','sms_otp',
                             'target_user_id', _user_id,
                             'phone_masked', public.mask_phone_e164(r.phone_e164),
                             'verified_at', _verified_at,
                             'challenge_id', r.id));

  RETURN jsonb_build_object('verifiedAt', _verified_at,
                            'phoneMasked', public.mask_phone_e164(r.phone_e164));
END $$;

REVOKE ALL ON FUNCTION public.phone_verification_verify(uuid,uuid,text,uuid,uuid,text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.phone_verification_verify(uuid,uuid,text,uuid,uuid,text) TO service_role;

-- 2. AUDITED, RACE-SAFE CANCEL -----------------------------------------------
CREATE OR REPLACE FUNCTION public.phone_verification_cancel(
  _user_id uuid,
  _challenge_id uuid DEFAULT NULL,
  _actor_user_id uuid DEFAULT NULL,
  _workspace_id uuid DEFAULT NULL,
  _purpose text DEFAULT 'widget_access'
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _n int; _row record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('pv:' || _user_id::text, 0));

  WITH cancelled AS (
    UPDATE phone_verification_challenges
       SET is_active = false, invalidated_at = now(), updated_at = now()
     WHERE user_id = _user_id
       AND is_active
       AND consumed_at IS NULL
       AND invalidated_at IS NULL
       AND (_challenge_id IS NULL OR id = _challenge_id)
    RETURNING id, phone_e164, purpose
  )
  SELECT count(*)::int AS n,
         (array_agg(id))[1] AS first_id,
         (array_agg(phone_e164))[1] AS phone
    INTO _row FROM cancelled;

  _n := COALESCE(_row.n, 0);

  IF _n > 0 THEN
    INSERT INTO audit_logs(action, entity_type, entity_id, user_id, workspace_id, new_value)
    VALUES ('phone_verification_cancelled','user_phone_verification', _user_id::text,
            _actor_user_id, _workspace_id,
            jsonb_build_object('purpose', _purpose,
                               'target_user_id', _user_id,
                               'phone_masked', public.mask_phone_e164(_row.phone),
                               'cancelled', _n,
                               'challenge_id', _row.first_id,
                               'cancelled_at', now()));
  END IF;

  RETURN jsonb_build_object('ok', true, 'cancelled', _n);
END $$;

REVOKE ALL ON FUNCTION public.phone_verification_cancel(uuid,uuid,uuid,uuid,text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.phone_verification_cancel(uuid,uuid,uuid,uuid,text) TO service_role;
DROP FUNCTION IF EXISTS public.phone_verification_cancel(uuid,uuid);

-- 3. ADMIN RESEND: durable request + finalize --------------------------------
CREATE OR REPLACE FUNCTION public.phone_verification_admin_resend_requested(
  _challenge_id uuid, _user_id uuid, _admin_id uuid, _phone_masked text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO audit_logs(action, entity_type, entity_id, user_id, new_value)
  VALUES ('phone_verification_admin_resend_requested','user_phone_verification', _user_id::text,
          _admin_id,
          jsonb_build_object('actor_admin_id', _admin_id, 'target_user_id', _user_id,
                             'phone_masked', _phone_masked, 'challenge_id', _challenge_id));
  RETURN jsonb_build_object('ok', true);
END $$;

REVOKE ALL ON FUNCTION public.phone_verification_admin_resend_requested(uuid,uuid,uuid,text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.phone_verification_admin_resend_requested(uuid,uuid,uuid,text) TO service_role;

CREATE OR REPLACE FUNCTION public.phone_verification_finalize_admin_resend(
  _challenge_id uuid,
  _admin_id uuid,
  _sent boolean,
  _provider_name text DEFAULT NULL,
  _provider_message_id text DEFAULT NULL,
  _error_code text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r phone_verification_challenges%ROWTYPE;
BEGIN
  SELECT * INTO r FROM phone_verification_challenges WHERE id = _challenge_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','phone_challenge_not_found'); END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('pv:' || r.user_id::text, 0));

  IF _sent THEN
    UPDATE phone_verification_challenges
       SET delivery_status = 'sent', sent_at = now(),
           provider_name = _provider_name, provider_message_id = _provider_message_id,
           updated_at = now()
     WHERE id = r.id AND consumed_at IS NULL AND invalidated_at IS NULL
    RETURNING * INTO r;
    IF NOT FOUND THEN RETURN jsonb_build_object('error','phone_challenge_not_found'); END IF;

    INSERT INTO audit_logs(action, entity_type, entity_id, user_id, new_value)
    VALUES ('phone_verification_admin_resend','user_phone_verification', r.user_id::text, _admin_id,
            jsonb_build_object('actor_admin_id', _admin_id, 'target_user_id', r.user_id,
                               'phone_masked', public.mask_phone_e164(r.phone_e164),
                               'challenge_id', r.id, 'sent_at', r.sent_at,
                               'provider', _provider_name));
    RETURN jsonb_build_object('ok', true, 'sentAt', r.sent_at);
  END IF;

  UPDATE phone_verification_challenges
     SET delivery_status = 'failed', is_active = false, invalidated_at = now(),
         provider_name = _provider_name, updated_at = now()
   WHERE id = r.id;

  INSERT INTO audit_logs(action, entity_type, entity_id, user_id, new_value)
  VALUES ('phone_verification_admin_resend_failed','user_phone_verification', r.user_id::text, _admin_id,
          jsonb_build_object('actor_admin_id', _admin_id, 'target_user_id', r.user_id,
                             'phone_masked', public.mask_phone_e164(r.phone_e164),
                             'challenge_id', r.id, 'error_code', _error_code,
                             'provider', _provider_name));
  RETURN jsonb_build_object('ok', false);
END $$;

REVOKE ALL ON FUNCTION public.phone_verification_finalize_admin_resend(uuid,uuid,boolean,text,text,text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.phone_verification_finalize_admin_resend(uuid,uuid,boolean,text,text,text) TO service_role;

-- 4. DEPRECATE THE OLD TWO-STEP FLOW (fail-closed) ---------------------------
CREATE OR REPLACE FUNCTION public.phone_verification_claim_attempt(
  _challenge_id uuid, _user_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN jsonb_build_object('error','phone_verification_unavailable');
END $$;

CREATE OR REPLACE FUNCTION public.phone_verification_consume(
  _challenge_id uuid, _user_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN jsonb_build_object('error','phone_verification_unavailable');
END $$;

REVOKE ALL ON FUNCTION public.phone_verification_claim_attempt(uuid,uuid) FROM public, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.phone_verification_consume(uuid,uuid) FROM public, anon, authenticated, service_role;

-- 5. FAIL-CLOSED CLEANUP OF INCONSISTENT CHALLENGES (history preserved) ------
UPDATE public.phone_verification_challenges
   SET is_active = false,
       invalidated_at = COALESCE(invalidated_at, now()),
       updated_at = now()
 WHERE is_active
   AND (delivery_status <> 'sent'
        OR consumed_at IS NOT NULL
        OR invalidated_at IS NOT NULL
        OR expires_at <= now());
