-- =========================================================================
-- WORKSPACE INVITATIONS v5.1 — canonical login-context contract (self-host)
-- =========================================================================
-- Forward-only. This migration makes the self-host chain agree, byte-for-byte
-- in *contract* terms, with the hosted chain for:
--
--   * public.wi_preview_login_context(text)                  -> jsonb
--   * public.accept_invitation_existing_context_v2(...)      -> jsonb
--
-- Divergences closed here (found by comparing 085 against hosted
-- 20260902112621 / 20260902112823):
--   - self-host preview omitted masked_phone / requires_otp / account_exists
--     even though /invite (InvitePage.tsx) reads all three;
--   - hosted preview masked the local part with a broken escape sequence and
--     to a different length than wi_preview_invitation;
--   - hosted preview did not re-check the token purpose consistently with the
--     acceptance path, and self-host acceptance delegated the whole context
--     consumption to wi_consume_login_context (different lock acquisition).
--
-- Canonical invariants (identical in both chains):
--   - preview NEVER consumes the context or the token;
--   - acceptance consumes context + token inside ONE transaction;
--   - seat / wrong-account / entitlement failures raise, so the surrounding
--     transaction rolls back and NOTHING (context, token, consent, OTP) is
--     consumed;
--   - canonical lock order: workspace -> invitation -> context -> token;
--   - every public failure collapses to INVITATION_NOT_FOUND;
--   - SECURITY DEFINER + SET search_path = public, pg_temp + fully-qualified
--     references;
--   - service_role is the only role allowed to EXECUTE.
-- =========================================================================

-- ── shared masking helper (same rule as public.wi_preview_invitation) ────
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

-- ── preview: read-only projection, never consumes ───────────────────────
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

  -- Secret-free projection: no token hash, no handle, no raw email/phone.
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
    -- a login context only ever exists AFTER the OTP/link challenge succeeded
    'requires_otp',   false,
    'account_exists', _account_exists
  );
END;
$$;

-- ── acceptance: consume context + delegate to the reviewed acceptance RPC ─
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

  -- canonical lock order: workspace -> invitation -> context -> token
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

  -- Any failure below (wrong account, seat limit, entitlement) RAISEs and the
  -- whole transaction — including the context consumption — rolls back.
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

-- ── ACL: service_role only, proven in-migration ─────────────────────────
DO $acl$
DECLARE
  _fn text;
  _fns text[] := ARRAY[
    'wi_preview_login_context(text)',
    'accept_invitation_existing_context_v2(text,uuid,text,uuid,uuid,text,text,text)',
    'wi_mask_email(text)',
    'wi_mask_phone(text)'
  ];
BEGIN
  FOREACH _fn IN ARRAY _fns LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC', _fn);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM anon', _fn);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM authenticated', _fn);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', _fn);
    END IF;
  END LOOP;
END
$acl$;

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
      IF (_role = 'public' OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = _role))
         AND has_function_privilege(_role, to_regprocedure(_fn), 'EXECUTE') THEN
        RAISE EXCEPTION 'privilege leak: % may EXECUTE %', _role, _fn;
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role')
       AND NOT has_function_privilege('service_role', to_regprocedure(_fn), 'EXECUTE') THEN
      RAISE EXCEPTION 'service_role cannot EXECUTE %', _fn;
    END IF;
  END LOOP;
END
$verify$;
