CREATE OR REPLACE FUNCTION public.wi_invitation_public_context(_invitation_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'inviter_name',
      (SELECT nullif(btrim(coalesce(p.full_name, '')), '')
         FROM public.workspace_invitations i
         JOIN public.profiles p ON p.id = i.created_by
        WHERE i.id = _invitation_id),
    'department_names',
      coalesce(
        (SELECT jsonb_agg(d.name ORDER BY d.name)
           FROM public.workspace_invitation_departments wid
           JOIN public.workspace_departments d ON d.id = wid.department_id
          WHERE wid.invitation_id = _invitation_id),
        '[]'::jsonb)
  )
$$;

REVOKE ALL ON FUNCTION public.wi_invitation_public_context(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.wi_invitation_public_context(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wi_invitation_public_context(uuid) TO service_role;

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
    'masked_email', public.wi_mask_email(_inv.invited_email_normalized),
    'masked_phone', public.wi_mask_phone(_inv.invited_phone_e164),
    'requires_otp', (_tok.purpose = 'manual_handoff'),
    'account_exists', EXISTS (
      SELECT 1 FROM public.user_credentials c
      JOIN public.profiles p ON p.id = c.user_id
      WHERE lower(p.email) = _inv.invited_email_normalized AND c.password_hash IS NOT NULL
    )
  ) || public.wi_invitation_public_context(_inv.id);
END;
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
  ) || public.wi_invitation_public_context(_inv.id);
END;
$$;

REVOKE ALL ON FUNCTION public.wi_preview_invitation(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.wi_preview_invitation(text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wi_preview_invitation(text, text) TO service_role;

REVOKE ALL ON FUNCTION public.wi_preview_login_context(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.wi_preview_login_context(text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wi_preview_login_context(text) TO service_role;