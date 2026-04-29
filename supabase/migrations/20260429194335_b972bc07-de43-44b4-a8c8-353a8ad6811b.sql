-- AI Agent Console — Pass B1: Automate (Topics, Workflows, Message triggers)

-- ─── Topics ───
CREATE TABLE IF NOT EXISTS public.ai_agent_topics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  slug text NOT NULL,
  keywords text[] NOT NULL DEFAULT '{}',
  examples text[] NOT NULL DEFAULT '{}',
  language text,
  confidence_threshold numeric NOT NULL DEFAULT 0.65,
  action text NOT NULL DEFAULT 'label_only' CHECK (action IN (
    'label_only','route','trigger_workflow','suggest_reply'
  )),
  action_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  system boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_topics_workspace ON public.ai_agent_topics(workspace_id);
CREATE INDEX IF NOT EXISTS idx_ai_topics_workspace_enabled ON public.ai_agent_topics(workspace_id, enabled);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_topics_workspace_slug ON public.ai_agent_topics(workspace_id, slug);

ALTER TABLE public.ai_agent_topics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can view topics"
ON public.ai_agent_topics FOR SELECT TO authenticated
USING (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Admins+ can manage topics"
ON public.ai_agent_topics FOR ALL TO authenticated
USING (public.get_workspace_role(workspace_id, auth.uid()) IN ('owner','admin'))
WITH CHECK (public.get_workspace_role(workspace_id, auth.uid()) IN ('owner','admin'));

CREATE TRIGGER trg_ai_topics_updated_at
BEFORE UPDATE ON public.ai_agent_topics
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ─── Workflows ───
CREATE TABLE IF NOT EXISTS public.ai_agent_workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  trigger_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  steps_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  enabled boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft','active','paused','archived'
  )),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_workflows_workspace ON public.ai_agent_workflows(workspace_id);
CREATE INDEX IF NOT EXISTS idx_ai_workflows_workspace_status ON public.ai_agent_workflows(workspace_id, status);

ALTER TABLE public.ai_agent_workflows ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can view workflows"
ON public.ai_agent_workflows FOR SELECT TO authenticated
USING (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Admins+ can manage workflows"
ON public.ai_agent_workflows FOR ALL TO authenticated
USING (public.get_workspace_role(workspace_id, auth.uid()) IN ('owner','admin'))
WITH CHECK (public.get_workspace_role(workspace_id, auth.uid()) IN ('owner','admin'));

CREATE TRIGGER trg_ai_workflows_updated_at
BEFORE UPDATE ON public.ai_agent_workflows
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ─── Message triggers ───
CREATE TABLE IF NOT EXISTS public.ai_agent_message_triggers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  event_type text NOT NULL CHECK (event_type IN (
    'visitor_first_message','conversation_started','after_prechat',
    'no_operator_online','ai_no_answer','topic_detected',
    'human_requested','business_hours_closed'
  )),
  conditions_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  action_type text NOT NULL CHECK (action_type IN (
    'send_message','start_workflow','handoff','assign','tag','internal_note'
  )),
  action_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  delay_seconds integer NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_msg_triggers_workspace ON public.ai_agent_message_triggers(workspace_id);
CREATE INDEX IF NOT EXISTS idx_ai_msg_triggers_workspace_event ON public.ai_agent_message_triggers(workspace_id, event_type);

ALTER TABLE public.ai_agent_message_triggers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can view message triggers"
ON public.ai_agent_message_triggers FOR SELECT TO authenticated
USING (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Admins+ can manage message triggers"
ON public.ai_agent_message_triggers FOR ALL TO authenticated
USING (public.get_workspace_role(workspace_id, auth.uid()) IN ('owner','admin'))
WITH CHECK (public.get_workspace_role(workspace_id, auth.uid()) IN ('owner','admin'));

CREATE TRIGGER trg_ai_msg_triggers_updated_at
BEFORE UPDATE ON public.ai_agent_message_triggers
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();