-- SEO — GSC Insights (V1, the fifth pluggable SEO data module; backlinks/
-- keywords/rank-tracking/performance shipped in 140/141/142).
--
-- Unlike the other four modules, Google Search Console has NO platform-level
-- API key: each workspace authorizes its OWN Google account via OAuth 2.0
-- (scope: https://www.googleapis.com/auth/webmasters.readonly) and picks
-- which Search Console property (site) to read. So there is no
-- `platform_gsc_provider_config` singleton — instead:
--
--   - `seo_gsc_oauth_states`   short-lived, single-use, unguessable random
--                              tokens minted when a workspace admin starts
--                              the Google consent flow. The OAuth `state`
--                              param IS this token — Google's callback
--                              carries no other workspace-identifying data,
--                              so this table is what makes the callback
--                              trustworthy (CSRF-proof, single-use, 15 min
--                              TTL) without a second signing secret.
--   - `seo_gsc_connections`   one Google account link per workspace. The
--                              refresh token is stored as an AES-256-GCM
--                              envelope (server/lib/pluginCrypto.ts, the
--                              repo's one canonical secret-at-rest helper —
--                              PLUGIN_SECRETS_MASTER_KEY), never plaintext.
--   - `seo_gsc_properties`    Search Console site(s) the workspace has
--                              linked under that connection (a Google
--                              account can own many; a workspace picks one
--                              or more to actually use here).
--   - `seo_gsc_query_cache`   short-TTL cache of Search Analytics query
--                              results, keyed by the exact query shape, so
--                              two users looking at the same report within
--                              the cache window don't double the Search
--                              Console API quota spend.
--
-- Same backend-only ACL convention as 140/141/142: every table is
-- service-role-only RLS, no auth.uid()-based policies — the Express API
-- layer (server/routes/seo.ts) is the sole caller, already gated by
-- authorizeWorkspaceAccess + requireModule('seo_gsc_insights').

-- ─────────────────────────────────────────────────────────────────────────
-- OAuth state — short-lived, single-use CSRF token for the consent flow.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.seo_gsc_oauth_states (
  token text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  initiated_by uuid NOT NULL,
  redirect_path text,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes')
);

CREATE INDEX IF NOT EXISTS idx_seo_gsc_oauth_states_workspace ON public.seo_gsc_oauth_states (workspace_id);
CREATE INDEX IF NOT EXISTS idx_seo_gsc_oauth_states_expires ON public.seo_gsc_oauth_states (expires_at);

ALTER TABLE public.seo_gsc_oauth_states ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.seo_gsc_oauth_states FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.seo_gsc_oauth_states TO service_role;

DROP POLICY IF EXISTS "service role only" ON public.seo_gsc_oauth_states;
CREATE POLICY "service role only"
  ON public.seo_gsc_oauth_states
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ─────────────────────────────────────────────────────────────────────────
-- Connection — one Google account link per workspace.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.seo_gsc_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL UNIQUE REFERENCES public.workspaces(id) ON DELETE CASCADE,
  google_account_email text,
  scope text NOT NULL DEFAULT 'https://www.googleapis.com/auth/webmasters.readonly',
  -- AES-256-GCM envelope from server/lib/pluginCrypto.ts's SecretEnvelope
  -- shape ({algorithm,key_version,nonce,ciphertext,auth_tag,fingerprint}).
  -- The plaintext refresh token NEVER touches this column or any log line.
  refresh_token_envelope jsonb NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'error')),
  last_error text,
  connected_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.seo_gsc_connections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.seo_gsc_connections FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.seo_gsc_connections TO service_role;

DROP POLICY IF EXISTS "service role only" ON public.seo_gsc_connections;
CREATE POLICY "service role only"
  ON public.seo_gsc_connections
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP TRIGGER IF EXISTS seo_gsc_connections_updated_at ON public.seo_gsc_connections;
CREATE TRIGGER seo_gsc_connections_updated_at
  BEFORE UPDATE ON public.seo_gsc_connections
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ─────────────────────────────────────────────────────────────────────────
-- Properties — Search Console site(s) linked under a workspace's connection.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.seo_gsc_properties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES public.seo_gsc_connections(id) ON DELETE CASCADE,
  -- Google's own identifier: either "sc-domain:example.com" (Domain
  -- property) or a URL-prefix property like "https://example.com/".
  site_url text NOT NULL,
  permission_level text,
  -- Optional correlation with a workspace_domains row already registered
  -- for Site Audit/Rank Tracker/Site Explorer. Never required — a GSC
  -- property can be linked long before (or instead of) running a crawl.
  website_id uuid REFERENCES public.workspace_domains(id) ON DELETE SET NULL,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT seo_gsc_properties_workspace_site_uniq UNIQUE (workspace_id, site_url)
);

CREATE INDEX IF NOT EXISTS idx_seo_gsc_properties_workspace ON public.seo_gsc_properties (workspace_id);
CREATE INDEX IF NOT EXISTS idx_seo_gsc_properties_connection ON public.seo_gsc_properties (connection_id);

ALTER TABLE public.seo_gsc_properties ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.seo_gsc_properties FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.seo_gsc_properties TO service_role;

DROP POLICY IF EXISTS "service role only" ON public.seo_gsc_properties;
CREATE POLICY "service role only"
  ON public.seo_gsc_properties
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Only one primary property per workspace.
CREATE UNIQUE INDEX IF NOT EXISTS idx_seo_gsc_properties_one_primary
  ON public.seo_gsc_properties (workspace_id) WHERE is_primary;

-- ─────────────────────────────────────────────────────────────────────────
-- Query cache — short-TTL cache of Search Analytics results.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.seo_gsc_query_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.seo_gsc_properties(id) ON DELETE CASCADE,
  -- sha256 of the normalized query shape (dates, dimensions, filters, row limit).
  query_hash text NOT NULL,
  query_params jsonb NOT NULL,
  rows jsonb NOT NULL DEFAULT '[]'::jsonb,
  response_aggregation_type text,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT seo_gsc_query_cache_property_hash_uniq UNIQUE (property_id, query_hash)
);

CREATE INDEX IF NOT EXISTS idx_seo_gsc_query_cache_fetched ON public.seo_gsc_query_cache (fetched_at);

ALTER TABLE public.seo_gsc_query_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.seo_gsc_query_cache FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.seo_gsc_query_cache TO service_role;

DROP POLICY IF EXISTS "service role only" ON public.seo_gsc_query_cache;
CREATE POLICY "service role only"
  ON public.seo_gsc_query_cache
  FOR ALL TO service_role USING (true) WITH CHECK (true);
