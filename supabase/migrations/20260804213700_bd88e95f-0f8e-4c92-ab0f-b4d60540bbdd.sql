UPDATE public.widget_settings SET template_slug = 'default' WHERE template_slug IS DISTINCT FROM 'default';
UPDATE public.widget_templates SET enabled = false, status = 'hidden' WHERE slug <> 'default';
UPDATE public.widget_templates SET enabled = true, status = 'active' WHERE slug = 'default';