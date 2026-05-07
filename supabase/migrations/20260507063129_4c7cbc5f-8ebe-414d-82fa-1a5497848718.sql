
-- Sync jobs (DB-backed queue with claim/lock)
CREATE TABLE IF NOT EXISTS public.ai_source_sync_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  source_id uuid NOT NULL,
  job_type text NOT NULL DEFAULT 'website_sync',
  status text NOT NULL DEFAULT 'queued',
  priority integer NOT NULL DEFAULT 100,
  locked_by text,
  locked_at timestamptz,
  lock_expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  started_at timestamptz,
  finished_at timestamptz,
  last_error text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_source_sync_jobs_status_chk CHECK (status IN ('queued','running','completed','failed','cancelled'))
);

CREATE INDEX IF NOT EXISTS ai_source_sync_jobs_claim_idx
  ON public.ai_source_sync_jobs (status, priority, created_at)
  WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS ai_source_sync_jobs_workspace_idx
  ON public.ai_source_sync_jobs (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_source_sync_jobs_source_idx
  ON public.ai_source_sync_jobs (source_id, created_at DESC);

ALTER TABLE public.ai_source_sync_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role full access" ON public.ai_source_sync_jobs;
CREATE POLICY "service role full access" ON public.ai_source_sync_jobs
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Per-page crawl record
CREATE TABLE IF NOT EXISTS public.ai_source_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  source_id uuid NOT NULL,
  url text NOT NULL,
  url_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  http_status integer,
  title text,
  locale text,
  text_length integer DEFAULT 0,
  content_hash text,
  chunks_created integer DEFAULT 0,
  embedding_status text,
  warning text,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_source_pages_unique_idx
  ON public.ai_source_pages (source_id, url_hash);
CREATE INDEX IF NOT EXISTS ai_source_pages_workspace_idx
  ON public.ai_source_pages (workspace_id);

ALTER TABLE public.ai_source_pages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role full access" ON public.ai_source_pages;
CREATE POLICY "service role full access" ON public.ai_source_pages
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Counters on ai_data_sources
ALTER TABLE public.ai_data_sources
  ADD COLUMN IF NOT EXISTS pages_found integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS chunks_created integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS embedded_chunks integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_warning text;

CREATE OR REPLACE FUNCTION public.touch_ai_source_sync_jobs() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;
DROP TRIGGER IF EXISTS trg_touch_ai_source_sync_jobs ON public.ai_source_sync_jobs;
CREATE TRIGGER trg_touch_ai_source_sync_jobs BEFORE UPDATE ON public.ai_source_sync_jobs
  FOR EACH ROW EXECUTE FUNCTION public.touch_ai_source_sync_jobs();

DROP TRIGGER IF EXISTS trg_touch_ai_source_pages ON public.ai_source_pages;
CREATE TRIGGER trg_touch_ai_source_pages BEFORE UPDATE ON public.ai_source_pages
  FOR EACH ROW EXECUTE FUNCTION public.touch_ai_source_sync_jobs();
