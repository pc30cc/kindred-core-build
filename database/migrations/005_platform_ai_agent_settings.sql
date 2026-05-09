-- E12 — Platform-wide AI Agent control settings (Super Admin only).
-- Singleton-style table (single canonical row managed via service role).
-- Workspace UI must NEVER read this table directly — it must use the
-- redacted /api/ai-agent/capabilities endpoint instead.

CREATE TABLE IF NOT EXISTS platform_ai_agent_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ai_agent_enabled boolean NOT NULL DEFAULT true,
  customer_ai_agent_visible boolean NOT NULL DEFAULT true,
  advanced_tools_enabled boolean NOT NULL DEFAULT false,
  regression_runner_enabled boolean NOT NULL DEFAULT false,
  source_health_visible_to_customers boolean NOT NULL DEFAULT false,
  test_harness_visible_to_customers boolean NOT NULL DEFAULT false,
  operator_assist_enabled boolean NOT NULL DEFAULT true,
  auto_answer_enabled boolean NOT NULL DEFAULT true,
  learning_enabled boolean NOT NULL DEFAULT true,
  files_enabled boolean NOT NULL DEFAULT true,
  websites_enabled boolean NOT NULL DEFAULT true,
  qna_enabled boolean NOT NULL DEFAULT true,
  kb_enabled boolean NOT NULL DEFAULT true,
  max_customer_visible_nav_items integer NOT NULL DEFAULT 6,
  disabled_message text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE platform_ai_agent_settings ENABLE ROW LEVEL SECURITY;

-- Only global platform admins (has_role('admin')) may read or write.
-- Service role bypasses RLS and is used by the Express backend.
DROP POLICY IF EXISTS "Admins read platform ai-agent settings" ON platform_ai_agent_settings;
CREATE POLICY "Admins read platform ai-agent settings"
  ON platform_ai_agent_settings FOR SELECT TO authenticated
  USING (has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "Admins manage platform ai-agent settings" ON platform_ai_agent_settings;
CREATE POLICY "Admins manage platform ai-agent settings"
  ON platform_ai_agent_settings FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'))
  WITH CHECK (has_role(auth.uid(), 'admin'));

-- Seed singleton row if none exists.
INSERT INTO platform_ai_agent_settings (id)
SELECT gen_random_uuid()
WHERE NOT EXISTS (SELECT 1 FROM platform_ai_agent_settings);