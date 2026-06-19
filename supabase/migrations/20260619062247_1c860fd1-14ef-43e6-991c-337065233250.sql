INSERT INTO public.widget_templates (slug, name, description, status, enabled, is_builtin, sort_order, metadata)
VALUES (
  'ila',
  'ILA Style',
  'A polished premium chat skin inspired by ila.chat — IRANYekanX typography, vivid blue accent (#0066ff), soft elevated panel. RTL-friendly.',
  'active',
  true,
  false,
  10,
  '{"preview":{"kind":"default"},"primary":"#0066ff","font":"IRANYekanXILACHAT"}'::jsonb
)
ON CONFLICT (slug) DO UPDATE
  SET name = EXCLUDED.name,
      description = EXCLUDED.description,
      enabled = EXCLUDED.enabled,
      status = CASE WHEN public.widget_templates.status = 'hidden' THEN public.widget_templates.status ELSE EXCLUDED.status END,
      sort_order = EXCLUDED.sort_order,
      metadata = EXCLUDED.metadata;