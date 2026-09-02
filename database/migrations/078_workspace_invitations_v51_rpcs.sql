-- 078 — Workspace Invitations v5.1: management RPCs, outbox claim and the
-- authoritative seat-entitlement mode setter (self-host chain).
--
-- Every function below is service_role-only, SECURITY DEFINER,
-- SET search_path = public, pg_temp, fully qualified, with no dynamic SQL.
-- Canonical lock order (v5.1 §6):
--   workspace -> invitation -> token/OTP/proof/context -> job -> membership.

-- =========================================================================
-- 0. Shared helpers
-- =========================================================================

-- Actor permission, revalidated inside every RPC from server-resolved ids.
CREATE OR REPLACE FUNCTION public.wi_can_manage_invitation(
  _actor_role public.workspace_role,
  _target_role public.workspace_role
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN _target_role = 'owner'::public.workspace_role THEN false
    WHEN _actor_role = 'owner'::public.workspace_role  THEN true
    WHEN _actor_role = 'admin'::public.workspace_role  THEN _target_role <> 'admin'::public.workspace_role
    ELSE false
  END;
$$;

-- Lazy expiry, always executed under the workspace lock.
CREATE OR REPLACE FUNCTION public.wi_expire_due(_workspace_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _n integer := 0;
BEGIN
  WITH due AS (
    UPDATE public.workspace_invitations
    SET status = 'expired', expired_at = COALESCE(expired_at, now())
    WHERE workspace_id = _workspace_id
      AND status = 'pending'
      AND expires_at IS NOT NULL
      AND expires_at <= now()
    RETURNING id
  )
  SELECT count(*) INTO _n FROM due;

  UPDATE public.workspace_invitation_tokens t
  SET revoked_at = now()
  FROM public.workspace_invitations i
  WHERE t.invitation_id = i.id
    AND i.workspace_id = _workspace_id
    AND i.status = 'expired'
    AND t.revoked_at IS NULL
    AND t.consumed_at IS NULL;

  UPDATE public.workspace_invitation_jobs j
  SET status = 'cancelled', updated_at = now()
  FROM public.workspace_invitations i
  WHERE j.invitation_id = i.id
    AND i.workspace_id = _workspace_id
    AND i.status = 'expired'
    AND j.status IN ('queued', 'retrying');

  RETURN _n;
END;
$$;

-- Revoke every live secret of an invitation (tokens/OTPs/proofs/contexts) and
-- cancel unclaimed jobs, optionally restricted to one generation.
CREATE OR REPLACE FUNCTION public.wi_revoke_secrets(
  _invitation_id uuid,
  _generation integer DEFAULT NULL,
  _purpose text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.workspace_invitation_tokens
  SET revoked_at = now()
  WHERE invitation_id = _invitation_id
    AND revoked_at IS NULL AND consumed_at IS NULL
    AND (_generation IS NULL OR notification_generation = _generation)
    AND (_purpose IS NULL OR purpose = _purpose);

  UPDATE public.workspace_invitation_otps
  SET revoked_at = now()
  WHERE invitation_id = _invitation_id
    AND revoked_at IS NULL AND consumed_at IS NULL
    AND (_generation IS NULL OR notification_generation = _generation);

  UPDATE public.workspace_invitation_proofs
  SET revoked_at = now()
  WHERE invitation_id = _invitation_id
    AND revoked_at IS NULL AND consumed_at IS NULL
    AND (_generation IS NULL OR notification_generation = _generation);

  UPDATE public.workspace_invitation_contexts
  SET revoked_at = now()
  WHERE invitation_id = _invitation_id
    AND revoked_at IS NULL AND consumed_at IS NULL
    AND (_generation IS NULL OR notification_generation = _generation);

  UPDATE public.workspace_invitation_jobs
  SET status = 'cancelled', updated_at = now()
  WHERE invitation_id = _invitation_id
    AND status IN ('queued', 'retrying')
    AND (_generation IS NULL OR notification_generation = _generation);
END;
$$;

-- Safe projection: never exposes a token hash, prefix, OTP or proof.
CREATE OR REPLACE FUNCTION public.wi_safe_invitation(_invitation_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'id', i.id,
    'workspace_id', i.workspace_id,
    'flow_version', i.invitation_flow_version,
    'first_name', i.first_name,
    'last_name', i.last_name,
    'email', i.invited_email_normalized,
    'phone', i.invited_phone_e164,
    'member_type', i.member_type,
    'role', i.role,
    'job_title', i.job_title,
    'staff_code', i.staff_code,
    'status', i.status,
    'expires_at', i.expires_at,
    'created_at', i.created_at,
    'created_by', i.created_by,
    'accepted_at', i.accepted_at,
    'accepted_by', i.accepted_by,
    'revoked_at', i.revoked_at,
    'revoked_reason', i.revoked_reason,
    'expired_at', i.expired_at,
    'archived_at', i.archived_at,
    'notification_generation', i.notification_generation,
    'last_email_status', i.last_email_status,
    'last_sms_status', i.last_sms_status,
    'departments', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name) ORDER BY d.sort_order, d.name)
      FROM public.workspace_invitation_departments wid
      JOIN public.workspace_departments d ON d.id = wid.department_id
      WHERE wid.invitation_id = i.id
    ), '[]'::jsonb)
  )
  FROM public.workspace_invitations i
  WHERE i.id = _invitation_id;
$$;


-- Audit helper. audit_logs.user_id carries a legacy FK to auth.users on some
-- chains while first-party identity lives in public.profiles; a missing audit
-- row must never roll back a completed invitation operation.
CREATE OR REPLACE FUNCTION public.wi_audit(
  _workspace_id uuid,
  _actor_id uuid,
  _action text,
  _entity_id uuid,
  _payload jsonb,
  _entity_type text DEFAULT 'workspace_invitation'
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.audit_logs (workspace_id, user_id, action, entity_type, entity_id, new_value)
  VALUES (_workspace_id, _actor_id, _action, _entity_type, _entity_id, _payload);
EXCEPTION
  WHEN foreign_key_violation OR not_null_violation THEN
    NULL;
END;
$$;

-- =========================================================================
-- 1. create_workspace_invitation_v2
-- =========================================================================
-- Blocker 1: the INSERT names `token` explicitly and sets it to NULL. The
-- legacy default can therefore never fire for a secure invitation.
CREATE OR REPLACE FUNCTION public.create_workspace_invitation_v2(
  _workspace_id uuid,
  _actor_id uuid,
  _first_name text,
  _last_name text,
  _email_normalized text,
  _phone_e164 text,
  _member_type text,
  _role public.workspace_role,
  _expires_at timestamptz,
  _department_ids uuid[],
  _manual_token_hash text,
  _manual_token_prefix text,
  _manual_token_expires_at timestamptz,
  _email_job_idempotency_key text,
  _sms_job_idempotency_key text,
  _email_destination_hash text,
  _sms_destination_hash text,
  _job_title text DEFAULT NULL,
  _staff_code text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _actor_role public.workspace_role;
  _invitation_id uuid;
  _dept uuid;
  _seat_limit integer;
  _seat_used integer;
BEGIN
  PERFORM 1 FROM public.workspaces WHERE id = _workspace_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'WORKSPACE_NOT_FOUND';
  END IF;

  SELECT role INTO _actor_role
  FROM public.workspace_members
  WHERE workspace_id = _workspace_id AND user_id = _actor_id;

  IF _actor_role IS NULL OR NOT public.wi_can_manage_invitation(_actor_role, _role) THEN
    RAISE EXCEPTION 'FORBIDDEN_ROLE_ESCALATION';
  END IF;

  IF _member_type NOT IN ('staff', 'customer_facing') THEN
    RAISE EXCEPTION 'INVALID_MEMBER_TYPE';
  END IF;

  IF _member_type = 'staff' AND array_length(_department_ids, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'STAFF_INVITATION_MUST_HAVE_NO_DEPARTMENT';
  END IF;

  IF _member_type = 'customer_facing' AND array_length(_department_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'CUSTOMER_FACING_INVITATION_REQUIRES_DEPARTMENT';
  END IF;

  PERFORM public.wi_expire_due(_workspace_id);

  IF EXISTS (
    SELECT 1 FROM public.workspace_invitations
    WHERE workspace_id = _workspace_id
      AND status = 'pending'
      AND (invited_email_normalized = _email_normalized
        OR invited_phone_e164 = _phone_e164)
  ) THEN
    RAISE EXCEPTION 'INVITATION_DUPLICATE';
  END IF;

  -- Advisory capacity check: creation is blocked when the workspace is full.
  SELECT limit_value, used INTO _seat_limit, _seat_used
  FROM public.wi_resolve_seat_capacity(_workspace_id);

  IF _seat_limit IS NOT NULL AND _seat_used >= _seat_limit THEN
    RAISE EXCEPTION 'SEAT_LIMIT_REACHED';
  END IF;

  INSERT INTO public.workspace_invitations (
    workspace_id, token, role, max_uses, use_count, expires_at, created_by,
    invited_email, invitation_flow_version, first_name, last_name,
    invited_email_normalized, invited_phone_e164, member_type, status,
    notification_generation, job_title, staff_code
  ) VALUES (
    _workspace_id, NULL, _role, 1, 0, _expires_at, _actor_id,
    _email_normalized, 2, _first_name, _last_name,
    _email_normalized, _phone_e164, _member_type, 'pending',
    1, _job_title, _staff_code
  )
  RETURNING id INTO _invitation_id;

  IF _department_ids IS NOT NULL THEN
    FOREACH _dept IN ARRAY _department_ids LOOP
      INSERT INTO public.workspace_invitation_departments (invitation_id, workspace_id, department_id)
      VALUES (_invitation_id, _workspace_id, _dept);
    END LOOP;
  END IF;

  -- Only the manual-handoff token hash exists at creation. The email claim
  -- token is derived by the worker after it exclusively claims the job.
  INSERT INTO public.workspace_invitation_tokens (
    invitation_id, workspace_id, purpose, token_hash, token_prefix,
    token_generation, notification_generation, expires_at
  ) VALUES (
    _invitation_id, _workspace_id, 'manual_handoff', _manual_token_hash,
    _manual_token_prefix, 1, 1, _manual_token_expires_at
  );

  INSERT INTO public.workspace_invitation_jobs (
    invitation_id, workspace_id, channel, notification_generation,
    email_token_generation, destination_hash, idempotency_key
  ) VALUES
    (_invitation_id, _workspace_id, 'email', 1, 1, _email_destination_hash, _email_job_idempotency_key),
    (_invitation_id, _workspace_id, 'sms',   1, NULL, _sms_destination_hash, _sms_job_idempotency_key);

  INSERT INTO public.workspace_invitation_deliveries (
    invitation_id, workspace_id, job_id, channel, notification_generation, status
  )
  SELECT _invitation_id, _workspace_id, j.id, j.channel, 1, 'queued'
  FROM public.workspace_invitation_jobs j
  WHERE j.invitation_id = _invitation_id;

  PERFORM public.wi_audit(_workspace_id, _actor_id, 'invitation.created', _invitation_id,
          jsonb_build_object('role', _role, 'member_type', _member_type, 'flow_version', 2));

  RETURN public.wi_safe_invitation(_invitation_id);
END;
$$;

-- =========================================================================
-- 2. edit_workspace_invitation_v2
-- =========================================================================
CREATE OR REPLACE FUNCTION public.edit_workspace_invitation_v2(
  _invitation_id uuid,
  _actor_id uuid,
  _first_name text,
  _last_name text,
  _email_normalized text,
  _phone_e164 text,
  _member_type text,
  _role public.workspace_role,
  _expires_at timestamptz,
  _department_ids uuid[],
  _email_job_idempotency_key text DEFAULT NULL,
  _sms_job_idempotency_key text DEFAULT NULL,
  _email_destination_hash text DEFAULT NULL,
  _sms_destination_hash text DEFAULT NULL,
  _job_title text DEFAULT NULL,
  _staff_code text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _workspace_id uuid;
  _actor_role public.workspace_role;
  _inv public.workspace_invitations%ROWTYPE;
  _dept uuid;
  _contact_changed boolean;
  _generation integer;
BEGIN
  -- Unlocked lookup ONLY to locate lock targets (v5.1 §6).
  SELECT workspace_id INTO _workspace_id
  FROM public.workspace_invitations WHERE id = _invitation_id;
  IF _workspace_id IS NULL THEN
    RAISE EXCEPTION 'INVITATION_NOT_FOUND';
  END IF;

  PERFORM 1 FROM public.workspaces WHERE id = _workspace_id FOR UPDATE;
  PERFORM public.wi_expire_due(_workspace_id);

  SELECT * INTO _inv FROM public.workspace_invitations
  WHERE id = _invitation_id FOR UPDATE;

  IF _inv.id IS NULL OR _inv.invitation_flow_version <> 2 OR _inv.status <> 'pending' THEN
    RAISE EXCEPTION 'INVITATION_NOT_PENDING';
  END IF;

  SELECT role INTO _actor_role FROM public.workspace_members
  WHERE workspace_id = _workspace_id AND user_id = _actor_id;

  -- Permission is revalidated against BOTH the existing and the resulting role.
  IF _actor_role IS NULL
     OR NOT public.wi_can_manage_invitation(_actor_role, _inv.role)
     OR NOT public.wi_can_manage_invitation(_actor_role, _role) THEN
    RAISE EXCEPTION 'FORBIDDEN_ROLE_ESCALATION';
  END IF;

  IF _member_type = 'staff' AND array_length(_department_ids, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'STAFF_INVITATION_MUST_HAVE_NO_DEPARTMENT';
  END IF;
  IF _member_type = 'customer_facing' AND array_length(_department_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'CUSTOMER_FACING_INVITATION_REQUIRES_DEPARTMENT';
  END IF;

  _contact_changed := (_inv.invited_email_normalized IS DISTINCT FROM _email_normalized)
                   OR (_inv.invited_phone_e164 IS DISTINCT FROM _phone_e164);
  _generation := _inv.notification_generation + CASE WHEN _contact_changed THEN 1 ELSE 0 END;

  IF _contact_changed THEN
    PERFORM public.wi_revoke_secrets(_invitation_id, _inv.notification_generation, NULL);
  END IF;

  UPDATE public.workspace_invitations
  SET first_name = _first_name,
      last_name = _last_name,
      invited_email_normalized = _email_normalized,
      invited_email = _email_normalized,
      invited_phone_e164 = _phone_e164,
      member_type = _member_type,
      role = _role,
      expires_at = _expires_at,
      job_title = _job_title,
      staff_code = _staff_code,
      notification_generation = _generation
  WHERE id = _invitation_id;

  DELETE FROM public.workspace_invitation_departments WHERE invitation_id = _invitation_id;
  IF _department_ids IS NOT NULL THEN
    FOREACH _dept IN ARRAY _department_ids LOOP
      INSERT INTO public.workspace_invitation_departments (invitation_id, workspace_id, department_id)
      VALUES (_invitation_id, _workspace_id, _dept);
    END LOOP;
  END IF;

  IF _contact_changed THEN
    IF _email_job_idempotency_key IS NULL OR _sms_job_idempotency_key IS NULL THEN
      RAISE EXCEPTION 'MISSING_JOB_IDEMPOTENCY_KEYS';
    END IF;

    INSERT INTO public.workspace_invitation_jobs (
      invitation_id, workspace_id, channel, notification_generation,
      email_token_generation, destination_hash, idempotency_key
    ) VALUES
      (_invitation_id, _workspace_id, 'email', _generation, 1, _email_destination_hash, _email_job_idempotency_key),
      (_invitation_id, _workspace_id, 'sms',   _generation, NULL, _sms_destination_hash, _sms_job_idempotency_key);

    INSERT INTO public.workspace_invitation_deliveries (
      invitation_id, workspace_id, job_id, channel, notification_generation, status
    )
    SELECT _invitation_id, _workspace_id, j.id, j.channel, _generation, 'queued'
    FROM public.workspace_invitation_jobs j
    WHERE j.invitation_id = _invitation_id AND j.notification_generation = _generation;
  END IF;

  PERFORM public.wi_audit(_workspace_id, _actor_id, 'invitation.edited', _invitation_id,
          jsonb_build_object('contact_changed', _contact_changed, 'generation', _generation));

  RETURN public.wi_safe_invitation(_invitation_id);
END;
$$;

-- =========================================================================
-- 3. resend / rotate / revoke / archive / expire
-- =========================================================================
CREATE OR REPLACE FUNCTION public.resend_invitation_email_v2(
  _invitation_id uuid,
  _actor_id uuid,
  _job_idempotency_key text,
  _destination_hash text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _workspace_id uuid;
  _actor_role public.workspace_role;
  _inv public.workspace_invitations%ROWTYPE;
  _next_token_generation integer;
  _job_id uuid;
BEGIN
  SELECT workspace_id INTO _workspace_id FROM public.workspace_invitations WHERE id = _invitation_id;
  IF _workspace_id IS NULL THEN RAISE EXCEPTION 'INVITATION_NOT_FOUND'; END IF;

  PERFORM 1 FROM public.workspaces WHERE id = _workspace_id FOR UPDATE;
  PERFORM public.wi_expire_due(_workspace_id);

  SELECT * INTO _inv FROM public.workspace_invitations WHERE id = _invitation_id FOR UPDATE;
  IF _inv.invitation_flow_version <> 2 OR _inv.status <> 'pending' THEN
    RAISE EXCEPTION 'INVITATION_NOT_PENDING';
  END IF;

  SELECT role INTO _actor_role FROM public.workspace_members
  WHERE workspace_id = _workspace_id AND user_id = _actor_id;
  IF _actor_role IS NULL OR NOT public.wi_can_manage_invitation(_actor_role, _inv.role) THEN
    RAISE EXCEPTION 'FORBIDDEN_ROLE_ESCALATION';
  END IF;

  SELECT COALESCE(max(email_token_generation), 1) + 1 INTO _next_token_generation
  FROM public.workspace_invitation_jobs
  WHERE invitation_id = _invitation_id AND channel = 'email';

  -- Previous email tokens die; the manual link is untouched.
  PERFORM public.wi_revoke_secrets(_invitation_id, NULL, 'email_claim');

  INSERT INTO public.workspace_invitation_jobs (
    invitation_id, workspace_id, channel, notification_generation,
    email_token_generation, destination_hash, idempotency_key
  ) VALUES (
    _invitation_id, _workspace_id, 'email', _inv.notification_generation,
    _next_token_generation, _destination_hash, _job_idempotency_key
  )
  RETURNING id INTO _job_id;

  INSERT INTO public.workspace_invitation_deliveries (
    invitation_id, workspace_id, job_id, channel, notification_generation, status
  ) VALUES (_invitation_id, _workspace_id, _job_id, 'email', _inv.notification_generation, 'queued');

  PERFORM public.wi_audit(_workspace_id, _actor_id, 'invitation.email_resent', _invitation_id,
          jsonb_build_object('email_token_generation', _next_token_generation));

  RETURN jsonb_build_object(
    'invitation', public.wi_safe_invitation(_invitation_id),
    'email_token_generation', _next_token_generation,
    'job_id', _job_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.rotate_manual_link_v2(
  _invitation_id uuid,
  _actor_id uuid,
  _token_hash text,
  _token_prefix text,
  _token_expires_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _workspace_id uuid;
  _actor_role public.workspace_role;
  _inv public.workspace_invitations%ROWTYPE;
  _generation integer;
BEGIN
  SELECT workspace_id INTO _workspace_id FROM public.workspace_invitations WHERE id = _invitation_id;
  IF _workspace_id IS NULL THEN RAISE EXCEPTION 'INVITATION_NOT_FOUND'; END IF;

  PERFORM 1 FROM public.workspaces WHERE id = _workspace_id FOR UPDATE;
  PERFORM public.wi_expire_due(_workspace_id);

  SELECT * INTO _inv FROM public.workspace_invitations WHERE id = _invitation_id FOR UPDATE;
  IF _inv.invitation_flow_version <> 2 OR _inv.status <> 'pending' THEN
    RAISE EXCEPTION 'INVITATION_NOT_PENDING';
  END IF;

  SELECT role INTO _actor_role FROM public.workspace_members
  WHERE workspace_id = _workspace_id AND user_id = _actor_id;
  IF _actor_role IS NULL OR NOT public.wi_can_manage_invitation(_actor_role, _inv.role) THEN
    RAISE EXCEPTION 'FORBIDDEN_ROLE_ESCALATION';
  END IF;

  SELECT COALESCE(max(token_generation), 0) + 1 INTO _generation
  FROM public.workspace_invitation_tokens
  WHERE invitation_id = _invitation_id AND purpose = 'manual_handoff';

  PERFORM public.wi_revoke_secrets(_invitation_id, NULL, 'manual_handoff');

  -- OTPs / proofs / contexts of the retired manual token die with it.
  UPDATE public.workspace_invitation_otps SET revoked_at = now()
  WHERE invitation_id = _invitation_id AND revoked_at IS NULL AND consumed_at IS NULL;
  UPDATE public.workspace_invitation_proofs SET revoked_at = now()
  WHERE invitation_id = _invitation_id AND revoked_at IS NULL AND consumed_at IS NULL;
  UPDATE public.workspace_invitation_contexts SET revoked_at = now()
  WHERE invitation_id = _invitation_id AND revoked_at IS NULL AND consumed_at IS NULL
    AND purpose = 'manual_handoff';

  INSERT INTO public.workspace_invitation_tokens (
    invitation_id, workspace_id, purpose, token_hash, token_prefix,
    token_generation, notification_generation, expires_at
  ) VALUES (
    _invitation_id, _workspace_id, 'manual_handoff', _token_hash, _token_prefix,
    _generation, _inv.notification_generation, _token_expires_at
  );

  PERFORM public.wi_audit(_workspace_id, _actor_id, 'invitation.manual_link_rotated', _invitation_id,
          jsonb_build_object('token_generation', _generation));

  RETURN jsonb_build_object(
    'invitation', public.wi_safe_invitation(_invitation_id),
    'token_generation', _generation
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_invitation_v2(
  _invitation_id uuid,
  _actor_id uuid,
  _reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _workspace_id uuid;
  _actor_role public.workspace_role;
  _inv public.workspace_invitations%ROWTYPE;
BEGIN
  IF _reason IS NULL OR btrim(_reason) = '' THEN
    RAISE EXCEPTION 'REVOKE_REASON_REQUIRED';
  END IF;

  SELECT workspace_id INTO _workspace_id FROM public.workspace_invitations WHERE id = _invitation_id;
  IF _workspace_id IS NULL THEN RAISE EXCEPTION 'INVITATION_NOT_FOUND'; END IF;

  PERFORM 1 FROM public.workspaces WHERE id = _workspace_id FOR UPDATE;
  SELECT * INTO _inv FROM public.workspace_invitations WHERE id = _invitation_id FOR UPDATE;

  IF _inv.status <> 'pending' THEN RAISE EXCEPTION 'INVITATION_NOT_PENDING'; END IF;

  SELECT role INTO _actor_role FROM public.workspace_members
  WHERE workspace_id = _workspace_id AND user_id = _actor_id;
  IF _actor_role IS NULL OR NOT public.wi_can_manage_invitation(_actor_role, _inv.role) THEN
    RAISE EXCEPTION 'FORBIDDEN_ROLE_ESCALATION';
  END IF;

  UPDATE public.workspace_invitations
  SET status = 'revoked', revoked_at = now(), revoked_by = _actor_id, revoked_reason = _reason
  WHERE id = _invitation_id;

  PERFORM public.wi_revoke_secrets(_invitation_id, NULL, NULL);

  PERFORM public.wi_audit(_workspace_id, _actor_id, 'invitation.revoked', _invitation_id,
          jsonb_build_object('reason', _reason));

  RETURN public.wi_safe_invitation(_invitation_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.archive_invitation_v2(
  _invitation_id uuid,
  _actor_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _workspace_id uuid;
  _actor_role public.workspace_role;
  _inv public.workspace_invitations%ROWTYPE;
BEGIN
  SELECT workspace_id INTO _workspace_id FROM public.workspace_invitations WHERE id = _invitation_id;
  IF _workspace_id IS NULL THEN RAISE EXCEPTION 'INVITATION_NOT_FOUND'; END IF;

  PERFORM 1 FROM public.workspaces WHERE id = _workspace_id FOR UPDATE;
  SELECT * INTO _inv FROM public.workspace_invitations WHERE id = _invitation_id FOR UPDATE;

  IF _inv.status = 'pending' THEN RAISE EXCEPTION 'INVITATION_NOT_PENDING'; END IF;

  SELECT role INTO _actor_role FROM public.workspace_members
  WHERE workspace_id = _workspace_id AND user_id = _actor_id;
  IF _actor_role IS NULL OR NOT public.wi_can_manage_invitation(_actor_role, _inv.role) THEN
    RAISE EXCEPTION 'FORBIDDEN_ROLE_ESCALATION';
  END IF;

  UPDATE public.workspace_invitations SET archived_at = now() WHERE id = _invitation_id;

  PERFORM public.wi_audit(_workspace_id, _actor_id, 'invitation.archived', _invitation_id,
          '{}'::jsonb);

  RETURN public.wi_safe_invitation(_invitation_id);
END;
$$;

-- Janitor entry point: idempotent, workspace-by-workspace, lock-ordered.
CREATE OR REPLACE FUNCTION public.expire_invitations_v2(_limit integer DEFAULT 200)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _ws uuid;
  _total integer := 0;
BEGIN
  FOR _ws IN
    SELECT DISTINCT workspace_id
    FROM public.workspace_invitations
    WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= now()
    LIMIT _limit
  LOOP
    PERFORM 1 FROM public.workspaces WHERE id = _ws FOR UPDATE;
    _total := _total + public.wi_expire_due(_ws);
  END LOOP;
  RETURN _total;
END;
$$;

-- =========================================================================
-- 4. Outbox claim (mirrors claim_channel_jobs, 048:213)
-- =========================================================================
CREATE OR REPLACE FUNCTION public.claim_invitation_jobs(
  _worker_id text,
  _limit integer DEFAULT 10,
  _lease_seconds integer DEFAULT 120,
  _channels text[] DEFAULT ARRAY['email', 'sms']
) RETURNS SETOF public.workspace_invitation_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT j.id
    FROM public.workspace_invitation_jobs j
    WHERE j.status IN ('queued', 'retrying')
      AND j.available_at <= now()
      AND j.channel = ANY(_channels)
    ORDER BY j.available_at
    LIMIT _limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.workspace_invitation_jobs j
  SET status = 'claimed',
      locked_by = _worker_id,
      locked_at = now(),
      claim_token = gen_random_uuid(),
      claim_expires_at = now() + make_interval(secs => _lease_seconds),
      attempt_count = j.attempt_count + 1,
      updated_at = now()
  FROM candidates c
  WHERE j.id = c.id
  RETURNING j.*;
END;
$$;

-- Lease reaper: an expired claim returns the job to the queue.
CREATE OR REPLACE FUNCTION public.reclaim_expired_invitation_jobs()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _n integer;
BEGIN
  WITH reclaimed AS (
    UPDATE public.workspace_invitation_jobs
    SET status = CASE WHEN attempt_count >= max_attempts THEN 'permanently_failed' ELSE 'queued' END,
        locked_by = NULL, locked_at = NULL, claim_token = NULL, claim_expires_at = NULL,
        available_at = now(),
        updated_at = now()
    WHERE status = 'claimed' AND claim_expires_at IS NOT NULL AND claim_expires_at <= now()
    RETURNING id
  )
  SELECT count(*) INTO _n FROM reclaimed;
  RETURN _n;
END;
$$;

-- =========================================================================
-- 5. Seat entitlement mode (blocker 4)
-- =========================================================================
CREATE OR REPLACE FUNCTION public.set_workspace_seat_entitlement_mode(
  _mode text,
  _source text,
  _seat_limit integer DEFAULT NULL,
  _updated_by uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _row public.workspace_seat_entitlement_mode%ROWTYPE;
BEGIN
  IF _mode NOT IN ('plan_authoritative', 'self_host_unlimited') THEN
    RAISE EXCEPTION 'INVALID_SEAT_ENTITLEMENT_MODE';
  END IF;

  IF _mode = 'self_host_unlimited' THEN
    _seat_limit := NULL;
  ELSIF _seat_limit IS NOT NULL AND _seat_limit < 0 THEN
    RAISE EXCEPTION 'INVALID_SEAT_LIMIT';
  END IF;

  INSERT INTO public.workspace_seat_entitlement_mode
    (id, mode, source, seat_limit, config_version, updated_by, updated_at)
  VALUES (true, _mode, _source, _seat_limit, 1, _updated_by, now())
  ON CONFLICT (id) DO UPDATE
    SET mode = EXCLUDED.mode,
        source = EXCLUDED.source,
        seat_limit = EXCLUDED.seat_limit,
        config_version = public.workspace_seat_entitlement_mode.config_version
          + CASE WHEN public.workspace_seat_entitlement_mode.mode <> EXCLUDED.mode
                   OR public.workspace_seat_entitlement_mode.seat_limit IS DISTINCT FROM EXCLUDED.seat_limit
                 THEN 1 ELSE 0 END,
        updated_by = EXCLUDED.updated_by,
        updated_at = now()
  RETURNING * INTO _row;

  RETURN jsonb_build_object('mode', _row.mode, 'source', _row.source,
                            'seat_limit', _row.seat_limit,
                            'config_version', _row.config_version);
END;
$$;

-- Authoritative seat capacity, resolved ENTIRELY inside the database.
--
-- SELF-HOST CHAIN BODY (v5.1 §16, blocker 4). The self-host schema has no
-- billing tables (server/services/billing/entitlementParse.ts), so this body
-- never references them: no to_regclass probing, no dynamic SQL. The authority
-- is the protected public.workspace_seat_entitlement_mode row, written by the
-- server bootstrap through set_workspace_seat_entitlement_mode():
--   self_host_unlimited -> unlimited (limit_value IS NULL)
--   plan_authoritative  -> the explicit seat_limit stored on that row
-- Anything else, including a missing row or a missing seat_limit, fails closed
-- with ENTITLEMENT_UNAVAILABLE. Missing state is NEVER unlimited.
CREATE OR REPLACE FUNCTION public.wi_resolve_seat_capacity(_workspace_id uuid)
RETURNS TABLE (limit_value integer, used integer, source text, version integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _mode text;
  _config_version integer;
  _seat_limit integer;
BEGIN
  SELECT m.mode, m.config_version, m.seat_limit
    INTO _mode, _config_version, _seat_limit
  FROM public.workspace_seat_entitlement_mode m WHERE m.id = true;

  IF _mode IS NULL THEN
    RAISE EXCEPTION 'ENTITLEMENT_UNAVAILABLE';
  END IF;

  SELECT count(*)::integer INTO used
  FROM public.workspace_members WHERE workspace_id = _workspace_id;

  IF _mode = 'self_host_unlimited' THEN
    limit_value := NULL;
    source := 'self_host_unlimited';
    version := _config_version;
    RETURN NEXT;
    RETURN;
  END IF;

  IF _seat_limit IS NULL OR _seat_limit < 0 THEN
    RAISE EXCEPTION 'ENTITLEMENT_UNAVAILABLE';
  END IF;

  limit_value := _seat_limit;
  source := 'self_host_fixed_limit';
  version := _config_version;
  RETURN NEXT;
END;
$$;

-- =========================================================================
-- 6. ACL — service_role only
-- =========================================================================
DO $$
DECLARE
  _fn text;
  _fns text[] := ARRAY[
    'wi_can_manage_invitation(public.workspace_role,public.workspace_role)',
    'wi_expire_due(uuid)',
    'wi_revoke_secrets(uuid,integer,text)',
    'wi_safe_invitation(uuid)',
    'wi_audit(uuid,uuid,text,uuid,jsonb,text)',
    'wi_resolve_seat_capacity(uuid)',
    'create_workspace_invitation_v2(uuid,uuid,text,text,text,text,text,public.workspace_role,timestamptz,uuid[],text,text,timestamptz,text,text,text,text,text,text)',
    'edit_workspace_invitation_v2(uuid,uuid,text,text,text,text,text,public.workspace_role,timestamptz,uuid[],text,text,text,text,text,text)',
    'resend_invitation_email_v2(uuid,uuid,text,text)',
    'rotate_manual_link_v2(uuid,uuid,text,text,timestamptz)',
    'revoke_invitation_v2(uuid,uuid,text)',
    'archive_invitation_v2(uuid,uuid)',
    'expire_invitations_v2(integer)',
    'claim_invitation_jobs(text,integer,integer,text[])',
    'reclaim_expired_invitation_jobs()',
    'set_workspace_seat_entitlement_mode(text,text,integer,uuid)'
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
    AND (p.proname LIKE 'wi\_%' OR p.proname LIKE '%\_invitation%\_v2' OR p.proname IN
         ('claim_invitation_jobs','reclaim_expired_invitation_jobs',
          'set_workspace_seat_entitlement_mode','expire_invitations_v2'))
    AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.rolname)
    AND has_function_privilege(r.rolname, p.oid, 'EXECUTE');

  IF _bad IS NOT NULL THEN
    RAISE EXCEPTION 'invitations v5.1 RPCs: unexpected client EXECUTE (%)', _bad;
  END IF;
END
$verify$;
