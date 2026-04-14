
-- Allow platform-level email templates (workspace_id = NULL)
ALTER TABLE public.email_templates ALTER COLUMN workspace_id DROP NOT NULL;

-- Drop existing policy that only checks workspace role
DROP POLICY IF EXISTS "Admins+ can manage email templates" ON public.email_templates;

-- Admins can manage platform-level templates, workspace admins can manage their own
CREATE POLICY "Admins can manage email templates"
ON public.email_templates
FOR ALL
TO authenticated
USING (
  (workspace_id IS NULL AND has_role(auth.uid(), 'admin'::app_role))
  OR
  (workspace_id IS NOT NULL AND get_workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin'))
)
WITH CHECK (
  (workspace_id IS NULL AND has_role(auth.uid(), 'admin'::app_role))
  OR
  (workspace_id IS NOT NULL AND get_workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin'))
);

-- Authenticated users can read platform-level templates
CREATE POLICY "Authenticated can read platform templates"
ON public.email_templates
FOR SELECT
TO authenticated
USING (workspace_id IS NULL);
