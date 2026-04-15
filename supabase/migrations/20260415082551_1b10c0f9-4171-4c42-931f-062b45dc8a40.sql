
-- 1. translations: restrict anon to platform-level only
DROP POLICY IF EXISTS "Public can read translations" ON translations;
CREATE POLICY "Public can read platform translations"
  ON translations FOR SELECT TO anon
  USING (workspace_id IS NULL);

-- 2. workspace_branding_localized: drop the old permissive policy
DROP POLICY IF EXISTS "Anon can read ws branding localized" ON workspace_branding_localized;

-- 3. email_settings: tighten authenticated read
DROP POLICY IF EXISTS "Authenticated can read email settings" ON email_settings;
CREATE POLICY "Authenticated can read email settings"
  ON email_settings FOR SELECT TO authenticated
  USING (
    (workspace_id IS NOT NULL AND is_workspace_member(workspace_id, auth.uid()))
    OR
    (workspace_id IS NULL AND has_role(auth.uid(), 'admin'))
  );

-- 4. email_settings_localized: tighten authenticated read
DROP POLICY IF EXISTS "Authenticated can read email settings localized" ON email_settings_localized;
CREATE POLICY "Authenticated can read email settings localized"
  ON email_settings_localized FOR SELECT TO authenticated
  USING (
    (workspace_id IS NOT NULL AND is_workspace_member(workspace_id, auth.uid()))
    OR
    (workspace_id IS NULL AND has_role(auth.uid(), 'admin'))
  );
