
-- ═══════════════════════════════════════════════════════════════
-- AI Knowledge Base Builder — schema + plan defaults
-- ═══════════════════════════════════════════════════════════════

-- ─── 1. Enums ───────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE public.ai_kb_job_status AS ENUM (
    'queued','running','crawling','extracting','generating',
    'completed','partial','failed','canceled'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.ai_kb_page_status AS ENUM (
    'pending','fetched','extracted','skipped','failed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.ai_kb_generated_status AS ENUM (
    'pending','accepted','rejected','published'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.ai_kb_source_kind AS ENUM (
    'workspace_domain','profile_domain'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── 2. ai_kb_jobs ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ai_kb_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  requested_by UUID,
  source_kind public.ai_kb_source_kind NOT NULL,
  source_domain TEXT NOT NULL,
  source_workspace_domain_id UUID REFERENCES public.workspace_domains(id) ON DELETE SET NULL,
  source_verified BOOLEAN NOT NULL DEFAULT false,
  locale TEXT NOT NULL DEFAULT 'en',
  status public.ai_kb_job_status NOT NULL DEFAULT 'queued',
  progress INT NOT NULL DEFAULT 0,
  plan_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  pages_discovered INT NOT NULL DEFAULT 0,
  pages_crawled INT NOT NULL DEFAULT 0,
  pages_failed INT NOT NULL DEFAULT 0,
  articles_generated INT NOT NULL DEFAULT 0,
  credits_used INT NOT NULL DEFAULT 0,
  error_message TEXT,
  worker_id TEXT,
  claimed_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_kb_jobs_workspace ON public.ai_kb_jobs(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_kb_jobs_status ON public.ai_kb_jobs(status, created_at);

ALTER TABLE public.ai_kb_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can view ai_kb_jobs" ON public.ai_kb_jobs;
CREATE POLICY "Members can view ai_kb_jobs" ON public.ai_kb_jobs
  FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()));

-- Inserts/updates handled by service-role backend/worker only (no policy = denied for authenticated).

-- ─── 3. ai_kb_job_pages ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ai_kb_job_pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES public.ai_kb_jobs(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  url_hash TEXT NOT NULL,
  depth INT NOT NULL DEFAULT 0,
  status public.ai_kb_page_status NOT NULL DEFAULT 'pending',
  http_status INT,
  bytes INT,
  text_length INT,
  content_hash TEXT,
  title TEXT,
  error_message TEXT,
  fetched_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(job_id, url_hash)
);
CREATE INDEX IF NOT EXISTS idx_ai_kb_job_pages_job ON public.ai_kb_job_pages(job_id, status);

ALTER TABLE public.ai_kb_job_pages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can view ai_kb_job_pages" ON public.ai_kb_job_pages;
CREATE POLICY "Members can view ai_kb_job_pages" ON public.ai_kb_job_pages
  FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()));

-- ─── 4. ai_kb_generated_articles ────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ai_kb_generated_articles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  job_id UUID NOT NULL REFERENCES public.ai_kb_jobs(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  excerpt TEXT,
  content_md TEXT NOT NULL DEFAULT '',
  locale TEXT NOT NULL DEFAULT 'en',
  suggested_category TEXT,
  confidence NUMERIC(4,3),
  source_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
  status public.ai_kb_generated_status NOT NULL DEFAULT 'pending',
  kb_article_id UUID REFERENCES public.knowledge_base_articles(id) ON DELETE SET NULL,
  model TEXT,
  credits_used INT NOT NULL DEFAULT 0,
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_kb_generated_workspace ON public.ai_kb_generated_articles(workspace_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_kb_generated_job ON public.ai_kb_generated_articles(job_id);

ALTER TABLE public.ai_kb_generated_articles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can view ai_kb_generated" ON public.ai_kb_generated_articles;
CREATE POLICY "Members can view ai_kb_generated" ON public.ai_kb_generated_articles
  FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()));

-- ─── 5. ai_kb_usage ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ai_kb_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  job_id UUID REFERENCES public.ai_kb_jobs(id) ON DELETE SET NULL,
  generated_article_id UUID REFERENCES public.ai_kb_generated_articles(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,        -- 'job_created' | 'page_crawled' | 'article_generated' | 'job_completed' | 'job_failed'
  credits INT NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_kb_usage_workspace ON public.ai_kb_usage(workspace_id, created_at DESC);

ALTER TABLE public.ai_kb_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins+ can view ai_kb_usage" ON public.ai_kb_usage;
CREATE POLICY "Admins+ can view ai_kb_usage" ON public.ai_kb_usage
  FOR SELECT TO authenticated
  USING (public.get_workspace_role(workspace_id, auth.uid()) IN ('owner','admin'));

-- ─── 6. ai_kb_job_events ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ai_kb_job_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES public.ai_kb_jobs(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  level TEXT NOT NULL DEFAULT 'info',  -- info | warn | error
  message TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_kb_job_events_job ON public.ai_kb_job_events(job_id, created_at);

ALTER TABLE public.ai_kb_job_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can view ai_kb_job_events" ON public.ai_kb_job_events;
CREATE POLICY "Members can view ai_kb_job_events" ON public.ai_kb_job_events
  FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()));

-- ─── 7. Updated-at triggers (reuse standard helper if present) ──
CREATE OR REPLACE FUNCTION public.ai_kb_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS trg_ai_kb_jobs_updated_at ON public.ai_kb_jobs;
CREATE TRIGGER trg_ai_kb_jobs_updated_at
  BEFORE UPDATE ON public.ai_kb_jobs
  FOR EACH ROW EXECUTE FUNCTION public.ai_kb_set_updated_at();

DROP TRIGGER IF EXISTS trg_ai_kb_generated_updated_at ON public.ai_kb_generated_articles;
CREATE TRIGGER trg_ai_kb_generated_updated_at
  BEFORE UPDATE ON public.ai_kb_generated_articles
  FOR EACH ROW EXECUTE FUNCTION public.ai_kb_set_updated_at();

-- ─── 8. Seed plan entitlements + limits for AI KB Builder ───────
-- Use jsonb concatenation so existing keys are preserved.
UPDATE public.billing_plans
SET entitlements = COALESCE(entitlements, '{}'::jsonb) || jsonb_build_object('ai_kb_builder', false),
    limits = COALESCE(limits, '{}'::jsonb) || jsonb_build_object(
      'ai_kb_max_pages', 3,
      'ai_kb_max_depth', 1,
      'ai_kb_jobs_per_month', 1,
      'ai_kb_max_articles', 3,
      'ai_kb_max_chars', 10000,
      'ai_kb_monthly_credits', 10
    )
WHERE slug = 'free';

UPDATE public.billing_plans
SET entitlements = COALESCE(entitlements, '{}'::jsonb) || jsonb_build_object('ai_kb_builder', true),
    limits = COALESCE(limits, '{}'::jsonb) || jsonb_build_object(
      'ai_kb_max_pages', 25,
      'ai_kb_max_depth', 2,
      'ai_kb_jobs_per_month', 5,
      'ai_kb_max_articles', 30,
      'ai_kb_max_chars', 100000,
      'ai_kb_monthly_credits', 200
    )
WHERE slug = 'pro';

UPDATE public.billing_plans
SET entitlements = COALESCE(entitlements, '{}'::jsonb) || jsonb_build_object('ai_kb_builder', true),
    limits = COALESCE(limits, '{}'::jsonb) || jsonb_build_object(
      'ai_kb_max_pages', 200,
      'ai_kb_max_depth', 3,
      'ai_kb_jobs_per_month', 50,
      'ai_kb_max_articles', 300,
      'ai_kb_max_chars', 1000000,
      'ai_kb_monthly_credits', 5000
    )
WHERE slug = 'enterprise';
