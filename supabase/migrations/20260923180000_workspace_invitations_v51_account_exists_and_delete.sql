-- =========================================================================
-- 209 — WORKSPACE INVITATIONS v5.1: canonical account_exists in both previews
--       and an atomic, ledger-owning hard delete
-- =========================================================================
-- Forward-only; nothing earlier is edited. Every statement is CREATE OR
-- REPLACE / REVOKE / GRANT, so re-running this file is a no-op.
--
-- 1. A-residual regression. 087 made both preview RPCs share ONE predicate,
--    public.wi_account_exists (profile + user_credentials.password_hash IS
--    NOT NULL). 094 then re-created both previews to add the Section E
--    context keys, but it re-based them on the pre-087 bodies:
--    wi_preview_invitation inlined its own copy of the predicate and
--    wi_preview_login_context went back to "a profile exists". A profile
--    without a usable password therefore read as account_exists = false on
--    /preview and true on /context-preview for the same invitation, sending
--    the invitee to a login form they cannot complete. Both previews are
--    re-created here with 094's projection and the canonical predicate.
--
-- 2. wi_delete_invitation. The Express hard-delete route used to sequence
--    four independent service_role writes (consents, the idempotency ledger,
--    the invitation, the audit row). That broke two rules at once: Express
--    must never touch public.workspace_invitation_idempotency (the ledger is
--    owned by the database RPCs, see services/invitations/idempotency.ts),
--    and a mutation must be ONE transaction in the canonical lock order. A
--    failure between the writes left consent evidence and replay results
--    deleted for an invitation that still existed.
--
--    The FKs make the cleanup explicit rather than implicit:
--      * tokens, OTPs, proofs, contexts, jobs, deliveries and department
--        links reference workspace_invitations ON DELETE CASCADE;
--      * workspace_invitation_consents is ON DELETE RESTRICT (consent is
--        evidence and is never silently cascaded away) and the ledger has no
--        FK at all — so both are removed explicitly, inside this function;
--      * workspace_member_details is ON DELETE RESTRICT and only exists for
--        an accepted invitation, which this function refuses to delete.
-- =========================================================================

-- ── 1. canonical account_exists in both previews ─────────────────────────

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
    'account_exists', public.wi_account_exists(_inv.invited_email_normalized)
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

  _account_exists := public.wi_account_exists(_inv.invited_email_normalized);

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


-- ── 2. atomic hard delete ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.wi_delete_invitation(
  _invitation_id uuid,
  _actor_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _workspace_id uuid;
  _actor_role text;
  _inv public.workspace_invitations%ROWTYPE;
BEGIN
  SELECT workspace_id INTO _workspace_id FROM public.workspace_invitations WHERE id = _invitation_id;
  IF _workspace_id IS NULL THEN RAISE EXCEPTION 'INVITATION_NOT_FOUND'; END IF;

  -- Canonical lock order: workspace, then invitation.
  PERFORM 1 FROM public.workspaces WHERE id = _workspace_id FOR UPDATE;
  SELECT * INTO _inv FROM public.workspace_invitations WHERE id = _invitation_id FOR UPDATE;
  IF _inv.id IS NULL THEN RAISE EXCEPTION 'INVITATION_NOT_FOUND'; END IF;

  SELECT role::text INTO _actor_role FROM public.workspace_members
  WHERE workspace_id = _workspace_id AND user_id = _actor_id;
  IF _actor_role IS NULL OR _actor_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;

  -- The membership an accepted invitation produced references it; deleting
  -- it would rewrite the workspace's staff history.
  IF _inv.status = 'accepted' THEN RAISE EXCEPTION 'INVITATION_ALREADY_ACCEPTED'; END IF;

  DELETE FROM public.workspace_invitation_consents WHERE invitation_id = _invitation_id;
  DELETE FROM public.workspace_invitation_idempotency WHERE invitation_id = _invitation_id;
  -- Tokens, OTPs, proofs, contexts, jobs, deliveries and department links
  -- follow through their ON DELETE CASCADE foreign keys.
  DELETE FROM public.workspace_invitations WHERE id = _invitation_id;

  PERFORM public.wi_audit(_workspace_id, _actor_id, 'invitation.deleted', _invitation_id,
          jsonb_build_object('status', _inv.status));

  RETURN jsonb_build_object('deleted', true, 'workspace_id', _workspace_id, 'status', _inv.status);
END;
$$;

REVOKE ALL ON FUNCTION public.wi_preview_invitation(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.wi_preview_invitation(text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wi_preview_invitation(text, text) TO service_role;

REVOKE ALL ON FUNCTION public.wi_preview_login_context(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.wi_preview_login_context(text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wi_preview_login_context(text) TO service_role;

REVOKE ALL ON FUNCTION public.wi_delete_invitation(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.wi_delete_invitation(uuid, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wi_delete_invitation(uuid, uuid) TO service_role;
