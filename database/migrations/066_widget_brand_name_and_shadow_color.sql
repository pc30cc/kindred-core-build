-- 066 — Widget header display name + panel shadow colour.
--
-- brand_name: the name rendered above the reply-time note in the widget
-- header. Defaults (empty/NULL) to the workspace name; operators may override
-- it without renaming their workspace.
--
-- shadow_color: workspace-configurable panel shadow tint. Empty/NULL falls
-- back to the template default (neutral black at 25% opacity).
--
-- No new table, so no GRANT block is required: widget_settings already carries
-- its privileges and RLS policies.

ALTER TABLE public.widget_settings
  ADD COLUMN IF NOT EXISTS brand_name text,
  ADD COLUMN IF NOT EXISTS shadow_color text;

COMMENT ON COLUMN public.widget_settings.brand_name IS
  'Optional widget header display name. Empty/NULL falls back to the workspace name.';
COMMENT ON COLUMN public.widget_settings.shadow_color IS
  'Optional hex colour used to tint the widget panel shadow. Empty/NULL uses the template default.';
