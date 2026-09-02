-- =========================================================================
-- WORKSPACE INVITATIONS v5.1 — A-residual (canonical account_exists) and
-- B (atomic, crash-safe idempotency) — self-host chain, forward-only.
-- =========================================================================
-- Nothing in 082 / 085 / 086 is edited. Both preview RPCs are re-created with
-- CREATE OR REPLACE so the running installation is upgraded in place.
--
-- A-residual — canonical account_exists rule (identical in both previews):
--   profile + user_credentials.password_hash IS NOT NULL -> true
--   profile without user_credentials                     -> false
--   profile with user_credentials but NULL password_hash -> false
-- A disabled/blocked profile is NOT special-cased here: accept-new keeps
-- raising ACCOUNT_DISABLED from accept_invitation_new_user_v2, so the preview
-- keeps reporting "an account exists, log in" for a disabled account, exactly
-- as the accept contract expects. (Tested explicitly.)
--
-- B — one logical mutation, one transaction. The ledger row, the mutation and
-- the recorded result are written by the SAME transaction, so:
--   * a crash/rollback removes the ledger row -> no permanent in_progress,
--   * a concurrent request with the same key blocks on FOR UPDATE and then
--     observes the committed result,
--   * the same key with a different fingerprint fails closed,
--   * the ledger stores only secret-free projections.
-- No dynamic SQL: the operation is dispatched by a static CASE.
-- =========================================================================

-- ── A-residual: canonical predicate ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.wi_account_exists(_email_normalized text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles p
    JOIN public.user_credentials c ON c.user_id = p.id
    WHERE lower(p.email) = lower(_email_normalized)
      AND c.password_hash IS NOT NULL
  )
$$;

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
  );
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
    'account_exists', public.wi_account_exists(_inv.invited_email_normalized)
  );
END;
$$;

-- ── B: ledger shape ─────────────────────────────────────────────────────
ALTER TABLE public.workspace_invitation_idempotency
  ADD COLUMN IF NOT EXISTS request_fingerprint text,
  ADD COLUMN IF NOT EXISTS safe_result jsonb,
  ADD COLUMN IF NOT EXISTS result_code text,
  ADD COLUMN IF NOT EXISTS actor_id uuid,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

ALTER TABLE public.workspace_invitation_idempotency
  DROP CONSTRAINT IF EXISTS workspace_invitation_idempotency_state_check;
ALTER TABLE public.workspace_invitation_idempotency
  ADD CONSTRAINT workspace_invitation_idempotency_state_check
  CHECK (result_state IN ('in_progress', 'committed', 'failed'));

CREATE INDEX IF NOT EXISTS idx_wi_idempotency_expires_at
  ON public.workspace_invitation_idempotency (expires_at);

-- Purge is limited to expired rows and never touches live state.
CREATE OR REPLACE FUNCTION public.wi_purge_expired_idempotency(_limit integer DEFAULT 1000)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _n integer;
BEGIN
  WITH doomed AS (
    SELECT key FROM public.workspace_invitation_idempotency
    WHERE expires_at <= now()
    ORDER BY expires_at
    LIMIT greatest(_limit, 0)
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.workspace_invitation_idempotency i
  USING doomed d WHERE i.key = d.key;
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n;
END;
$$;

-- ── B: the single-transaction idempotent executor ───────────────────────
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
  _fresh boolean := false;
  _result jsonb;
  _safe jsonb;
  _code text;
  _depts uuid[];
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

  _fresh := (_row.result_state = 'in_progress'
             AND _row.completed_at IS NULL
             AND _row.request_fingerprint IS NOT DISTINCT FROM _fingerprint
             AND _row.xmin::text = txid_current()::text) OR false;

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
      SELECT ARRAY(SELECT (jsonb_array_elements_text(coalesce(_args -> 'department_ids', '[]'::jsonb)))::uuid)
        INTO _depts;
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
      SELECT ARRAY(SELECT (jsonb_array_elements_text(coalesce(_args -> 'department_ids', '[]'::jsonb)))::uuid)
        INTO _depts;
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
  END CASE;

  -- Secret-free projection. Explicit allow-list: nothing else is ever stored.
  _safe := jsonb_strip_nulls(jsonb_build_object(
    'operation', _operation,
    'invitation_id', coalesce(_result ->> 'invitation_id', _invitation_id::text),
    'workspace_id', coalesce(_result ->> 'workspace_id', _workspace_id::text),
    'status', _result ->> 'status',
    'notification_generation', _result -> 'notification_generation',
    'token_generation', _result -> 'token_generation',
    'user_id', _result ->> 'user_id',
    'role', _result ->> 'role',
    'member_type', _result ->> 'member_type'
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

-- ── ACL: service_role only ──────────────────────────────────────────────
DO $acl$
DECLARE
  _fn text;
  _fns text[] := ARRAY[
    'wi_account_exists(text)',
    'wi_preview_invitation(text,text)',
    'wi_preview_login_context(text)',
    'wi_purge_expired_idempotency(integer)',
    'wi_execute_idempotent(text,text,text,text,uuid,uuid,uuid,jsonb,integer)'
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
    'public.wi_account_exists(text)',
    'public.wi_preview_invitation(text,text)',
    'public.wi_preview_login_context(text)',
    'public.wi_execute_idempotent(text,text,text,text,uuid,uuid,uuid,jsonb,integer)'
  ];
BEGIN
  FOREACH _fn IN ARRAY _fns LOOP
    IF to_regprocedure(_fn) IS NULL THEN
      RAISE EXCEPTION 'missing RPC: %', _fn;
    END IF;
    IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(_fn)) THEN
      RAISE EXCEPTION 'RPC is not SECURITY DEFINER: %', _fn;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
      WHERE p.oid = to_regprocedure(_fn)
        AND p.proconfig @> ARRAY['search_path=public, pg_temp']
    ) THEN
      RAISE EXCEPTION 'RPC has no pinned search_path: %', _fn;
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
