-- Corrective follow-up to the widget single-design cleanup.
--
-- The applied migration (20260805131122) dropped public.widget_templates and
-- public.widget_settings.template_slug WITHOUT archiving them. Migration
-- history is not rewritten. This migration cannot reconstruct the deleted
-- rows: they are recoverable only from a database backup taken before
-- 20260805131122. It establishes the archive schema the archive-first policy
-- requires and records the data-loss provenance so future operators are not
-- misled into thinking a copy exists.

CREATE SCHEMA IF NOT EXISTS widget_archive;
REVOKE ALL ON SCHEMA widget_archive FROM PUBLIC;
GRANT USAGE ON SCHEMA widget_archive TO service_role;

CREATE TABLE IF NOT EXISTS widget_archive.data_loss_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_version text NOT NULL,
  dropped_object text NOT NULL,
  archived boolean NOT NULL DEFAULT false,
  recovery_note text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (migration_version, dropped_object)
);

-- Backend/admin only. No anon or authenticated access: this is operational
-- provenance, not application data.
GRANT ALL ON widget_archive.data_loss_notices TO service_role;
ALTER TABLE widget_archive.data_loss_notices ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION widget_archive.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = widget_archive, public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS data_loss_notices_updated_at ON widget_archive.data_loss_notices;
CREATE TRIGGER data_loss_notices_updated_at
  BEFORE UPDATE ON widget_archive.data_loss_notices
  FOR EACH ROW EXECUTE FUNCTION widget_archive.set_updated_at();

INSERT INTO widget_archive.data_loss_notices (migration_version, dropped_object, archived, recovery_note)
VALUES
  ('20260805131122', 'public.widget_templates', false,
   'Dropped without archiving. Row data is NOT recoverable from the database; restore from a pre-20260805131122 backup if the template registry is ever needed.'),
  ('20260805131122', 'public.widget_settings.template_slug', false,
   'Column dropped without archiving. Per-workspace template selections are NOT recoverable from the database; restore from a pre-20260805131122 backup. The widget now ships a single canonical design, so no selection value is required.')
ON CONFLICT (migration_version, dropped_object) DO NOTHING;