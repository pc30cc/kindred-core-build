-- 063 — Platform-owned "Powered by" footer for the chat widget.
--
-- The widget footer used to render `workspace_branding.platform_name`, a row
-- every workspace owner can edit. That made the platform credit workspace-
-- editable. The footer is now owned exclusively by the platform admin:
-- prefix text, brand label and the outbound link all live on the singleton
-- `widget_platform_settings` row.
--
-- No new table => no new GRANTs required (widget_platform_settings is
-- backend-only, see 046_widget_platform_settings_backend_only.sql).

ALTER TABLE public.widget_platform_settings
  ADD COLUMN IF NOT EXISTS powered_by_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS powered_by_text text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS powered_by_brand_text text,
  ADD COLUMN IF NOT EXISTS powered_by_url text;

COMMENT ON COLUMN public.widget_platform_settings.powered_by_enabled IS
  'Master switch for the widget powered-by footer. Plans may still hide it via the widget_powered_by entitlement.';
COMMENT ON COLUMN public.widget_platform_settings.powered_by_text IS
  'Prefix text ("Powered by"). Empty => widget falls back to its localized default.';
COMMENT ON COLUMN public.widget_platform_settings.powered_by_brand_text IS
  'Brand label rendered after the prefix. NULL => platform_branding.platform_name.';
COMMENT ON COLUMN public.widget_platform_settings.powered_by_url IS
  'Absolute URL opened when the visitor clicks the footer. NULL => not clickable.';
