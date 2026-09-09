-- AI Agent: strict topic scope (allow-list conversation posture).
--
-- Independent of, and complementary to, the topics 'decline' gate: that gate
-- is a deterministic hard guarantee for specific sensitive categories
-- (politics/war/religion) regardless of this setting. This setting instead
-- flips the DEFAULT conversational posture in the system prompt
-- (server/services/ai-agent/prompt.ts) from "engage with any harmless
-- general question" to "only engage with this business + greetings/identity
-- questions, decline everything else with a short redirect".
--
-- Defaults to false so every existing workspace keeps its current,
-- unchanged behavior; an owner opts in per workspace from AI Agent Settings.
ALTER TABLE public.ai_agent_settings
  ADD COLUMN IF NOT EXISTS strict_topic_scope boolean NOT NULL DEFAULT false;
