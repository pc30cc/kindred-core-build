-- =========================================================================
-- WORKSPACE INVITATIONS v5.1 §10 — offboarding idempotency (Section C.3)
-- =========================================================================
-- Forward-only follow-up to 088. Member offboarding was the last member-
-- lifecycle mutation still executed OUTSIDE the atomic idempotency ledger:
-- DELETE /api/workspace-members/:id called offboard_workspace_member()
-- directly, so a lost response followed by a client retry re-ran a full
-- destructive offboarding (second history row, second audit entry, second
-- invitation-revocation sweep) instead of replaying the committed outcome.
--
-- This migration re-creates public.wi_execute_idempotent with ONE addition:
-- the 'offboard' operation. Everything else — the fingerprint/scope binding,
-- the in-transaction commit of the ledger row and the secret-free projection
-- allow-list — is byte-for-byte the 088 behaviour. Two extra projected keys
-- ('revoked_invitations', 'offboarded_at') are non-secret counters/timestamps
-- returned by the offboarding RPC itself.
--
-- 087/088 are NOT modified. This file only replaces the function body.
-- =========================================================================

CREATE OR REPLACE FUNCTION public.wi_execute_idempotent(
  _key text,
  _fingerprint text,
  _operation text,
  _scope_kind text,
  _workspace_id uuid,
  _invitation_id uuid,
  _actor_id uuid,
  _args jsonb,
  _ttl_seconds integer DEFAULT 86400
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _row public.workspace_invitation_idempotency%ROWTYPE;
  _result jsonb;
  _safe jsonb;
  _code text;
  _depts uuid[];
  _inv_json jsonb;
BEGIN
  IF _key IS NULL OR length(_key) < 16 THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED'; END IF;
  IF _fingerprint IS NULL OR length(_fingerprint) < 16 THEN RAISE EXCEPTION 'IDEMPOTENCY_FINGERPRINT_REQUIRED'; END IF;
  IF _operation NOT IN (
    'create', 'edit', 'resend', 'rotate', 'revoke', 'archive',
    'login_context', 'otp_request', 'otp_verify', 'accept_new', 'accept_existing',
    'offboard'
  ) THEN
    RAISE EXCEPTION 'IDEMPOTENCY_OPERATION_UNKNOWN';
  END IF;

  INSERT INTO public.workspace_invitation_idempotency
    (key, scope_kind, operation, workspace_id, invitation_id, actor_id,
     request_fingerprint, result_state, expires_at)
  VALUES
    (_key, _scope_kind, _operation, _workspace_id, _invitation_id, _actor_id,
     _fingerprint, 'in_progress', now() + make_interval(secs => greatest(_ttl_seconds, 60)))
  ON CONFLICT (key) DO NOTHING;

  SELECT * INTO _row FROM public.workspace_invitation_idempotency
  WHERE key = _key FOR UPDATE;

  IF _row.key IS NULL THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;

  IF _row.operation IS DISTINCT FROM _operation
     OR _row.scope_kind IS DISTINCT FROM _scope_kind
     OR _row.request_fingerprint IS DISTINCT FROM _fingerprint
     OR (_workspace_id IS NOT NULL AND _row.workspace_id IS DISTINCT FROM _workspace_id) THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED';
  END IF;

  IF _row.result_state = 'committed' THEN
    RETURN jsonb_build_object(
      'replayed', true,
      'result_code', coalesce(_row.result_code, 'COMMITTED'),
      'safe_result', coalesce(_row.safe_result, '{}'::jsonb)
    );
  END IF;

  IF _row.completed_at IS NOT NULL THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;

  CASE _operation
    WHEN 'create' THEN
      SELECT array_agg(d::uuid) INTO _depts
      FROM jsonb_array_elements_text(coalesce(_args -> 'department_ids', '[]'::jsonb)) AS t(d);
      _result := public.create_workspace_invitation_v2(
        _workspace_id                := _workspace_id,
        _actor_id                    := _actor_id,
        _first_name                  := _args ->> 'first_name',
        _last_name                   := _args ->> 'last_name',
        _email_normalized            := _args ->> 'email_normalized',
        _phone_e164                  := _args ->> 'phone_e164',
        _member_type                 := _args ->> 'member_type',
        _role                        := (_args ->> 'role')::public.workspace_role,
        _expires_at                  := (_args ->> 'expires_at')::timestamptz,
        _department_ids              := CASE WHEN coalesce(array_length(_depts, 1), 0) = 0 THEN NULL ELSE _depts END,
        _manual_token_hash           := _args ->> 'manual_token_hash',
        _manual_token_prefix         := _args ->> 'manual_token_prefix',
        _manual_token_expires_at     := (_args ->> 'manual_token_expires_at')::timestamptz,
        _email_job_idempotency_key   := _args ->> 'email_job_idempotency_key',
        _sms_job_idempotency_key     := _args ->> 'sms_job_idempotency_key',
        _email_destination_hash      := _args ->> 'email_destination_hash',
        _sms_destination_hash        := _args ->> 'sms_destination_hash',
        _job_title                   := _args ->> 'job_title',
        _staff_code                  := _args ->> 'staff_code'
      );
      _code := 'OPERATION_COMMITTED_LINK_NOT_REPLAYABLE';

    WHEN 'edit' THEN
      SELECT array_agg(d::uuid) INTO _depts
      FROM jsonb_array_elements_text(coalesce(_args -> 'department_ids', '[]'::jsonb)) AS t(d);
      _result := public.edit_workspace_invitation_v2(
        _invitation_id               := _invitation_id,
        _actor_id                    := _actor_id,
        _first_name                  := _args ->> 'first_name',
        _last_name                   := _args ->> 'last_name',
        _email_normalized            := _args ->> 'email_normalized',
        _phone_e164                  := _args ->> 'phone_e164',
        _member_type                 := _args ->> 'member_type',
        _role                        := (_args ->> 'role')::public.workspace_role,
        _expires_at                  := (_args ->> 'expires_at')::timestamptz,
        _department_ids              := CASE WHEN coalesce(array_length(_depts, 1), 0) = 0 THEN NULL ELSE _depts END,
        _email_job_idempotency_key   := _args ->> 'email_job_idempotency_key',
        _sms_job_idempotency_key     := _args ->> 'sms_job_idempotency_key',
        _email_destination_hash      := _args ->> 'email_destination_hash',
        _sms_destination_hash        := _args ->> 'sms_destination_hash',
        _job_title                   := _args ->> 'job_title',
        _staff_code                  := _args ->> 'staff_code'
      );
      _code := 'COMMITTED';

    WHEN 'resend' THEN
      _result := public.resend_invitation_email_v2(
        _invitation_id     := _invitation_id,
        _actor_id          := _actor_id,
        _job_idempotency_key := _args ->> 'job_idempotency_key',
        _destination_hash  := _args ->> 'destination_hash'
      );
      _code := 'COMMITTED';

    WHEN 'rotate' THEN
      _result := public.rotate_manual_link_v2(
        _invitation_id     := _invitation_id,
        _actor_id          := _actor_id,
        _token_hash        := _args ->> 'token_hash',
        _token_prefix      := _args ->> 'token_prefix',
        _token_expires_at  := (_args ->> 'token_expires_at')::timestamptz
      );
      _code := 'OPERATION_COMMITTED_LINK_NOT_REPLAYABLE';

    WHEN 'revoke' THEN
      _result := public.revoke_invitation_v2(
        _invitation_id := _invitation_id,
        _actor_id      := _actor_id,
        _reason        := _args ->> 'reason'
      );
      _code := 'COMMITTED';

    WHEN 'archive' THEN
      _result := public.archive_invitation_v2(
        _invitation_id := _invitation_id,
        _actor_id      := _actor_id
      );
      _code := 'COMMITTED';

    WHEN 'login_context' THEN
      _result := public.wi_create_login_context(
        _token_hash  := _args ->> 'token_hash',
        _purpose     := _args ->> 'purpose',
        _handle_hash := _args ->> 'handle_hash',
        _expires_at  := (_args ->> 'expires_at')::timestamptz
      );
      _code := 'COMMITTED';

    WHEN 'otp_request' THEN
      _result := public.wi_request_invitation_otp(
        _token_hash  := _args ->> 'token_hash',
        _code_digest := _args ->> 'code_digest',
        _expires_at  := (_args ->> 'expires_at')::timestamptz,
        _ip_hash     := _args ->> 'ip_hash'
      );
      _code := 'COMMITTED';

    WHEN 'otp_verify' THEN
      _result := public.wi_verify_invitation_otp(
        _token_hash        := _args ->> 'token_hash',
        _code_digest       := _args ->> 'code_digest',
        _proof_hash        := _args ->> 'proof_hash',
        _proof_expires_at  := (_args ->> 'proof_expires_at')::timestamptz
      );
      _code := 'COMMITTED';

    WHEN 'accept_new' THEN
      _result := public.accept_invitation_new_user_v2(
        _token_hash         := _args ->> 'token_hash',
        _purpose            := _args ->> 'purpose',
        _proof_hash         := _args ->> 'proof_hash',
        _user_id            := (_args ->> 'user_id')::uuid,
        _password_hash      := _args ->> 'password_hash',
        _terms_version_id   := (_args ->> 'terms_version_id')::uuid,
        _privacy_version_id := (_args ->> 'privacy_version_id')::uuid,
        _acceptance_method  := _args ->> 'acceptance_method',
        _locale             := _args ->> 'locale',
        _ip                 := _args ->> 'ip',
        _user_agent         := _args ->> 'user_agent'
      );
      _code := 'COMMITTED';

    WHEN 'accept_existing' THEN
      _result := public.accept_invitation_existing_context_v2(
        _handle_hash              := _args ->> 'handle_hash',
        _session_user_id          := (_args ->> 'session_user_id')::uuid,
        _session_email_normalized := _args ->> 'session_email_normalized',
        _terms_version_id         := (_args ->> 'terms_version_id')::uuid,
        _privacy_version_id       := (_args ->> 'privacy_version_id')::uuid,
        _locale                   := _args ->> 'locale',
        _ip                       := _args ->> 'ip',
        _user_agent               := _args ->> 'user_agent'
      );
      _code := 'COMMITTED';

    -- NEW (Section C.3): destructive member offboarding, replay-safe.
    WHEN 'offboard' THEN
      _result := public.offboard_workspace_member(
        _workspace_id := _workspace_id,
        _user_id      := (_args ->> 'user_id')::uuid,
        _actor_id     := _actor_id,
        _reason       := _args ->> 'reason'
      );
      _code := 'COMMITTED';

    ELSE
      RAISE EXCEPTION 'IDEMPOTENCY_OPERATION_UNKNOWN';
  END CASE;

  -- Secret-free projection. Explicit allow-list: nothing else is ever stored.
  _inv_json := CASE
    WHEN jsonb_typeof(_result -> 'invitation') = 'object' THEN _result -> 'invitation'
    ELSE coalesce(_result, '{}'::jsonb)
  END;

  _safe := jsonb_strip_nulls(jsonb_build_object(
    'operation', _operation,
    'invitation_id', coalesce(
      _result ->> 'invitation_id', _inv_json ->> 'invitation_id',
      _inv_json ->> 'id', _invitation_id::text),
    'workspace_id', coalesce(
      _result ->> 'workspace_id', _inv_json ->> 'workspace_id', _workspace_id::text),
    'status', coalesce(_result ->> 'status', _inv_json ->> 'status'),
    'notification_generation', coalesce(_result -> 'notification_generation', _inv_json -> 'notification_generation'),
    'token_generation', coalesce(_result -> 'token_generation', _result -> 'email_token_generation'),
    'user_id', coalesce(_result ->> 'user_id', _inv_json ->> 'accepted_by'),
    'role', coalesce(_result ->> 'role', _inv_json ->> 'role'),
    'member_type', coalesce(_result ->> 'member_type', _inv_json ->> 'member_type'),
    'revoked_invitations', _result -> 'revoked_invitations',
    'offboarded_at', _result ->> 'offboarded_at'
  ));

  UPDATE public.workspace_invitation_idempotency
  SET result_state = 'committed',
      result_code = _code,
      safe_result = _safe,
      invitation_id = coalesce(invitation_id, nullif(_safe ->> 'invitation_id', '')::uuid),
      workspace_id = coalesce(workspace_id, nullif(_safe ->> 'workspace_id', '')::uuid),
      completed_at = now()
  WHERE key = _key;

  RETURN jsonb_build_object(
    'replayed', false,
    'result_code', _code,
    'safe_result', _safe,
    'result', _result
  );
END;
$$;

DO $acl$
DECLARE
  _fn text := 'wi_execute_idempotent(text,text,text,text,uuid,uuid,uuid,jsonb,integer)';
BEGIN
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
END
$acl$;

DO $verify$
DECLARE
  _fn text := 'public.wi_execute_idempotent(text,text,text,text,uuid,uuid,uuid,jsonb,integer)';
  _role text;
BEGIN
  IF to_regprocedure(_fn) IS NULL THEN RAISE EXCEPTION 'missing RPC: %', _fn; END IF;
  IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(_fn)) THEN
    RAISE EXCEPTION 'RPC is not SECURITY DEFINER: %', _fn;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure(_fn) AND p.proconfig @> ARRAY['search_path=public, pg_temp']
  ) THEN
    RAISE EXCEPTION 'RPC has no pinned search_path: %', _fn;
  END IF;
  IF to_regprocedure('public.offboard_workspace_member(uuid,uuid,uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'missing dependency: public.offboard_workspace_member(uuid,uuid,uuid,text)';
  END IF;
  FOREACH _role IN ARRAY ARRAY['public', 'anon', 'authenticated'] LOOP
    IF (_role = 'public' OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = _role))
       AND has_function_privilege(_role, to_regprocedure(_fn), 'EXECUTE') THEN
      RAISE EXCEPTION 'privilege leak: % may EXECUTE %', _role, _fn;
    END IF;
  END LOOP;
END
$verify$;
