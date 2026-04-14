
-- =============================================
-- PLATFORM-LEVEL CONFIGURATION TABLES
-- =============================================

-- Platform Settings (single row)
CREATE TABLE public.platform_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_mode text NOT NULL DEFAULT 'multi_language' CHECK (site_mode IN ('single_language', 'multi_language')),
  default_locale text NOT NULL DEFAULT 'en',
  panel_default_locale text NOT NULL DEFAULT 'en',
  widget_default_locale text NOT NULL DEFAULT 'en',
  fallback_locale text NOT NULL DEFAULT 'en',
  active_locales text[] NOT NULL DEFAULT '{en}'::text[],
  timezone text NOT NULL DEFAULT 'UTC',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage platform settings"
  ON public.platform_settings FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Authenticated can read platform settings"
  ON public.platform_settings FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "Anon can read platform settings"
  ON public.platform_settings FOR SELECT TO anon
  USING (true);

-- Platform Branding (non-localized visual assets, single row)
CREATE TABLE public.platform_branding (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  logo_url text,
  favicon_url text,
  pwa_icon_url text,
  primary_color text DEFAULT '#3B82F6',
  secondary_color text DEFAULT '#1E40AF',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE public.platform_branding ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage platform branding"
  ON public.platform_branding FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Authenticated can read platform branding"
  ON public.platform_branding FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "Anon can read platform branding"
  ON public.platform_branding FOR SELECT TO anon
  USING (true);

-- Platform Branding Localized (per-locale text identity)
CREATE TABLE public.platform_branding_localized (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  locale text NOT NULL,
  platform_name text NOT NULL DEFAULT 'My Platform',
  public_site_title text,
  browser_title_format text DEFAULT '{{page}} — {{platform}}',
  meta_title text,
  meta_description text,
  footer_company_text text,
  support_label text,
  legal_company_display_name text,
  social_share_title text,
  social_share_description text,
  knowledge_base_title text DEFAULT 'Help Center',
  widget_display_name text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(locale)
);

ALTER TABLE public.platform_branding_localized ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage platform branding localized"
  ON public.platform_branding_localized FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Authenticated can read platform branding localized"
  ON public.platform_branding_localized FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "Anon can read platform branding localized"
  ON public.platform_branding_localized FOR SELECT TO anon
  USING (true);

-- Platform Domains (single row)
CREATE TABLE public.platform_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  primary_domain text,
  canonical_base_url text,
  public_base_url text,
  app_base_url text,
  api_base_url text,
  widget_base_url text,
  asset_base_url text,
  help_center_base_url text,
  email_base_url text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE public.platform_domains ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage platform domains"
  ON public.platform_domains FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Authenticated can read platform domains"
  ON public.platform_domains FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "Anon can read platform domains"
  ON public.platform_domains FOR SELECT TO anon
  USING (true);

-- =============================================
-- EMAIL SETTINGS (platform + workspace)
-- =============================================

CREATE TABLE public.email_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES public.workspaces(id) ON DELETE CASCADE,
  sender_email text DEFAULT 'noreply@example.com',
  reply_to_email text,
  email_logo_url text,
  email_footer_text text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE public.email_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage platform email settings"
  ON public.email_settings FOR ALL TO authenticated
  USING (
    (workspace_id IS NULL AND has_role(auth.uid(), 'admin'::app_role))
    OR
    (workspace_id IS NOT NULL AND get_workspace_role(workspace_id, auth.uid()) IN ('owner'::workspace_role, 'admin'::workspace_role))
  )
  WITH CHECK (
    (workspace_id IS NULL AND has_role(auth.uid(), 'admin'::app_role))
    OR
    (workspace_id IS NOT NULL AND get_workspace_role(workspace_id, auth.uid()) IN ('owner'::workspace_role, 'admin'::workspace_role))
  );

CREATE POLICY "Authenticated can read email settings"
  ON public.email_settings FOR SELECT TO authenticated
  USING (
    workspace_id IS NULL
    OR is_workspace_member(workspace_id, auth.uid())
  );

CREATE TABLE public.email_settings_localized (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES public.workspaces(id) ON DELETE CASCADE,
  locale text NOT NULL,
  sender_name text,
  footer_text text,
  support_contact_label text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(workspace_id, locale)
);

ALTER TABLE public.email_settings_localized ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage email settings localized"
  ON public.email_settings_localized FOR ALL TO authenticated
  USING (
    (workspace_id IS NULL AND has_role(auth.uid(), 'admin'::app_role))
    OR
    (workspace_id IS NOT NULL AND get_workspace_role(workspace_id, auth.uid()) IN ('owner'::workspace_role, 'admin'::workspace_role))
  )
  WITH CHECK (
    (workspace_id IS NULL AND has_role(auth.uid(), 'admin'::app_role))
    OR
    (workspace_id IS NOT NULL AND get_workspace_role(workspace_id, auth.uid()) IN ('owner'::workspace_role, 'admin'::workspace_role))
  );

CREATE POLICY "Authenticated can read email settings localized"
  ON public.email_settings_localized FOR SELECT TO authenticated
  USING (
    workspace_id IS NULL
    OR is_workspace_member(workspace_id, auth.uid())
  );

-- =============================================
-- WORKSPACE-LEVEL CONFIG OVERRIDES
-- =============================================

CREATE TABLE public.workspace_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE UNIQUE,
  site_mode text CHECK (site_mode IS NULL OR site_mode IN ('single_language', 'multi_language')),
  default_locale text,
  panel_default_locale text,
  widget_default_locale text,
  fallback_locale text,
  active_locales text[],
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE public.workspace_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins+ can manage workspace settings"
  ON public.workspace_settings FOR ALL TO authenticated
  USING (get_workspace_role(workspace_id, auth.uid()) IN ('owner'::workspace_role, 'admin'::workspace_role))
  WITH CHECK (get_workspace_role(workspace_id, auth.uid()) IN ('owner'::workspace_role, 'admin'::workspace_role));

CREATE POLICY "Members can read workspace settings"
  ON public.workspace_settings FOR SELECT TO authenticated
  USING (is_workspace_member(workspace_id, auth.uid()));

-- Workspace Branding Localized
CREATE TABLE public.workspace_branding_localized (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  locale text NOT NULL,
  platform_name text,
  public_site_title text,
  browser_title_format text,
  meta_title text,
  meta_description text,
  footer_company_text text,
  support_label text,
  legal_company_display_name text,
  social_share_title text,
  social_share_description text,
  knowledge_base_title text,
  widget_display_name text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(workspace_id, locale)
);

ALTER TABLE public.workspace_branding_localized ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins+ can manage ws branding localized"
  ON public.workspace_branding_localized FOR ALL TO authenticated
  USING (get_workspace_role(workspace_id, auth.uid()) IN ('owner'::workspace_role, 'admin'::workspace_role))
  WITH CHECK (get_workspace_role(workspace_id, auth.uid()) IN ('owner'::workspace_role, 'admin'::workspace_role));

CREATE POLICY "Members can read ws branding localized"
  ON public.workspace_branding_localized FOR SELECT TO authenticated
  USING (is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Anon can read ws branding localized"
  ON public.workspace_branding_localized FOR SELECT TO anon
  USING (true);

-- Workspace Domains Extended
CREATE TABLE public.workspace_domains_extended (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE UNIQUE,
  primary_domain text,
  canonical_base_url text,
  public_base_url text,
  app_base_url text,
  api_base_url text,
  widget_base_url text,
  asset_base_url text,
  help_center_base_url text,
  email_base_url text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE public.workspace_domains_extended ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins+ can manage ws domains extended"
  ON public.workspace_domains_extended FOR ALL TO authenticated
  USING (get_workspace_role(workspace_id, auth.uid()) IN ('owner'::workspace_role, 'admin'::workspace_role))
  WITH CHECK (get_workspace_role(workspace_id, auth.uid()) IN ('owner'::workspace_role, 'admin'::workspace_role));

CREATE POLICY "Members can read ws domains extended"
  ON public.workspace_domains_extended FOR SELECT TO authenticated
  USING (is_workspace_member(workspace_id, auth.uid()));

-- =============================================
-- EXTEND EXISTING email_templates
-- =============================================

ALTER TABLE public.email_templates ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT true;

-- =============================================
-- SEED PLATFORM DEFAULTS
-- =============================================

INSERT INTO public.platform_settings (site_mode, default_locale, panel_default_locale, widget_default_locale, fallback_locale, active_locales, timezone)
VALUES ('multi_language', 'en', 'en', 'en', 'en', '{en,fa,tr}', 'UTC');

INSERT INTO public.platform_branding (primary_color, secondary_color)
VALUES ('#3B82F6', '#1E40AF');

INSERT INTO public.platform_branding_localized (locale, platform_name, knowledge_base_title, browser_title_format)
VALUES 
  ('en', 'My Platform', 'Help Center', '{{page}} — {{platform}}'),
  ('fa', 'پلتفرم من', 'مرکز راهنما', '{{page}} — {{platform}}'),
  ('tr', 'Platformum', 'Yardım Merkezi', '{{page}} — {{platform}}');

INSERT INTO public.platform_domains (primary_domain) VALUES (NULL);

INSERT INTO public.email_settings (workspace_id, sender_email, reply_to_email)
VALUES (NULL, 'noreply@example.com', NULL);

INSERT INTO public.email_settings_localized (workspace_id, locale, sender_name)
VALUES 
  (NULL, 'en', 'My Platform'),
  (NULL, 'fa', 'پلتفرم من'),
  (NULL, 'tr', 'Platformum');
