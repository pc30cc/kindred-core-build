-- SEO — Bot Analytics (Phase 5 of the Ahrefs-style SEO rebuild).
--
-- Why this is a LOG FILE ANALYZER, not a Web-Analytics-style JS beacon:
-- Web Analytics (144/145) can observe every HUMAN visitor because the chat
-- widget's own snippet runs in their browser. It cannot observe most bot
-- traffic the same way: search-engine crawlers (Googlebot, Bingbot) and
-- essentially all AI/LLM crawlers (GPTBot, ClaudeBot, PerplexityBot, CCBot,
-- Bytespider, ...) fetch raw HTML only — they do not execute JavaScript and
-- do not request a page's subresources, so they never call the widget's
-- loader script or its tracking endpoints. There is no reuse path here.
--
-- The only source of truth for "which bots crawled my site" is the site's
-- own web-server/CDN access log, which the workspace owner exports and
-- uploads (server/services/botAnalytics/logParser.ts parses standard
-- combined-log and JSON-Lines formats). This mirrors how real log-file
-- analyzers (Screaming Frog Log File Analyser, Ahrefs' own Bot Analytics)
-- work — there is no vendor to call and nothing to fabricate: every row
-- here is a real line from a real access log, matched against a maintained
-- bot user-agent signature table
-- (server/services/botAnalytics/signatures.ts).
--
-- Same backend-only ACL convention as the other SEO modules: service-role
-- only RLS, every write goes through Express (server/routes/botAnalytics.ts).

CREATE TABLE IF NOT EXISTS public.bot_log_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  filename text NOT NULL,
  format text NOT NULL,
  total_lines integer NOT NULL DEFAULT 0,
  matched_bot_lines integer NOT NULL DEFAULT 0,
  date_range_start timestamptz,
  date_range_end timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bot_log_imports_workspace_time ON public.bot_log_imports (workspace_id, created_at DESC);

ALTER TABLE public.bot_log_imports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bot_log_imports FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.bot_log_imports TO service_role;

CREATE POLICY "service role only"
  ON public.bot_log_imports
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- One row per matched-bot request line. Non-bot log lines are discarded at
-- parse time (server/services/botAnalytics/importService.ts) — this table
-- only ever holds real, already-classified bot hits, never raw traffic.
CREATE TABLE IF NOT EXISTS public.bot_visits (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  import_id uuid NOT NULL REFERENCES public.bot_log_imports(id) ON DELETE CASCADE,
  bot_name text NOT NULL,
  bot_category text NOT NULL,
  user_agent text NOT NULL,
  path text NOT NULL,
  method text,
  status_code integer,
  ip text,
  visited_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bot_visits_workspace_time ON public.bot_visits (workspace_id, visited_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_visits_workspace_bot_time ON public.bot_visits (workspace_id, bot_name, visited_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_visits_workspace_path ON public.bot_visits (workspace_id, path);
CREATE INDEX IF NOT EXISTS idx_bot_visits_import ON public.bot_visits (import_id);

ALTER TABLE public.bot_visits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bot_visits FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.bot_visits TO service_role;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relkind = 'S' AND relname = 'bot_visits_id_seq') THEN
    GRANT USAGE, SELECT ON SEQUENCE public.bot_visits_id_seq TO service_role;
  END IF;
END $$;

CREATE POLICY "service role only"
  ON public.bot_visits
  FOR ALL TO service_role USING (true) WITH CHECK (true);
