
-- Workspace-level provider settings (end-user configurable)
CREATE TABLE public.workspace_provider_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  provider_type text NOT NULL CHECK (provider_type IN ('email', 'ai', 'webhook')),
  provider_name text NOT NULL DEFAULT 'disabled',
  enabled boolean NOT NULL DEFAULT false,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  secrets jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, provider_type)
);

-- Enable RLS
ALTER TABLE public.workspace_provider_settings ENABLE ROW LEVEL SECURITY;

-- Workspace owner/admin can fully manage their settings
CREATE POLICY "Workspace admins can manage provider settings"
  ON public.workspace_provider_settings
  FOR ALL
  TO authenticated
  USING (get_workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin'))
  WITH CHECK (get_workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin'));

-- Platform admins can view all (for support/debugging)
CREATE POLICY "Platform admins can view all provider settings"
  ON public.workspace_provider_settings
  FOR SELECT
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role));

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION public.update_workspace_provider_settings_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER trg_workspace_provider_settings_updated_at
  BEFORE UPDATE ON public.workspace_provider_settings
  FOR EACH ROW
  EXECUTE FUNCTION public.update_workspace_provider_settings_updated_at();
