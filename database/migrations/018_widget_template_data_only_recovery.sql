-- ════════════════════════════════════════════════════════════════════
-- 018 — DATA-ONLY RECOVERY for 017 (widget template system)
--
-- HONEST SCOPE — read before running.
-- This is NOT a schema-complete rollback. `CREATE TABLE AS SELECT` copies
-- rows and column types only. It does NOT restore:
--     • primary key / unique constraints        • check constraints
--     • indexes                                 • column defaults
--     • NOT NULL markers                        • foreign keys
--     • the original grant set                  • the original RLS policies
--     • the validate_widget_template_slug() trigger + function
-- The grants/policy re-created below are a minimal safe substitute chosen by
-- this script, not the pre-017 originals.
--
-- Restoring the exact original schema requires the pre-017 DDL from a
-- database backup (`pg_dump --schema-only`), which is the supported path if
-- you need a true rollback. Use this file only to get the DATA back.
--
-- Also note: on the hosted Supabase project the equivalent cleanup ran as
-- `supabase/migrations/20260805131122_*.sql`, which dropped the objects
-- WITHOUT archiving. There, not even the data is recoverable from the
-- database — see widget_archive.data_loss_notices.
--
-- NOT part of the forward chain. Run MANUALLY only.
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

-- 1. Restore the registry ROWS (no keys/indexes/defaults — see header)
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

-- 2. Restore the per-workspace slug VALUES (plain TEXT column, no trigger)
ALTER TABLE public.widget_settings ADD COLUMN IF NOT EXISTS template_slug TEXT;

UPDATE public.widget_settings ws
SET template_slug = b.template_slug
FROM widget_archive.widget_settings_template_slug_backup b
WHERE b.widget_settings_id = ws.id
  AND ws.template_slug IS DISTINCT FROM b.template_slug;
