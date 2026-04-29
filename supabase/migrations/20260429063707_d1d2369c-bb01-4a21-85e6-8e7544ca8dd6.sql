ALTER TABLE public.ai_agent_settings
  ADD COLUMN IF NOT EXISTS pause_auto_reply_after_human_reply boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS allow_suggestions_after_takeover boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS keep_in_automated_until_handoff boolean NOT NULL DEFAULT true;
