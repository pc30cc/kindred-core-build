
-- ============================================================
-- 1. FIX: visitor_sessions — replace permissive anon UPDATE
-- ============================================================
DROP POLICY IF EXISTS "Anon can update visitor sessions" ON visitor_sessions;
CREATE POLICY "Anon can update own visitor sessions"
  ON visitor_sessions FOR UPDATE TO anon
  USING (visitor_id = current_setting('request.headers', true)::json->>'x-visitor-id')
  WITH CHECK (visitor_id = current_setting('request.headers', true)::json->>'x-visitor-id');

-- Also tighten INSERT
DROP POLICY IF EXISTS "Anon can insert visitor sessions" ON visitor_sessions;
CREATE POLICY "Anon can insert visitor sessions"
  ON visitor_sessions FOR INSERT TO anon
  WITH CHECK (visitor_id IS NOT NULL AND workspace_id IS NOT NULL);

-- ============================================================
-- 2. FIX: visitor_presence — replace permissive anon ALL
-- ============================================================
DROP POLICY IF EXISTS "Anon can manage presence" ON visitor_presence;

CREATE POLICY "Anon can insert presence"
  ON visitor_presence FOR INSERT TO anon
  WITH CHECK (visitor_session_id IS NOT NULL AND workspace_id IS NOT NULL);

CREATE POLICY "Anon can update own presence"
  ON visitor_presence FOR UPDATE TO anon
  USING (
    EXISTS (
      SELECT 1 FROM visitor_sessions vs
      WHERE vs.id = visitor_presence.visitor_session_id
      AND vs.visitor_id = current_setting('request.headers', true)::json->>'x-visitor-id'
    )
  );

CREATE POLICY "Anon can read own presence"
  ON visitor_presence FOR SELECT TO anon
  USING (
    EXISTS (
      SELECT 1 FROM visitor_sessions vs
      WHERE vs.id = visitor_presence.visitor_session_id
      AND vs.visitor_id = current_setting('request.headers', true)::json->>'x-visitor-id'
    )
  );

-- ============================================================
-- 3. FIX: app_runtime_config — remove anon access (has API keys)
-- ============================================================
DROP POLICY IF EXISTS "Public can read runtime config" ON app_runtime_config;

CREATE POLICY "Authenticated can read runtime config"
  ON app_runtime_config FOR SELECT TO authenticated
  USING (true);

-- ============================================================
-- 4. FIX: auth token tables — explicit deny-all (SECURITY DEFINER only)
-- ============================================================
-- auth_reset_tokens
CREATE POLICY "No direct access to reset tokens"
  ON auth_reset_tokens FOR ALL TO authenticated, anon
  USING (false)
  WITH CHECK (false);

-- auth_sessions
CREATE POLICY "No direct access to auth sessions"
  ON auth_sessions FOR ALL TO authenticated, anon
  USING (false)
  WITH CHECK (false);

-- auth_verify_tokens
CREATE POLICY "No direct access to verify tokens"
  ON auth_verify_tokens FOR ALL TO authenticated, anon
  USING (false)
  WITH CHECK (false);

-- login_attempts
CREATE POLICY "No direct access to login attempts"
  ON login_attempts FOR ALL TO authenticated, anon
  USING (false)
  WITH CHECK (false);

-- ============================================================
-- 5. FIX: workspace_settings — add RLS policies (was empty)
-- ============================================================
ALTER TABLE IF EXISTS workspace_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can view workspace settings"
  ON workspace_settings FOR SELECT TO authenticated
  USING (is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Admins can manage workspace settings"
  ON workspace_settings FOR ALL TO authenticated
  USING (get_workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin'))
  WITH CHECK (get_workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin'));

CREATE POLICY "Global admins can view all workspace settings"
  ON workspace_settings FOR SELECT TO authenticated
  USING (has_role(auth.uid(), 'admin'));

-- ============================================================
-- 6. FIX: workspace_domains_extended — add RLS policies (was empty)
-- ============================================================
ALTER TABLE IF EXISTS workspace_domains_extended ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can view workspace domains extended"
  ON workspace_domains_extended FOR SELECT TO authenticated
  USING (is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Admins can manage workspace domains extended"
  ON workspace_domains_extended FOR ALL TO authenticated
  USING (get_workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin'))
  WITH CHECK (get_workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin'));

CREATE POLICY "Global admins can view all workspace domains extended"
  ON workspace_domains_extended FOR SELECT TO authenticated
  USING (has_role(auth.uid(), 'admin'));

-- ============================================================
-- 7. FIX: workspace_subscriptions — add RLS policies (was empty)
-- ============================================================
ALTER TABLE IF EXISTS workspace_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can view workspace subscriptions"
  ON workspace_subscriptions FOR SELECT TO authenticated
  USING (is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Admins can manage workspace subscriptions"
  ON workspace_subscriptions FOR ALL TO authenticated
  USING (get_workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin'))
  WITH CHECK (get_workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin'));

CREATE POLICY "Global admins can view all workspace subscriptions"
  ON workspace_subscriptions FOR SELECT TO authenticated
  USING (has_role(auth.uid(), 'admin'));

-- ============================================================
-- 8. FIX: billing_events — add workspace owner access
-- ============================================================
CREATE POLICY "Workspace owners can view billing events"
  ON billing_events FOR SELECT TO authenticated
  USING (get_workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin'));

-- ============================================================
-- 9. Tighten knowledge_base_categories anon SELECT
-- ============================================================
DROP POLICY IF EXISTS "Public can read KB categories" ON knowledge_base_categories;
CREATE POLICY "Public can read KB categories with published articles"
  ON knowledge_base_categories FOR SELECT TO anon
  USING (
    EXISTS (
      SELECT 1 FROM knowledge_base_articles a
      WHERE a.category_id = knowledge_base_categories.id
      AND a.status = 'published'
    )
  );
