-- Hosted mirror of self-host migration 082 — Workspace Invitations v5.1
-- runtime RPCs (preview, OTP/proof, login-context, outbox worker lifecycle).

CREATE OR REPLACE FUNCTION public.wi_preview_invitation(
  _token_hash text,
  _purpose text
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _tok public.workspace_invitation_tokens%ROWTYPE;
  _inv public.workspace_invitations%ROWTYPE;
  _ws_name text;
  _email text;
  _local text;
  _domain text;
BEGIN
  SELECT * INTO _tok FROM public.workspace_invitation_tokens t
  WHERE t.token_hash = _token_hash AND t.purpose = _purpose;

  IF _tok.id IS NULL
     OR _tok.consumed_at IS NOT NULL
     OR _tok.revoked_at IS NOT NULL
     OR _tok.expires_at <= now() THEN
    RAISE EXCEPTION 'INVITATION_NOT_FOUND';
  END IF;

  SELECT * INTO _inv FROM public.workspace_invitations i WHERE i.id = _tok.invitation_id;

  IF _inv.id IS NULL
     OR _inv.invitation_flow_version <> 2
     OR _inv.status <> 'pending'
     OR (_inv.expires_at IS NOT NULL AND _inv.expires_at <= now())
     OR _tok.notification_generation <> _inv.notification_generation THEN
    RAISE EXCEPTION 'INVITATION_NOT_FOUND';
  END IF;

  SELECT w.name INTO _ws_name FROM public.workspaces w WHERE w.id = _inv.workspace_id;

  _email := _inv.invited_email_normalized;
  _local := split_part(_email, '@', 1);
  _domain := split_part(_email, '@', 2);

  RETURN jsonb_build_object(
    'invitation_id', _inv.id,
    'workspace_id', _inv.workspace_id,
    'workspace_name', _ws_name,
    'purpose', _tok.purpose,
    'role', _inv.role,
    'member_type', _inv.member_type,
    'first_name', _inv.first_name,
    'last_name', _inv.last_name,
    'job_title', _inv.job_title,
    'expires_at', _inv.expires_at,
    'notification_generation', _inv.notification_generation,
    'masked_email',
      CASE WHEN length(_local) <= 2 THEN left(_local, 1) || '***@' || _domain
           ELSE left(_local, 2) || '***@' || _domain END,
    'masked_phone',
      CASE WHEN _inv.invited_phone_e164 IS NULL THEN NULL
           ELSE '***' || right(_inv.invited_phone_e164, 4) END,
    'requires_otp', (_tok.purpose = 'manual_handoff'),
    'account_exists', EXISTS (
      SELECT 1 FROM public.user_credentials c
      JOIN public.profiles p ON p.id = c.user_id
      WHERE lower(p.email) = _email AND c.password_hash IS NOT NULL
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.wi_request_invitation_otp(
  _token_hash text,
  _code_digest text,
  _expires_at timestamptz,
  _ip_hash text DEFAULT NULL,
  _cooldown_seconds integer DEFAULT 60,
  _max_per_window integer DEFAULT 5,
  _window_seconds integer DEFAULT 3600
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _ctx record;
  _inv public.workspace_invitations%ROWTYPE;
  _tok public.workspace_invitation_tokens%ROWTYPE;
  _recent integer;
  _last timestamptz;
  _otp_id uuid;
BEGIN
  SELECT * INTO _ctx FROM public.wi_lock_and_validate_token(_token_hash, 'manual_handoff');
  SELECT * INTO _inv FROM public.workspace_invitations WHERE id = _ctx.invitation_id;
  SELECT * INTO _tok FROM public.workspace_invitation_tokens WHERE id = _ctx.token_id;

  SELECT count(*)::integer, max(created_at) INTO _recent, _last
  FROM public.workspace_invitation_otps o
  WHERE o.invitation_id = _inv.id
    AND o.created_at > now() - make_interval(secs => _window_seconds);

  IF _last IS NOT NULL AND _last > now() - make_interval(secs => _cooldown_seconds) THEN
    RAISE EXCEPTION 'OTP_RATE_LIMITED';
  END IF;
  IF _recent >= _max_per_window THEN
    RAISE EXCEPTION 'OTP_RATE_LIMITED';
  END IF;

  UPDATE public.workspace_invitation_otps
  SET revoked_at = now()
  WHERE invitation_id = _inv.id AND consumed_at IS NULL AND revoked_at IS NULL;

  INSERT INTO public.workspace_invitation_otps (
    invitation_id, workspace_id, email_normalized, manual_token_id,
    manual_token_generation, notification_generation, code_digest,
    expires_at, ip_hash
  ) VALUES (
    _inv.id, _inv.workspace_id, _inv.invited_email_normalized, _tok.id,
    _tok.token_generation, _inv.notification_generation, _code_digest,
    _expires_at, _ip_hash
  )
  RETURNING id INTO _otp_id;

  RETURN jsonb_build_object(
    'otp_id', _otp_id,
    'invitation_id', _inv.id,
    'workspace_id', _inv.workspace_id,
    'email_normalized', _inv.invited_email_normalized,
    'first_name', _inv.first_name,
    'expires_at', _expires_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.wi_verify_invitation_otp(
  _token_hash text,
  _code_digest text,
  _proof_hash text,
  _proof_expires_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _ctx record;
  _inv public.workspace_invitations%ROWTYPE;
  _otp public.workspace_invitation_otps%ROWTYPE;
BEGIN
  SELECT * INTO _ctx FROM public.wi_lock_and_validate_token(_token_hash, 'manual_handoff');
  SELECT * INTO _inv FROM public.workspace_invitations WHERE id = _ctx.invitation_id;

  SELECT * INTO _otp FROM public.workspace_invitation_otps o
  WHERE o.invitation_id = _inv.id
    AND o.consumed_at IS NULL
    AND o.revoked_at IS NULL
  ORDER BY o.created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF _otp.id IS NULL
     OR _otp.manual_token_id <> _ctx.token_id
     OR _otp.notification_generation <> _inv.notification_generation
     OR _otp.expires_at <= now() THEN
    RAISE EXCEPTION 'OTP_INVALID';
  END IF;

  IF _otp.attempts >= _otp.max_attempts THEN
    UPDATE public.workspace_invitation_otps SET revoked_at = now() WHERE id = _otp.id;
    RAISE EXCEPTION 'OTP_RATE_LIMITED';
  END IF;

  IF _otp.code_digest <> _code_digest THEN
    UPDATE public.workspace_invitation_otps
    SET attempts = attempts + 1,
        revoked_at = CASE WHEN attempts + 1 >= max_attempts THEN now() ELSE revoked_at END
    WHERE id = _otp.id;
    RAISE EXCEPTION 'OTP_INVALID';
  END IF;

  UPDATE public.workspace_invitation_otps
  SET consumed_at = now(), attempts = attempts + 1
  WHERE id = _otp.id;

  UPDATE public.workspace_invitation_proofs
  SET revoked_at = now()
  WHERE invitation_id = _inv.id AND consumed_at IS NULL AND revoked_at IS NULL;

  INSERT INTO public.workspace_invitation_proofs (
    otp_id, invitation_id, workspace_id, email_normalized, manual_token_id,
    manual_token_generation, notification_generation, proof_hash, expires_at
  ) VALUES (
    _otp.id, _inv.id, _inv.workspace_id, _inv.invited_email_normalized,
    _ctx.token_id, _otp.manual_token_generation, _inv.notification_generation,
    _proof_hash, _proof_expires_at
  );

  RETURN jsonb_build_object('invitation_id', _inv.id, 'expires_at', _proof_expires_at);
END;
$$;

CREATE OR REPLACE FUNCTION public.wi_create_login_context(
  _token_hash text,
  _purpose text,
  _handle_hash text,
  _expires_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _ctx record;
  _inv public.workspace_invitations%ROWTYPE;
  _tok public.workspace_invitation_tokens%ROWTYPE;
BEGIN
  IF _expires_at > now() + interval '15 minutes' THEN
    RAISE EXCEPTION 'INVITATION_CONTEXT_TTL_TOO_LONG';
  END IF;

  SELECT * INTO _ctx FROM public.wi_lock_and_validate_token(_token_hash, _purpose);
  SELECT * INTO _inv FROM public.workspace_invitations WHERE id = _ctx.invitation_id;
  SELECT * INTO _tok FROM public.workspace_invitation_tokens WHERE id = _ctx.token_id;

  UPDATE public.workspace_invitation_contexts
  SET revoked_at = now()
  WHERE invitation_id = _inv.id AND consumed_at IS NULL AND revoked_at IS NULL;

  INSERT INTO public.workspace_invitation_contexts (
    handle_hash, invitation_id, workspace_id, token_id, token_generation,
    notification_generation, purpose, expires_at
  ) VALUES (
    _handle_hash, _inv.id, _inv.workspace_id, _tok.id, _tok.token_generation,
    _inv.notification_generation, _purpose, _expires_at
  );

  RETURN jsonb_build_object('invitation_id', _inv.id, 'expires_at', _expires_at);
END;
$$;

CREATE OR REPLACE FUNCTION public.wi_consume_login_context(_handle_hash text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _c public.workspace_invitation_contexts%ROWTYPE;
  _inv public.workspace_invitations%ROWTYPE;
  _tok public.workspace_invitation_tokens%ROWTYPE;
BEGIN
  SELECT * INTO _c FROM public.workspace_invitation_contexts c
  WHERE c.handle_hash = _handle_hash;

  IF _c.id IS NULL THEN RAISE EXCEPTION 'INVITATION_NOT_FOUND'; END IF;

  PERFORM 1 FROM public.workspaces WHERE id = _c.workspace_id FOR UPDATE;
  SELECT * INTO _inv FROM public.workspace_invitations WHERE id = _c.invitation_id FOR UPDATE;
  SELECT * INTO _c FROM public.workspace_invitation_contexts WHERE id = _c.id FOR UPDATE;
  SELECT * INTO _tok FROM public.workspace_invitation_tokens WHERE id = _c.token_id FOR UPDATE;

  IF _c.consumed_at IS NOT NULL
     OR _c.revoked_at IS NOT NULL
     OR _c.expires_at <= now()
     OR _inv.id IS NULL
     OR _inv.status <> 'pending'
     OR _inv.invitation_flow_version <> 2
     OR _c.notification_generation <> _inv.notification_generation
     OR _tok.id IS NULL
     OR _tok.consumed_at IS NOT NULL
     OR _tok.revoked_at IS NOT NULL
     OR _tok.expires_at <= now()
     OR _tok.token_generation <> _c.token_generation THEN
    RAISE EXCEPTION 'INVITATION_NOT_FOUND';
  END IF;

  UPDATE public.workspace_invitation_contexts SET consumed_at = now() WHERE id = _c.id;

  RETURN jsonb_build_object(
    'invitation_id', _inv.id,
    'workspace_id', _inv.workspace_id,
    'token_hash', _tok.token_hash,
    'purpose', _tok.purpose
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.wi_revoke_login_context(_handle_hash text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.workspace_invitation_contexts
  SET revoked_at = now()
  WHERE handle_hash = _handle_hash AND consumed_at IS NULL AND revoked_at IS NULL;
$$;

CREATE OR REPLACE FUNCTION public.wi_prepare_invitation_job(
  _job_id uuid,
  _claim_token uuid,
  _token_hash text DEFAULT NULL,
  _token_prefix text DEFAULT NULL,
  _token_expires_at timestamptz DEFAULT NULL,
  _derivation_key_version integer DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _job public.workspace_invitation_jobs%ROWTYPE;
  _inv public.workspace_invitations%ROWTYPE;
  _ws_name text;
BEGIN
  SELECT * INTO _job FROM public.workspace_invitation_jobs WHERE id = _job_id;
  IF _job.id IS NULL THEN RAISE EXCEPTION 'JOB_NOT_FOUND'; END IF;

  PERFORM 1 FROM public.workspaces WHERE id = _job.workspace_id FOR UPDATE;
  SELECT * INTO _inv FROM public.workspace_invitations WHERE id = _job.invitation_id FOR UPDATE;
  SELECT * INTO _job FROM public.workspace_invitation_jobs WHERE id = _job_id FOR UPDATE;

  IF _job.claim_token IS DISTINCT FROM _claim_token
     OR _job.status <> 'claimed'
     OR _job.claim_expires_at IS NULL
     OR _job.claim_expires_at <= now() THEN
    RAISE EXCEPTION 'JOB_CLAIM_LOST';
  END IF;

  IF _inv.id IS NULL
     OR _inv.status <> 'pending'
     OR _inv.invitation_flow_version <> 2
     OR _job.notification_generation <> _inv.notification_generation THEN
    UPDATE public.workspace_invitation_jobs
    SET status = 'cancelled', claim_token = NULL, locked_by = NULL,
        claim_expires_at = NULL, updated_at = now()
    WHERE id = _job_id;
    RETURN jsonb_build_object('cancelled', true);
  END IF;

  IF _job.channel = 'email' THEN
    IF _token_hash IS NULL OR _token_prefix IS NULL OR _token_expires_at IS NULL THEN
      RAISE EXCEPTION 'EMAIL_TOKEN_REQUIRED';
    END IF;

    UPDATE public.workspace_invitation_tokens
    SET revoked_at = now()
    WHERE invitation_id = _inv.id AND purpose = 'email_claim'
      AND consumed_at IS NULL AND revoked_at IS NULL
      AND token_hash <> _token_hash;

    INSERT INTO public.workspace_invitation_tokens (
      invitation_id, workspace_id, purpose, token_hash, token_prefix,
      token_generation, notification_generation, derivation_key_version, expires_at
    ) VALUES (
      _inv.id, _inv.workspace_id, 'email_claim', _token_hash, _token_prefix,
      COALESCE(_job.email_token_generation, 1), _inv.notification_generation,
      _derivation_key_version, _token_expires_at
    )
    ON CONFLICT (token_hash) DO NOTHING;

    UPDATE public.workspace_invitation_jobs
    SET derivation_key_version = COALESCE(derivation_key_version, _derivation_key_version),
        updated_at = now()
    WHERE id = _job_id;
  END IF;

  SELECT w.name INTO _ws_name FROM public.workspaces w WHERE w.id = _inv.workspace_id;

  RETURN jsonb_build_object(
    'cancelled', false,
    'invitation_id', _inv.id,
    'workspace_id', _inv.workspace_id,
    'workspace_name', _ws_name,
    'channel', _job.channel,
    'email', _inv.invited_email_normalized,
    'phone', _inv.invited_phone_e164,
    'first_name', _inv.first_name,
    'last_name', _inv.last_name,
    'role', _inv.role,
    'expires_at', _inv.expires_at,
    'attempt_number', _job.attempt_count,
    'notification_generation', _inv.notification_generation
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.wi_job_still_sendable(_job_id uuid, _claim_token uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.workspace_invitation_jobs j
    JOIN public.workspace_invitations i ON i.id = j.invitation_id
    WHERE j.id = _job_id
      AND j.claim_token = _claim_token
      AND j.status = 'claimed'
      AND j.claim_expires_at > now()
      AND i.status = 'pending'
      AND i.invitation_flow_version = 2
      AND j.notification_generation = i.notification_generation
  );
$$;

CREATE OR REPLACE FUNCTION public.wi_complete_invitation_job(
  _job_id uuid,
  _claim_token uuid,
  _outcome text,
  _provider_name text DEFAULT NULL,
  _provider_message_id text DEFAULT NULL,
  _error_code text DEFAULT NULL,
  _safe_error_message text DEFAULT NULL,
  _retry_in_seconds integer DEFAULT 60
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _job public.workspace_invitation_jobs%ROWTYPE;
  _next_status text;
BEGIN
  IF _outcome NOT IN ('provider_accepted', 'retry', 'permanently_failed', 'unconfigured',
                      'derivation_key_unavailable') THEN
    RAISE EXCEPTION 'INVALID_JOB_OUTCOME';
  END IF;

  SELECT * INTO _job FROM public.workspace_invitation_jobs WHERE id = _job_id FOR UPDATE;
  IF _job.id IS NULL THEN RAISE EXCEPTION 'JOB_NOT_FOUND'; END IF;

  IF _job.claim_token IS DISTINCT FROM _claim_token THEN
    RETURN jsonb_build_object('applied', false);
  END IF;

  _next_status := CASE
    WHEN _outcome = 'retry' AND _job.attempt_count >= _job.max_attempts THEN 'permanently_failed'
    WHEN _outcome = 'retry' THEN 'retrying'
    ELSE _outcome
  END;

  UPDATE public.workspace_invitation_jobs
  SET status = _next_status,
      last_error = _safe_error_message,
      available_at = CASE WHEN _next_status = 'retrying'
                          THEN now() + make_interval(secs => GREATEST(_retry_in_seconds, 5))
                          ELSE available_at END,
      locked_by = NULL,
      locked_at = NULL,
      claim_token = CASE WHEN _next_status = 'retrying' THEN NULL ELSE _job.claim_token END,
      claim_expires_at = NULL,
      updated_at = now()
  WHERE id = _job_id;

  INSERT INTO public.workspace_invitation_deliveries (
    invitation_id, workspace_id, job_id, channel, notification_generation,
    attempt_number, provider_name, provider_message_id, status, error_code,
    safe_error_message, provider_accepted_at, sent_at, failed_at
  ) VALUES (
    _job.invitation_id, _job.workspace_id, _job.id, _job.channel,
    _job.notification_generation, _job.attempt_count, _provider_name,
    _provider_message_id,
    CASE WHEN _outcome = 'provider_accepted' THEN 'provider_accepted' ELSE _next_status END,
    _error_code, _safe_error_message,
    CASE WHEN _outcome = 'provider_accepted' THEN now() END,
    CASE WHEN _outcome = 'provider_accepted' THEN now() END,
    CASE WHEN _outcome <> 'provider_accepted' THEN now() END
  );

  RETURN jsonb_build_object('applied', true, 'status', _next_status);
END;
$$;

REVOKE ALL ON FUNCTION public.wi_preview_invitation(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.wi_request_invitation_otp(text,text,timestamptz,text,integer,integer,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.wi_verify_invitation_otp(text,text,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.wi_create_login_context(text,text,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.wi_consume_login_context(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.wi_revoke_login_context(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.wi_prepare_invitation_job(uuid,uuid,text,text,timestamptz,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.wi_job_still_sendable(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.wi_complete_invitation_job(uuid,uuid,text,text,text,text,text,integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.wi_preview_invitation(text,text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.wi_request_invitation_otp(text,text,timestamptz,text,integer,integer,integer) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.wi_verify_invitation_otp(text,text,text,timestamptz) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.wi_create_login_context(text,text,text,timestamptz) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.wi_consume_login_context(text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.wi_revoke_login_context(text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.wi_prepare_invitation_job(uuid,uuid,text,text,timestamptz,integer) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.wi_job_still_sendable(uuid,uuid) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.wi_complete_invitation_job(uuid,uuid,text,text,text,text,text,integer) FROM anon, authenticated;

GRANT EXECUTE ON FUNCTION public.wi_preview_invitation(text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.wi_request_invitation_otp(text,text,timestamptz,text,integer,integer,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.wi_verify_invitation_otp(text,text,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.wi_create_login_context(text,text,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.wi_consume_login_context(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.wi_revoke_login_context(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.wi_prepare_invitation_job(uuid,uuid,text,text,timestamptz,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.wi_job_still_sendable(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.wi_complete_invitation_job(uuid,uuid,text,text,text,text,text,integer) TO service_role;