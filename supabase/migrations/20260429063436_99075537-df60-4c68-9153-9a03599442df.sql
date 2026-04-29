-- AI Agent Phase 3.1 — Automated inbox & human takeover state.
-- Adds a metadata jsonb column on conversations (used by AI agent runtime
-- and other future per-conversation flags), plus a generated ai_state
-- column for fast inbox filtering, plus the missing sender_type values
-- ('ai' was used by the engine but not in the enum).

-- 1. metadata column on conversations
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

-- 2. Ensure 'ai' is a valid sender_type. Existing enum was ('agent','contact','system','bot').
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_enum e ON t.oid = e.enumtypid
    WHERE t.typname = 'sender_type' AND e.enumlabel = 'ai'
  ) THEN
    ALTER TYPE public.sender_type ADD VALUE 'ai';
  END IF;
END$$;

-- 3. Generated column ai_state derived from metadata.ai_state.
--    Defaults to NULL (= legacy / non-AI conversation). Engine sets:
--      'ai_managed' | 'needs_human' | 'human_assigned' | 'human_active' | 'closed'
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS ai_state text
  GENERATED ALWAYS AS ((metadata->>'ai_state')) STORED;

CREATE INDEX IF NOT EXISTS idx_conversations_ai_state
  ON public.conversations(workspace_id, ai_state)
  WHERE ai_state IS NOT NULL;

-- 4. Helpful index on conversation_messages metadata.source for AI vs operator audit lookups.
CREATE INDEX IF NOT EXISTS idx_conversation_messages_metadata_source
  ON public.conversation_messages((metadata->>'source'));
