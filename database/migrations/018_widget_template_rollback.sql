-- ════════════════════════════════════════════════════════════════════
-- 018 — ROLLBACK for 017 (widget template system)
--
-- NOT part of the forward chain. Run MANUALLY only if the single-design
-- rollout must be reverted. Requires that 017 archived the old state
-- into the `widget_archive` schema (it always does).
--
-- Restores:
--   • public.widget_templates                 (from widget_archive)
--   • public.widget_settings.template_slug    (from widget_archive)
--
-- It does NOT restore the validation trigger — the application no longer
-- ships that code path. Re-deploy the pre-017 backend alongside this.
-- ════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'widget_archive' AND table_name = 'widget_templates_backup'
  ) THEN
    RAISE EXCEPTION 'Rollback aborted: widget_archive.widget_templates_backup is missing. Nothing to restore.';
  END IF;
END $$;

-- 1. Restore the registry table
CREATE TABLE IF NOT EXISTS public.widget_templates AS
SELECT * FROM widget_archive.widget_templates_backup;

ALTER TABLE public.widget_templates DROP COLUMN IF EXISTS archived_at;

GRANT SELECT ON public.widget_templates TO anon, authenticated;
GRANT ALL ON public.widget_templates TO service_role;
ALTER TABLE public.widget_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "widget_templates_read_all" ON public.widget_templates;
CREATE POLICY "widget_templates_read_all"
  ON public.widget_templates FOR SELECT
  TO anon, authenticated
  USING (true);

-- 2. Restore the per-workspace slug
ALTER TABLE public.widget_settings ADD COLUMN IF NOT EXISTS template_slug TEXT;

UPDATE public.widget_settings ws
SET template_slug = b.template_slug
FROM widget_archive.widget_settings_template_slug_backup b
WHERE b.widget_settings_id = ws.id
  AND ws.template_slug IS DISTINCT FROM b.template_slug;
