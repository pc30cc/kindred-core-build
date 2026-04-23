-- Phase 8H — Optional lightweight departments + routing foundation.
-- Additive only. System must behave identically when no departments exist.

CREATE TABLE IF NOT EXISTS public.workspace_departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  chat_enabled boolean NOT NULL DEFAULT true,
  audio_enabled boolean NOT NULL DEFAULT false,
  video_enabled boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workspace_departments_workspace
  ON public.workspace_departments(workspace_id, enabled, sort_order);

CREATE TABLE IF NOT EXISTS public.workspace_department_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL REFERENCES public.workspace_departments(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (department_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_department_members_dept
  ON public.workspace_department_members(department_id);
CREATE INDEX IF NOT EXISTS idx_workspace_department_members_user
  ON public.workspace_department_members(workspace_id, user_id);

ALTER TABLE public.workspace_departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_department_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "members_can_view_departments"
  ON public.workspace_departments
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.workspace_members wm
      WHERE wm.workspace_id = workspace_departments.workspace_id
        AND wm.user_id = auth.uid()
    )
  );

CREATE POLICY "owners_admins_can_manage_departments"
  ON public.workspace_departments
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.workspace_members wm
      WHERE wm.workspace_id = workspace_departments.workspace_id
        AND wm.user_id = auth.uid()
        AND wm.role IN ('owner','admin')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.workspace_members wm
      WHERE wm.workspace_id = workspace_departments.workspace_id
        AND wm.user_id = auth.uid()
        AND wm.role IN ('owner','admin')
    )
  );

CREATE POLICY "members_can_view_department_members"
  ON public.workspace_department_members
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.workspace_members wm
      WHERE wm.workspace_id = workspace_department_members.workspace_id
        AND wm.user_id = auth.uid()
    )
  );

CREATE POLICY "owners_admins_can_manage_department_members"
  ON public.workspace_department_members
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.workspace_members wm
      WHERE wm.workspace_id = workspace_department_members.workspace_id
        AND wm.user_id = auth.uid()
        AND wm.role IN ('owner','admin')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.workspace_members wm
      WHERE wm.workspace_id = workspace_department_members.workspace_id
        AND wm.user_id = auth.uid()
        AND wm.role IN ('owner','admin')
    )
  );

-- Dedicated updated_at trigger function (scoped to this table)
CREATE OR REPLACE FUNCTION public.set_workspace_departments_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_workspace_departments_updated_at ON public.workspace_departments;
CREATE TRIGGER trg_workspace_departments_updated_at
  BEFORE UPDATE ON public.workspace_departments
  FOR EACH ROW
  EXECUTE FUNCTION public.set_workspace_departments_updated_at();