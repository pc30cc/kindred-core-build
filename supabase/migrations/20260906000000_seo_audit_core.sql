-- SEO / Website Audit — core schema (V1).
--
-- Architecture: a GENERIC background-job queue (`background_jobs`) that any
-- future worker kind (DNS checks, SSL checks, uptime, performance audits)
-- can reuse, plus SEO-SPECIFIC result tables that reference it. The two are
-- deliberately kept apart: `background_jobs` knows nothing about crawling or
-- SEO, and every SEO table carries its own `workspace_id`/`website_id` FKs so
-- tenant isolation never depends on joining through the generic job row.
--
-- `website_id` always references `workspace_domains(id)` — the ALREADY
-- EXISTING workspace site registry (see 002_workspace_features.sql). No new
-- "sites" concept is introduced, and no domain-ownership verification is
-- added: a domain already registered in the workspace is sufficient to
-- authorize crawling it (see server/routes/seo.ts for the enforcement).
--
-- Backend-only ACL (no auth.uid()-based RLS policies): this app's browser
-- session never carries a Supabase Auth JWT, so RLS policies referencing
-- auth.uid() are dead code here (see workspace_invitations v5.1's 093/096
-- migrations for the same reasoning). All reads/writes go through the
-- Express service-role client, which is the actual tenant-isolation boundary
-- (server/lib/workspaceAuth.ts).

CREATE TABLE IF NOT EXISTS public.background_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  job_type text NOT NULL,
  subject_type text NOT NULL,
  subject_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'processing', 'completed', 'failed', 'cancelled')),
  priority integer NOT NULL DEFAULT 100,
  locked_by text,
  locked_at timestamptz,
  lock_expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 2,
  progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  progress_stage text,
  cancel_requested boolean NOT NULL DEFAULT false,
  error_message text,
  error_category text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_background_jobs_claim ON public.background_jobs (job_type, status, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_background_jobs_workspace ON public.background_jobs (workspace_id);
CREATE INDEX IF NOT EXISTS idx_background_jobs_subject ON public.background_jobs (subject_type, subject_id);

ALTER TABLE public.background_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.background_jobs FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.background_jobs TO service_role;

COMMENT ON TABLE public.background_jobs IS
  'Generic async job queue (poll + conditional-claim, matching ai_source_sync_jobs). job_type discriminates the worker kind (e.g. seo_crawl). Carries no domain-specific columns on purpose.';

-- ─────────────────────────────────────────────────────────────────────────
-- SEO crawl — the business/result object. One row per audit run.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.seo_crawls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL UNIQUE REFERENCES public.background_jobs(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  website_id uuid NOT NULL REFERENCES public.workspace_domains(id) ON DELETE CASCADE,
  canonical_url text NOT NULL,
  user_agent text NOT NULL,
  respect_robots boolean NOT NULL DEFAULT true,
  limits jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'processing', 'completed', 'failed', 'cancelled')),
  progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  progress_stage text,
  pages_discovered integer NOT NULL DEFAULT 0,
  pages_crawled integer NOT NULL DEFAULT 0,
  pages_failed integer NOT NULL DEFAULT 0,
  pages_skipped integer NOT NULL DEFAULT 0,
  score integer CHECK (score IS NULL OR score BETWEEN 0 AND 100),
  score_version text,
  score_breakdown jsonb,
  robots_summary jsonb,
  sitemap_summary jsonb,
  cancel_requested boolean NOT NULL DEFAULT false,
  error_message text,
  error_category text,
  created_by uuid,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_seo_crawls_workspace ON public.seo_crawls (workspace_id);
CREATE INDEX IF NOT EXISTS idx_seo_crawls_website ON public.seo_crawls (website_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_seo_crawls_status ON public.seo_crawls (status);

ALTER TABLE public.seo_crawls ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.seo_crawls FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.seo_crawls TO service_role;

COMMENT ON TABLE public.seo_crawls IS
  'One row per SEO audit run. canonical_url is resolved server-side from workspace_domains at creation time and never re-derived from client input.';

-- ─────────────────────────────────────────────────────────────────────────
-- Normalized per-page results (the UI never reads raw crawler output).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.seo_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  crawl_id uuid NOT NULL REFERENCES public.seo_crawls(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  url text NOT NULL,
  normalized_url text NOT NULL,
  final_url text,
  discovered_via text NOT NULL DEFAULT 'link' CHECK (discovered_via IN ('start', 'link', 'sitemap', 'redirect')),
  depth integer NOT NULL DEFAULT 0,
  http_status integer,
  content_type text,
  response_time_ms integer,
  response_bytes integer,
  redirect_chain jsonb NOT NULL DEFAULT '[]'::jsonb,
  title text,
  title_length integer,
  meta_description text,
  meta_description_length integer,
  canonical_url text,
  canonical_status text CHECK (canonical_status IN ('missing', 'self', 'points_elsewhere', 'invalid')),
  meta_robots text,
  is_indexable boolean NOT NULL DEFAULT true,
  is_nofollow boolean NOT NULL DEFAULT false,
  h1 text,
  h1_count integer NOT NULL DEFAULT 0,
  h2_count integer NOT NULL DEFAULT 0,
  lang text,
  charset text,
  word_count integer NOT NULL DEFAULT 0,
  internal_links_count integer NOT NULL DEFAULT 0,
  external_links_count integer NOT NULL DEFAULT 0,
  incoming_internal_links_count integer NOT NULL DEFAULT 0,
  images_count integer NOT NULL DEFAULT 0,
  images_missing_alt_count integer NOT NULL DEFAULT 0,
  has_open_graph boolean NOT NULL DEFAULT false,
  has_twitter_card boolean NOT NULL DEFAULT false,
  has_structured_data boolean NOT NULL DEFAULT false,
  structured_data_types text[] NOT NULL DEFAULT '{}',
  structured_data_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  html_size_bytes integer,
  is_https boolean NOT NULL DEFAULT true,
  has_mixed_content boolean NOT NULL DEFAULT false,
  fetch_error text,
  crawled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (crawl_id, normalized_url)
);
CREATE INDEX IF NOT EXISTS idx_seo_pages_crawl ON public.seo_pages (crawl_id);
CREATE INDEX IF NOT EXISTS idx_seo_pages_crawl_status ON public.seo_pages (crawl_id, http_status);
CREATE INDEX IF NOT EXISTS idx_seo_pages_workspace ON public.seo_pages (workspace_id);

ALTER TABLE public.seo_pages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.seo_pages FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.seo_pages TO service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- Link graph (internal + external). Crawler never follows external links —
-- they are recorded here for reporting only (see seo/crawler/crawlSite.ts).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.seo_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  crawl_id uuid NOT NULL REFERENCES public.seo_crawls(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  source_page_id uuid NOT NULL REFERENCES public.seo_pages(id) ON DELETE CASCADE,
  target_url text NOT NULL,
  target_normalized_url text,
  target_page_id uuid REFERENCES public.seo_pages(id) ON DELETE SET NULL,
  is_external boolean NOT NULL DEFAULT false,
  anchor_text text,
  rel text,
  http_status integer,
  is_broken boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_seo_links_crawl ON public.seo_links (crawl_id);
CREATE INDEX IF NOT EXISTS idx_seo_links_crawl_external ON public.seo_links (crawl_id, is_external);
CREATE INDEX IF NOT EXISTS idx_seo_links_crawl_broken ON public.seo_links (crawl_id, is_broken);
CREATE INDEX IF NOT EXISTS idx_seo_links_source ON public.seo_links (source_page_id);

ALTER TABLE public.seo_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.seo_links FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.seo_links TO service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- Issues — the output of the SEO rules engine, never raw crawler output.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.seo_issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  crawl_id uuid NOT NULL REFERENCES public.seo_crawls(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  website_id uuid NOT NULL REFERENCES public.workspace_domains(id) ON DELETE CASCADE,
  issue_type text NOT NULL,
  category text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
  title text NOT NULL,
  description text NOT NULL,
  recommendation text NOT NULL,
  affected_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'persistent', 'resolved')),
  first_detected_at timestamptz NOT NULL DEFAULT now(),
  last_detected_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_seo_issues_crawl ON public.seo_issues (crawl_id);
CREATE INDEX IF NOT EXISTS idx_seo_issues_crawl_severity ON public.seo_issues (crawl_id, severity);
CREATE INDEX IF NOT EXISTS idx_seo_issues_crawl_category ON public.seo_issues (crawl_id, category);
CREATE INDEX IF NOT EXISTS idx_seo_issues_website_type ON public.seo_issues (website_id, issue_type, created_at DESC);

ALTER TABLE public.seo_issues ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.seo_issues FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.seo_issues TO service_role;

CREATE TABLE IF NOT EXISTS public.seo_issue_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id uuid NOT NULL REFERENCES public.seo_issues(id) ON DELETE CASCADE,
  page_id uuid REFERENCES public.seo_pages(id) ON DELETE CASCADE,
  url text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_seo_issue_pages_issue ON public.seo_issue_pages (issue_id);
CREATE INDEX IF NOT EXISTS idx_seo_issue_pages_page ON public.seo_issue_pages (page_id);

ALTER TABLE public.seo_issue_pages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.seo_issue_pages FROM anon, authenticated;
GRANT SELECT, INSERT ON public.seo_issue_pages TO service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- Sitemap discovery/validation summary.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.seo_sitemaps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  crawl_id uuid NOT NULL REFERENCES public.seo_crawls(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  url text NOT NULL,
  discovered_via text NOT NULL DEFAULT 'default_path' CHECK (discovered_via IN ('robots', 'default_path', 'sitemap_index')),
  status text NOT NULL CHECK (status IN ('valid', 'invalid', 'unreachable')),
  http_status integer,
  url_count integer NOT NULL DEFAULT 0,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_seo_sitemaps_crawl ON public.seo_sitemaps (crawl_id);

ALTER TABLE public.seo_sitemaps ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.seo_sitemaps FROM anon, authenticated;
GRANT SELECT, INSERT ON public.seo_sitemaps TO service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- Performance (Lighthouse/Unlighthouse) results — SCHEMA CONTRACT ONLY in V1.
-- No performance worker ships in this phase; the table exists so the API/UI
-- contract is stable when that worker is added later (see docs/SEO_AUDIT.md).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.seo_performance_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  crawl_id uuid NOT NULL REFERENCES public.seo_crawls(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  page_id uuid REFERENCES public.seo_pages(id) ON DELETE CASCADE,
  url text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'unavailable')),
  performance_score integer,
  accessibility_score integer,
  best_practices_score integer,
  seo_score integer,
  lcp_ms integer,
  cls numeric,
  inp_ms integer,
  fcp_ms integer,
  tbt_ms integer,
  raw_summary jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_seo_performance_crawl ON public.seo_performance_results (crawl_id);

ALTER TABLE public.seo_performance_results ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.seo_performance_results FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.seo_performance_results TO service_role;
