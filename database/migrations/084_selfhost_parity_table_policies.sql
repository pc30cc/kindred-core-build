-- 084_selfhost_parity_table_policies.sql
--
-- RLS policies for the base tables ported in 016a. They live in a separate,
-- later migration because several policies reference relations and helper
-- functions (workspace_subscriptions, is_workspace_member,
-- workspace_owner_phone_verified) that the chain only creates afterwards.

DROP POLICY IF EXISTS "ai_agent_settings_member_read" ON public.ai_agent_settings;
CREATE POLICY "ai_agent_settings_member_read" ON public.ai_agent_settings AS PERMISSIVE FOR SELECT TO authenticated
  USING (is_workspace_member(workspace_id, auth.uid()));

DROP POLICY IF EXISTS "Admins can manage plans" ON public.billing_plans;
CREATE POLICY "Admins can manage plans" ON public.billing_plans AS PERMISSIVE FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

DROP POLICY IF EXISTS "Authenticated can read visible plans" ON public.billing_plans;
CREATE POLICY "Authenticated can read visible plans" ON public.billing_plans AS PERMISSIVE FOR SELECT TO authenticated
  USING ((has_role(auth.uid(), 'admin'::app_role) OR ((is_active = true) AND (COALESCE(is_hidden, false) = false)) OR (EXISTS ( SELECT 1
   FROM workspace_subscriptions ws
  WHERE ((ws.plan_id = billing_plans.id) AND is_workspace_member(ws.workspace_id, auth.uid()))))));

DROP POLICY IF EXISTS "Workspace admins mutate queue" ON public.call_queue_entries;
CREATE POLICY "Workspace admins mutate queue" ON public.call_queue_entries AS PERMISSIVE FOR ALL TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM workspace_members wm
  WHERE ((wm.workspace_id = call_queue_entries.workspace_id) AND (wm.user_id = auth.uid()) AND (wm.role = ANY (ARRAY['owner'::workspace_role, 'admin'::workspace_role]))))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM workspace_members wm
  WHERE ((wm.workspace_id = call_queue_entries.workspace_id) AND (wm.user_id = auth.uid()) AND (wm.role = ANY (ARRAY['owner'::workspace_role, 'admin'::workspace_role]))))));

DROP POLICY IF EXISTS "Workspace members read queue" ON public.call_queue_entries;
CREATE POLICY "Workspace members read queue" ON public.call_queue_entries AS PERMISSIVE FOR SELECT TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM workspace_members wm
  WHERE ((wm.workspace_id = call_queue_entries.workspace_id) AND (wm.user_id = auth.uid())))));

DROP POLICY IF EXISTS "call_sessions_select_members" ON public.call_sessions;
CREATE POLICY "call_sessions_select_members" ON public.call_sessions AS PERMISSIVE FOR SELECT TO authenticated
  USING ((is_workspace_member(workspace_id, auth.uid()) OR has_role(auth.uid(), 'admin'::app_role)));

DROP POLICY IF EXISTS "members insert callbacks" ON public.callback_requests;
CREATE POLICY "members insert callbacks" ON public.callback_requests AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (is_workspace_member(workspace_id, auth.uid()));

DROP POLICY IF EXISTS "members read callbacks" ON public.callback_requests;
CREATE POLICY "members read callbacks" ON public.callback_requests AS PERMISSIVE FOR SELECT TO public
  USING (is_workspace_member(workspace_id, auth.uid()));

DROP POLICY IF EXISTS "members update callbacks" ON public.callback_requests;
CREATE POLICY "members update callbacks" ON public.callback_requests AS PERMISSIVE FOR UPDATE TO public
  USING (is_workspace_member(workspace_id, auth.uid()))
  WITH CHECK (is_workspace_member(workspace_id, auth.uid()));

DROP POLICY IF EXISTS "Service role full access prechat" ON public.widget_prechat_settings;
CREATE POLICY "Service role full access prechat" ON public.widget_prechat_settings AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Workspace admins manage prechat" ON public.widget_prechat_settings;
CREATE POLICY "Workspace admins manage prechat" ON public.widget_prechat_settings AS PERMISSIVE FOR ALL TO authenticated
  USING ((is_workspace_member(workspace_id, auth.uid()) AND (get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::workspace_role, 'admin'::workspace_role])) AND workspace_owner_phone_verified(workspace_id)))
  WITH CHECK ((is_workspace_member(workspace_id, auth.uid()) AND (get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::workspace_role, 'admin'::workspace_role])) AND workspace_owner_phone_verified(workspace_id)));

DROP POLICY IF EXISTS "Workspace members read prechat" ON public.widget_prechat_settings;
CREATE POLICY "Workspace members read prechat" ON public.widget_prechat_settings AS PERMISSIVE FOR SELECT TO authenticated
  USING (is_workspace_member(workspace_id, auth.uid()));

DROP POLICY IF EXISTS "Workspace members can create smart rules" ON public.widget_smart_rules;
CREATE POLICY "Workspace members can create smart rules" ON public.widget_smart_rules AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (is_workspace_member(workspace_id, auth.uid()));

DROP POLICY IF EXISTS "Workspace members can delete smart rules" ON public.widget_smart_rules;
CREATE POLICY "Workspace members can delete smart rules" ON public.widget_smart_rules AS PERMISSIVE FOR DELETE TO authenticated
  USING (is_workspace_member(workspace_id, auth.uid()));

DROP POLICY IF EXISTS "Workspace members can update smart rules" ON public.widget_smart_rules;
CREATE POLICY "Workspace members can update smart rules" ON public.widget_smart_rules AS PERMISSIVE FOR UPDATE TO authenticated
  USING (is_workspace_member(workspace_id, auth.uid()))
  WITH CHECK (is_workspace_member(workspace_id, auth.uid()));

DROP POLICY IF EXISTS "Workspace members can view smart rules" ON public.widget_smart_rules;
CREATE POLICY "Workspace members can view smart rules" ON public.widget_smart_rules AS PERMISSIVE FOR SELECT TO authenticated
  USING (is_workspace_member(workspace_id, auth.uid()));

DROP POLICY IF EXISTS "Admins can manage all subscriptions" ON public.workspace_subscriptions;
CREATE POLICY "Admins can manage all subscriptions" ON public.workspace_subscriptions AS PERMISSIVE FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

DROP POLICY IF EXISTS "Admins can manage workspace subscriptions" ON public.workspace_subscriptions;
CREATE POLICY "Admins can manage workspace subscriptions" ON public.workspace_subscriptions AS PERMISSIVE FOR ALL TO authenticated
  USING ((get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::workspace_role, 'admin'::workspace_role])))
  WITH CHECK ((get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::workspace_role, 'admin'::workspace_role])));

DROP POLICY IF EXISTS "Admins can view workspace subscriptions" ON public.workspace_subscriptions;
CREATE POLICY "Admins can view workspace subscriptions" ON public.workspace_subscriptions AS PERMISSIVE FOR SELECT TO authenticated
  USING ((get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::workspace_role, 'admin'::workspace_role])));

DROP POLICY IF EXISTS "Billing role can view subscription" ON public.workspace_subscriptions;
CREATE POLICY "Billing role can view subscription" ON public.workspace_subscriptions AS PERMISSIVE FOR SELECT TO authenticated
  USING ((get_workspace_role(workspace_id, auth.uid()) = 'billing'::workspace_role));

DROP POLICY IF EXISTS "Global admins can manage all subscriptions" ON public.workspace_subscriptions;
CREATE POLICY "Global admins can manage all subscriptions" ON public.workspace_subscriptions AS PERMISSIVE FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

DROP POLICY IF EXISTS "Global admins can view all workspace subscriptions" ON public.workspace_subscriptions;
CREATE POLICY "Global admins can view all workspace subscriptions" ON public.workspace_subscriptions AS PERMISSIVE FOR SELECT TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role));

DROP POLICY IF EXISTS "Members can view subscription" ON public.workspace_subscriptions;
CREATE POLICY "Members can view subscription" ON public.workspace_subscriptions AS PERMISSIVE FOR SELECT TO authenticated
  USING (is_workspace_member(workspace_id, auth.uid()));

DROP POLICY IF EXISTS "Workspace admins can view subscription" ON public.workspace_subscriptions;
CREATE POLICY "Workspace admins can view subscription" ON public.workspace_subscriptions AS PERMISSIVE FOR SELECT TO authenticated
  USING ((get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::workspace_role, 'admin'::workspace_role])));

DROP POLICY IF EXISTS "Workspace members can view smart events" ON public.widget_smart_events;
CREATE POLICY "Workspace members can view smart events" ON public.widget_smart_events AS PERMISSIVE FOR SELECT TO authenticated
  USING (is_workspace_member(workspace_id, auth.uid()));

