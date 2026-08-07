-- AI Agent — per-locale intro message. Lets the workspace owner set the
-- pre-chat AI greeting text separately for each language (fa/en/tr/...),
-- alongside the existing single-locale intro_message (kept as a legacy
-- fallback for older clients / API consumers).
ALTER TABLE public.ai_agent_settings
  ADD COLUMN IF NOT EXISTS intro_message_localized jsonb NOT NULL DEFAULT '{}'::jsonb;
