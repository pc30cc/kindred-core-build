-- 216: conversation_messages.updated_at — the cursor for incremental thread sync.
--
-- ADDITIVE ONLY. One nullable-free column with a default, one trigger, one
-- index. No column is dropped, renamed or retyped; no row is deleted.
-- Every statement is idempotent.
--
-- Why: a message changes after it is inserted — its metadata (a call card's
-- status, outbound delivery status, Telegram media, the privacy anonymizer)
-- and seen_at. GET /api/conversations/:id/messages?since=<cursor> returns
-- the rows created OR changed after the cursor (services/messageSync.ts), so
-- the native apps stop re-reading whole threads on every poll. Without this
-- column the route keeps answering in full, as before.
--
-- updated_at is set on INSERT by its default and on every UPDATE by the
-- trigger (clock_timestamp(), so two updates in one transaction still move
-- it). Existing rows start at the later of created_at and seen_at. A file
-- that lands on a message after it was written (conversation_attachments
-- gaining message_id, or its status changing) touches the message too, since
-- the thread shows attachments as part of the message.

ALTER TABLE public.conversation_messages
  ADD COLUMN IF NOT EXISTS updated_at timestamptz;

UPDATE public.conversation_messages
   SET updated_at = GREATEST(created_at, COALESCE(seen_at, created_at))
 WHERE updated_at IS NULL;

ALTER TABLE public.conversation_messages
  ALTER COLUMN updated_at SET DEFAULT now();

ALTER TABLE public.conversation_messages
  ALTER COLUMN updated_at SET NOT NULL;

CREATE OR REPLACE FUNCTION public.tg_conversation_messages_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_conversation_messages_touch_updated_at ON public.conversation_messages;
CREATE TRIGGER trg_conversation_messages_touch_updated_at
  BEFORE UPDATE ON public.conversation_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_conversation_messages_touch_updated_at();

CREATE INDEX IF NOT EXISTS idx_conversation_messages_conv_updated
  ON public.conversation_messages (conversation_id, updated_at);

-- An attachment joining (or leaving) a message changes how the message reads.
CREATE OR REPLACE FUNCTION public.tg_conversation_attachments_touch_message()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.message_id IS NOT NULL
     AND (NEW.message_id IS DISTINCT FROM OLD.message_id OR NEW.status IS DISTINCT FROM OLD.status) THEN
    UPDATE public.conversation_messages SET updated_at = clock_timestamp() WHERE id = NEW.message_id;
  END IF;
  IF OLD.message_id IS NOT NULL AND OLD.message_id IS DISTINCT FROM NEW.message_id THEN
    UPDATE public.conversation_messages SET updated_at = clock_timestamp() WHERE id = OLD.message_id;
  END IF;
  RETURN NEW;
END;
$$;

-- Only where the attachments table exists (not every self-host chain has it).
DO $$
BEGIN
  IF to_regclass('public.conversation_attachments') IS NOT NULL THEN
    EXECUTE format('DROP TRIGGER IF EXISTS trg_conversation_attachments_touch_message ON %I.%I',
                   'public', 'conversation_attachments');
    EXECUTE format('CREATE TRIGGER trg_conversation_attachments_touch_message
                      AFTER UPDATE OF message_id, status ON %I.%I
                      FOR EACH ROW
                      EXECUTE FUNCTION public.tg_conversation_attachments_touch_message()',
                   'public', 'conversation_attachments');
  END IF;
END;
$$;
