CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_messages_client_message_id
  ON public.conversation_messages (conversation_id, (metadata->>'client_message_id'))
  WHERE metadata->>'client_message_id' IS NOT NULL;

CREATE OR REPLACE FUNCTION public.conversation_apply_post_send_action(
  p_workspace_id uuid,
  p_conversation_id uuid,
  p_target_status text,
  p_allowed_from text[],
  p_after_message_id uuid
)
RETURNS TABLE (changed boolean, new_status text, changed_at timestamptz, blocked_reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
  v_after_created timestamptz;
  v_newer boolean;
  v_now timestamptz := now();
BEGIN
  SELECT c.status INTO v_status
  FROM public.conversations c
  WHERE c.id = p_conversation_id AND c.workspace_id = p_workspace_id
  FOR UPDATE;

  IF v_status IS NULL THEN
    RETURN QUERY SELECT false, NULL::text, NULL::timestamptz, 'not_found'::text;
    RETURN;
  END IF;

  IF NOT (v_status = ANY (p_allowed_from)) THEN
    RETURN QUERY SELECT false, v_status, NULL::timestamptz, 'status_conflict'::text;
    RETURN;
  END IF;

  IF p_after_message_id IS NOT NULL THEN
    SELECT m.created_at INTO v_after_created
    FROM public.conversation_messages m
    WHERE m.id = p_after_message_id;

    IF v_after_created IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1 FROM public.conversation_messages m
        WHERE m.conversation_id = p_conversation_id
          AND m.sender_type = 'contact'
          AND (m.created_at, m.id) > (v_after_created, p_after_message_id)
      ) INTO v_newer;

      IF v_newer THEN
        RETURN QUERY SELECT false, v_status, NULL::timestamptz, 'customer_replied'::text;
        RETURN;
      END IF;
    END IF;
  END IF;

  UPDATE public.conversations c
  SET status = p_target_status, updated_at = v_now
  WHERE c.id = p_conversation_id AND c.workspace_id = p_workspace_id;

  RETURN QUERY SELECT true, p_target_status, v_now, NULL::text;
END;
$$;

REVOKE ALL ON FUNCTION public.conversation_apply_post_send_action(uuid, uuid, text, text[], uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.conversation_apply_post_send_action(uuid, uuid, text, text[], uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.conversation_apply_post_send_action(uuid, uuid, text, text[], uuid) TO service_role;