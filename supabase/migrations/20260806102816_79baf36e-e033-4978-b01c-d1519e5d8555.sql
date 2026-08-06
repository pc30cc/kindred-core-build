-- Smart Engagement (proactive widget messaging)
CREATE TABLE public.widget_smart_rules (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  priority INTEGER NOT NULL DEFAULT 100,
  schema_version INTEGER NOT NULL DEFAULT 1,
  published_version INTEGER NOT NULL DEFAULT 0,
  trigger_config JSONB NOT NULL DEFAULT '{"type":"time_on_page","seconds":20}'::jsonb,
  audience_config JSONB NOT NULL DEFAULT '{"match":"all","conditions":[]}'::jsonb,
  content_config JSONB NOT NULL DEFAULT '{"default_locale":"en","locales":{}}'::jsonb,
  presentation_config JSONB NOT NULL DEFAULT '{"mode":"launcher_nudge","action":"open_chat"}'::jsonb,
  schedule_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  frequency_config JSONB NOT NULL DEFAULT '{"mode":"once_per_session"}'::jsonb,
  behavior_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID,
  updated_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  CONSTRAINT widget_smart_rules_name_not_blank CHECK (length(btrim(name)) > 0),
  CONSTRAINT widget_smart_rules_name_len CHECK (length(name) <= 80),
  CONSTRAINT widget_smart_rules_status_valid CHECK (status IN ('draft','active','paused')),
  CONSTRAINT widget_smart_rules_priority_range CHECK (priority >= 0 AND priority <= 1000)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.widget_smart_rules TO authenticated;
GRANT ALL ON public.widget_smart_rules TO service_role;

ALTER TABLE public.widget_smart_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace members can view smart rules"
  ON public.widget_smart_rules FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Workspace members can create smart rules"
  ON public.widget_smart_rules FOR INSERT TO authenticated
  WITH CHECK (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Workspace members can update smart rules"
  ON public.widget_smart_rules FOR UPDATE TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()))
  WITH CHECK (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Workspace members can delete smart rules"
  ON public.widget_smart_rules FOR DELETE TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()));

CREATE INDEX idx_widget_smart_rules_ws_status
  ON public.widget_smart_rules (workspace_id, status, priority DESC);

CREATE TRIGGER trg_widget_smart_rules_updated_at
  BEFORE UPDATE ON public.widget_smart_rules
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Interaction events (analytics + server-side frequency)
CREATE TABLE public.widget_smart_events (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  rule_id UUID NOT NULL REFERENCES public.widget_smart_rules(id) ON DELETE CASCADE,
  rule_version INTEGER NOT NULL DEFAULT 1,
  visitor_id TEXT,
  session_id TEXT,
  event_type TEXT NOT NULL,
  page_path TEXT,
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT widget_smart_events_type_valid CHECK (
    event_type IN ('shown','opened','dismissed','cta_clicked','widget_opened','conversation_started','suppressed')
  )
);

GRANT SELECT ON public.widget_smart_events TO authenticated;
GRANT ALL ON public.widget_smart_events TO service_role;

ALTER TABLE public.widget_smart_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace members can view smart events"
  ON public.widget_smart_events FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()));

CREATE UNIQUE INDEX uq_widget_smart_events_idem
  ON public.widget_smart_events (workspace_id, idempotency_key);

CREATE INDEX idx_widget_smart_events_rule
  ON public.widget_smart_events (rule_id, event_type, created_at DESC);

-- Master switch, OFF by default for every existing workspace.
ALTER TABLE public.widget_settings
  ADD COLUMN IF NOT EXISTS smart_engagement_enabled BOOLEAN NOT NULL DEFAULT false;