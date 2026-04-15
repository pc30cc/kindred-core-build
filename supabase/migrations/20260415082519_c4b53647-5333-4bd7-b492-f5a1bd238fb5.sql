
-- 1. app_runtime_config: restrict to admins only
DROP POLICY IF EXISTS "Authenticated can read runtime config" ON app_runtime_config;
CREATE POLICY "Admins can read runtime config"
  ON app_runtime_config FOR SELECT TO authenticated
  USING (has_role(auth.uid(), 'admin'));

-- 2. workspace_branding: scope anon access to public-facing workspaces
DROP POLICY IF EXISTS "Public can read branding" ON workspace_branding;
CREATE POLICY "Public can read active workspace branding"
  ON workspace_branding FOR SELECT TO anon
  USING (
    EXISTS (
      SELECT 1 FROM widget_settings ws
      WHERE ws.workspace_id = workspace_branding.workspace_id
      AND ws.enabled = true
    )
  );

-- 3. workspace_branding_localized: same scope
-- Check if there's an anon policy
DO $$
BEGIN
  -- Drop any existing anon-accessible policies
  IF EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'workspace_branding_localized' 
    AND policyname LIKE '%anon%' OR policyname LIKE '%Public%' OR policyname LIKE '%public%'
  ) THEN
    NULL; -- Will handle below
  END IF;
END $$;

-- Drop and recreate
DROP POLICY IF EXISTS "Public can read workspace branding localized" ON workspace_branding_localized;
DROP POLICY IF EXISTS "Anon can read workspace branding localized" ON workspace_branding_localized;

-- Add scoped anon policy if needed for widget
CREATE POLICY "Public can read active workspace branding localized"
  ON workspace_branding_localized FOR SELECT TO anon
  USING (
    EXISTS (
      SELECT 1 FROM widget_settings ws
      WHERE ws.workspace_id = workspace_branding_localized.workspace_id
      AND ws.enabled = true
    )
  );

-- 4. visitor_sessions: tighten INSERT to validate workspace has tracking enabled
DROP POLICY IF EXISTS "Anon can insert visitor sessions" ON visitor_sessions;
CREATE POLICY "Anon can insert visitor sessions"
  ON visitor_sessions FOR INSERT TO anon
  WITH CHECK (
    visitor_id IS NOT NULL
    AND workspace_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM widget_settings ws
      WHERE ws.workspace_id = visitor_sessions.workspace_id
      AND ws.visitor_tracking_enabled = true
      AND ws.enabled = true
    )
  );

-- 5. visitor_presence: tighten INSERT to validate session ownership
DROP POLICY IF EXISTS "Anon can insert presence" ON visitor_presence;
CREATE POLICY "Anon can insert own presence"
  ON visitor_presence FOR INSERT TO anon
  WITH CHECK (
    visitor_session_id IS NOT NULL
    AND workspace_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM visitor_sessions vs
      WHERE vs.id = visitor_presence.visitor_session_id
      AND vs.workspace_id = visitor_presence.workspace_id
      AND vs.visitor_id = current_setting('request.headers', true)::json->>'x-visitor-id'
    )
  );
