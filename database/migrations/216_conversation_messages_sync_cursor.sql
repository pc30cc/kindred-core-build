-- 216 — Incremental thread sync: conversation_messages.updated_at
--
-- Native clients (Windows first) keep each thread on the device and ask the
-- server only for what changed since their last sync
-- (GET /api/conversations/:id/messages?since=<cursor>, see
-- server/services/messageSync.ts). "Changed" must include edits, not just
-- new rows: delivery receipts, Telegram media ingest, call-invitation status
-- and the privacy anonymizer all UPDATE existing messages, and a file can be
-- linked to a message after the message itself was written.
--
-- 1) updated_at — one timestamp per row, set by a trigger on every INSERT
--    and UPDATE, so no writer can forget it. clock_timestamp() rather than
--    now(): the stamp is taken when the row is written, not when its
--    transaction began, which keeps the gap to COMMIT short; the sync cursor
--    additionally stays 30 s behind the clock (SAFETY_LAG), so a row written
--    just before a read but committed after it is still picked up.
--    Existing rows get the time this migration ran (a constant default, so
--    the ALTER does not rewrite the table); that is only ever compared with
--    later cursors, which is what incremental sync needs.
--
-- 2) (conversation_id, updated_at) index — the delta query is
--    "this conversation, updated after X".
--
-- 3) conversation_attachments touch — when an attachment row is created or
--    its status/message link changes, the message it belongs to is marked
--    changed too, because the thread payload embeds attachment metadata.
--    Guarded: the self-host chain does not create conversation_attachments.
--
-- Deletes need no tombstones: every sync answer carries the thread's
-- visible total, and a client whose copy does not add up re-fetches in full.
-- Purely additive: clients that never send `since` see no difference.

ALTER TABLE public.conversation_messages
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

COMMENT ON COLUMN public.conversation_messages.updated_at IS
  'Last insert/update of this row (trigger-maintained, clock_timestamp). Drives incremental thread sync (?since=).';

CREATE OR REPLACE FUNCTION public.conversation_messages_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.conversation_messages_touch_updated_at() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_conversation_messages_touch_updated_at ON public.conversation_messages;
CREATE TRIGGER trg_conversation_messages_touch_updated_at
  BEFORE INSERT OR UPDATE ON public.conversation_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.conversation_messages_touch_updated_at();

CREATE INDEX IF NOT EXISTS idx_conversation_messages_conversation_updated
  ON public.conversation_messages (conversation_id, updated_at);

DO $migration$
BEGIN
  IF to_regclass('public.conversation_attachments') IS NULL THEN
    RAISE NOTICE 'conversation_attachments absent: attachment touch trigger skipped';
    RETURN;
  END IF;

  EXECUTE $fn$
    CREATE OR REPLACE FUNCTION public.conversation_attachments_touch_message()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = public
    AS $body$
    DECLARE
      v_previous uuid;
    BEGIN
      -- OLD is only read on UPDATE (nested IFs: SQL does not promise short-circuit).
      IF TG_OP = 'UPDATE' THEN
        IF NEW.status IS NOT DISTINCT FROM OLD.status
           AND NEW.message_id IS NOT DISTINCT FROM OLD.message_id THEN
          RETURN NEW;
        END IF;
        v_previous := OLD.message_id;
      END IF;
      IF NEW.conversation_id IS NULL THEN
        RETURN NEW;
      END IF;
      -- The message trigger stamps updated_at; any UPDATE of the row is enough.
      UPDATE public.conversation_messages m
         SET updated_at = clock_timestamp()
       WHERE m.conversation_id = NEW.conversation_id
         AND (m.id = NEW.message_id
              OR m.id = v_previous
              OR m.metadata->>'attachment_id' = NEW.id::text);
      RETURN NEW;
    END;
    $body$
  $fn$;

  EXECUTE 'REVOKE ALL ON FUNCTION public.conversation_attachments_touch_message() FROM PUBLIC';
  EXECUTE 'DROP TRIGGER IF EXISTS trg_conversation_attachments_touch_message ON public.conversation_attachments';
  EXECUTE 'CREATE TRIGGER trg_conversation_attachments_touch_message
             AFTER INSERT OR UPDATE OF status, message_id ON public.conversation_attachments
             FOR EACH ROW
             EXECUTE FUNCTION public.conversation_attachments_touch_message()';
END
$migration$;

NOTIFY pgrst, 'reload schema';
