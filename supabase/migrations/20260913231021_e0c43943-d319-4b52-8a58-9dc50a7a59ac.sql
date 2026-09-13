-- 182_backup_registry.sql
-- Backup & recovery metadata registry. Backend-only (service_role); no
-- credential material is ever stored here (enforced by trigger below).

CREATE TABLE IF NOT EXISTS public.backup_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  backup_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('base','wal','logical','object')),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  bytes bigint,
  checksum text,
  destination text,
  lsn text,
  encrypted boolean NOT NULL DEFAULT false,
  verification_status text NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('unverified','verified','failed')),
  verified_at timestamptz,
  last_restore_tested_at timestamptz,
  error text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, backup_id)
);

CREATE INDEX IF NOT EXISTS backup_runs_kind_started_idx
  ON public.backup_runs (kind, started_at DESC);
CREATE INDEX IF NOT EXISTS backup_runs_status_idx
  ON public.backup_runs (status, started_at DESC);

GRANT ALL ON public.backup_runs TO service_role;
ALTER TABLE public.backup_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.backup_runs FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.backup_restore_drills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  drill_kind text NOT NULL CHECK (drill_kind IN ('full_restore','pitr','object_storage')),
  environment text NOT NULL,
  source_backup_id text,
  target_time timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','passed','failed')),
  findings jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS backup_restore_drills_kind_idx
  ON public.backup_restore_drills (drill_kind, started_at DESC);

GRANT ALL ON public.backup_restore_drills TO service_role;
ALTER TABLE public.backup_restore_drills ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.backup_restore_drills FROM anon, authenticated;

-- Credential guard: this registry is displayed in Super Admin, so it must
-- never carry secret material. Reject anything that looks like an embedded
-- credential instead of silently storing it.
CREATE OR REPLACE FUNCTION public.backup_reject_credentials()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  blob text;
BEGIN
  blob := coalesce(NEW.destination, '') || ' ' || coalesce(NEW.metadata::text, '');
  IF TG_TABLE_NAME = 'backup_restore_drills' THEN
    blob := coalesce(NEW.notes, '') || ' ' || coalesce(NEW.findings::text, '');
  END IF;
  IF blob ~* '(://[^/[:space:]]*:[^/@[:space:]]+@)'
     OR blob ~* '(password|passwd|secret_access_key|aws_secret|private_key|service_role_key)[[:space:]]*[:=]'
     OR blob ~* 'AKIA[0-9A-Z]{16}'
  THEN
    RAISE EXCEPTION 'backup_metadata_contains_credentials';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.backup_reject_credentials() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS backup_runs_no_credentials ON public.backup_runs;
CREATE TRIGGER backup_runs_no_credentials
  BEFORE INSERT OR UPDATE ON public.backup_runs
  FOR EACH ROW EXECUTE FUNCTION public.backup_reject_credentials();

DROP TRIGGER IF EXISTS backup_drills_no_credentials ON public.backup_restore_drills;
CREATE TRIGGER backup_drills_no_credentials
  BEFORE INSERT OR UPDATE ON public.backup_restore_drills
  FOR EACH ROW EXECUTE FUNCTION public.backup_reject_credentials();

CREATE OR REPLACE FUNCTION public.backup_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

REVOKE ALL ON FUNCTION public.backup_touch_updated_at() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS backup_runs_touch ON public.backup_runs;
CREATE TRIGGER backup_runs_touch
  BEFORE UPDATE ON public.backup_runs
  FOR EACH ROW EXECUTE FUNCTION public.backup_touch_updated_at();

-- Health projection: latest run per kind + live WAL archiver state.
CREATE OR REPLACE FUNCTION public.backup_health()
RETURNS TABLE (
  kind text,
  backup_id text,
  status text,
  finished_at timestamptz,
  age_seconds double precision,
  bytes bigint,
  encrypted boolean,
  verification_status text,
  verified_at timestamptz,
  last_restore_tested_at timestamptz,
  destination text,
  lsn text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT ON (b.kind)
    b.kind, b.backup_id, b.status, b.finished_at,
    extract(epoch FROM (now() - coalesce(b.finished_at, b.started_at))),
    b.bytes, b.encrypted, b.verification_status, b.verified_at,
    b.last_restore_tested_at, b.destination, b.lsn
  FROM public.backup_runs b
  ORDER BY b.kind, b.started_at DESC
$$;

REVOKE ALL ON FUNCTION public.backup_health() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backup_health() TO service_role;

-- Live WAL archiver state, read from pg_stat_archiver (not reachable through
-- PostgREST for the app roles, hence the definer wrapper).
CREATE OR REPLACE FUNCTION public.backup_wal_status()
RETURNS TABLE (
  archive_mode text,
  wal_level text,
  archive_timeout_seconds integer,
  archived_count bigint,
  last_archived_wal text,
  last_archived_time timestamptz,
  archive_lag_seconds double precision,
  failed_count bigint,
  last_failed_wal text,
  last_failed_time timestamptz,
  stats_reset timestamptz,
  current_lsn text,
  database_bytes bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT
    current_setting('archive_mode'),
    current_setting('wal_level'),
    current_setting('archive_timeout')::integer,
    a.archived_count,
    a.last_archived_wal,
    a.last_archived_time,
    extract(epoch FROM (now() - a.last_archived_time)),
    a.failed_count,
    a.last_failed_wal,
    a.last_failed_time,
    a.stats_reset,
    pg_current_wal_lsn()::text,
    pg_database_size(current_database())
  FROM pg_stat_archiver a
$$;

REVOKE ALL ON FUNCTION public.backup_wal_status() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backup_wal_status() TO service_role;