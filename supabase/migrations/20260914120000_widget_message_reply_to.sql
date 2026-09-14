-- 176 — Visitor widget: real reply-to-message relationship.
--
-- The widget composer already lets a visitor pick a message to "reply to"
-- and shows a reply preview above the composer — but until now the
-- relationship only ever existed as a client-side text convention (the
-- quoted line was baked into the outgoing message body as "> quoted\n\n
-- text"). That survives rendering, but is not a real, queryable link
-- between two rows.
--
-- reply_to_message_id: nullable self-referencing FK on conversation_messages.
--   ON DELETE SET NULL — deleting the parent (e.g. a workspace data wipe)
--   must never fail or cascade-delete the reply; it just becomes an
--   unlinked message, same as it would render today.
--   No CHECK enforcing same-conversation here: the API layer is the one
--   that validates the reply target belongs to the same conversation
--   before ever writing this column (a DB-level cross-conversation check
--   would need a trigger for a self-referencing FK; the API guard is the
--   simpler, sufficient boundary given this is only ever written by one
--   server-controlled insert path).

ALTER TABLE public.conversation_messages
  ADD COLUMN IF NOT EXISTS reply_to_message_id uuid NULL
    REFERENCES public.conversation_messages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_conv_messages_reply_to
  ON public.conversation_messages (reply_to_message_id)
  WHERE reply_to_message_id IS NOT NULL;

COMMENT ON COLUMN public.conversation_messages.reply_to_message_id IS
  'Optional: the message this one is a reply to (visitor widget reply feature). Same-conversation is enforced at the API layer, not by a DB constraint.';
