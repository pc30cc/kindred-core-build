DELETE FROM public.widget_templates WHERE slug = 'ila';

INSERT INTO public.widget_templates (slug, name, description, status, enabled, is_builtin, sort_order, metadata)
VALUES (
  'template2',
  'Widget Template 2',
  'Premium chat skin with vivid blue accent, curved header, Vazirmatn typography. RTL-friendly.',
  'active',
  true,
  false,
  10,
  '{"preview":{"kind":"default"},"primary":"#0066ff","font":"Vazirmatn"}'::jsonb
)
ON CONFLICT (slug) DO UPDATE
  SET name = EXCLUDED.name,
      description = EXCLUDED.description,
      enabled = EXCLUDED.enabled,
      status = CASE WHEN public.widget_templates.status = 'hidden' THEN public.widget_templates.status ELSE EXCLUDED.status END,
      sort_order = EXCLUDED.sort_order,
      metadata = EXCLUDED.metadata;