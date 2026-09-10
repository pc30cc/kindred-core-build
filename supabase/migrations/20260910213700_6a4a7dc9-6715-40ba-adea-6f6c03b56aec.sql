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

  SELECT role INTO _actor_role FROM public.workspace_members
  WHERE workspace_id = _workspace_id AND user_id = _actor_id;

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