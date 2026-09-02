-- =========================================================================
-- WORKSPACE INVITATIONS v5.1 — login-context surface (self-host chain)
-- =========================================================================
-- Real gap closed here (found by the v5.1 §20 acceptance suite running the
-- canonical Express router against a fresh self-host database):
--
--   server/routes/workspaceInvitations.ts calls
--     * public.wi_preview_login_context(text)                 [/context-preview]
--     * public.accept_invitation_existing_context_v2(...)     [/accept-existing]
--
--   …but the self-host chain only shipped wi_create_login_context /
--   wi_consume_login_context. Existing-account acceptance therefore failed
--   with "function does not exist" on every self-hosted install.
--
-- Both functions are thin, transaction-local wrappers over the already
-- reviewed primitives, so the v5.1 invariants are preserved verbatim:
--   - canonical lock order stays inside wi_consume_login_context /
--     wi_lock_and_validate_token (workspace -> invitation -> context -> token),
--   - no raw token, proof, OTP or handle is ever stored or returned,
--   - the context is single-use: preview never consumes, acceptance always does,
--   - every public failure collapses to INVITATION_NOT_FOUND,
--   - service_role is the only role that may execute them.
-- =========================================================================

-- Read-only projection of a live login context. It must NOT consume the
-- context (the user still has to sign in first), so it re-validates the same
-- conditions wi_consume_login_context enforces without mutating anything.
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
  _ws_name text;
  _local text;
  _domain text;
BEGIN
  SELECT * INTO _c FROM public.workspace_invitation_contexts
  WHERE handle_hash = _handle_hash;
  IF _c.id IS NULL THEN RAISE EXCEPTION 'INVITATION_NOT_FOUND'; END IF;

  SELECT * INTO _inv FROM public.workspace_invitations WHERE id = _c.invitation_id;
  SELECT * INTO _tok FROM public.workspace_invitation_tokens WHERE id = _c.token_id;

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

  SELECT name INTO _ws_name FROM public.workspaces WHERE id = _inv.workspace_id;
  _local  := split_part(_inv.invited_email_normalized, '@', 1);
  _domain := split_part(_inv.invited_email_normalized, '@', 2);

  -- Secret-free projection: no token hash, no handle, no phone number.
  RETURN jsonb_build_object(
    'invitation_id',  _inv.id,
    'workspace_id',   _inv.workspace_id,
    'workspace_name', _ws_name,
    'first_name',     _inv.first_name,
    'last_name',      _inv.last_name,
    'masked_email',
      CASE WHEN length(_local) <= 2 THEN left(_local, 1) || '***@' || _domain
           ELSE left(_local, 2) || '***@' || _domain END,
    'member_type',    _inv.member_type,
    'role',           _inv.role,
    'job_title',      _inv.job_title,
    'expires_at',     _inv.expires_at,
    'purpose',        _c.purpose
  );
END;
$$;

-- Existing-account acceptance driven by the HttpOnly login context instead of
-- a token in the request body: consume the context (single transaction, same
-- lock order) and hand the resolved STORED token hash to the reviewed
-- accept_invitation_existing_user_v2 contract.
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
  _ctx jsonb;
BEGIN
  IF _session_user_id IS NULL THEN RAISE EXCEPTION 'SESSION_REQUIRED'; END IF;

  _ctx := public.wi_consume_login_context(_handle_hash);

  RETURN public.accept_invitation_existing_user_v2(
    _token_hash                := _ctx ->> 'token_hash',
    _purpose                   := _ctx ->> 'purpose',
    _session_user_id           := _session_user_id,
    _session_email_normalized  := _session_email_normalized,
    _terms_version_id          := _terms_version_id,
    _privacy_version_id        := _privacy_version_id,
    _locale                    := _locale,
    _ip                        := _ip,
    _user_agent                := _user_agent
  );
END;
$$;

-- ACL — service_role only, like every other v5.1 RPC.
DO $acl$
DECLARE
  _fn text;
  _fns text[] := ARRAY[
    'wi_preview_login_context(text)',
    'accept_invitation_existing_context_v2(text,uuid,text,uuid,uuid,text,text,text)'
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
