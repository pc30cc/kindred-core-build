CREATE OR REPLACE FUNCTION public.wi_preview_login_context(_handle_hash text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _c public.workspace_invitation_contexts%ROWTYPE;
  _inv public.workspace_invitations%ROWTYPE;
  _tok public.workspace_invitation_tokens%ROWTYPE;
  _workspace_name text;
BEGIN
  SELECT * INTO _c
  FROM public.workspace_invitation_contexts c
  WHERE c.handle_hash = _handle_hash;
  IF _c.id IS NULL OR _c.consumed_at IS NOT NULL OR _c.revoked_at IS NOT NULL OR _c.expires_at <= now() THEN
    RAISE EXCEPTION 'INVITATION_NOT_FOUND';
  END IF;

  SELECT * INTO _inv FROM public.workspace_invitations i WHERE i.id = _c.invitation_id;
  SELECT * INTO _tok FROM public.workspace_invitation_tokens t WHERE t.id = _c.token_id;
  SELECT name INTO _workspace_name FROM public.workspaces WHERE id = _c.workspace_id;

  IF _inv.id IS NULL OR _inv.invitation_flow_version <> 2 OR _inv.status <> 'pending'
     OR _c.notification_generation <> _inv.notification_generation
     OR _tok.id IS NULL OR _tok.consumed_at IS NOT NULL OR _tok.revoked_at IS NOT NULL
     OR _tok.expires_at <= now() OR _tok.token_generation <> _c.token_generation
     OR _tok.purpose <> _c.purpose THEN
    RAISE EXCEPTION 'INVITATION_NOT_FOUND';
  END IF;

  RETURN jsonb_build_object(
    'invitation_id', _inv.id,
    'workspace_id', _inv.workspace_id,
    'workspace_name', _workspace_name,
    'role', _inv.role,
    'member_type', _inv.member_type,
    'first_name', _inv.first_name,
    'last_name', _inv.last_name,
    'job_title', _inv.job_title,
    'expires_at', _inv.expires_at,
    'masked_email', regexp_replace(_inv.invited_email_normalized, '(^.).*(@.*$)', '\\1***\\2'),
    'masked_phone', CASE WHEN _inv.invited_phone_e164 IS NULL THEN NULL ELSE '***' || right(_inv.invited_phone_e164, 4) END,
    'purpose', _c.purpose,
    'requires_otp', false,
    'account_exists', true
  );
END;
$$;

REVOKE ALL ON FUNCTION public.wi_preview_login_context(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.wi_preview_login_context(text) FROM anon;
REVOKE ALL ON FUNCTION public.wi_preview_login_context(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.wi_preview_login_context(text) TO service_role;