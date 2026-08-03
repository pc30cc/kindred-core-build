-- ============================================================
-- Chain-order baseline repair (CI hotfix).
--
-- `public.platform_settings` and `public.workspace_domains_extended` were
-- originally created directly in the hosted project (SQL editor), so no
-- migration in this directory ever created them. Later migrations then
-- ALTER / policy them, which breaks any clean `supabase db reset`:
--
--   20260414134641 → ALTER TABLE public.platform_settings ...
--   20260415082424 → RLS + policies on workspace_domains_extended
--
-- This file restores the missing origin, mirroring the exact hosted
-- definitions as they existed BEFORE those later migrations (i.e. without
-- the columns/policies that the later migrations add). It is fully
-- idempotent, so the hosted project — where these objects already exist —
-- is unaffected.
-- ============================================================

-- ---------- public.platform_settings (singleton) ----------
CREATE TABLE IF NOT EXISTS public.platform_settings (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  site_mode text NOT NULL DEFAULT 'multi_language',
  default_locale text NOT NULL DEFAULT 'en',
  panel_default_locale text NOT NULL DEFAULT 'en',
  widget_default_locale text NOT NULL DEFAULT 'en',
  fallback_locale text NOT NULL DEFAULT 'en',
  active_locales text[] NOT NULL DEFAULT '{en}'::text[],
  timezone text NOT NULL DEFAULT 'UTC',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT platform_settings_site_mode_check
    CHECK (site_mode = ANY (ARRAY['single_language'::text, 'multi_language'::text]))
);

GRANT ALL ON public.platform_settings TO anon;
GRANT ALL ON public.platform_settings TO authenticated;
GRANT ALL ON public.platform_settings TO service_role;

ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anon can read platform settings" ON public.platform_settings;
CREATE POLICY "Anon can read platform settings"
  ON public.platform_settings FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "Authenticated can read platform settings" ON public.platform_settings;
CREATE POLICY "Authenticated can read platform settings"
  ON public.platform_settings FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Admins can manage platform settings" ON public.platform_settings;
CREATE POLICY "Admins can manage platform settings"
  ON public.platform_settings FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

-- Singleton row, as in the hosted project.
INSERT INTO public.platform_settings (id)
SELECT gen_random_uuid()
WHERE NOT EXISTS (SELECT 1 FROM public.platform_settings);

-- ---------- public.workspace_domains_extended ----------
CREATE TABLE IF NOT EXISTS public.workspace_domains_extended (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id uuid NOT NULL UNIQUE
    REFERENCES public.workspaces(id) ON DELETE CASCADE,
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

GRANT ALL ON public.workspace_domains_extended TO anon;
GRANT ALL ON public.workspace_domains_extended TO authenticated;
GRANT ALL ON public.workspace_domains_extended TO service_role;

ALTER TABLE public.workspace_domains_extended ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- Additional remote-only origins.
--
-- The same defect applies to these tables: they exist in the hosted project
-- but no migration ever created them, while later migrations enable RLS on
-- them and/or create policies for them. Each definition mirrors the hosted
-- schema exactly (columns, defaults, constraints, indexes, grants).
--
-- Policies are created here ONLY where no later migration creates them; the
-- policies the chain re-creates later are intentionally left to the chain so
-- that no duplicate-policy conflict can occur.
-- ============================================================

-- ---------- public.auth_sessions ----------
CREATE TABLE IF NOT EXISTS public.auth_sessions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  user_id uuid NOT NULL,
  email text NOT NULL,
  ip_address text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id ON public.auth_sessions USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at ON public.auth_sessions USING btree (expires_at);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_token_hash ON public.auth_sessions USING btree (token_hash) WHERE (revoked_at IS NULL);
GRANT ALL ON public.auth_sessions TO anon;
GRANT ALL ON public.auth_sessions TO authenticated;
GRANT ALL ON public.auth_sessions TO service_role;
ALTER TABLE public.auth_sessions ENABLE ROW LEVEL SECURITY;

-- ---------- public.auth_reset_tokens ----------
CREATE TABLE IF NOT EXISTS public.auth_reset_tokens (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  user_id uuid NOT NULL,
  email text NOT NULL,
  ip_address text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_auth_reset_tokens_user_id ON public.auth_reset_tokens USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_auth_reset_tokens_hash ON public.auth_reset_tokens USING btree (token_hash) WHERE ((used_at IS NULL) AND (revoked_at IS NULL));
GRANT ALL ON public.auth_reset_tokens TO anon;
GRANT ALL ON public.auth_reset_tokens TO authenticated;
GRANT ALL ON public.auth_reset_tokens TO service_role;
ALTER TABLE public.auth_reset_tokens ENABLE ROW LEVEL SECURITY;

-- ---------- public.auth_verify_tokens ----------
CREATE TABLE IF NOT EXISTS public.auth_verify_tokens (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  user_id uuid NOT NULL,
  email text NOT NULL,
  ip_address text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_auth_verify_tokens_user_id ON public.auth_verify_tokens USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_auth_verify_tokens_hash ON public.auth_verify_tokens USING btree (token_hash) WHERE ((used_at IS NULL) AND (revoked_at IS NULL));
GRANT ALL ON public.auth_verify_tokens TO anon;
GRANT ALL ON public.auth_verify_tokens TO authenticated;
GRANT ALL ON public.auth_verify_tokens TO service_role;
ALTER TABLE public.auth_verify_tokens ENABLE ROW LEVEL SECURITY;

-- ---------- public.platform_branding ----------
CREATE TABLE IF NOT EXISTS public.platform_branding (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  logo_url text,
  favicon_url text,
  pwa_icon_url text,
  primary_color text DEFAULT '#3B82F6'::text,
  secondary_color text DEFAULT '#1E40AF'::text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
GRANT ALL ON public.platform_branding TO anon;
GRANT ALL ON public.platform_branding TO authenticated;
GRANT ALL ON public.platform_branding TO service_role;
ALTER TABLE public.platform_branding ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anon can read platform branding" ON public.platform_branding;
CREATE POLICY "Anon can read platform branding"
  ON public.platform_branding FOR SELECT TO anon USING (true);
DROP POLICY IF EXISTS "Authenticated can read platform branding" ON public.platform_branding;
CREATE POLICY "Authenticated can read platform branding"
  ON public.platform_branding FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Admins can manage platform branding" ON public.platform_branding;
CREATE POLICY "Admins can manage platform branding"
  ON public.platform_branding FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

-- ---------- public.platform_branding_localized ----------
CREATE TABLE IF NOT EXISTS public.platform_branding_localized (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  locale text NOT NULL UNIQUE,
  platform_name text NOT NULL DEFAULT 'My Platform'::text,
  public_site_title text,
  browser_title_format text DEFAULT '{{page}} — {{platform}}'::text,
  meta_title text,
  meta_description text,
  footer_company_text text,
  support_label text,
  legal_company_display_name text,
  social_share_title text,
  social_share_description text,
  knowledge_base_title text DEFAULT 'Help Center'::text,
  widget_display_name text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
GRANT ALL ON public.platform_branding_localized TO anon;
GRANT ALL ON public.platform_branding_localized TO authenticated;
GRANT ALL ON public.platform_branding_localized TO service_role;
ALTER TABLE public.platform_branding_localized ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anon can read platform branding localized" ON public.platform_branding_localized;
CREATE POLICY "Anon can read platform branding localized"
  ON public.platform_branding_localized FOR SELECT TO anon USING (true);
DROP POLICY IF EXISTS "Authenticated can read platform branding localized" ON public.platform_branding_localized;
CREATE POLICY "Authenticated can read platform branding localized"
  ON public.platform_branding_localized FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Admins can manage platform branding localized" ON public.platform_branding_localized;
CREATE POLICY "Admins can manage platform branding localized"
  ON public.platform_branding_localized FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

-- ---------- public.platform_domains ----------
CREATE TABLE IF NOT EXISTS public.platform_domains (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
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
GRANT ALL ON public.platform_domains TO anon;
GRANT ALL ON public.platform_domains TO authenticated;
GRANT ALL ON public.platform_domains TO service_role;
ALTER TABLE public.platform_domains ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anon can read platform domains" ON public.platform_domains;
CREATE POLICY "Anon can read platform domains"
  ON public.platform_domains FOR SELECT TO anon USING (true);
DROP POLICY IF EXISTS "Authenticated can read platform domains" ON public.platform_domains;
CREATE POLICY "Authenticated can read platform domains"
  ON public.platform_domains FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Admins can manage platform domains" ON public.platform_domains;
CREATE POLICY "Admins can manage platform domains"
  ON public.platform_domains FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

-- ---------- public.email_settings ----------
CREATE TABLE IF NOT EXISTS public.email_settings (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id uuid REFERENCES public.workspaces(id) ON DELETE CASCADE,
  sender_email text DEFAULT 'noreply@example.com'::text,
  reply_to_email text,
  email_logo_url text,
  email_footer_text text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
GRANT ALL ON public.email_settings TO anon;
GRANT ALL ON public.email_settings TO authenticated;
GRANT ALL ON public.email_settings TO service_role;
ALTER TABLE public.email_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can manage platform email settings" ON public.email_settings;
CREATE POLICY "Admins can manage platform email settings"
  ON public.email_settings FOR ALL TO authenticated
  USING (
    ((workspace_id IS NULL) AND public.has_role(auth.uid(), 'admin'::public.app_role))
    OR ((workspace_id IS NOT NULL) AND (public.get_workspace_role(workspace_id, auth.uid())
        = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role])))
  )
  WITH CHECK (
    ((workspace_id IS NULL) AND public.has_role(auth.uid(), 'admin'::public.app_role))
    OR ((workspace_id IS NOT NULL) AND (public.get_workspace_role(workspace_id, auth.uid())
        = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role])))
  );

-- ---------- public.email_settings_localized ----------
CREATE TABLE IF NOT EXISTS public.email_settings_localized (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id uuid REFERENCES public.workspaces(id) ON DELETE CASCADE,
  locale text NOT NULL,
  sender_name text,
  footer_text text,
  support_contact_label text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT email_settings_localized_workspace_id_locale_key UNIQUE (workspace_id, locale)
);
GRANT ALL ON public.email_settings_localized TO anon;
GRANT ALL ON public.email_settings_localized TO authenticated;
GRANT ALL ON public.email_settings_localized TO service_role;
ALTER TABLE public.email_settings_localized ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can manage email settings localized" ON public.email_settings_localized;
CREATE POLICY "Admins can manage email settings localized"
  ON public.email_settings_localized FOR ALL TO authenticated
  USING (
    ((workspace_id IS NULL) AND public.has_role(auth.uid(), 'admin'::public.app_role))
    OR ((workspace_id IS NOT NULL) AND (public.get_workspace_role(workspace_id, auth.uid())
        = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role])))
  )
  WITH CHECK (
    ((workspace_id IS NULL) AND public.has_role(auth.uid(), 'admin'::public.app_role))
    OR ((workspace_id IS NOT NULL) AND (public.get_workspace_role(workspace_id, auth.uid())
        = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role])))
  );

-- ---------- public.workspace_settings ----------
CREATE TABLE IF NOT EXISTS public.workspace_settings (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id uuid NOT NULL UNIQUE REFERENCES public.workspaces(id) ON DELETE CASCADE,
  site_mode text,
  default_locale text,
  panel_default_locale text,
  widget_default_locale text,
  fallback_locale text,
  active_locales text[],
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT workspace_settings_site_mode_check CHECK (
    (site_mode IS NULL) OR (site_mode = ANY (ARRAY['single_language'::text, 'multi_language'::text]))
  )
);
GRANT ALL ON public.workspace_settings TO anon;
GRANT ALL ON public.workspace_settings TO authenticated;
GRANT ALL ON public.workspace_settings TO service_role;
ALTER TABLE public.workspace_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can read workspace settings" ON public.workspace_settings;
CREATE POLICY "Members can read workspace settings"
  ON public.workspace_settings FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()));
DROP POLICY IF EXISTS "Admins+ can manage workspace settings" ON public.workspace_settings;
CREATE POLICY "Admins+ can manage workspace settings"
  ON public.workspace_settings FOR ALL TO authenticated
  USING (public.get_workspace_role(workspace_id, auth.uid())
         = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role]))
  WITH CHECK (public.get_workspace_role(workspace_id, auth.uid())
         = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role]));

-- ---------- public.workspace_branding_localized ----------
CREATE TABLE IF NOT EXISTS public.workspace_branding_localized (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
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
  CONSTRAINT workspace_branding_localized_workspace_id_locale_key UNIQUE (workspace_id, locale)
);
GRANT ALL ON public.workspace_branding_localized TO anon;
GRANT ALL ON public.workspace_branding_localized TO authenticated;
GRANT ALL ON public.workspace_branding_localized TO service_role;
ALTER TABLE public.workspace_branding_localized ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can read ws branding localized" ON public.workspace_branding_localized;
CREATE POLICY "Members can read ws branding localized"
  ON public.workspace_branding_localized FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()));
DROP POLICY IF EXISTS "Admins+ can manage ws branding localized" ON public.workspace_branding_localized;
CREATE POLICY "Admins+ can manage ws branding localized"
  ON public.workspace_branding_localized FOR ALL TO authenticated
  USING (public.get_workspace_role(workspace_id, auth.uid())
         = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role]))
  WITH CHECK (public.get_workspace_role(workspace_id, auth.uid())
         = ANY (ARRAY['owner'::public.workspace_role, 'admin'::public.workspace_role]));
