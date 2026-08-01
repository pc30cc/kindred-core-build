-- Phase 6-S3B-R4: fail-closed admin resend audit + consistent lock ordering.
-- Forward-only. No previous migration is rewritten.

-- 1. Requested audit: transactional, advisory-lock-first, verifiable result.
CREATE OR REPLACE FUNCTION public.phone_verification_admin_resend_requested(
  _challenge_id uuid, _user_id uuid, _admin_id uuid, _phone_masked text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _rows int; _exists boolean;
BEGIN
  IF _challenge_id IS NULL OR _user_id IS NULL THEN
    RETURN jsonb_build_object('error','phone_challenge_not_found');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('pv:' || _user_id::text, 0));

  SELECT EXISTS(
    SELECT 1 FROM phone_verification_challenges
     WHERE id = _challenge_id AND user_id = _user_id
       AND is_active = true AND consumed_at IS NULL AND invalidated_at IS NULL
  ) INTO _exists;
  IF NOT _exists THEN
    RETURN jsonb_build_object('error','phone_challenge_not_found');
  END IF;

  INSERT INTO audit_logs(action, entity_type, entity_id, user_id, new_value)
  VALUES ('phone_verification_admin_resend_requested','user_phone_verification', _user_id::text,
          _admin_id,
          jsonb_build_object('actor_admin_id', _admin_id, 'target_user_id', _user_id,
                             'phone_masked', _phone_masked, 'challenge_id', _challenge_id,
                             'requested_at', now()));
  GET DIAGNOSTICS _rows = ROW_COUNT;
  IF _rows <> 1 THEN
    RETURN jsonb_build_object('error','phone_verification_unavailable');
  END IF;
  RETURN jsonb_build_object('ok', true);
END $$;

REVOKE ALL ON FUNCTION public.phone_verification_admin_resend_requested(uuid,uuid,uuid,text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.phone_verification_admin_resend_requested(uuid,uuid,uuid,text) TO service_role;

-- 2. Finalize: advisory user lock BEFORE the challenge row lock.
CREATE OR REPLACE FUNCTION public.phone_verification_finalize_admin_resend(
  _challenge_id uuid,
  _admin_id uuid,
  _sent boolean,
  _provider_name text DEFAULT NULL,
  _provider_message_id text DEFAULT NULL,
  _error_code text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r phone_verification_challenges%ROWTYPE; _user_id uuid;
BEGIN
  SELECT user_id INTO _user_id FROM phone_verification_challenges WHERE id = _challenge_id;
  IF _user_id IS NULL THEN RETURN jsonb_build_object('error','phone_challenge_not_found'); END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('pv:' || _user_id::text, 0));

  SELECT * INTO r FROM phone_verification_challenges WHERE id = _challenge_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','phone_challenge_not_found'); END IF;

  IF _sent THEN
    -- A cancelled / consumed / invalidated / expired challenge can never be
    -- resurrected into a sent state.
    UPDATE phone_verification_challenges
       SET delivery_status = 'sent', sent_at = now(),
           provider_name = _provider_name, provider_message_id = _provider_message_id,
           updated_at = now()
     WHERE id = r.id
       AND user_id = _user_id
       AND is_active = true
       AND consumed_at IS NULL
       AND invalidated_at IS NULL
       AND delivery_status = 'pending'
       AND expires_at > now()
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

  -- Failure path is idempotent: an already-closed challenge is not reopened
  -- and does not produce a duplicate audit row.
  IF r.consumed_at IS NOT NULL OR r.invalidated_at IS NOT NULL OR r.is_active = false THEN
    RETURN jsonb_build_object('ok', false, 'alreadyClosed', true);
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

-- 3. Delivery bookkeeping: same advisory-first ordering.
CREATE OR REPLACE FUNCTION public.phone_verification_mark_delivery(
  _challenge_id uuid, _sent boolean, _provider_name text DEFAULT NULL,
  _provider_message_id text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _rows int; _user_id uuid;
BEGIN
  SELECT user_id INTO _user_id FROM phone_verification_challenges WHERE id = _challenge_id;
  IF _user_id IS NULL THEN RETURN jsonb_build_object('ok', false); END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('pv:' || _user_id::text, 0));

  UPDATE phone_verification_challenges
     SET delivery_status = CASE WHEN _sent THEN 'sent' ELSE 'failed' END,
         sent_at = CASE WHEN _sent THEN now() ELSE sent_at END,
         is_active = CASE WHEN _sent THEN is_active ELSE false END,
         invalidated_at = CASE WHEN _sent THEN invalidated_at ELSE COALESCE(invalidated_at, now()) END,
         provider_name = _provider_name,
         provider_message_id = _provider_message_id,
         updated_at = now()
   WHERE id = _challenge_id
     AND consumed_at IS NULL
     AND invalidated_at IS NULL
     AND delivery_status = 'pending';
  GET DIAGNOSTICS _rows = ROW_COUNT;
  RETURN jsonb_build_object('ok', _rows = 1);
END $$;

REVOKE ALL ON FUNCTION public.phone_verification_mark_delivery(uuid,boolean,text,text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.phone_verification_mark_delivery(uuid,boolean,text,text) TO service_role;

-- 4. Invalidate: same advisory-first ordering, idempotent.
CREATE OR REPLACE FUNCTION public.phone_verification_invalidate(
  _challenge_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _rows int; _user_id uuid;
BEGIN
  SELECT user_id INTO _user_id FROM phone_verification_challenges WHERE id = _challenge_id;
  IF _user_id IS NULL THEN RETURN jsonb_build_object('ok', false); END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('pv:' || _user_id::text, 0));

  UPDATE phone_verification_challenges
     SET is_active = false, delivery_status = 'failed',
         invalidated_at = COALESCE(invalidated_at, now()), updated_at = now()
   WHERE id = _challenge_id;
  GET DIAGNOSTICS _rows = ROW_COUNT;
  RETURN jsonb_build_object('ok', _rows = 1);
END $$;

REVOKE ALL ON FUNCTION public.phone_verification_invalidate(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.phone_verification_invalidate(uuid) TO service_role;

-- 5. Fail-closed cleanup of inconsistent challenges. History is preserved.
UPDATE public.phone_verification_challenges
   SET is_active = false,
       invalidated_at = COALESCE(invalidated_at, now()),
       updated_at = now()
 WHERE is_active = true
   AND (
     delivery_status <> 'sent'
     OR consumed_at IS NOT NULL
     OR invalidated_at IS NOT NULL
     OR expires_at <= now()
   );