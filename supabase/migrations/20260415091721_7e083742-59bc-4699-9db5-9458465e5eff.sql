-- Allow billing role to view billing_payments
DROP POLICY IF EXISTS "Workspace admins can view payments" ON public.billing_payments;
CREATE POLICY "Workspace billing access can view payments" ON public.billing_payments
  FOR SELECT TO authenticated
  USING (
    get_workspace_role(workspace_id, auth.uid()) IN ('owner'::workspace_role, 'admin'::workspace_role, 'billing'::workspace_role)
  );

-- Allow billing role to view billing_events
DROP POLICY IF EXISTS "Workspace owners can view billing events" ON public.billing_events;
CREATE POLICY "Workspace billing access can view billing events" ON public.billing_events
  FOR SELECT TO authenticated
  USING (
    get_workspace_role(workspace_id, auth.uid()) IN ('owner'::workspace_role, 'admin'::workspace_role, 'billing'::workspace_role)
  );