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
  IF _expires_at <= now() OR _expires_at > now() + interval '10 minutes'
     OR _cooldown_seconds <> 60 OR _max_per_window <> 5 OR _window_seconds <> 3600 THEN
    RAISE EXCEPTION 'OTP_POLICY_INVALID';
  END IF;

  SELECT * INTO _ctx FROM public.wi_lock_and_validate_token(_token_hash, 'manual_handoff');
  SELECT * INTO _inv FROM public.workspace_invitations WHERE id = _ctx.invitation_id;
  SELECT * INTO _tok FROM public.workspace_invitation_tokens WHERE id = _ctx.token_id;

  SELECT count(*)::integer, max(created_at) INTO _recent, _last
  FROM public.workspace_invitation_otps o
  WHERE o.invitation_id = _inv.id
    AND o.created_at > now() - interval '1 hour';

  IF (_last IS NOT NULL AND _last > now() - interval '60 seconds') OR _recent >= 5 THEN
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
    'otp_id', _otp_id,
    'invitation_id', _inv.id,
    'workspace_id', _inv.workspace_id,
    'email_normalized', _inv.invited_email_normalized,
    'first_name', _inv.first_name,
    'expires_at', _expires_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.accept_invitation_existing_context_v2(
  _handle_hash text,
  _session_user_id uuid,
  _session_email_normalized text,
  _terms_version_id uuid,
  _privacy_version_id uuid,
  _locale text DEFAULT NULL,
  _ip text DEFAULT NULL,
  _user_agent text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _c public.workspace_invitation_contexts%ROWTYPE;
  _inv public.workspace_invitations%ROWTYPE;
  _tok public.workspace_invitation_tokens%ROWTYPE;
  _result jsonb;
BEGIN
  SELECT * INTO _c
  FROM public.workspace_invitation_contexts c
  WHERE c.handle_hash = _handle_hash;
  IF _c.id IS NULL THEN RAISE EXCEPTION 'INVITATION_NOT_FOUND'; END IF;

  PERFORM 1 FROM public.workspaces w WHERE w.id = _c.workspace_id FOR UPDATE;
  SELECT * INTO _inv FROM public.workspace_invitations i WHERE i.id = _c.invitation_id FOR UPDATE;
  SELECT * INTO _c FROM public.workspace_invitation_contexts c WHERE c.id = _c.id FOR UPDATE;
  SELECT * INTO _tok FROM public.workspace_invitation_tokens t WHERE t.id = _c.token_id FOR UPDATE;

  IF _c.consumed_at IS NOT NULL OR _c.revoked_at IS NOT NULL OR _c.expires_at <= now()
     OR _inv.id IS NULL OR _inv.invitation_flow_version <> 2 OR _inv.status <> 'pending'
     OR _c.notification_generation <> _inv.notification_generation
     OR _tok.id IS NULL OR _tok.consumed_at IS NOT NULL OR _tok.revoked_at IS NOT NULL
     OR _tok.expires_at <= now() OR _tok.token_generation <> _c.token_generation
     OR _tok.purpose <> _c.purpose THEN
    RAISE EXCEPTION 'INVITATION_NOT_FOUND';
  END IF;

  _result := public.accept_invitation_existing_user_v2(
    _tok.token_hash, _tok.purpose, _session_user_id, _session_email_normalized,
    _terms_version_id, _privacy_version_id, _locale, _ip, _user_agent
  );

  UPDATE public.workspace_invitation_contexts
  SET consumed_at = now()
  WHERE id = _c.id;

  RETURN _result;
END;
$$;

INSERT INTO public.legal_policy_versions
  (id, policy_type, version, locale, content_hash, document_url, published_at, effective_from, is_active)
VALUES
  ('51000000-0000-4000-8000-000000000001', 'terms', 'self-host-baseline-v1', 'en',
   encode(digest('workspace-invitations-self-host-baseline-terms-v1', 'sha256'), 'hex'), NULL, now(), now(), true),
  ('51000000-0000-4000-8000-000000000002', 'privacy', 'self-host-baseline-v1', 'en',
   encode(digest('workspace-invitations-self-host-baseline-privacy-v1', 'sha256'), 'hex'), NULL, now(), now(), true)
ON CONFLICT (policy_type, version, locale) DO NOTHING;

REVOKE ALL ON FUNCTION public.accept_invitation_existing_context_v2(text,uuid,text,uuid,uuid,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.accept_invitation_existing_context_v2(text,uuid,text,uuid,uuid,text,text,text) FROM anon;
REVOKE ALL ON FUNCTION public.accept_invitation_existing_context_v2(text,uuid,text,uuid,uuid,text,text,text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.accept_invitation_existing_context_v2(text,uuid,text,uuid,uuid,text,text,text) TO service_role;

REVOKE ALL ON FUNCTION public.wi_request_invitation_otp(text,text,timestamptz,text,integer,integer,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.wi_request_invitation_otp(text,text,timestamptz,text,integer,integer,integer) FROM anon;
REVOKE ALL ON FUNCTION public.wi_request_invitation_otp(text,text,timestamptz,text,integer,integer,integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.wi_request_invitation_otp(text,text,timestamptz,text,integer,integer,integer) TO service_role;