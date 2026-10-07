-- 253: The workspace panel's theme ("قالب"), chosen platform-wide by the
-- Super Admin (Super Admin → Panel theme, PUT /api/admin/management/panel-theme).
--
-- 'classic' is the panel as it has always looked, so existing installs see no
-- change until a Super Admin picks another theme. Which ids exist is decided by
-- shared/panelThemes.ts, and the write route accepts only those: a new theme
-- needs no migration. The check only keeps the value a short slug.
-- Re-runnable.

ALTER TABLE public.platform_branding
  ADD COLUMN IF NOT EXISTS workspace_panel_theme text NOT NULL DEFAULT 'classic';

DO $$
BEGIN
  ALTER TABLE public.platform_branding
    ADD CONSTRAINT platform_branding_workspace_panel_theme_chk
    CHECK (workspace_panel_theme ~ '^[a-z][a-z0-9-]{1,31}$');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
