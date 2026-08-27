-- 049_channels_contract_and_outbox.sql
--
-- Completion pass for the Plugin Platform / Channels runtime:
--
--   1. Align `channel_inbound_events` with the processing service contract
--      (status / error / canonical result ids). No service may write a column
--      that does not exist.
--   2. Transactional OUTBOX: a canonical outbound message and its channel
--      delivery intent become durable in the SAME transaction, via an
--      AFTER INSERT trigger on conversation_messages. If Core crashes right
--      after the commit, the intent is already in `channel_jobs`.
--   3. Duplicate-provider-account invariant hardened for the canonical
--      lifecycle (pending | connected | disconnected | error).
--
-- Idempotent: safe to re-run.

-- ── 1. Inbound event contract ─────────────────────────────────────────
ALTER TABLE public.channel_inbound_events
  ADD COLUMN IF NOT EXISTS status          text NOT NULL DEFAULT 'processing',
  ADD COLUMN IF NOT EXISTS last_error      text,
  ADD COLUMN IF NOT EXISTS conversation_id uuid,
  ADD COLUMN IF NOT EXISTS contact_id      uuid,
  ADD COLUMN IF NOT EXISTS message_id      uuid;

ALTER TABLE public.channel_inbound_events
  ALTER COLUMN payload SET DEFAULT '{}'::jsonb;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'channel_inbound_events_status_check'
  ) THEN
    ALTER TABLE public.channel_inbound_events
      ADD CONSTRAINT channel_inbound_events_status_check
      CHECK (status IN ('processing','processed','failed','ignored','duplicate'));
  END IF;
END
$do$;

-- ── 2. Duplicate provider account invariant ───────────────────────────
-- One provider account (Telegram bot_id) may be bound to at most ONE
-- workspace while it is pending/connected/error. Disconnected rows are
-- history and never block a re-connect elsewhere.
DROP INDEX IF EXISTS public.channel_integrations_account_unique;
CREATE UNIQUE INDEX IF NOT EXISTS channel_integrations_account_unique
  ON public.channel_integrations (provider, external_account_id)
  WHERE external_account_id IS NOT NULL AND status <> 'disconnected';

-- ── 3. Transactional outbox for outbound channel delivery ─────────────
-- One delivery intent per canonical message.
CREATE UNIQUE INDEX IF NOT EXISTS channel_jobs_outbound_message_unique
  ON public.channel_jobs ((payload->>'message_id'))
  WHERE job_type IN ('telegram_outbound_message','telegram_outbound_media');

CREATE OR REPLACE FUNCTION public.channel_enqueue_outbound_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c_workspace uuid;
  c_channel   text;
  c_metadata  jsonb;
  v_integration uuid;
  v_chat        text;
  v_attachments jsonb;
  v_job_type    text;
BEGIN
  -- Only operator ('agent') and AI ('bot') replies are delivered outbound.
  IF NEW.sender_type::text NOT IN ('agent','bot') THEN
    RETURN NEW;
  END IF;

  -- Messages that ORIGINATED on the provider must never be echoed back.
  IF COALESCE(NEW.metadata->>'channel_inbound','') = 'true'
     OR COALESCE(NEW.metadata->>'channel_delivery_skip','') = 'true' THEN
    RETURN NEW;
  END IF;

  SELECT workspace_id, channel, COALESCE(metadata, '{}'::jsonb)
    INTO c_workspace, c_channel, c_metadata
  FROM public.conversations
  WHERE id = NEW.conversation_id;

  IF c_workspace IS NULL THEN
    RETURN NEW;
  END IF;

  IF COALESCE(c_channel, c_metadata->>'channel', '') <> 'telegram' THEN
    RETURN NEW;  -- widget and other non-channel conversations: no-op
  END IF;

  v_integration := NULLIF(c_metadata->>'channel_integration_id','')::uuid;
  v_chat        := NULLIF(c_metadata->>'channel_chat_id','');
  IF v_integration IS NULL OR v_chat IS NULL THEN
    RETURN NEW;
  END IF;

  v_attachments := COALESCE(NEW.metadata->'attachments', '[]'::jsonb);
  IF jsonb_typeof(v_attachments) = 'array' AND jsonb_array_length(v_attachments) > 0 THEN
    v_job_type := 'telegram_outbound_media';
  ELSE
    v_job_type := 'telegram_outbound_message';
    IF COALESCE(btrim(NEW.body), '') = '' THEN
      RETURN NEW;  -- nothing deliverable
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
$$;

DROP TRIGGER IF EXISTS trg_channel_enqueue_outbound ON public.conversation_messages;
CREATE TRIGGER trg_channel_enqueue_outbound
  AFTER INSERT ON public.conversation_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.channel_enqueue_outbound_message();

DO $do$
BEGIN
  EXECUTE 'REVOKE ALL ON FUNCTION public.channel_enqueue_outbound_message() FROM PUBLIC';
END
$do$;

-- ── 4. Worker heartbeat freshness lookup ──────────────────────────────
CREATE INDEX IF NOT EXISTS channel_worker_heartbeats_seen_idx
  ON public.channel_worker_heartbeats (worker_kind, last_seen_at DESC);
