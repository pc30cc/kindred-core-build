-- Widget Templates registry — platform-level foundation for managing
-- which widget UI templates are enabled across the platform. Currently
-- only the built-in "default" template exists; this schema is designed
-- so additional templates can be registered later without changes.

CREATE TABLE IF NOT EXISTS public.widget_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'beta', 'deprecated', 'hidden')),
  enabled boolean NOT NULL DEFAULT true,
  is_builtin boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_widget_templates_enabled ON public.widget_templates (enabled);
CREATE INDEX IF NOT EXISTS idx_widget_templates_sort ON public.widget_templates (sort_order, slug);

ALTER TABLE public.widget_templates ENABLE ROW LEVEL SECURITY;

-- Admins manage; any authenticated user can read (workspace UIs may
-- need to know which templates are available later).
CREATE POLICY "Admins can manage widget templates"
  ON public.widget_templates
  FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

CREATE POLICY "Authenticated can read widget templates"
  ON public.widget_templates
  FOR SELECT
  TO authenticated
  USING (true);

-- Update timestamp trigger (reuses the existing helper if present)
CREATE OR REPLACE FUNCTION public.set_widget_templates_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_widget_templates_updated_at ON public.widget_templates;
CREATE TRIGGER trg_widget_templates_updated_at
  BEFORE UPDATE ON public.widget_templates
  FOR EACH ROW EXECUTE FUNCTION public.set_widget_templates_updated_at();

-- Seed the current production widget as the first registered template.
INSERT INTO public.widget_templates (slug, name, description, status, enabled, is_builtin, sort_order)
VALUES (
  'default',
  'Default Widget',
  'The current production widget template. Built-in and always available as a fallback.',
  'active',
  true,
  true,
  0
)
ON CONFLICT (slug) DO UPDATE
  SET is_builtin = EXCLUDED.is_builtin,
      status = CASE WHEN public.widget_templates.status = 'hidden' THEN public.widget_templates.status ELSE EXCLUDED.status END;