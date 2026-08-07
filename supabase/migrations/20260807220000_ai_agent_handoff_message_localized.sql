-- AI Agent — per-locale handoff acknowledgement message. Lets the workspace
-- owner customize the "connecting you to a human agent now" text the AI
-- sends when it hands a conversation off, the same way intro_message_localized
-- already covers the AI's own opening greeting.
ALTER TABLE public.ai_agent_settings
  ADD COLUMN IF NOT EXISTS handoff_message_localized jsonb NOT NULL DEFAULT '{}'::jsonb;
