-- Canonical workspace-invitation login-context contract (hosted chain).
-- Contract parity with database/migrations/086 on the self-host chain.

CREATE OR REPLACE FUNCTION public.wi_mask_email(_email text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN _email IS NULL THEN NULL
    WHEN length(split_part(_email, '@', 1)) <= 2
      THEN left(split_part(_email, '@', 1), 1) || '***@' || split_part(_email, '@', 2)
    ELSE left(split_part(_email, '@', 1), 2) || '***@' || split_part(_email, '@', 2)
  END
$$;

CREATE OR REPLACE FUNCTION public.wi_mask_phone(_phone text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN _phone IS NULL THEN NULL ELSE '***' || right(_phone, 4) END
$$;

CREATE OR REPLACE FUNCTION public.wi_preview_login_context(_handle_hash text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _c public.workspace_invitation_contexts%ROWTYPE;
  _inv public.workspace_invitations%ROWTYPE;
  _tok public.workspace_invitation_tokens%ROWTYPE;
  _workspace_name text;
  _account_exists boolean;
BEGIN
  SELECT * INTO _c FROM public.workspace_invitation_contexts c
  WHERE c.handle_hash = _handle_hash;
  IF _c.id IS NULL THEN RAISE EXCEPTION 'INVITATION_NOT_FOUND'; END IF;

  SELECT * INTO _inv FROM public.workspace_invitations i WHERE i.id = _c.invitation_id;
  SELECT * INTO _tok FROM public.workspace_invitation_tokens t WHERE t.id = _c.token_id;

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
     OR _tok.token_generation <> _c.token_generation
     OR _tok.purpose <> _c.purpose THEN
    RAISE EXCEPTION 'INVITATION_NOT_FOUND';
  END IF;

  SELECT w.name INTO _workspace_name FROM public.workspaces w WHERE w.id = _inv.workspace_id;

  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE lower(p.email) = _inv.invited_email_normalized
  ) INTO _account_exists;

  RETURN jsonb_build_object(
    'invitation_id',  _inv.id,
    'workspace_id',   _inv.workspace_id,
    'workspace_name', _workspace_name,
    'first_name',     _inv.first_name,
    'last_name',      _inv.last_name,
    'job_title',      _inv.job_title,
    'member_type',    _inv.member_type,
    'role',           _inv.role,
    'expires_at',     _inv.expires_at,
    'masked_email',   public.wi_mask_email(_inv.invited_email_normalized),
    'masked_phone',   public.wi_mask_phone(_inv.invited_phone_e164),
    'purpose',        _c.purpose,
    'requires_otp',   false,
    'account_exists', _account_exists
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
  IF _session_user_id IS NULL THEN RAISE EXCEPTION 'SESSION_REQUIRED'; END IF;

  SELECT * INTO _c FROM public.workspace_invitation_contexts c
  WHERE c.handle_hash = _handle_hash;
  IF _c.id IS NULL THEN RAISE EXCEPTION 'INVITATION_NOT_FOUND'; END IF;

  PERFORM 1 FROM public.workspaces w WHERE w.id = _c.workspace_id FOR UPDATE;
  SELECT * INTO _inv FROM public.workspace_invitations i WHERE i.id = _c.invitation_id FOR UPDATE;
  SELECT * INTO _c   FROM public.workspace_invitation_contexts c WHERE c.id = _c.id FOR UPDATE;
  SELECT * INTO _tok FROM public.workspace_invitation_tokens t WHERE t.id = _c.token_id FOR UPDATE;

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
     OR _tok.token_generation <> _c.token_generation
     OR _tok.purpose <> _c.purpose THEN
    RAISE EXCEPTION 'INVITATION_NOT_FOUND';
  END IF;

  _result := public.accept_invitation_existing_user_v2(
    _token_hash                := _tok.token_hash,
    _purpose                   := _tok.purpose,
    _session_user_id           := _session_user_id,
    _session_email_normalized  := _session_email_normalized,
    _terms_version_id          := _terms_version_id,
    _privacy_version_id        := _privacy_version_id,
    _locale                    := _locale,
    _ip                        := _ip,
    _user_agent                := _user_agent
  );

  UPDATE public.workspace_invitation_contexts
  SET consumed_at = now()
  WHERE id = _c.id;

  RETURN _result;
END;
$$;

-- Worker heartbeat: extends the lease ONLY while this worker still owns an
-- unexpired claim. Returns false when the claim was lost/stolen/expired.
CREATE OR REPLACE FUNCTION public.wi_heartbeat_invitation_job(
  _job_id uuid,
  _claim_token uuid,
  _lease_seconds integer DEFAULT 120
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF _claim_token IS NULL THEN
    RAISE EXCEPTION 'CLAIM_TOKEN_REQUIRED';
  END IF;
  IF _lease_seconds < 30 OR _lease_seconds > 600 THEN
    RAISE EXCEPTION 'INVALID_LEASE_SECONDS';
  END IF;
  UPDATE public.workspace_invitation_jobs
  SET claim_expires_at = now() + make_interval(secs => _lease_seconds),
      updated_at = now()
  WHERE id = _job_id
    AND claim_token = _claim_token
    AND status = 'claimed'
    AND claim_expires_at > now();
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.wi_mask_email(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.wi_mask_phone(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.wi_preview_login_context(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.accept_invitation_existing_context_v2(text,uuid,text,uuid,uuid,text,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.wi_heartbeat_invitation_job(uuid,uuid,integer) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.wi_mask_email(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.wi_mask_phone(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.wi_preview_login_context(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.accept_invitation_existing_context_v2(text,uuid,text,uuid,uuid,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.wi_heartbeat_invitation_job(uuid,uuid,integer) TO service_role;

DO $verify$
DECLARE
  _fn text;
  _role text;
  _fns text[] := ARRAY[
    'public.wi_preview_login_context(text)',
    'public.accept_invitation_existing_context_v2(text,uuid,text,uuid,uuid,text,text,text)',
    'public.wi_heartbeat_invitation_job(uuid,uuid,integer)'
  ];
BEGIN
  FOREACH _fn IN ARRAY _fns LOOP
    IF to_regprocedure(_fn) IS NULL THEN
      RAISE EXCEPTION 'canonical invitation RPC missing: %', _fn;
    END IF;
    FOREACH _role IN ARRAY ARRAY['public', 'anon', 'authenticated'] LOOP
      IF has_function_privilege(_role, to_regprocedure(_fn), 'EXECUTE') THEN
        RAISE EXCEPTION 'privilege leak: % may EXECUTE %', _role, _fn;
      END IF;
    END LOOP;
    IF NOT has_function_privilege('service_role', to_regprocedure(_fn), 'EXECUTE') THEN
      RAISE EXCEPTION 'service_role cannot EXECUTE %', _fn;
    END IF;
  END LOOP;
END
$verify$;