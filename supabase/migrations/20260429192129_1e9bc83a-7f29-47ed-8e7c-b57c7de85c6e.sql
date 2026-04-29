-- AI Agent Console — Pass A: Guidance + Routing + Data Sources

-- ─── Guidance rules ───
CREATE TABLE IF NOT EXISTS public.ai_agent_guidance_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  rule_type text NOT NULL CHECK (rule_type IN (
    'tone','answer_policy','escalation_policy','restricted_topic',
    'fallback_behavior','sales_guidance','support_guidance','pricing_guidance'
  )),
  condition_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  instruction text NOT NULL DEFAULT '',
  priority integer NOT NULL DEFAULT 100,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_guidance_workspace ON public.ai_agent_guidance_rules(workspace_id, priority);

ALTER TABLE public.ai_agent_guidance_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can view guidance rules"
ON public.ai_agent_guidance_rules FOR SELECT TO authenticated
USING (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Admins+ can manage guidance rules"
ON public.ai_agent_guidance_rules FOR ALL TO authenticated
USING (public.get_workspace_role(workspace_id, auth.uid()) IN ('owner','admin'))
WITH CHECK (public.get_workspace_role(workspace_id, auth.uid()) IN ('owner','admin'));

CREATE TRIGGER trg_ai_guidance_updated_at
BEFORE UPDATE ON public.ai_agent_guidance_rules
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ─── Routing rules ───
CREATE TABLE IF NOT EXISTS public.ai_agent_routing_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  trigger_type text NOT NULL CHECK (trigger_type IN (
    'human_request','no_answer','low_confidence','topic_detected',
    'business_hours','language','vip_customer','plan_limit'
  )),
  conditions_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  action_type text NOT NULL CHECK (action_type IN (
    'handoff','assign_team','assign_operator','keep_ai','create_ticket','mark_priority'
  )),
  action_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  priority integer NOT NULL DEFAULT 100,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_routing_workspace ON public.ai_agent_routing_rules(workspace_id, priority);

ALTER TABLE public.ai_agent_routing_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can view routing rules"
ON public.ai_agent_routing_rules FOR SELECT TO authenticated
USING (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Admins+ can manage routing rules"
ON public.ai_agent_routing_rules FOR ALL TO authenticated
USING (public.get_workspace_role(workspace_id, auth.uid()) IN ('owner','admin'))
WITH CHECK (public.get_workspace_role(workspace_id, auth.uid()) IN ('owner','admin'));

CREATE TRIGGER trg_ai_routing_updated_at
BEFORE UPDATE ON public.ai_agent_routing_rules
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ─── Data sources (web pages, files, etc.) ───
CREATE TABLE IF NOT EXISTS public.ai_data_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  source_type text NOT NULL CHECK (source_type IN (
    'website','kb','qna','file','business_profile','snippet'
  )),
  name text NOT NULL,
  base_url text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN (
    'active','paused','syncing','failed','deleted'
  )),
  include_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  exclude_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  crawl_depth integer NOT NULL DEFAULT 2,
  max_pages integer NOT NULL DEFAULT 50,
  refresh_interval text NOT NULL DEFAULT 'manual' CHECK (refresh_interval IN (
    'manual','daily','weekly','monthly'
  )),
  last_synced_at timestamptz,
  next_sync_at timestamptz,
  last_error text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_data_sources_workspace ON public.ai_data_sources(workspace_id, source_type);

ALTER TABLE public.ai_data_sources ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can view data sources"
ON public.ai_data_sources FOR SELECT TO authenticated
USING (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Admins+ can manage data sources"
ON public.ai_data_sources FOR ALL TO authenticated
USING (public.get_workspace_role(workspace_id, auth.uid()) IN ('owner','admin'))
WITH CHECK (public.get_workspace_role(workspace_id, auth.uid()) IN ('owner','admin'));

CREATE TRIGGER trg_ai_data_sources_updated_at
BEFORE UPDATE ON public.ai_data_sources
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ─── Source sync logs ───
CREATE TABLE IF NOT EXISTS public.ai_source_sync_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES public.ai_data_sources(id) ON DELETE CASCADE,
  status text NOT NULL,
  message text,
  pages_found integer DEFAULT 0,
  chunks_created integer DEFAULT 0,
  embedded_chunks integer DEFAULT 0,
  errors integer DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_source_logs_source ON public.ai_source_sync_logs(source_id, created_at DESC);

ALTER TABLE public.ai_source_sync_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can view sync logs"
ON public.ai_source_sync_logs FOR SELECT TO authenticated
USING (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Admins+ can insert sync logs"
ON public.ai_source_sync_logs FOR INSERT TO authenticated
WITH CHECK (public.get_workspace_role(workspace_id, auth.uid()) IN ('owner','admin'));