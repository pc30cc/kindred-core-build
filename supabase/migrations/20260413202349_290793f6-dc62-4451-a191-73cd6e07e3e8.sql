
CREATE TABLE IF NOT EXISTS visitor_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  visitor_id TEXT NOT NULL,
  current_page TEXT,
  referrer TEXT,
  browser TEXT,
  device TEXT,
  os TEXT,
  country TEXT,
  city TEXT,
  ip_hash TEXT,
  started_at TIMESTAMPTZ DEFAULT now(),
  last_seen_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_visitor_sessions_workspace ON visitor_sessions(workspace_id);
CREATE INDEX idx_visitor_sessions_last_seen ON visitor_sessions(workspace_id, last_seen_at DESC);
ALTER TABLE visitor_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members can view visitor sessions" ON visitor_sessions FOR SELECT TO authenticated USING (is_workspace_member(workspace_id, auth.uid()));
CREATE POLICY "Anon can insert visitor sessions" ON visitor_sessions FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Anon can update visitor sessions" ON visitor_sessions FOR UPDATE TO anon USING (true);

CREATE TYPE public.presence_status AS ENUM ('online', 'idle', 'offline');
CREATE TABLE IF NOT EXISTS visitor_presence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  visitor_session_id UUID NOT NULL REFERENCES visitor_sessions(id) ON DELETE CASCADE,
  status presence_status DEFAULT 'online',
  current_page TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_visitor_presence_workspace ON visitor_presence(workspace_id, status);
ALTER TABLE visitor_presence ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members can view presence" ON visitor_presence FOR SELECT TO authenticated USING (is_workspace_member(workspace_id, auth.uid()));
CREATE POLICY "Anon can manage presence" ON visitor_presence FOR ALL TO anon USING (true);

CREATE TABLE IF NOT EXISTS knowledge_base_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  locale TEXT NOT NULL DEFAULT 'en',
  name TEXT NOT NULL,
  description TEXT,
  icon TEXT,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (workspace_id, slug, locale)
);
ALTER TABLE knowledge_base_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members can manage KB categories" ON knowledge_base_categories FOR ALL TO authenticated USING (is_workspace_member(workspace_id, auth.uid()));
CREATE POLICY "Public can read KB categories" ON knowledge_base_categories FOR SELECT TO anon USING (true);

CREATE TYPE public.article_status AS ENUM ('draft', 'published', 'archived');
CREATE TABLE IF NOT EXISTS knowledge_base_articles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  category_id UUID REFERENCES knowledge_base_categories(id) ON DELETE SET NULL,
  slug TEXT NOT NULL,
  locale TEXT NOT NULL DEFAULT 'en',
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  excerpt TEXT,
  status article_status DEFAULT 'draft',
  sort_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (workspace_id, slug, locale)
);
CREATE INDEX idx_kb_articles_workspace ON knowledge_base_articles(workspace_id, locale, status);
ALTER TABLE knowledge_base_articles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members can manage KB articles" ON knowledge_base_articles FOR ALL TO authenticated USING (is_workspace_member(workspace_id, auth.uid()));
CREATE POLICY "Public can read published articles" ON knowledge_base_articles FOR SELECT TO anon USING (status = 'published');

CREATE TABLE IF NOT EXISTS provider_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider_type TEXT NOT NULL,
  provider_name TEXT NOT NULL,
  config JSONB DEFAULT '{}',
  is_active BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (workspace_id, provider_type, provider_name)
);
ALTER TABLE provider_configs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins+ can manage provider configs" ON provider_configs FOR ALL TO authenticated USING (get_workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin'));

CREATE TABLE IF NOT EXISTS translations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  locale TEXT NOT NULL,
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  UNIQUE (workspace_id, locale, namespace, key)
);
ALTER TABLE translations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members can view translations" ON translations FOR SELECT TO authenticated USING (workspace_id IS NULL OR is_workspace_member(workspace_id, auth.uid()));
CREATE POLICY "Admins+ can manage translations" ON translations FOR ALL TO authenticated USING (workspace_id IS NULL OR get_workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin'));
CREATE POLICY "Public can read translations" ON translations FOR SELECT TO anon USING (true);

CREATE TABLE IF NOT EXISTS feature_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  enabled BOOLEAN DEFAULT false,
  description TEXT,
  UNIQUE (workspace_id, key)
);
ALTER TABLE feature_flags ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members can view feature flags" ON feature_flags FOR SELECT TO authenticated USING (workspace_id IS NULL OR is_workspace_member(workspace_id, auth.uid()));
CREATE POLICY "Admins+ can manage feature flags" ON feature_flags FOR ALL TO authenticated USING (workspace_id IS NULL OR get_workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin'));

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  old_value JSONB,
  new_value JSONB,
  ip_address TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_audit_logs_workspace ON audit_logs(workspace_id, created_at DESC);
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins+ can view audit logs" ON audit_logs FOR SELECT TO authenticated USING (get_workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin'));
CREATE POLICY "Members can insert audit logs" ON audit_logs FOR INSERT TO authenticated WITH CHECK (is_workspace_member(workspace_id, auth.uid()));

CREATE TABLE IF NOT EXISTS email_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  locale TEXT NOT NULL DEFAULT 'en',
  subject TEXT NOT NULL,
  html_body TEXT NOT NULL,
  text_body TEXT,
  UNIQUE (workspace_id, slug, locale)
);
ALTER TABLE email_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins+ can manage email templates" ON email_templates FOR ALL TO authenticated USING (get_workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin'));

CREATE TABLE IF NOT EXISTS app_runtime_config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE app_runtime_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public can read runtime config" ON app_runtime_config FOR SELECT TO anon USING (true);
CREATE POLICY "Admins can manage runtime config" ON app_runtime_config FOR ALL TO authenticated USING (has_role(auth.uid(), 'admin'));
