-- 055_instagram_channel.sql
--
-- Adds the Instagram Messaging channel (Meta Messenger Platform) alongside
-- Telegram, Bale and WhatsApp.
--
-- The wire protocol difference is confined to the Channels Worker: inbound
-- payloads are translated into the shared bot envelope at Core's ingest
-- boundary, so the database only needs to know the provider exists.
--
-- Idempotent: safe to re-run.

-- ── 1. Outbound intent uniqueness covers Instagram job types ──────────
DROP INDEX IF EXISTS public.channel_jobs_outbound_message_unique;
CREATE UNIQUE INDEX IF NOT EXISTS channel_jobs_outbound_message_unique
  ON public.channel_jobs ((payload->>'message_id'))
  WHERE job_type IN (
    'telegram_outbound_message','telegram_outbound_media',
    'bale_outbound_message','bale_outbound_media',
    'whatsapp_outbound_message','whatsapp_outbound_media',
    'instagram_outbound_message','instagram_outbound_media'
  );

-- ── 2. Outbox trigger recognises the Instagram channel ────────────────
CREATE OR REPLACE FUNCTION public.channel_enqueue_outbound_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  c_workspace uuid;
  c_metadata  jsonb;
  c_channel   text;
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

  IF c_workspace IS NULL THEN
    RETURN NEW;
  END IF;

  c_channel := COALESCE(c_metadata->>'channel', '');
  IF c_channel NOT IN ('telegram', 'bale', 'whatsapp', 'instagram') THEN
    RETURN NEW;
  END IF;

  v_integration := NULLIF(c_metadata->>'channel_integration_id', '')::uuid;
  v_chat := NULLIF(c_metadata->>'channel_chat_id', '');
  IF v_integration IS NULL OR v_chat IS NULL THEN
    RETURN NEW;
  END IF;

  v_attachments := COALESCE(NEW.metadata->'attachments', '[]'::jsonb);
  IF jsonb_typeof(v_attachments) = 'array' AND jsonb_array_length(v_attachments) > 0 THEN
    v_job_type := c_channel || '_outbound_media';
  ELSE
    v_job_type := c_channel || '_outbound_message';
    IF COALESCE(btrim(NEW.body), '') = '' THEN
      RETURN NEW;
    END IF;
  END IF;

  INSERT INTO public.channel_jobs (provider, job_type, workspace_id, integration_id, payload)
  VALUES (
    c_channel,
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

DROP TRIGGER IF EXISTS trg_channel_enqueue_outbound ON public.conversation_messages;
CREATE TRIGGER trg_channel_enqueue_outbound
  AFTER INSERT ON public.conversation_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.channel_enqueue_outbound_message();

REVOKE ALL ON FUNCTION public.channel_enqueue_outbound_message() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.channel_enqueue_outbound_message() FROM anon;
REVOKE ALL ON FUNCTION public.channel_enqueue_outbound_message() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.channel_enqueue_outbound_message() TO service_role;

-- ── 3. Platform state row for the new plugin ──────────────────────────
INSERT INTO public.plugin_platform_state
  (plugin_id, enabled, marketplace_visible, installable, featured, sort_order, rollout_status)
VALUES ('instagram', true, true, true, true, 17, 'public')
ON CONFLICT (plugin_id) DO UPDATE
  SET installable = true,
      enabled = true,
      marketplace_visible = true,
      rollout_status = 'public',
      sort_order = 17;
