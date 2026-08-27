CREATE OR REPLACE FUNCTION public.channel_enqueue_outbound_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  c_workspace uuid;
  c_metadata  jsonb;
  v_integration uuid;
  v_chat        text;
  v_attachments jsonb;
  v_job_type    text;
BEGIN
  IF NEW.sender_type::text NOT IN ('agent', 'bot', 'ai') THEN
    RETURN NEW;
  END IF;

  IF COALESCE(NEW.metadata->>'channel_inbound', '') = 'true'
     OR COALESCE(NEW.metadata->>'channel_delivery_skip', '') = 'true' THEN
    RETURN NEW;
  END IF;

  SELECT workspace_id, COALESCE(metadata, '{}'::jsonb)
    INTO c_workspace, c_metadata
  FROM public.conversations
  WHERE id = NEW.conversation_id;

  IF c_workspace IS NULL OR COALESCE(c_metadata->>'channel', '') <> 'telegram' THEN
    RETURN NEW;
  END IF;

  v_integration := NULLIF(c_metadata->>'channel_integration_id', '')::uuid;
  v_chat := NULLIF(c_metadata->>'channel_chat_id', '');
  IF v_integration IS NULL OR v_chat IS NULL THEN
    RETURN NEW;
  END IF;

  v_attachments := COALESCE(NEW.metadata->'attachments', '[]'::jsonb);
  IF jsonb_typeof(v_attachments) = 'array' AND jsonb_array_length(v_attachments) > 0 THEN
    v_job_type := 'telegram_outbound_media';
  ELSE
    v_job_type := 'telegram_outbound_message';
    IF COALESCE(btrim(NEW.body), '') = '' THEN
      RETURN NEW;
    END IF;
  END IF;

  INSERT INTO public.channel_jobs (provider, job_type, workspace_id, integration_id, payload)
  VALUES (
    'telegram',
    v_job_type,
    c_workspace,
    v_integration,
    jsonb_build_object(
      'chat_id', v_chat,
      'text', COALESCE(NEW.body, ''),
      'message_id', NEW.id::text,
      'conversation_id', NEW.conversation_id::text,
      'attachments', v_attachments
    )
  )
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.channel_enqueue_outbound_message() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.channel_enqueue_outbound_message() FROM anon;
REVOKE ALL ON FUNCTION public.channel_enqueue_outbound_message() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.channel_enqueue_outbound_message() TO service_role;