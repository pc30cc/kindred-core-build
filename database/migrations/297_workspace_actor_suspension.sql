-- 297 — a suspended or seat-locked member no longer manages invitations.
--
-- APPLIED BY HAND ON WEBYAR, BEFORE THE MERGE of the code that ships with it
-- (CLAUDE.md, "Migrations"): a dry run inside BEGIN … ROLLBACK first, then
-- scripts/migrate-database.sh as postgres. RESPOK's migrator applies it on
-- push. It writes no data, and the code does not need it (the routes refuse
-- a suspended or seat-locked actor on their own, through
-- authorizeWorkspaceAccess); it is the database's own line behind them.
--
-- The invitation primitives (create, edit, resend, rotate the manual link,
-- revoke, archive, delete) and offboard_workspace_member decided who may act from the actor's
-- workspace_members.role alone. A member an owner had suspended
-- (suspended_at, migration 096), or whose seat the plan has paused
-- (billing_is_locked, migration 265), kept that role and so kept inviting:
-- a suspended admin could invite a second address of their own and come
-- back in. Each function now reads the actor's role through
-- wi_active_actor_role(), which answers NULL for such a member, so the
-- function refuses exactly as it refuses a non-member (FORBIDDEN_ROLE_ESCALATION;
-- FORBIDDEN for the delete).
--
-- Every function below is its latest definition (create and edit: 251;
-- resend, rotate, revoke, archive: 078; delete: 209; offboard: 278b),
-- unchanged but for that one lookup. Same signatures, SECURITY DEFINER, pinned search_path and
-- service_role-only grants. Idempotent: CREATE OR REPLACE, so a second run
-- changes nothing.
--
-- Locks: none beyond each CREATE OR REPLACE's own, briefly.
--
-- The way back: re-run the eight definitions from 251, 078, 209 and 278b
-- (they only differ in the actor lookup), then DROP FUNCTION
-- public.wi_active_actor_role(uuid, uuid).

-- The actor's role when they may act in the workspace now: a member, not
-- suspended, and not past the plan's seat limit (the owner never is, and
-- nobody is while the edition's lock switch is off). NULL otherwise.
CREATE OR REPLACE FUNCTION public.wi_active_actor_role(_workspace_id uuid, _actor_id uuid)
RETURNS public.workspace_role
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT m.role
    FROM public.workspace_members m
   WHERE m.workspace_id = _workspace_id
     AND m.user_id = _actor_id
     AND m.suspended_at IS NULL
     AND NOT public.billing_is_locked(_workspace_id, 'member', _actor_id)
$$;

REVOKE ALL ON FUNCTION public.wi_active_actor_role(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.wi_active_actor_role(uuid, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wi_active_actor_role(uuid, uuid) TO service_role;

-- create_workspace_invitation_v2: 251_production_parity.sql, unchanged but for the actor lookup.
CREATE OR REPLACE FUNCTION public.create_workspace_invitation_v2(_workspace_id uuid, _actor_id uuid, _first_name text, _last_name text, _email_normalized text, _phone_e164 text, _member_type text, _role workspace_role, _expires_at timestamp with time zone, _department_ids uuid[], _manual_token_hash text, _manual_token_prefix text, _manual_token_expires_at timestamp with time zone, _email_job_idempotency_key text, _sms_job_idempotency_key text, _email_destination_hash text, _sms_destination_hash text, _job_title text DEFAULT NULL::text, _staff_code text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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

  _actor_role := public.wi_active_actor_role(_workspace_id, _actor_id);

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
        OR (_phone_e164 IS NOT NULL AND invited_phone_e164 = _phone_e164))
  ) THEN
    RAISE EXCEPTION 'INVITATION_DUPLICATE';
  END IF;

  SELECT c.limit_value, c.used INTO _seat_limit, _seat_used
  FROM public.wi_resolve_seat_capacity(_workspace_id) c;

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
    (_invitation_id, _workspace_id, 'email', 1, 1, _email_destination_hash, _email_job_idempotency_key);

  IF _phone_e164 IS NOT NULL THEN
    INSERT INTO public.workspace_invitation_jobs (
      invitation_id, workspace_id, channel, notification_generation,
      email_token_generation, destination_hash, idempotency_key
    ) VALUES
      (_invitation_id, _workspace_id, 'sms', 1, NULL, _sms_destination_hash, _sms_job_idempotency_key);
  END IF;

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
$function$;

-- edit_workspace_invitation_v2: 251_production_parity.sql, unchanged but for the actor lookup.
CREATE OR REPLACE FUNCTION public.edit_workspace_invitation_v2(_invitation_id uuid, _actor_id uuid, _first_name text, _last_name text, _email_normalized text, _phone_e164 text, _member_type text, _role workspace_role, _expires_at timestamp with time zone, _department_ids uuid[], _email_job_idempotency_key text DEFAULT NULL::text, _sms_job_idempotency_key text DEFAULT NULL::text, _email_destination_hash text DEFAULT NULL::text, _sms_destination_hash text DEFAULT NULL::text, _job_title text DEFAULT NULL::text, _staff_code text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _workspace_id uuid;
  _actor_role public.workspace_role;
  _inv public.workspace_invitations%ROWTYPE;
  _dept uuid;
  _contact_changed boolean;
  _generation integer;
BEGIN
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

  _actor_role := public.wi_active_actor_role(_workspace_id, _actor_id);

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
    IF _email_job_idempotency_key IS NULL
       OR (_phone_e164 IS NOT NULL AND _sms_job_idempotency_key IS NULL) THEN
      RAISE EXCEPTION 'MISSING_JOB_IDEMPOTENCY_KEYS';
    END IF;

    INSERT INTO public.workspace_invitation_jobs (
      invitation_id, workspace_id, channel, notification_generation,
      email_token_generation, destination_hash, idempotency_key
    ) VALUES
      (_invitation_id, _workspace_id, 'email', _generation, 1, _email_destination_hash, _email_job_idempotency_key);

    IF _phone_e164 IS NOT NULL THEN
      INSERT INTO public.workspace_invitation_jobs (
        invitation_id, workspace_id, channel, notification_generation,
        email_token_generation, destination_hash, idempotency_key
      ) VALUES
        (_invitation_id, _workspace_id, 'sms', _generation, NULL, _sms_destination_hash, _sms_job_idempotency_key);
    END IF;

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
$function$;

-- resend_invitation_email_v2: 078_workspace_invitations_v51_rpcs.sql, unchanged but for the actor lookup.
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

  _actor_role := public.wi_active_actor_role(_workspace_id, _actor_id);
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

-- rotate_manual_link_v2: 078_workspace_invitations_v51_rpcs.sql, unchanged but for the actor lookup.
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

  _actor_role := public.wi_active_actor_role(_workspace_id, _actor_id);
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

-- revoke_invitation_v2: 078_workspace_invitations_v51_rpcs.sql, unchanged but for the actor lookup.
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

  _actor_role := public.wi_active_actor_role(_workspace_id, _actor_id);
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

-- archive_invitation_v2: 078_workspace_invitations_v51_rpcs.sql, unchanged but for the actor lookup.
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

  _actor_role := public.wi_active_actor_role(_workspace_id, _actor_id);
  IF _actor_role IS NULL OR NOT public.wi_can_manage_invitation(_actor_role, _inv.role) THEN
    RAISE EXCEPTION 'FORBIDDEN_ROLE_ESCALATION';
  END IF;

  UPDATE public.workspace_invitations SET archived_at = now() WHERE id = _invitation_id;

  PERFORM public.wi_audit(_workspace_id, _actor_id, 'invitation.archived', _invitation_id,
          '{}'::jsonb);

  RETURN public.wi_safe_invitation(_invitation_id);
END;
$$;

-- wi_delete_invitation: 209_workspace_invitations_v51_account_exists_and_delete.sql, unchanged but for the actor lookup.
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

  _actor_role := public.wi_active_actor_role(_workspace_id, _actor_id)::text;
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

-- offboard_workspace_member: 278b_chat_routing_member_release.sql, unchanged but for the actor lookup.
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
  _revoked_ids uuid[] := ARRAY[]::uuid[];
  _released uuid[] := ARRAY[]::uuid[];
BEGIN
  -- 278b: the routing lock before the workspace row (the order
  -- chat_route_claim takes them in); re-entrant, so the release below takes
  -- it again for nothing.
  PERFORM pg_advisory_xact_lock(hashtextextended('chat_route_claim:' || _workspace_id::text, 0));

  SELECT owner_id INTO _owner_id FROM public.workspaces WHERE id = _workspace_id FOR UPDATE;
  IF _owner_id IS NULL THEN RAISE EXCEPTION 'WORKSPACE_NOT_FOUND'; END IF;

  SELECT role INTO _target_role FROM public.workspace_members
  WHERE workspace_id = _workspace_id AND user_id = _user_id FOR UPDATE;
  IF _target_role IS NULL THEN RAISE EXCEPTION 'MEMBER_NOT_FOUND'; END IF;

  IF _user_id = _owner_id OR _target_role = 'owner'::public.workspace_role THEN
    RAISE EXCEPTION 'CANNOT_REMOVE_WORKSPACE_OWNER';
  END IF;

  _actor_role := public.wi_active_actor_role(_workspace_id, _actor_id);
  IF _actor_role IS NULL OR NOT public.wi_can_manage_invitation(_actor_role, _target_role) THEN
    RAISE EXCEPTION 'FORBIDDEN_ROLE_ESCALATION';
  END IF;

  SELECT d.first_name, d.last_name, d.work_email_normalized, d.work_phone_e164,
         d.member_type, d.job_title, d.staff_code, d.invited_by, d.invitation_id, d.joined_at
    INTO _first_name, _last_name, _email, _phone,
         _member_type, _job_title, _staff_code, _invited_by, _invitation_id, _joined_at
  FROM public.workspace_member_details d
  WHERE d.workspace_id = _workspace_id AND d.user_id = _user_id;

  INSERT INTO public.workspace_member_details_history (
    workspace_id, user_id, first_name, last_name, work_email_normalized, work_phone_e164,
    member_type, job_title, staff_code, invited_by, invitation_id, joined_at,
    offboarded_by, reason
  ) VALUES (
    _workspace_id, _user_id, _first_name, _last_name, _email, _phone,
    _member_type, _job_title, _staff_code, _invited_by, _invitation_id, _joined_at,
    _actor_id, _reason
  );

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
    SELECT count(*)::integer, COALESCE(array_agg(id), ARRAY[]::uuid[])
      INTO _revoked, _revoked_ids
    FROM revoked;

    IF array_length(_revoked_ids, 1) IS NOT NULL THEN
      PERFORM public.wi_revoke_secrets(rid, NULL, NULL) FROM unnest(_revoked_ids) AS rid;
    END IF;
  END IF;

  DELETE FROM public.call_center_department_agents
  WHERE workspace_id = _workspace_id AND user_id = _user_id;

  DELETE FROM public.call_center_agent_presence
  WHERE workspace_id = _workspace_id AND user_id = _user_id;

  DELETE FROM public.operator_call_availability
  WHERE workspace_id = _workspace_id AND user_id = _user_id;

  DELETE FROM public.user_notification_prefs
  WHERE workspace_id = _workspace_id AND user_id = _user_id;

  -- Workspace-scoped availability only. The global (workspace_id IS NULL)
  -- preference row must survive.
  DELETE FROM public.user_availability_prefs
  WHERE workspace_id = _workspace_id AND user_id = _user_id;

  DELETE FROM public.workspace_department_members
  WHERE workspace_id = _workspace_id AND user_id = _user_id;

  DELETE FROM public.workspace_member_details
  WHERE workspace_id = _workspace_id AND user_id = _user_id;

  -- 278b: the member's open and pending chats go back to routing (the
  -- backend routes each again from the ids in the result).
  SELECT COALESCE(array_agg(r.conversation_id), ARRAY[]::uuid[])
    INTO _released
  FROM public.chat_routing_release_member(_workspace_id, _user_id) AS r;

  DELETE FROM public.workspace_members
  WHERE workspace_id = _workspace_id AND user_id = _user_id;

  IF EXISTS (SELECT 1 FROM public.workspace_members
             WHERE workspace_id = _workspace_id AND user_id = _user_id)
     OR EXISTS (SELECT 1 FROM public.workspace_department_members
                WHERE workspace_id = _workspace_id AND user_id = _user_id)
     OR EXISTS (SELECT 1 FROM public.workspace_member_details
                WHERE workspace_id = _workspace_id AND user_id = _user_id)
     OR EXISTS (SELECT 1 FROM public.call_center_department_agents
                WHERE workspace_id = _workspace_id AND user_id = _user_id) THEN
    RAISE EXCEPTION 'OFFBOARDING_INCOMPLETE';
  END IF;

  PERFORM public.wi_audit(_workspace_id, _actor_id, 'workspace_member.offboarded', _user_id,
          jsonb_build_object('role', _target_role, 'revoked_invitations', _revoked,
                             'reason', _reason), 'workspace_member');

  RETURN jsonb_build_object(
    'workspace_id', _workspace_id,
    'user_id', _user_id,
    'revoked_invitations', _revoked,
    'released_conversation_ids', to_jsonb(_released)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_workspace_invitation_v2(uuid,uuid,text,text,text,text,text,public.workspace_role,timestamptz,uuid[],text,text,timestamptz,text,text,text,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_workspace_invitation_v2(uuid,uuid,text,text,text,text,text,public.workspace_role,timestamptz,uuid[],text,text,timestamptz,text,text,text,text,text,text) TO service_role;
REVOKE ALL ON FUNCTION public.edit_workspace_invitation_v2(uuid,uuid,text,text,text,text,text,public.workspace_role,timestamptz,uuid[],text,text,text,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.edit_workspace_invitation_v2(uuid,uuid,text,text,text,text,text,public.workspace_role,timestamptz,uuid[],text,text,text,text,text,text) TO service_role;
REVOKE ALL ON FUNCTION public.resend_invitation_email_v2(uuid,uuid,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resend_invitation_email_v2(uuid,uuid,text,text) TO service_role;
REVOKE ALL ON FUNCTION public.rotate_manual_link_v2(uuid,uuid,text,text,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rotate_manual_link_v2(uuid,uuid,text,text,timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.revoke_invitation_v2(uuid,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_invitation_v2(uuid,uuid,text) TO service_role;
REVOKE ALL ON FUNCTION public.archive_invitation_v2(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.archive_invitation_v2(uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.wi_delete_invitation(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wi_delete_invitation(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.offboard_workspace_member(uuid,uuid,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.offboard_workspace_member(uuid,uuid,uuid,text) TO service_role;
