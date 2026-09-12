-- Migration: 164_channel_oauth_states.sql
--
-- Generic OAuth2 CSRF-state table for channel plugins that connect via a
-- browser redirect flow instead of a pasted token (Gmail now; Yahoo Mail in
-- a later phase — both are OAuth2, unlike Telegram/WhatsApp/Instagram/X's
-- paste-a-credential connect). Mirrors seo_gsc_oauth_states'
-- (047_seo_gsc_insights.sql-family) shape exactly, generalized with a
-- `provider` column so one table serves every OAuth2 channel provider
-- instead of duplicating it per provider.
--
-- One row per in-flight consent attempt: minted by the `/oauth/start` route,
-- consumed exactly once by the matching `/oauth/callback` route (a redirect
-- Google's own OAuth server controls, so it cannot carry the workspace in
-- its path — the workspace instead travels inside this signed, single-use
-- token). Short TTL, service-role only, never read by a browser directly.

CREATE TABLE IF NOT EXISTS public.channel_oauth_states (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider        text NOT NULL CHECK (provider IN ('gmail', 'yahoo')),
  token           text NOT NULL,
  workspace_id    uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  installation_id uuid NOT NULL REFERENCES public.workspace_plugin_installations(id) ON DELETE CASCADE,
  initiated_by    uuid,
  consumed_at     timestamptz,
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_oauth_states_token ON public.channel_oauth_states (token);
CREATE INDEX IF NOT EXISTS idx_channel_oauth_states_expiry ON public.channel_oauth_states (expires_at);

ALTER TABLE public.channel_oauth_states ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.channel_oauth_states FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.channel_oauth_states TO service_role;
