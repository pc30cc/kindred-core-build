-- 072 — Fix type mismatch in public.ensure_active_conversation.
--
-- `conversations.visitor_session_id` is `uuid`, but migration 071 declared the
-- parameter as `text` and used it directly in the INSERT and the equality
-- match. PostgreSQL rejects the whole function body at execution time with:
--
--   column "visitor_session_id" is of type uuid but expression is of type text
--
-- ...even when the argument is NULL (channel inbound always passes NULL), so
-- EVERY inbound Telegram / Bale / WhatsApp / Instagram message failed with
-- "conversation creation failed" and the job retried forever.
--
-- Signature is unchanged (text stays the wire type — callers send strings);
-- only the casts are added. Non-uuid text is treated as "no session".

CREATE OR REPLACE FUNCTION public.ensure_active_conversation(
  p_workspace_id uuid,
  p_lock_key text,
  p_match_thread_key text DEFAULT NULL,
  p_match_session_id text DEFAULT NULL,
  p_match_contact_id uuid DEFAULT NULL,
  p_contact_id uuid DEFAULT NULL,
  p_visitor_session_id text DEFAULT NULL,
  p_subject text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE (id uuid, created boolean, matched_by text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_now timestamptz := now();
  v_session_uuid uuid;
  v_match_session_uuid uuid;
BEGIN
  IF p_workspace_id IS NULL THEN
    RAISE EXCEPTION 'workspace_id required';
  END IF;

  -- Tolerant text -> uuid coercion: a malformed value means "no session"
  -- rather than a hard failure of the whole inbound pipeline.
  BEGIN
    v_session_uuid := NULLIF(btrim(COALESCE(p_visitor_session_id, '')), '')::uuid;
  EXCEPTION WHEN others THEN
    v_session_uuid := NULL;
  END;

  BEGIN
    v_match_session_uuid := NULLIF(btrim(COALESCE(p_match_session_id, '')), '')::uuid;
  EXCEPTION WHEN others THEN
    v_match_session_uuid := NULL;
  END;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_workspace_id::text || '|' || COALESCE(p_lock_key, gen_random_uuid()::text), 0)
  );

  -- 1) Channel thread key (Telegram / Bale / WhatsApp / Instagram)
  IF p_match_thread_key IS NOT NULL THEN
    SELECT c.id INTO v_id
    FROM public.conversations c
    WHERE c.workspace_id = p_workspace_id
      AND c.metadata @> jsonb_build_object('channel_thread_key', p_match_thread_key)
      AND c.status IN ('open', 'pending', 'resolved')
    ORDER BY c.updated_at DESC NULLS LAST
    LIMIT 1;
    IF v_id IS NOT NULL THEN
      RETURN QUERY SELECT v_id, false, 'thread_key'::text;
      RETURN;
    END IF;
  END IF;

  -- 2) Widget visitor session
  IF v_match_session_uuid IS NOT NULL THEN
    SELECT c.id INTO v_id
    FROM public.conversations c
    WHERE c.workspace_id = p_workspace_id
      AND c.visitor_session_id = v_match_session_uuid
      AND c.status IN ('open', 'pending', 'resolved')
    ORDER BY c.updated_at DESC NULLS LAST
    LIMIT 1;
    IF v_id IS NOT NULL THEN
      RETURN QUERY SELECT v_id, false, 'session'::text;
      RETURN;
    END IF;
  END IF;

  -- 3) Widget contact identity
  IF p_match_contact_id IS NOT NULL THEN
    SELECT c.id INTO v_id
    FROM public.conversations c
    WHERE c.workspace_id = p_workspace_id
      AND c.contact_id = p_match_contact_id
      AND c.status IN ('open', 'pending', 'resolved')
    ORDER BY c.updated_at DESC NULLS LAST
    LIMIT 1;
    IF v_id IS NOT NULL THEN
      RETURN QUERY SELECT v_id, false, 'contact'::text;
      RETURN;
    END IF;
  END IF;

  INSERT INTO public.conversations (
    workspace_id, contact_id, status, priority, subject,
    visitor_session_id, metadata, updated_at
  )
  VALUES (
    p_workspace_id, p_contact_id, 'open', 'normal', p_subject,
    v_session_uuid, COALESCE(p_metadata, '{}'::jsonb), v_now
  )
  RETURNING conversations.id INTO v_id;

  RETURN QUERY SELECT v_id, true, 'created'::text;
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_active_conversation(uuid, text, text, text, uuid, uuid, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ensure_active_conversation(uuid, text, text, text, uuid, uuid, text, text, jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_active_conversation(uuid, text, text, text, uuid, uuid, text, text, jsonb) TO service_role;
