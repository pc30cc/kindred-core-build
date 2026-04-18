-- Phase 7 — Operator-side seen trigger.
-- Called from the inbox UI when an operator opens/selects a conversation.
-- Returns how many messages transitioned to "seen".
CREATE OR REPLACE FUNCTION public.mark_conversation_seen(_conversation_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _workspace_id uuid;
  _affected integer;
BEGIN
  -- Resolve and authorize: operator must be a member of the conversation's workspace.
  SELECT c.workspace_id INTO _workspace_id
    FROM public.conversations c
    WHERE c.id = _conversation_id;

  IF _workspace_id IS NULL THEN
    RAISE EXCEPTION 'conversation_not_found';
  END IF;

  IF NOT public.is_workspace_member(_workspace_id, auth.uid()) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  -- Monotonic update: only fill seen_at if it's still NULL.
  -- Only visitor (contact) messages can be "seen" by an operator.
  UPDATE public.conversation_messages
     SET seen_at = now()
   WHERE conversation_id = _conversation_id
     AND sender_type = 'contact'
     AND seen_at IS NULL;

  GET DIAGNOSTICS _affected = ROW_COUNT;
  RETURN _affected;
END;
$$;

-- Grant execution to authenticated users (RLS-style auth done inside the function).
REVOKE ALL ON FUNCTION public.mark_conversation_seen(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_conversation_seen(uuid) TO authenticated;