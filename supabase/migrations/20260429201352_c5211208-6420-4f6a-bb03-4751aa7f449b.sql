-- AI Agent Console — Pass B2: Integrations & MCP (configuration only, no runtime execution)

-- ─── Tool servers ───
CREATE TABLE IF NOT EXISTS public.ai_agent_tool_servers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  server_type text NOT NULL DEFAULT 'mcp' CHECK (server_type IN ('mcp','internal','webhook')),
  endpoint_url text,
  status text NOT NULL DEFAULT 'disabled' CHECK (status IN ('disabled','enabled','error')),
  auth_type text NOT NULL DEFAULT 'none' CHECK (auth_type IN ('none','bearer','basic','api_key','oauth')),
  encrypted_config jsonb,
  allowed_tools text[] NOT NULL DEFAULT '{}',
  permissions_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_checked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_tool_servers_workspace ON public.ai_agent_tool_servers(workspace_id);
CREATE INDEX IF NOT EXISTS idx_ai_tool_servers_workspace_status ON public.ai_agent_tool_servers(workspace_id, status);

ALTER TABLE public.ai_agent_tool_servers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can view tool servers"
ON public.ai_agent_tool_servers FOR SELECT TO authenticated
USING (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Admins+ can manage tool servers"
ON public.ai_agent_tool_servers FOR ALL TO authenticated
USING (public.get_workspace_role(workspace_id, auth.uid()) IN ('owner','admin'))
WITH CHECK (public.get_workspace_role(workspace_id, auth.uid()) IN ('owner','admin'));

CREATE TRIGGER trg_ai_tool_servers_updated_at
BEFORE UPDATE ON public.ai_agent_tool_servers
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ─── Tools catalog ───
CREATE TABLE IF NOT EXISTS public.ai_agent_tools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  tool_type text NOT NULL CHECK (tool_type IN ('internal','mcp','webhook','crm','ticket')),
  provider text,
  server_id uuid REFERENCES public.ai_agent_tool_servers(id) ON DELETE SET NULL,
  config_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT false,
  permissions_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  risk_level text NOT NULL DEFAULT 'low' CHECK (risk_level IN ('low','medium','high')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_tools_workspace ON public.ai_agent_tools(workspace_id);
CREATE INDEX IF NOT EXISTS idx_ai_tools_workspace_type ON public.ai_agent_tools(workspace_id, tool_type);
CREATE INDEX IF NOT EXISTS idx_ai_tools_server ON public.ai_agent_tools(server_id);

ALTER TABLE public.ai_agent_tools ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can view tools"
ON public.ai_agent_tools FOR SELECT TO authenticated
USING (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Admins+ can manage tools"
ON public.ai_agent_tools FOR ALL TO authenticated
USING (public.get_workspace_role(workspace_id, auth.uid()) IN ('owner','admin'))
WITH CHECK (public.get_workspace_role(workspace_id, auth.uid()) IN ('owner','admin'));

CREATE TRIGGER trg_ai_tools_updated_at
BEFORE UPDATE ON public.ai_agent_tools
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();