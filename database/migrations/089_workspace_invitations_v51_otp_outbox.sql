-- =========================================================================
-- WORKSPACE INVITATIONS v5.1 — B.5: close the OTP commit/delivery crash window
-- =========================================================================
-- Forward-only. Migrations 077/082/083/087/088 are NOT edited.
--
-- Problem closed here: the OTP row was committed by wi_request_invitation_otp
-- and the code was e-mailed inline afterwards. A crash, a provider outage or a
-- lost process between those two steps left a live OTP that no human ever
-- received, with no recovery path and no visible delivery state.
--
-- Fix: the OTP row and its delivery job are written in ONE transaction through
-- the existing durable outbox (workspace_invitation_jobs). The database still
-- stores ONLY the keyed OTP digest — never the six-digit code. The worker
-- re-derives the code deterministically from non-secret job material plus the
-- process-local OTP pepper (server/services/invitations/tokens.ts), so nothing
-- secret is persisted and delivery stays replayable after a crash.
--
-- Invariants preserved: canonical lock order (workspace -> invitation ->
-- token -> otp -> job), identical rate limits, service_role-only ACL,
-- SECURITY DEFINER with a pinned search_path and fully-qualified references.
-- =========================================================================

-- 1. The outbox learns one new channel: 'otp_email'.
ALTER TABLE public.workspace_invitation_jobs
  DROP CONSTRAINT IF EXISTS workspace_invitation_jobs_channel_check;
ALTER TABLE public.workspace_invitation_jobs
  ADD CONSTRAINT workspace_invitation_jobs_channel_check
  CHECK (channel IN ('email', 'sms', 'otp_email'));

ALTER TABLE public.workspace_invitation_deliveries
  DROP CONSTRAINT IF EXISTS workspace_invitation_deliveries_channel_check;
ALTER TABLE public.workspace_invitation_deliveries
  ADD CONSTRAINT workspace_invitation_deliveries_channel_check
  CHECK (channel IN ('email', 'sms', 'otp_email'));

-- The job points at the OTP it must deliver (never at the code itself).
ALTER TABLE public.workspace_invitation_jobs
  ADD COLUMN IF NOT EXISTS otp_id uuid;

CREATE INDEX IF NOT EXISTS idx_workspace_invitation_jobs_otp
  ON public.workspace_invitation_jobs (otp_id)
  WHERE otp_id IS NOT NULL;

-- 2. Atomic OTP issuance + delivery enqueue.
CREATE OR REPLACE FUNCTION public.wi_request_invitation_otp_v2(
  _token_hash text,
  _otp_id uuid,
  _code_digest text,
  _expires_at timestamptz,
  _job_idempotency_key text,
  _ip_hash text DEFAULT NULL
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
  _job_id uuid;
BEGIN
  IF _otp_id IS NULL OR _code_digest IS NULL OR _job_idempotency_key IS NULL
     OR _expires_at <= now() OR _expires_at > now() + interval '10 minutes' THEN
    RAISE EXCEPTION 'OTP_POLICY_INVALID';
  END IF;

  -- Canonical lock order lives inside this helper.
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

  -- Superseded codes die with their undelivered jobs: a code nobody received
  -- must never stay live once a new generation exists.
  UPDATE public.workspace_invitation_otps
  SET revoked_at = now()
  WHERE invitation_id = _inv.id AND consumed_at IS NULL AND revoked_at IS NULL;

  UPDATE public.workspace_invitation_jobs
  SET status = 'cancelled', claim_token = NULL, locked_by = NULL,
      claim_expires_at = NULL, updated_at = now()
  WHERE invitation_id = _inv.id
    AND channel = 'otp_email'
    AND status IN ('queued', 'retrying');

  INSERT INTO public.workspace_invitation_otps (
    id, invitation_id, workspace_id, email_normalized, manual_token_id,
    manual_token_generation, notification_generation, code_digest,
    expires_at, ip_hash
  ) VALUES (
    _otp_id, _inv.id, _inv.workspace_id, _inv.invited_email_normalized, _tok.id,
    _tok.token_generation, _inv.notification_generation, _code_digest,
    _expires_at, _ip_hash
  );

  INSERT INTO public.workspace_invitation_jobs (
    invitation_id, workspace_id, channel, notification_generation,
    destination_hash, idempotency_key, otp_id, max_attempts
  ) VALUES (
    _inv.id, _inv.workspace_id, 'otp_email', _inv.notification_generation,
    encode(digest(_inv.invited_email_normalized, 'sha256'), 'hex'),
    _job_idempotency_key, _otp_id, 3
  )
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO _job_id;

  IF _job_id IS NULL THEN
    SELECT id INTO _job_id FROM public.workspace_invitation_jobs
    WHERE idempotency_key = _job_idempotency_key;
  END IF;

  -- Secret-free projection: no code, no token, no phone number.
  RETURN jsonb_build_object(
    'otp_id', _otp_id,
    'job_id', _job_id,
    'invitation_id', _inv.id,
    'workspace_id', _inv.workspace_id,
    'expires_at', _expires_at
  );
END;
$$;

-- 3. Worker-side preflight: is the OTP this job carries still worth sending?
CREATE OR REPLACE FUNCTION public.wi_otp_job_sendable(_job_id uuid, _claim_token uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    (SELECT jsonb_build_object(
       'sendable', o.consumed_at IS NULL AND o.revoked_at IS NULL AND o.expires_at > now(),
       'otp_id', o.id,
       'invitation_id', o.invitation_id,
       'workspace_id', o.workspace_id,
       'email', o.email_normalized,
       'expires_at', o.expires_at)
     FROM public.workspace_invitation_jobs j
     JOIN public.workspace_invitation_otps o ON o.id = j.otp_id
     WHERE j.id = _job_id
       AND j.claim_token = _claim_token
       AND j.status = 'claimed'
       AND j.claim_expires_at > now()),
    jsonb_build_object('sendable', false));
$$;

-- 4. Recovery: an OTP whose delivery permanently failed must not stay live.
CREATE OR REPLACE FUNCTION public.wi_revoke_undelivered_otp(_job_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE _otp uuid;
BEGIN
  SELECT otp_id INTO _otp FROM public.workspace_invitation_jobs WHERE id = _job_id;
  IF _otp IS NULL THEN RETURN false; END IF;
  UPDATE public.workspace_invitation_otps
  SET revoked_at = now()
  WHERE id = _otp AND consumed_at IS NULL AND revoked_at IS NULL;
  RETURN FOUND;
END;
$$;

-- 5. ACL — service_role only, like every other v5.1 RPC.
DO $acl$
DECLARE
  _fn text;
  _fns text[] := ARRAY[
    'wi_request_invitation_otp_v2(text,uuid,text,timestamptz,text,text)',
    'wi_otp_job_sendable(uuid,uuid)',
    'wi_revoke_undelivered_otp(uuid)'
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
DECLARE _fn text;
BEGIN
  FOREACH _fn IN ARRAY ARRAY[
    'public.wi_request_invitation_otp_v2(text,uuid,text,timestamptz,text,text)',
    'public.wi_otp_job_sendable(uuid,uuid)',
    'public.wi_revoke_undelivered_otp(uuid)'
  ] LOOP
    IF has_function_privilege('anon', _fn, 'EXECUTE')
       OR has_function_privilege('authenticated', _fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'OTP outbox ACL proof failed for %', _fn;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'workspace_invitation_jobs'
      AND column_name = 'otp_id'
  ) THEN
    RAISE EXCEPTION 'otp_id column missing';
  END IF;
END
$verify$;

-- 6. Dispatcher: otp_request now issues code + delivery job atomically.
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
    'login_context', 'otp_request', 'otp_verify', 'accept_new', 'accept_existing'
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

  -- scope / fingerprint binding: the same key may never mean two things.
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

  -- Reaching here the row is ours (just inserted) or a stale/failed remnant.
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
      -- v5.1 B.5: the OTP row and its delivery job commit together.
      _result := public.wi_request_invitation_otp_v2(
        _token_hash          := _args ->> 'token_hash',
        _otp_id              := (_args ->> 'otp_id')::uuid,
        _code_digest         := _args ->> 'code_digest',
        _expires_at          := (_args ->> 'expires_at')::timestamptz,
        _job_idempotency_key := _args ->> 'job_idempotency_key',
        _ip_hash             := _args ->> 'ip_hash'
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

    ELSE
      RAISE EXCEPTION 'IDEMPOTENCY_OPERATION_UNKNOWN';
  END CASE;

  -- Secret-free projection. Explicit allow-list: nothing else is ever stored.
  -- Some primitives return the safe invitation directly, others wrap it in
  -- an 'invitation' member; normalize before projecting.
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
    'member_type', coalesce(_result ->> 'member_type', _inv_json ->> 'member_type')
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
