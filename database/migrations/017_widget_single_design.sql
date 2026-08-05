-- ════════════════════════════════════════════════════════════════════
-- 017 — Widget single canonical design
--
-- The chat widget now ships exactly ONE design ("canonical-v1").
-- The multi-template system (registry table + per-workspace slug +
-- validation trigger) is removed. No runtime behaviour depended on it:
-- every workspace already rendered the default template.
--
-- Idempotent and safe to re-run.
-- ════════════════════════════════════════════════════════════════════

DROP TRIGGER IF EXISTS validate_widget_template_slug_trg ON public.widget_settings;
DROP FUNCTION IF EXISTS public.validate_widget_template_slug() CASCADE;

ALTER TABLE public.widget_settings DROP COLUMN IF EXISTS template_slug CASCADE;

DROP TABLE IF EXISTS public.widget_templates CASCADE;
