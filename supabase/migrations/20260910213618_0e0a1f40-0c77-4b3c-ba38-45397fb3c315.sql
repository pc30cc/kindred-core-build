ALTER TABLE public.workspace_invitations DROP CONSTRAINT IF EXISTS workspace_invitations_v2_required_chk;
ALTER TABLE public.workspace_invitations
  ADD CONSTRAINT workspace_invitations_v2_required_chk
  CHECK (
    invitation_flow_version <> 2 OR (
          first_name IS NOT NULL AND btrim(first_name) <> ''
      AND last_name  IS NOT NULL AND btrim(last_name)  <> ''
      AND invited_email_normalized IS NOT NULL
      AND invited_email_normalized = lower(btrim(invited_email_normalized))
      AND (invited_phone_e164 IS NULL OR invited_phone_e164 ~ '^\+[1-9][0-9]{6,14}$')
      AND member_type IS NOT NULL
      AND role IS NOT NULL AND role <> 'owner'::public.workspace_role
      AND workspace_id IS NOT NULL
      AND created_by   IS NOT NULL
      AND created_at   IS NOT NULL
      AND expires_at   IS NOT NULL AND expires_at > created_at
      AND notification_generation IS NOT NULL AND notification_generation >= 1
      AND token IS NULL
    )
  );

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