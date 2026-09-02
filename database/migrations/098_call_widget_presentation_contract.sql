-- Call Widget presentation contract (hosted/self-hosted mirror).
-- Existing embeds remain compatible: "callback" is normalized and all rows
-- receive the backwards-compatible default presentation.
ALTER TABLE public.call_center_settings
  ADD COLUMN IF NOT EXISTS widget_template_id text NOT NULL DEFAULT 'default';

UPDATE public.call_center_settings
SET offline_behavior = 'show_callback'
WHERE offline_behavior = 'callback';

UPDATE public.call_center_settings
SET offline_behavior = 'show_callback'
WHERE offline_behavior NOT IN ('hide', 'show_callback', 'show_message');

UPDATE public.call_center_settings
SET widget_theme = '{}'::jsonb
WHERE jsonb_typeof(widget_theme) IS DISTINCT FROM 'object';

UPDATE public.call_center_settings
SET pre_call_form_schema = '[]'::jsonb
WHERE jsonb_typeof(pre_call_form_schema) IS DISTINCT FROM 'array';

ALTER TABLE public.call_center_settings
  DROP CONSTRAINT IF EXISTS call_center_settings_widget_template_id_check,
  DROP CONSTRAINT IF EXISTS call_center_settings_offline_behavior_check,
  DROP CONSTRAINT IF EXISTS call_center_settings_widget_theme_object_check,
  DROP CONSTRAINT IF EXISTS call_center_settings_pre_call_form_array_check;

ALTER TABLE public.call_center_settings
  ADD CONSTRAINT call_center_settings_widget_template_id_check
    CHECK (widget_template_id = 'default'),
  ADD CONSTRAINT call_center_settings_offline_behavior_check
    CHECK (offline_behavior IN ('hide', 'show_callback', 'show_message')),
  ADD CONSTRAINT call_center_settings_widget_theme_object_check
    CHECK (jsonb_typeof(widget_theme) = 'object'),
  ADD CONSTRAINT call_center_settings_pre_call_form_array_check
    CHECK (jsonb_typeof(pre_call_form_schema) = 'array' AND jsonb_array_length(pre_call_form_schema) <= 12);

COMMENT ON COLUMN public.call_center_settings.widget_template_id IS
  'Allowlisted Call Widget presentation id. Runtime falls back to default.';

