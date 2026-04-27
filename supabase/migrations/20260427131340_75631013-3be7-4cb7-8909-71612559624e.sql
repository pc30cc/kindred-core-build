-- Pass A — idempotency guard for the call-ended summary message.
-- Ensures only one system message with metadata.kind = 'call_ended' can exist
-- per (conversation_id, call_session_id) pair. Subsequent inserts (e.g. from
-- a retried hangup or a duplicate webhook) will fail with a unique-violation
-- and the server will swallow the error.

CREATE UNIQUE INDEX IF NOT EXISTS conversation_messages_call_ended_uidx
  ON public.conversation_messages (
    conversation_id,
    ((metadata ->> 'call_session_id'))
  )
  WHERE sender_type = 'system'
    AND (metadata ->> 'kind') = 'call_ended'
    AND (metadata ->> 'call_session_id') IS NOT NULL;