-- 191 — remove the last persisted provider URL: the AI logo snapshot frozen
-- into `conversation_messages.metadata`.
--
-- Migration 190 made a storage key the only record of a WebYar-owned file,
-- so that promoting a new storage provider rewrites nothing. One writer was
-- still violating that invariant on every AI reply: the responder copied the
-- agent's logo URL into `metadata.agent_logo_url` as a per-message snapshot,
-- so the widget could draw the avatar straight off the realtime envelope
-- without a second lookup.
--
-- A URL names ONE vendor's hostname. Once a different provider is primary,
-- every such snapshot points at the retired host and the widget draws a dead
-- image -- which is exactly what happened: all rows carrying the field name a
-- host that is no longer served. The write was removed
-- (server/services/ai-agent/responder.ts, which now derives the link from the
-- stored key and puts it on the envelope as `sender_avatar`), and the widget
-- runtime's fallback to the field was removed with it, so the values left
-- behind are inert. This migration deletes them, because an inert provider
-- URL sitting in a row is still a provider URL the platform would have to
-- reason about at the next promotion.
--
-- SCOPE: exactly one JSON key, only where it is present. `metadata` is
-- otherwise untouched -- `agent_name` and every other key survive, and a row
-- whose metadata is NULL or has no `agent_logo_url` is not rewritten at all.
-- Message bodies, senders and timestamps are not read.
--
-- IRREVERSIBLE by design: the value is a dead link to a retired host, and
-- the live link is derived from `ai_agent_settings.metadata->>
-- 'ai_avatar_storage_key'` on every read, so there is nothing to preserve.

BEGIN;

UPDATE public.conversation_messages
SET metadata = metadata - 'agent_logo_url'
WHERE metadata ? 'agent_logo_url';

-- Fail the migration rather than report success on a partial cleanup.
DO $$
DECLARE
  remaining bigint;
BEGIN
  SELECT count(*) INTO remaining
  FROM public.conversation_messages
  WHERE metadata ? 'agent_logo_url';

  IF remaining > 0 THEN
    RAISE EXCEPTION
      'migration 191: % conversation_messages row(s) still carry metadata.agent_logo_url',
      remaining;
  END IF;

  RAISE NOTICE 'migration 191: no message row persists an AI logo URL';
END $$;

COMMIT;
