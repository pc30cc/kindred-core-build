-- Privacy export → provider-based storage
-- Adds metadata columns so artifacts can be located/deleted via the
-- pluggable storage provider system. Legacy rows with NULL values continue
-- to work via local-disk fallback (backward compatible).

ALTER TABLE public.privacy_jobs
  ADD COLUMN IF NOT EXISTS artifact_storage_provider text,
  ADD COLUMN IF NOT EXISTS artifact_storage_key text;

COMMENT ON COLUMN public.privacy_jobs.artifact_storage_provider IS
  'Storage provider name that holds the export artifact (e.g. local, s3, bunny_storage). NULL = legacy local-disk artifact stored at artifact_path.';

COMMENT ON COLUMN public.privacy_jobs.artifact_storage_key IS
  'Provider-relative object key for the artifact (e.g. privacy-exports/<workspace>/<job>.zip). Used together with artifact_storage_provider.';

-- Index for cleanup queries (purge expired artifacts from any provider)
CREATE INDEX IF NOT EXISTS idx_privacy_jobs_expires_at
  ON public.privacy_jobs (expires_at)
  WHERE artifact_storage_key IS NOT NULL;