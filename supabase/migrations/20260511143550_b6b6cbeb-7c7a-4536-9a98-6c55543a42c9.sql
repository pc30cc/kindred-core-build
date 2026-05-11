-- ─── Departments ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.call_center_departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  slug text NOT NULL,
  description text,
  color text,
  icon text,
  enabled boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  routing_mode text NOT NULL DEFAULT 'broadcast'
    CHECK (routing_mode IN ('broadcast','round_robin','least_busy')),
  fallback_department_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_ccd_workspace ON public.call_center_departments(workspace_id);
CREATE INDEX IF NOT EXISTS idx_ccd_workspace_enabled ON public.call_center_departments(workspace_id, enabled);
CREATE INDEX IF NOT EXISTS idx_ccd_workspace_slug ON public.call_center_departments(workspace_id, slug);

ALTER TABLE public.call_center_departments
  ADD CONSTRAINT call_center_departments_fallback_fk
  FOREIGN KEY (fallback_department_id) REFERENCES public.call_center_departments(id) ON DELETE SET NULL
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public.call_center_departments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ccd_member_read ON public.call_center_departments;
CREATE POLICY ccd_member_read
  ON public.call_center_departments FOR SELECT
  USING (public.is_workspace_member(workspace_id, auth.uid()));

DROP POLICY IF EXISTS ccd_admin_write ON public.call_center_departments;
CREATE POLICY ccd_admin_write
  ON public.call_center_departments FOR ALL
  USING (public.get_workspace_role(workspace_id, auth.uid()) IN ('owner','admin'))
  WITH CHECK (public.get_workspace_role(workspace_id, auth.uid()) IN ('owner','admin'));

DROP TRIGGER IF EXISTS trg_ccd_touch ON public.call_center_departments;
CREATE TRIGGER trg_ccd_touch BEFORE UPDATE ON public.call_center_departments
  FOR EACH ROW EXECUTE FUNCTION public.cc_touch_updated_at();

-- ─── Department agents ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.call_center_department_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  department_id uuid NOT NULL REFERENCES public.call_center_departments(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'agent' CHECK (role IN ('agent','supervisor')),
  priority integer NOT NULL DEFAULT 100,
  enabled boolean NOT NULL DEFAULT true,
  max_concurrent_calls integer,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, department_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_ccda_workspace ON public.call_center_department_agents(workspace_id);
CREATE INDEX IF NOT EXISTS idx_ccda_department ON public.call_center_department_agents(department_id);
CREATE INDEX IF NOT EXISTS idx_ccda_user ON public.call_center_department_agents(user_id);
CREATE INDEX IF NOT EXISTS idx_ccda_workspace_enabled ON public.call_center_department_agents(workspace_id, enabled);

ALTER TABLE public.call_center_department_agents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ccda_member_read ON public.call_center_department_agents;
CREATE POLICY ccda_member_read
  ON public.call_center_department_agents FOR SELECT
  USING (public.is_workspace_member(workspace_id, auth.uid()));

DROP POLICY IF EXISTS ccda_admin_write ON public.call_center_department_agents;
CREATE POLICY ccda_admin_write
  ON public.call_center_department_agents FOR ALL
  USING (public.get_workspace_role(workspace_id, auth.uid()) IN ('owner','admin'))
  WITH CHECK (public.get_workspace_role(workspace_id, auth.uid()) IN ('owner','admin'));

DROP TRIGGER IF EXISTS trg_ccda_touch ON public.call_center_department_agents;
CREATE TRIGGER trg_ccda_touch BEFORE UPDATE ON public.call_center_department_agents
  FOR EACH ROW EXECUTE FUNCTION public.cc_touch_updated_at();

-- ─── Agent presence ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.call_center_agent_presence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'offline'
    CHECK (status IN ('available','busy','away','offline')),
  status_message text,
  active_call_count integer NOT NULL DEFAULT 0,
  last_seen_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_ccap_workspace ON public.call_center_agent_presence(workspace_id);
CREATE INDEX IF NOT EXISTS idx_ccap_user ON public.call_center_agent_presence(user_id);
CREATE INDEX IF NOT EXISTS idx_ccap_workspace_status ON public.call_center_agent_presence(workspace_id, status);

ALTER TABLE public.call_center_agent_presence ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ccap_member_read ON public.call_center_agent_presence;
CREATE POLICY ccap_member_read
  ON public.call_center_agent_presence FOR SELECT
  USING (public.is_workspace_member(workspace_id, auth.uid()));

DROP POLICY IF EXISTS ccap_self_write ON public.call_center_agent_presence;
CREATE POLICY ccap_self_write
  ON public.call_center_agent_presence FOR ALL
  USING (
    user_id = auth.uid()
    AND public.get_workspace_role(workspace_id, auth.uid())
        IN ('owner','admin','agent','support_agent','team_lead')
  )
  WITH CHECK (
    user_id = auth.uid()
    AND public.get_workspace_role(workspace_id, auth.uid())
        IN ('owner','admin','agent','support_agent','team_lead')
  );

DROP TRIGGER IF EXISTS trg_ccap_touch ON public.call_center_agent_presence;
CREATE TRIGGER trg_ccap_touch BEFORE UPDATE ON public.call_center_agent_presence
  FOR EACH ROW EXECUTE FUNCTION public.cc_touch_updated_at();

-- ─── Additive columns: call_sessions ──────────────────────────────────────
ALTER TABLE public.call_sessions
  ADD COLUMN IF NOT EXISTS department_id uuid,
  ADD COLUMN IF NOT EXISTS assigned_agent_id uuid,
  ADD COLUMN IF NOT EXISTS transfer_from_agent_id uuid,
  ADD COLUMN IF NOT EXISTS transfer_to_agent_id uuid,
  ADD COLUMN IF NOT EXISTS transfer_to_department_id uuid,
  ADD COLUMN IF NOT EXISTS transfer_reason text;

CREATE INDEX IF NOT EXISTS idx_call_sessions_department
  ON public.call_sessions(workspace_id, department_id);
CREATE INDEX IF NOT EXISTS idx_call_sessions_assigned
  ON public.call_sessions(workspace_id, assigned_agent_id);

-- ─── Additive columns: call_queue_entries ─────────────────────────────────
ALTER TABLE public.call_queue_entries
  ADD COLUMN IF NOT EXISTS department_id uuid,
  ADD COLUMN IF NOT EXISTS assigned_agent_id uuid,
  ADD COLUMN IF NOT EXISTS routing_mode text,
  ADD COLUMN IF NOT EXISTS routing_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_routing_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_call_queue_department
  ON public.call_queue_entries(workspace_id, department_id);
CREATE INDEX IF NOT EXISTS idx_call_queue_assigned
  ON public.call_queue_entries(workspace_id, assigned_agent_id);
