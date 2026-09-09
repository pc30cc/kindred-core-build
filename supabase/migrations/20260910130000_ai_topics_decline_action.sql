-- AI Agent topics: add the 'decline' action.
--
-- 'decline' is the one deterministic, server-enforced topic action: when the
-- top-detected topic for a visitor turn carries it, the engine
-- (engine/answerStage.ts) returns a fixed refusal WITHOUT ever calling the
-- model. Every other action ('label_only' | 'route' | 'trigger_workflow' |
-- 'suggest_reply') stays advisory-only. Backs the built-in "Off-topic"
-- default topic (politics/war/religion) in topics/defaults.ts.
ALTER TABLE public.ai_agent_topics
  DROP CONSTRAINT IF EXISTS ai_agent_topics_action_check;

ALTER TABLE public.ai_agent_topics
  ADD CONSTRAINT ai_agent_topics_action_check CHECK (action IN (
    'label_only','route','trigger_workflow','suggest_reply','decline'
  ));
