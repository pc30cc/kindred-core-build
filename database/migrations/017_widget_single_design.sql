-- ════════════════════════════════════════════════════════════════════
-- 017 — Widget single canonical design (ARCHIVE-FIRST, non-destructive)
--
-- The chat widget now ships exactly ONE design ("canonical-v1").
-- The multi-template system (registry table + per-workspace slug +
-- validation trigger) is retired.
--
-- This migration is DESTRUCTIVE for the live schema, so it ARCHIVES
-- every byte of the old state into the `widget_archive` schema BEFORE
-- dropping anything. `018_widget_template_data_only_recovery.sql` can
-- restore the ROWS only — not keys, indexes, defaults, FKs, grants, policies
-- or the trigger; see that file's header.
--
-- Idempotent and safe to re-run.
-- ════════════════════════════════════════════════════════════════════

CREATE SCHEMA IF NOT EXISTS widget_archive;
REVOKE ALL ON SCHEMA widget_archive FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA widget_archive TO service_role;

-- ── 1. Archive the template registry (if it still exists) ───────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'widget_templates'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'widget_archive' AND table_name = 'widget_templates_backup'
  ) THEN
    EXECUTE 'CREATE TABLE widget_archive.widget_templates_backup AS
             SELECT *, now() AS archived_at FROM public.widget_templates';
  END IF;
END $$;

-- ── 2. Archive every workspace''s previous template_slug ────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'widget_settings'
      AND column_name = 'template_slug'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'widget_archive' AND table_name = 'widget_settings_template_slug_backup'
  ) THEN
    EXECUTE 'CREATE TABLE widget_archive.widget_settings_template_slug_backup AS
             SELECT id AS widget_settings_id, workspace_id, template_slug, now() AS archived_at
             FROM public.widget_settings';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'widget_archive' AND table_name = 'widget_templates_backup'
  ) THEN
    EXECUTE 'GRANT SELECT ON widget_archive.widget_templates_backup TO service_role';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'widget_archive' AND table_name = 'widget_settings_template_slug_backup'
  ) THEN
    EXECUTE 'GRANT SELECT ON widget_archive.widget_settings_template_slug_backup TO service_role';
  END IF;
END $$;

-- ── 3. Only NOW drop the live objects ───────────────────────────────
DROP TRIGGER IF EXISTS validate_widget_template_slug_trg ON public.widget_settings;
DROP FUNCTION IF EXISTS public.validate_widget_template_slug() CASCADE;

ALTER TABLE public.widget_settings DROP COLUMN IF EXISTS template_slug CASCADE;

DROP TABLE IF EXISTS public.widget_templates CASCADE;
