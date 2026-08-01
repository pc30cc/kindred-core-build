-- 1) Restrict billing_plans reads for authenticated users
DROP POLICY IF EXISTS "Authenticated can read plans" ON public.billing_plans;

CREATE POLICY "Authenticated can read visible plans"
ON public.billing_plans
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'admin'::app_role)
  OR (is_active = true AND coalesce(is_hidden, false) = false)
  OR EXISTS (
    SELECT 1
    FROM public.workspace_subscriptions ws
    WHERE ws.plan_id = billing_plans.id
      AND public.is_workspace_member(ws.workspace_id, auth.uid())
  )
);

-- 2) Revoke anonymous EXECUTE on SECURITY DEFINER helpers that anonymous
--    clients never legitimately need (role / account membership checks).
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, app_role) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_account_role(uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.is_account_member(uuid, uuid) FROM anon;
