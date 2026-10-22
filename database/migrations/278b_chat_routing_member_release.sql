-- 278b — Chat routing: a member who leaves, or is suspended, gives their open
-- chats back (owner decisions of 2026-10-21, DECISIONS §4 "Offboard/suspend";
-- audit finding R-03), and a member who let a chat go is not offered it again.
--
-- 1. chat_routing_release_member(workspace, user): every open or pending
--    conversation of the workspace held by that member is unassigned, under
--    the per-workspace routing lock (the one chat_route_claim takes, so a
--    claim in flight either lands before the release, and is released with
--    the rest, or runs after it and no longer finds the member). Returns the
--    released conversation ids; the backend announces each and routes it
--    again (server/services/chatRouting.ts afterMemberReleased). Resolved and
--    closed conversations keep their assignee: they record who handled them.
--    updated_at is left alone, so the released threads keep their place in
--    every list. The suspension route and a change to a role without an Inbox
--    call it; offboarding calls it inside its own transaction (3).
-- 2. chat_routing_skip(workspace, conversation, user): routing does not offer
--    this conversation to that member again (chat_routing_state.skip_user_ids,
--    which chat_route_claim already honours). The inbox adds whoever handed a
--    chat back or on; a NULL user clears the list (the conversation was
--    resolved or closed: a later thread starts afresh).
-- 3. offboard_workspace_member: the same function as in 251, statement for
--    statement, plus one step before the membership row is deleted — the
--    member's open and pending conversations are released (1) — and one key
--    in its result, `released_conversation_ids`. The idempotency ledger's
--    stored projection (092) is an allow-list and does not keep it.
--
-- Both new functions are SECURITY INVOKER with a pinned search_path,
-- executable by service_role only. offboard_workspace_member keeps its
-- SECURITY DEFINER, owner and grants (CREATE OR REPLACE keeps them).
--
-- Locks: none beyond the functions' own while they run (the routing advisory
-- lock and the released rows). Re-runnable: CREATE OR REPLACE only. Changes
-- no existing row. Dry run: the file inside BEGIN … ROLLBACK.

SET lock_timeout = '5s';

-- ─── 1. Release a member's open chats ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.chat_routing_release_member(p_workspace_id uuid, p_user_id uuid)
RETURNS TABLE (conversation_id uuid)
LANGUAGE plpgsql
VOLATILE
SET search_path = public, pg_temp
AS $fn_release_member$
BEGIN
  IF p_workspace_id IS NULL OR p_user_id IS NULL THEN
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('chat_route_claim:' || p_workspace_id::text, 0));
  RETURN QUERY
  UPDATE public.conversations c
     SET assigned_to = NULL
   WHERE c.workspace_id = p_workspace_id
     AND c.assigned_to = p_user_id
     AND c.status IN ('open', 'pending')
  RETURNING c.id;
END;
$fn_release_member$;

COMMENT ON FUNCTION public.chat_routing_release_member(uuid, uuid) IS
  'Unassigns every open or pending conversation of the workspace held by the member (removed, suspended, or no longer allowed an Inbox), under the chat routing lock; returns their ids for the backend to announce and route again. Server-only. Migration 278b.';

-- ─── 2. Do not offer a conversation to a member again ─────────────────────
CREATE OR REPLACE FUNCTION public.chat_routing_skip(p_workspace_id uuid, p_conversation_id uuid, p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SET search_path = public, pg_temp
AS $fn_routing_skip$
BEGIN
  IF p_user_id IS NULL THEN
    UPDATE public.chat_routing_state
       SET skip_user_ids = '{}'::uuid[], updated_at = now()
     WHERE conversation_id = p_conversation_id
       AND workspace_id = p_workspace_id
       AND cardinality(skip_user_ids) > 0;
    RETURN;
  END IF;
  INSERT INTO public.chat_routing_state AS s (conversation_id, workspace_id, skip_user_ids, updated_at)
  SELECT c.id, c.workspace_id, ARRAY[p_user_id], now()
    FROM public.conversations c
   WHERE c.id = p_conversation_id AND c.workspace_id = p_workspace_id
  ON CONFLICT (conversation_id) DO UPDATE SET
    skip_user_ids = CASE
      WHEN p_user_id = ANY (s.skip_user_ids) THEN s.skip_user_ids
      ELSE (s.skip_user_ids || p_user_id)[greatest(1, cardinality(s.skip_user_ids) - 48):]
    END,
    updated_at = now();
END;
$fn_routing_skip$;

COMMENT ON FUNCTION public.chat_routing_skip(uuid, uuid, uuid) IS
  'Routing does not offer the conversation to the member again (they handed it back or on); a NULL member clears the list (the thread ended). Server-only. Migration 278b.';

-- ─── 3. Offboarding releases the member's open chats ──────────────────────
-- 251's offboard_workspace_member, unchanged but for the release before the
-- membership row goes and the released ids in the result.
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
  SELECT owner_id INTO _owner_id FROM public.workspaces WHERE id = _workspace_id FOR UPDATE;
  IF _owner_id IS NULL THEN RAISE EXCEPTION 'WORKSPACE_NOT_FOUND'; END IF;

  SELECT role INTO _target_role FROM public.workspace_members
  WHERE workspace_id = _workspace_id AND user_id = _user_id FOR UPDATE;
  IF _target_role IS NULL THEN RAISE EXCEPTION 'MEMBER_NOT_FOUND'; END IF;

  IF _user_id = _owner_id OR _target_role = 'owner'::public.workspace_role THEN
    RAISE EXCEPTION 'CANNOT_REMOVE_WORKSPACE_OWNER';
  END IF;

  SELECT role INTO _actor_role FROM public.workspace_members
  WHERE workspace_id = _workspace_id AND user_id = _actor_id;
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

-- ─── Access: the backend (service_role) only ──────────────────────────────
DO $acl$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.chat_routing_release_member(uuid, uuid)',
    'public.chat_routing_skip(uuid, uuid, uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', f);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', f);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
    END IF;
  END LOOP;
END $acl$;

RESET lock_timeout;
