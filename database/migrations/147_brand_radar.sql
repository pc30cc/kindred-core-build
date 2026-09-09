-- SEO — Brand Radar (Phase 6 of the Ahrefs-style SEO rebuild).
--
-- Three distinct data domains, each reusing an EXISTING pipeline rather than
-- calling a new vendor — no fabricated data anywhere:
--
--   - AI Visibility: asks the workspace's already-configured AI provider
--     (server/services/ai/index.ts's executeAICompletion — the same billed
--     path AI Assistant/KB Builder/Operator Assist already use, resolved via
--     provider_configs -> app_runtime_config) a neutral question for each
--     tracked topic, then checks whether the brand name (and each tracked
--     competitor) appears in the real response text. Billed through the
--     existing AI credit/wallet system like any other AI feature — no new
--     billing path.
--   - Web Visibility: reuses server/services/seo/rankTracking/index.ts's
--     checkKeywordRank() — the SAME DataForSEO adapter Rank Tracker calls —
--     called directly (bypassing seo_tracked_keywords entirely) so Brand
--     Radar's own small term list never competes with a workspace's manual
--     Rank Tracker keyword quota.
--   - Search Demand: reuses server/services/seo/gsc/index.ts's
--     querySearchAnalytics() against the workspace's already-connected GSC
--     property, filtered to queries containing the brand/competitor name.
--
-- Same backend-only ACL convention as every other SEO module: service-role
-- only RLS, every write goes through Express (server/routes/brandRadar.ts).

CREATE TABLE IF NOT EXISTS public.brand_radar_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL UNIQUE REFERENCES public.workspaces(id) ON DELETE CASCADE,
  brand_name text NOT NULL,
  competitor_names text[] NOT NULL DEFAULT '{}',
  site_id uuid REFERENCES public.workspace_domains(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.brand_radar_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.brand_radar_settings FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.brand_radar_settings TO service_role;

CREATE POLICY "service role only"
  ON public.brand_radar_settings
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TRIGGER brand_radar_settings_updated_at
  BEFORE UPDATE ON public.brand_radar_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Tracked AI-visibility prompts/topics — a workspace defines a handful of
-- neutral category questions ("best live chat software for small
-- businesses") that a real buyer might ask an AI assistant.
CREATE TABLE IF NOT EXISTS public.brand_radar_topics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  label text NOT NULL,
  prompt text NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_brand_radar_topics_workspace ON public.brand_radar_topics (workspace_id, created_at DESC);

ALTER TABLE public.brand_radar_topics ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.brand_radar_topics FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.brand_radar_topics TO service_role;

CREATE POLICY "service role only"
  ON public.brand_radar_topics
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Append-only history of AI-visibility runs. topic_label/prompt are
-- denormalized snapshots so history reads correctly even after a topic is
-- edited or deleted.
CREATE TABLE IF NOT EXISTS public.brand_radar_ai_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  topic_id uuid REFERENCES public.brand_radar_topics(id) ON DELETE SET NULL,
  topic_label text NOT NULL,
  prompt text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  response_text text NOT NULL,
  brand_mentioned boolean NOT NULL,
  brand_mention_position integer,
  competitors_mentioned text[] NOT NULL DEFAULT '{}',
  checked_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_brand_radar_ai_checks_workspace_time ON public.brand_radar_ai_checks (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_brand_radar_ai_checks_topic ON public.brand_radar_ai_checks (topic_id, created_at DESC);

ALTER TABLE public.brand_radar_ai_checks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.brand_radar_ai_checks FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.brand_radar_ai_checks TO service_role;

CREATE POLICY "service role only"
  ON public.brand_radar_ai_checks
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Append-only history of Web Visibility rank checks for the brand name and
-- each tracked competitor name, run directly through the rank-tracking
-- provider adapter (never through seo_tracked_keywords).
CREATE TABLE IF NOT EXISTS public.brand_radar_web_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  term text NOT NULL,
  is_own_brand boolean NOT NULL,
  device text NOT NULL DEFAULT 'desktop',
  position integer,
  ranking_url text,
  checked_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_brand_radar_web_checks_workspace_time ON public.brand_radar_web_checks (workspace_id, created_at DESC);

ALTER TABLE public.brand_radar_web_checks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.brand_radar_web_checks FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.brand_radar_web_checks TO service_role;

CREATE POLICY "service role only"
  ON public.brand_radar_web_checks
  FOR ALL TO service_role USING (true) WITH CHECK (true);
