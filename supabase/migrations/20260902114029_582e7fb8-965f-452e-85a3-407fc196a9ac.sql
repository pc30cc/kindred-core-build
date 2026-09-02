INSERT INTO public.legal_policy_versions (
  id, policy_type, version, locale, document_url, content_hash, published_at, effective_from, is_active
) VALUES
  ('51000000-0000-4000-8000-000000000001', 'terms', 'self-host-baseline-v1', 'en', '/terms', encode(digest('self-host-baseline-terms-v1', 'sha256'), 'hex'), now(), now(), true),
  ('51000000-0000-4000-8000-000000000002', 'privacy', 'self-host-baseline-v1', 'en', '/privacy', encode(digest('self-host-baseline-privacy-v1', 'sha256'), 'hex'), now(), now(), true)
ON CONFLICT (policy_type, version, locale) DO NOTHING;

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
  IF _cooldown_seconds <> 60 OR _max_per_window <> 5 OR _window_seconds <> 3600
     OR _expires_at <= now() OR _expires_at > now() + interval '10 minutes' THEN
    RAISE EXCEPTION 'OTP_POLICY_INVALID';
  END IF;

  SELECT * INTO _ctx FROM public.wi_lock_and_validate_token(_token_hash, 'manual_handoff');
  SELECT * INTO _inv FROM public.workspace_invitations WHERE id = _ctx.invitation_id;
  SELECT * INTO _tok FROM public.workspace_invitation_tokens WHERE id = _ctx.token_id;

  SELECT count(*)::integer, max(created_at) INTO _recent, _last
  FROM public.workspace_invitation_otps o
  WHERE o.invitation_id = _inv.id
    AND o.created_at > now() - interval '1 hour';

  IF _last IS NOT NULL AND _last > now() - interval '60 seconds' THEN
    RAISE EXCEPTION 'OTP_RATE_LIMITED';
  END IF;
  IF _recent >= 5 THEN
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
  ) RETURNING id INTO _otp_id;

  RETURN jsonb_build_object(
    'otp_id', _otp_id, 'invitation_id', _inv.id,
    'workspace_id', _inv.workspace_id,
    'email_normalized', _inv.invited_email_normalized,
    'first_name', _inv.first_name, 'expires_at', _expires_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.wi_purge_expired_idempotency(_limit integer DEFAULT 500)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE _count integer;
BEGIN
  WITH doomed AS (
    SELECT key FROM public.workspace_invitation_idempotency
    WHERE expires_at <= now()
    ORDER BY expires_at
    LIMIT LEAST(GREATEST(_limit, 1), 5000)
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.workspace_invitation_idempotency i
  USING doomed d WHERE i.key = d.key;
  GET DIAGNOSTICS _count = ROW_COUNT;
  RETURN _count;
END;
$$;

REVOKE ALL ON FUNCTION public.wi_request_invitation_otp(text,text,timestamptz,text,integer,integer,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.wi_purge_expired_idempotency(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wi_request_invitation_otp(text,text,timestamptz,text,integer,integer,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.wi_purge_expired_idempotency(integer) TO service_role;

DO $verify$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.legal_policy_versions WHERE policy_type='terms' AND is_active)
     OR NOT EXISTS (SELECT 1 FROM public.legal_policy_versions WHERE policy_type='privacy' AND is_active) THEN
    RAISE EXCEPTION 'active legal policy baseline missing';
  END IF;
  IF has_function_privilege('anon', 'public.wi_request_invitation_otp(text,text,timestamptz,text,integer,integer,integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.wi_request_invitation_otp(text,text,timestamptz,text,integer,integer,integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.wi_purge_expired_idempotency(integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.wi_purge_expired_idempotency(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'invitation hardening ACL proof failed';
  END IF;
END
$verify$;