-- AI Agent — per-locale text for the inline pre-chat card shown when the
-- AI hands a conversation off to a human mid-thread ("please complete your
-- info so our team can help you faster"). Lets the workspace owner
-- customize/replace the built-in copy, same pattern as
-- handoff_message_localized / intro_message_localized.
ALTER TABLE public.ai_agent_settings
  ADD COLUMN IF NOT EXISTS handoff_prechat_message_localized jsonb NOT NULL DEFAULT '{}'::jsonb;
