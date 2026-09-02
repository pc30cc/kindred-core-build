-- 079 — Workspace Invitations v5.1: acceptance state machine + offboarding
-- (self-host chain).
--
-- Both acceptance paths and offboarding are single transactions following the
-- canonical lock order (v5.1 §6):
--   workspace -> invitation -> token/proof/context -> job -> membership rows.
--
-- Express NEVER passes a raw token: only sha256 hashes and server-resolved
-- ids reach these functions. Plaintext passwords never reach the database —
-- only the Argon2id hash produced by Express.

-- =========================================================================
-- 0. Shared acceptance guard
-- =========================================================================
-- Resolves an invitation from a token hash, takes the canonical locks and
-- revalidates every binding. Returns the locked invitation + token row ids.
CREATE OR REPLACE FUNCTION public.wi_lock_and_validate_token(
  _token_hash text,
  _purpose text,
  OUT invitation_id uuid,
  OUT workspace_id uuid,
  OUT token_id uuid
) RETURNS record
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _inv public.workspace_invitations%ROWTYPE;
  _tok public.workspace_invitation_tokens%ROWTYPE;
BEGIN
  -- Unlocked lookup ONLY to locate lock targets.
  SELECT t.invitation_id, t.workspace_id INTO invitation_id, workspace_id
  FROM public.workspace_invitation_tokens t
  WHERE t.token_hash = _token_hash AND t.purpose = _purpose;

  IF invitation_id IS NULL THEN
    RAISE EXCEPTION 'INVITATION_NOT_FOUND';
  END IF;

  PERFORM 1 FROM public.workspaces w WHERE w.id = workspace_id FOR UPDATE;
  PERFORM public.wi_expire_due(workspace_id);

  SELECT * INTO _inv FROM public.workspace_invitations i
  WHERE i.id = invitation_id FOR UPDATE;

  IF _inv.id IS NULL OR _inv.invitation_flow_version <> 2 OR _inv.status <> 'pending' THEN
    RAISE EXCEPTION 'INVITATION_NOT_FOUND';
  END IF;

  SELECT * INTO _tok FROM public.workspace_invitation_tokens t
  WHERE t.token_hash = _token_hash AND t.purpose = _purpose FOR UPDATE;

  IF _tok.id IS NULL
     OR _tok.invitation_id <> _inv.id
     OR _tok.workspace_id <> _inv.workspace_id
     OR _tok.consumed_at IS NOT NULL
     OR _tok.revoked_at IS NOT NULL
     OR _tok.expires_at <= now()
     OR _tok.notification_generation <> _inv.notification_generation THEN
    RAISE EXCEPTION 'INVITATION_NOT_FOUND';
  END IF;

  token_id := _tok.id;
END;
$$;

-- Seat enforcement, always executed under the workspace lock.
CREATE OR REPLACE FUNCTION public.wi_assert_seat_available(_workspace_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _cap record;
BEGIN
  SELECT * INTO _cap FROM public.wi_resolve_seat_capacity(_workspace_id);

  IF _cap.limit_value IS NOT NULL AND _cap.used >= _cap.limit_value THEN
    RAISE EXCEPTION 'SEAT_LIMIT_REACHED';
  END IF;

  RETURN jsonb_build_object(
    'source', _cap.source,
    'version', _cap.version,
    'limit', _cap.limit_value,
    'used', _cap.used
  );
END;
$$;

-- Department assignment from the invitation's own rows (same workspace only).
CREATE OR REPLACE FUNCTION public.wi_apply_departments(
  _invitation_id uuid,
  _workspace_id uuid,
  _user_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.workspace_department_members (department_id, workspace_id, user_id)
  SELECT wid.department_id, _workspace_id, _user_id
  FROM public.workspace_invitation_departments wid
  WHERE wid.invitation_id = _invitation_id AND wid.workspace_id = _workspace_id
  ON CONFLICT (department_id, user_id) DO NOTHING;
END;
$$;

-- =========================================================================
-- 1. accept_invitation_new_user_v2
-- =========================================================================
CREATE OR REPLACE FUNCTION public.accept_invitation_new_user_v2(
  _token_hash text,
  _purpose text,
  _proof_hash text,
  _user_id uuid,
  _password_hash text,
  _terms_version_id uuid,
  _privacy_version_id uuid,
  _acceptance_method text,
  _locale text DEFAULT NULL,
  _ip text DEFAULT NULL,
  _user_agent text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _ctx record;
  _inv public.workspace_invitations%ROWTYPE;
  _proof public.workspace_invitation_proofs%ROWTYPE;
  _existing_user uuid;
  _existing_hash text;
  _entitlement jsonb;
  _terms_hash text;
  _privacy_hash text;
  _verification_source text;
BEGIN
  IF _password_hash IS NULL OR btrim(_password_hash) = '' THEN
    RAISE EXCEPTION 'PASSWORD_REQUIRED';
  END IF;
  IF _terms_version_id IS NULL OR _privacy_version_id IS NULL THEN
    RAISE EXCEPTION 'CONSENT_REQUIRED';
  END IF;

  SELECT * INTO _ctx FROM public.wi_lock_and_validate_token(_token_hash, _purpose);
  SELECT * INTO _inv FROM public.workspace_invitations WHERE id = _ctx.invitation_id;

  -- The manual link demands a fresh OTP proof; the email link proves the
  -- mailbox by itself.
  IF _purpose = 'manual_handoff' THEN
    IF _proof_hash IS NULL THEN
      RAISE EXCEPTION 'EMAIL_PROOF_REQUIRED';
    END IF;

    SELECT * INTO _proof FROM public.workspace_invitation_proofs p
    WHERE p.proof_hash = _proof_hash FOR UPDATE;

    IF _proof.id IS NULL
       OR _proof.invitation_id <> _inv.id
       OR _proof.workspace_id <> _inv.workspace_id
       OR _proof.manual_token_id <> _ctx.token_id
       OR _proof.notification_generation <> _inv.notification_generation
       OR _proof.email_normalized <> _inv.invited_email_normalized
       OR _proof.consumed_at IS NOT NULL
       OR _proof.revoked_at IS NOT NULL
       OR _proof.expires_at <= now() THEN
      RAISE EXCEPTION 'EMAIL_PROOF_REQUIRED';
    END IF;

    _verification_source := 'workspace_invitation_manual_otp';
  ELSE
    _verification_source := 'workspace_invitation_email_claim';
  END IF;

  -- Entitlement + seats, resolved and enforced inside this transaction.
  _entitlement := public.wi_assert_seat_available(_inv.workspace_id);

  -- A live password-protected account must log in instead.
  SELECT p.id, c.password_hash INTO _existing_user, _existing_hash
  FROM public.profiles p
  LEFT JOIN public.user_credentials c ON c.user_id = p.id
  WHERE lower(p.email) = _inv.invited_email_normalized;

  IF _existing_user IS NOT NULL AND _existing_hash IS NOT NULL THEN
    RAISE EXCEPTION 'ACCOUNT_EXISTS_LOGIN_REQUIRED';
  END IF;

  IF _existing_user IS NULL THEN
    INSERT INTO public.profiles (id, email, full_name, preferred_locale)
    VALUES (_user_id, _inv.invited_email_normalized,
            btrim(_inv.first_name || ' ' || _inv.last_name), COALESCE(_locale, 'en'));
    _existing_user := _user_id;
  END IF;

  INSERT INTO public.user_credentials (user_id, password_hash, password_algo, password_set_at,
                                       email_verified_at, status)
  VALUES (_existing_user, _password_hash, 'argon2id', now(), now(), 'active')
  ON CONFLICT (user_id) DO UPDATE
    SET password_hash = EXCLUDED.password_hash,
        password_algo = 'argon2id',
        password_set_at = now(),
        email_verified_at = COALESCE(public.user_credentials.email_verified_at, now()),
        updated_at = now();

  IF EXISTS (SELECT 1 FROM public.user_credentials
             WHERE user_id = _existing_user AND status <> 'active') THEN
    RAISE EXCEPTION 'ACCOUNT_DISABLED';
  END IF;

  INSERT INTO public.workspace_members (workspace_id, user_id, role)
  VALUES (_inv.workspace_id, _existing_user, _inv.role)
  ON CONFLICT (workspace_id, user_id) DO NOTHING;

  INSERT INTO public.workspace_member_details (
    workspace_id, user_id, first_name, last_name, work_email_normalized,
    work_phone_e164, member_type, job_title, staff_code, invited_by, invitation_id
  ) VALUES (
    _inv.workspace_id, _existing_user, _inv.first_name, _inv.last_name,
    _inv.invited_email_normalized, _inv.invited_phone_e164, _inv.member_type,
    _inv.job_title, _inv.staff_code, _inv.created_by, _inv.id
  )
  ON CONFLICT (workspace_id, user_id) DO NOTHING;

  PERFORM public.wi_apply_departments(_inv.id, _inv.workspace_id, _existing_user);

  SELECT content_hash INTO _terms_hash FROM public.legal_policy_versions WHERE id = _terms_version_id;
  SELECT content_hash INTO _privacy_hash FROM public.legal_policy_versions WHERE id = _privacy_version_id;
  IF _terms_hash IS NULL OR _privacy_hash IS NULL THEN
    RAISE EXCEPTION 'CONSENT_REQUIRED';
  END IF;

  INSERT INTO public.workspace_invitation_consents (
    user_id, workspace_id, invitation_id, terms_version_id, terms_content_hash,
    privacy_version_id, privacy_content_hash, ip, user_agent, locale, acceptance_method
  ) VALUES (
    _existing_user, _inv.workspace_id, _inv.id, _terms_version_id, _terms_hash,
    _privacy_version_id, _privacy_hash, _ip, _user_agent, _locale, _acceptance_method
  );

  UPDATE public.workspace_invitations
  SET status = 'accepted', accepted_at = now(), accepted_by = _existing_user
  WHERE id = _inv.id;

  UPDATE public.workspace_invitation_tokens SET consumed_at = now() WHERE id = _ctx.token_id;
  IF _proof.id IS NOT NULL THEN
    UPDATE public.workspace_invitation_proofs SET consumed_at = now() WHERE id = _proof.id;
    UPDATE public.workspace_invitation_otps SET consumed_at = COALESCE(consumed_at, now())
    WHERE id = _proof.otp_id;
  END IF;
  PERFORM public.wi_revoke_secrets(_inv.id, NULL, NULL);

  INSERT INTO public.audit_logs (workspace_id, user_id, action, entity_type, entity_id, new_value)
  VALUES (_inv.workspace_id, _existing_user, 'invitation.accepted_new_user',
          'workspace_invitation', _inv.id,
          jsonb_build_object('entitlement', _entitlement,
                             'verification_source', _verification_source,
                             'acceptance_method', _acceptance_method));

  RETURN jsonb_build_object(
    'user_id', _existing_user,
    'workspace_id', _inv.workspace_id,
    'role', _inv.role,
    'invitation', public.wi_safe_invitation(_inv.id)
  );
END;
$$;

-- =========================================================================
-- 2. accept_invitation_existing_user_v2
-- =========================================================================
-- Requires BOTH a verified gs_session identity (resolved by Express) AND a
-- current invitation token. No OTP: an authenticated login on the invited
-- address is itself mailbox proof — but the token is still consumed.
CREATE OR REPLACE FUNCTION public.accept_invitation_existing_user_v2(
  _token_hash text,
  _purpose text,
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
  _ctx record;
  _inv public.workspace_invitations%ROWTYPE;
  _cred public.user_credentials%ROWTYPE;
  _entitlement jsonb;
  _terms_hash text;
  _privacy_hash text;
BEGIN
  IF _session_user_id IS NULL THEN RAISE EXCEPTION 'SESSION_REQUIRED'; END IF;
  IF _terms_version_id IS NULL OR _privacy_version_id IS NULL THEN
    RAISE EXCEPTION 'CONSENT_REQUIRED';
  END IF;

  SELECT * INTO _ctx FROM public.wi_lock_and_validate_token(_token_hash, _purpose);
  SELECT * INTO _inv FROM public.workspace_invitations WHERE id = _ctx.invitation_id;

  IF _session_email_normalized IS DISTINCT FROM _inv.invited_email_normalized THEN
    RAISE EXCEPTION 'WRONG_ACCOUNT';
  END IF;

  SELECT * INTO _cred FROM public.user_credentials WHERE user_id = _session_user_id;
  IF _cred.user_id IS NULL OR _cred.status <> 'active' THEN
    RAISE EXCEPTION 'ACCOUNT_DISABLED';
  END IF;

  _entitlement := public.wi_assert_seat_available(_inv.workspace_id);

  INSERT INTO public.workspace_members (workspace_id, user_id, role)
  VALUES (_inv.workspace_id, _session_user_id, _inv.role)
  ON CONFLICT (workspace_id, user_id) DO NOTHING;

  INSERT INTO public.workspace_member_details (
    workspace_id, user_id, first_name, last_name, work_email_normalized,
    work_phone_e164, member_type, job_title, staff_code, invited_by, invitation_id
  ) VALUES (
    _inv.workspace_id, _session_user_id, _inv.first_name, _inv.last_name,
    _inv.invited_email_normalized, _inv.invited_phone_e164, _inv.member_type,
    _inv.job_title, _inv.staff_code, _inv.created_by, _inv.id
  )
  ON CONFLICT (workspace_id, user_id) DO NOTHING;

  PERFORM public.wi_apply_departments(_inv.id, _inv.workspace_id, _session_user_id);

  SELECT content_hash INTO _terms_hash FROM public.legal_policy_versions WHERE id = _terms_version_id;
  SELECT content_hash INTO _privacy_hash FROM public.legal_policy_versions WHERE id = _privacy_version_id;
  IF _terms_hash IS NULL OR _privacy_hash IS NULL THEN
    RAISE EXCEPTION 'CONSENT_REQUIRED';
  END IF;

  INSERT INTO public.workspace_invitation_consents (
    user_id, workspace_id, invitation_id, terms_version_id, terms_content_hash,
    privacy_version_id, privacy_content_hash, ip, user_agent, locale, acceptance_method
  ) VALUES (
    _session_user_id, _inv.workspace_id, _inv.id, _terms_version_id, _terms_hash,
    _privacy_version_id, _privacy_hash, _ip, _user_agent, _locale, 'existing_account'
  );

  UPDATE public.workspace_invitations
  SET status = 'accepted', accepted_at = now(), accepted_by = _session_user_id
  WHERE id = _inv.id;

  UPDATE public.workspace_invitation_tokens SET consumed_at = now() WHERE id = _ctx.token_id;
  UPDATE public.workspace_invitation_contexts SET consumed_at = now()
  WHERE invitation_id = _inv.id AND consumed_at IS NULL AND revoked_at IS NULL;
  PERFORM public.wi_revoke_secrets(_inv.id, NULL, NULL);

  INSERT INTO public.audit_logs (workspace_id, user_id, action, entity_type, entity_id, new_value)
  VALUES (_inv.workspace_id, _session_user_id, 'invitation.accepted_existing_user',
          'workspace_invitation', _inv.id, jsonb_build_object('entitlement', _entitlement));

  RETURN jsonb_build_object(
    'user_id', _session_user_id,
    'workspace_id', _inv.workspace_id,
    'role', _inv.role,
    'invitation', public.wi_safe_invitation(_inv.id)
  );
END;
$$;

-- =========================================================================
-- 3. offboard_workspace_member — FK-accurate order (v5.1 §16, blocker 5)
-- =========================================================================
-- SELF-HOST BODY. The hosted mirror deliberately differs: it also cleans
-- call_center_department_agents, operator_call_availability,
-- user_notification_prefs and the workspace-scoped user_availability_prefs
-- row — none of which exist on this chain. No to_regclass guessing, no
-- dynamic SQL: each chain names exactly the tables it has.
CREATE OR REPLACE FUNCTION public.offboard_workspace_member(
  _workspace_id uuid,
  _user_id uuid,
  _actor_id uuid,
  _reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _owner_id uuid;
  _actor_role public.workspace_role;
  _target_role public.workspace_role;
  -- values captured BEFORE any delete
  _first_name text;
  _last_name text;
  _email text;
  _phone text;
  _member_type text;
  _job_title text;
  _staff_code text;
  _invited_by uuid;
  _invitation_id uuid;
  _joined_at timestamptz;
  _revoked integer := 0;
BEGIN
  -- 1. workspace lock
  SELECT owner_id INTO _owner_id FROM public.workspaces WHERE id = _workspace_id FOR UPDATE;
  IF _owner_id IS NULL THEN RAISE EXCEPTION 'WORKSPACE_NOT_FOUND'; END IF;

  -- 2. resolve + lock the target membership
  SELECT role INTO _target_role FROM public.workspace_members
  WHERE workspace_id = _workspace_id AND user_id = _user_id FOR UPDATE;
  IF _target_role IS NULL THEN RAISE EXCEPTION 'MEMBER_NOT_FOUND'; END IF;

  -- 3. protect the canonical owner
  IF _user_id = _owner_id OR _target_role = 'owner'::public.workspace_role THEN
    RAISE EXCEPTION 'CANNOT_REMOVE_WORKSPACE_OWNER';
  END IF;

  SELECT role INTO _actor_role FROM public.workspace_members
  WHERE workspace_id = _workspace_id AND user_id = _actor_id;
  IF _actor_role IS NULL OR NOT public.wi_can_manage_invitation(_actor_role, _target_role) THEN
    RAISE EXCEPTION 'FORBIDDEN_ROLE_ESCALATION';
  END IF;

  -- 4. capture everything the later steps need, while details still exist
  SELECT d.first_name, d.last_name, d.work_email_normalized, d.work_phone_e164,
         d.member_type, d.job_title, d.staff_code, d.invited_by, d.invitation_id, d.joined_at
    INTO _first_name, _last_name, _email, _phone,
         _member_type, _job_title, _staff_code, _invited_by, _invitation_id, _joined_at
  FROM public.workspace_member_details d
  WHERE d.workspace_id = _workspace_id AND d.user_id = _user_id;

  -- 5. immutable history snapshot
  INSERT INTO public.workspace_member_details_history (
    workspace_id, user_id, first_name, last_name, work_email_normalized, work_phone_e164,
    member_type, job_title, staff_code, invited_by, invitation_id, joined_at,
    offboarded_by, reason
  ) VALUES (
    _workspace_id, _user_id, _first_name, _last_name, _email, _phone,
    _member_type, _job_title, _staff_code, _invited_by, _invitation_id, _joined_at,
    _actor_id, _reason
  );

  -- 6. revoke matching pending invitations using the CAPTURED contact values
  IF _email IS NOT NULL OR _phone IS NOT NULL THEN
    WITH revoked AS (
      UPDATE public.workspace_invitations
      SET status = 'revoked', revoked_at = now(), revoked_by = _actor_id,
          revoked_reason = COALESCE(_reason, 'member_offboarded')
      WHERE workspace_id = _workspace_id
        AND status = 'pending'
        AND (invited_email_normalized = _email OR invited_phone_e164 = _phone)
      RETURNING id
    )
    SELECT count(*) INTO _revoked FROM revoked;

    PERFORM public.wi_revoke_secrets(i.id, NULL, NULL)
    FROM public.workspace_invitations i
    WHERE i.workspace_id = _workspace_id
      AND i.status = 'revoked'
      AND (i.invited_email_normalized = _email OR i.invited_phone_e164 = _phone);
  END IF;

  -- 7. explicit non-cascading children (nothing cascades from workspace_members)
  DELETE FROM public.workspace_department_members
  WHERE workspace_id = _workspace_id AND user_id = _user_id;

  -- 8. RESTRICT child of workspace_members
  DELETE FROM public.workspace_member_details
  WHERE workspace_id = _workspace_id AND user_id = _user_id;

  -- 9. membership itself
  DELETE FROM public.workspace_members
  WHERE workspace_id = _workspace_id AND user_id = _user_id;

  -- 10/11. verify no workspace-scoped authorization row survives
  IF EXISTS (SELECT 1 FROM public.workspace_members
             WHERE workspace_id = _workspace_id AND user_id = _user_id)
     OR EXISTS (SELECT 1 FROM public.workspace_department_members
                WHERE workspace_id = _workspace_id AND user_id = _user_id)
     OR EXISTS (SELECT 1 FROM public.workspace_member_details
                WHERE workspace_id = _workspace_id AND user_id = _user_id) THEN
    RAISE EXCEPTION 'OFFBOARDING_INCOMPLETE';
  END IF;

  -- 12. audit from captured locals
  INSERT INTO public.audit_logs (workspace_id, user_id, action, entity_type, entity_id, new_value)
  VALUES (_workspace_id, _actor_id, 'workspace_member.offboarded', 'workspace_member', _user_id,
          jsonb_build_object('role', _target_role, 'revoked_invitations', _revoked,
                             'reason', _reason));

  RETURN jsonb_build_object(
    'workspace_id', _workspace_id,
    'user_id', _user_id,
    'revoked_invitations', _revoked
  );
END;
$$;

-- =========================================================================
-- 4. ACL — service_role only
-- =========================================================================
DO $$
DECLARE
  _fn text;
  _fns text[] := ARRAY[
    'wi_lock_and_validate_token(text,text)',
    'wi_assert_seat_available(uuid)',
    'wi_apply_departments(uuid,uuid,uuid)',
    'accept_invitation_new_user_v2(text,text,text,uuid,text,uuid,uuid,text,text,text,text)',
    'accept_invitation_existing_user_v2(text,text,uuid,text,uuid,uuid,text,text,text)',
    'offboard_workspace_member(uuid,uuid,uuid,text)'
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
END $$;

DO $verify$
DECLARE
  _bad text;
BEGIN
  SELECT string_agg(p.proname || ':' || r.rolname, ', ') INTO _bad
  FROM pg_proc p
  CROSS JOIN (VALUES ('anon'), ('authenticated')) AS r(rolname)
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname IN ('wi_lock_and_validate_token','wi_assert_seat_available','wi_apply_departments',
                      'accept_invitation_new_user_v2','accept_invitation_existing_user_v2',
                      'offboard_workspace_member')
    AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.rolname)
    AND has_function_privilege(r.rolname, p.oid, 'EXECUTE');

  IF _bad IS NOT NULL THEN
    RAISE EXCEPTION 'invitations v5.1 acceptance: unexpected client EXECUTE (%)', _bad;
  END IF;
END
$verify$;
