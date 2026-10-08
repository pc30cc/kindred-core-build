-- 254: The workspace panel theme's options, chosen platform-wide by the Super
-- Admin with the theme (Super Admin → Panel theme,
-- PUT /api/admin/management/panel-theme). For Art: its frame (top menu or
-- side menu) and its colour scheme.
--
-- Stored per theme: {"art": {"layout": "sidebar", "palette": "sage"}}. Which
-- options and values exist is decided by shared/panelThemes.ts
-- (PANEL_THEME_OPTIONS) and the write route accepts only those, so a new
-- option or value needs no migration. A missing or unknown value reads as
-- that option's default, so '{}' is every theme exactly as it looked before
-- this migration. The checks only keep the value a small JSON object.
-- Re-runnable.

ALTER TABLE public.platform_branding
  ADD COLUMN IF NOT EXISTS workspace_panel_theme_options jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  ALTER TABLE public.platform_branding
    ADD CONSTRAINT platform_branding_workspace_panel_theme_options_chk
    CHECK (
      jsonb_typeof(workspace_panel_theme_options) = 'object'
      AND octet_length(workspace_panel_theme_options::text) <= 4096
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
