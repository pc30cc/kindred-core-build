-- AI Agent — Phase 3 runtime settings
ALTER TABLE public.ai_agent_settings
  ADD COLUMN IF NOT EXISTS ai_intro_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS intro_message text,
  ADD COLUMN IF NOT EXISTS fallback_behavior text NOT NULL DEFAULT 'handoff',
  ADD COLUMN IF NOT EXISTS stop_on_handoff boolean NOT NULL DEFAULT true;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'ai_agent_settings'
      AND constraint_name = 'ai_agent_settings_fallback_chk'
  ) THEN
    ALTER TABLE public.ai_agent_settings
      ADD CONSTRAINT ai_agent_settings_fallback_chk
      CHECK (fallback_behavior IN ('handoff','silent'));
  END IF;
END$$;

-- Helpful index for runtime query: AI replies per conversation lookup.
-- Uses metadata->>'source'='ai_agent' marker on conversation_messages.
CREATE INDEX IF NOT EXISTS idx_conversation_messages_conv_sender_created
  ON public.conversation_messages(conversation_id, sender_type, created_at DESC);

-- Marker table for one-time intro per (workspace, conversation/session)
-- prevents the widget firing intro twice when the visitor reloads.
CREATE TABLE IF NOT EXISTS public.ai_agent_intro_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  conversation_id uuid,
  visitor_session_id uuid,
  visitor_id text,
  message_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_agent_intro_log_conv
  ON public.ai_agent_intro_log(workspace_id, conversation_id)
  WHERE conversation_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_agent_intro_log_session
  ON public.ai_agent_intro_log(workspace_id, visitor_session_id)
  WHERE visitor_session_id IS NOT NULL AND conversation_id IS NULL;

ALTER TABLE public.ai_agent_intro_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_agent_intro_log_member_read ON public.ai_agent_intro_log;
CREATE POLICY ai_agent_intro_log_member_read ON public.ai_agent_intro_log
  FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()));