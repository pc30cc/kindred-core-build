-- Migration: 002_workspace_features.sql

CREATE TABLE IF NOT EXISTS workspace_branding (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
  platform_name TEXT NOT NULL DEFAULT 'My Platform',
  short_name TEXT DEFAULT 'Platform',
  logo_url TEXT,
  favicon_url TEXT,
  primary_color TEXT DEFAULT '#3B82F6',
  accent_color TEXT DEFAULT '#1E40AF',
  support_email TEXT,
  sender_name TEXT,
  meta_title TEXT,
  meta_description TEXT,
  social_image_url TEXT,
  footer_text TEXT,
  legal_name TEXT,
  canonical_base_url TEXT,
  panel_base_url TEXT,
  widget_base_url TEXT,
  asset_base_url TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE workspace_branding ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members can view branding" ON workspace_branding FOR SELECT TO authenticated USING (is_workspace_member(workspace_id, auth.uid()));
CREATE POLICY "Admins+ can update branding" ON workspace_branding FOR UPDATE TO authenticated USING (get_workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin'));
CREATE POLICY "Owner can insert branding" ON workspace_branding FOR INSERT TO authenticated WITH CHECK (get_workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin'));
-- Public read for widget/public site branding
CREATE POLICY "Public can read branding" ON workspace_branding FOR SELECT TO anon USING (true);

CREATE TABLE IF NOT EXISTS workspace_domains (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  verified BOOLEAN DEFAULT false,
  is_primary BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE workspace_domains ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members can view domains" ON workspace_domains FOR SELECT TO authenticated USING (is_workspace_member(workspace_id, auth.uid()));
CREATE POLICY "Admins+ can manage domains" ON workspace_domains FOR ALL TO authenticated USING (get_workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin'));

CREATE TABLE IF NOT EXISTS contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT,
  name TEXT,
  phone TEXT,
  avatar_url TEXT,
  tags TEXT[] DEFAULT '{}',
  notes TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members can view contacts" ON contacts FOR SELECT TO authenticated USING (is_workspace_member(workspace_id, auth.uid()));
CREATE POLICY "Members can insert contacts" ON contacts FOR INSERT TO authenticated WITH CHECK (is_workspace_member(workspace_id, auth.uid()));
CREATE POLICY "Members can update contacts" ON contacts FOR UPDATE TO authenticated USING (is_workspace_member(workspace_id, auth.uid()));
CREATE POLICY "Members can delete contacts" ON contacts FOR DELETE TO authenticated USING (is_workspace_member(workspace_id, auth.uid()));

CREATE TYPE public.conversation_status AS ENUM ('open', 'pending', 'resolved', 'closed');
CREATE TYPE public.conversation_priority AS ENUM ('low', 'normal', 'high', 'urgent');

CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  visitor_session_id UUID,
  subject TEXT,
  status conversation_status DEFAULT 'open',
  assigned_to UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  priority conversation_priority DEFAULT 'normal',
  tags TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members can view conversations" ON conversations FOR SELECT TO authenticated USING (is_workspace_member(workspace_id, auth.uid()));
CREATE POLICY "Members can insert conversations" ON conversations FOR INSERT TO authenticated WITH CHECK (is_workspace_member(workspace_id, auth.uid()));
CREATE POLICY "Members can update conversations" ON conversations FOR UPDATE TO authenticated USING (is_workspace_member(workspace_id, auth.uid()));

CREATE TYPE public.sender_type AS ENUM ('agent', 'contact', 'system', 'bot');
CREATE TABLE IF NOT EXISTS conversation_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_type sender_type NOT NULL,
  sender_id UUID,
  body TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE conversation_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members can view messages" ON conversation_messages FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM conversations c WHERE c.id = conversation_id AND is_workspace_member(c.workspace_id, auth.uid())));
CREATE POLICY "Members can insert messages" ON conversation_messages FOR INSERT TO authenticated WITH CHECK (EXISTS (SELECT 1 FROM conversations c WHERE c.id = conversation_id AND is_workspace_member(c.workspace_id, auth.uid())));

CREATE TABLE IF NOT EXISTS widget_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled BOOLEAN DEFAULT false,
  primary_color TEXT DEFAULT '#3B82F6',
  launcher_text TEXT DEFAULT 'Chat with us',
  welcome_message TEXT DEFAULT 'Hello! How can we help you?',
  logo_url TEXT,
  position TEXT DEFAULT 'bottom-right',
  allowed_domains TEXT[] DEFAULT '{}',
  chat_enabled BOOLEAN DEFAULT true,
  kb_enabled BOOLEAN DEFAULT true,
  visitor_tracking_enabled BOOLEAN DEFAULT true,
  locale TEXT DEFAULT 'en',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE widget_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members can view widget settings" ON widget_settings FOR SELECT TO authenticated USING (is_workspace_member(workspace_id, auth.uid()));
CREATE POLICY "Admins+ can insert widget settings" ON widget_settings FOR INSERT TO authenticated WITH CHECK (get_workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin'));
CREATE POLICY "Admins+ can update widget settings" ON widget_settings FOR UPDATE TO authenticated USING (get_workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin'));
CREATE POLICY "Public read for widget config" ON widget_settings FOR SELECT TO anon USING (enabled = true);
