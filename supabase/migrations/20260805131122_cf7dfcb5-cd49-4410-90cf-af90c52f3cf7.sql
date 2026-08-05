-- Widget single-design migration.
-- The widget now ships exactly one canonical design ("canonical-v1").
-- All template registry / per-workspace template selection is removed.

DROP TRIGGER IF EXISTS validate_widget_template_slug_trg ON public.widget_settings;
DROP FUNCTION IF EXISTS public.validate_widget_template_slug() CASCADE;

ALTER TABLE public.widget_settings DROP COLUMN IF EXISTS template_slug CASCADE;

DROP TABLE IF EXISTS public.widget_templates CASCADE;