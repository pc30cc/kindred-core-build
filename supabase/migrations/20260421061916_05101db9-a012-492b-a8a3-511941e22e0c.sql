ALTER TABLE public.widget_settings
  ADD COLUMN IF NOT EXISTS template_slug text NOT NULL DEFAULT 'default';

-- Soft FK: validation trigger (not a CHECK because templates can be added/disabled later)
CREATE OR REPLACE FUNCTION public.validate_widget_template_slug()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Allow 'default' always (runtime fallback).
  IF NEW.template_slug = 'default' THEN
    RETURN NEW;
  END IF;
  -- Otherwise the slug must exist in widget_templates and be enabled.
  IF NOT EXISTS (
    SELECT 1 FROM public.widget_templates
    WHERE slug = NEW.template_slug AND enabled = true
  ) THEN
    RAISE EXCEPTION 'Widget template "%" is not registered or not enabled', NEW.template_slug;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_widget_template_slug_trg ON public.widget_settings;
CREATE TRIGGER validate_widget_template_slug_trg
  BEFORE INSERT OR UPDATE OF template_slug ON public.widget_settings
  FOR EACH ROW EXECUTE FUNCTION public.validate_widget_template_slug();