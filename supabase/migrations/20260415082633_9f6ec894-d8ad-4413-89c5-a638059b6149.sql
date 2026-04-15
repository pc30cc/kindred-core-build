
-- 1. workspace_subscriptions: restrict to owners/admins
DROP POLICY IF EXISTS "Members can view workspace subscriptions" ON workspace_subscriptions;
CREATE POLICY "Admins can view workspace subscriptions"
  ON workspace_subscriptions FOR SELECT TO authenticated
  USING (get_workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin'));

-- 2. feature_flags: split platform vs workspace access
DROP POLICY IF EXISTS "Members can view feature flags" ON feature_flags;

CREATE POLICY "Members can view workspace feature flags"
  ON feature_flags FOR SELECT TO authenticated
  USING (workspace_id IS NOT NULL AND is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Admins can view platform feature flags"
  ON feature_flags FOR SELECT TO authenticated
  USING (workspace_id IS NULL AND has_role(auth.uid(), 'admin'));

-- 3. provider_configs: add explicit SELECT for admins only
CREATE POLICY "Admins can read provider configs"
  ON provider_configs FOR SELECT TO authenticated
  USING (get_workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin'));
