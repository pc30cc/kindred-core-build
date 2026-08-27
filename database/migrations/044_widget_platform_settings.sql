-- 044_widget_platform_settings.sql
--
-- Self-host parity: the admin "Widget settings" page reads the singleton
-- `widget_platform_settings` row through the first-party backend. The
-- self-host chain never created this table, so fresh installs showed
-- "No platform widget settings row found. Please re-run the migration."
--
-- Idempotent: safe to re-run, safe on installs where the table already
-- exists (hosted chain) — only missing columns / the seed row are added.

CREATE TABLE IF NOT EXISTS public.widget_platform_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Pre-chat field policies
  prechat_name_policy  text NOT NULL DEFAULT 'default_on',
  prechat_email_policy text NOT NULL DEFAULT 'default_on',
  prechat_phone_policy text NOT NULL DEFAULT 'default_off',

  -- Deployment defaults
  default_allow_subdomains boolean NOT NULL DEFAULT true,
  max_allowed_domains_per_workspace integer NOT NULL DEFAULT 10,
  enforce_domain_validation boolean NOT NULL DEFAULT true,
  default_debug_mode boolean NOT NULL DEFAULT false,

  -- Feature locks
  force_chat_enabled     text NOT NULL DEFAULT 'allow',
  force_kb_enabled       text NOT NULL DEFAULT 'allow',
  force_visitor_tracking text NOT NULL DEFAULT 'allow',

  -- Limits
  max_message_length integer NOT NULL DEFAULT 5000,
  rate_limit_messages_per_minute integer NOT NULL DEFAULT 20,

  admin_notes text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,

  CONSTRAINT prechat_name_policy_check  CHECK (prechat_name_policy  IN ('force_on','force_off','default_on','default_off')),
  CONSTRAINT prechat_email_policy_check CHECK (prechat_email_policy IN ('force_on','force_off','default_on','default_off')),
  CONSTRAINT prechat_phone_policy_check CHECK (prechat_phone_policy IN ('force_on','force_off','default_on','default_off')),
  CONSTRAINT force_chat_check    CHECK (force_chat_enabled     IN ('allow','force_on','force_off')),
  CONSTRAINT force_kb_check      CHECK (force_kb_enabled       IN ('allow','force_on','force_off')),
  CONSTRAINT force_visitor_check CHECK (force_visitor_tracking IN ('allow','force_on','force_off'))
);

-- Deployment URLs / embed snippet / welcome message
ALTER TABLE public.widget_platform_settings
  ADD COLUMN IF NOT EXISTS widget_loader_base_url text,
  ADD COLUMN IF NOT EXISTS widget_asset_base_url  text,
  ADD COLUMN IF NOT EXISTS widget_public_base_url text,
  ADD COLUMN IF NOT EXISTS widget_api_base_url    text,
  ADD COLUMN IF NOT EXISTS embed_header_comment   text,
  ADD COLUMN IF NOT EXISTS embed_footer_comment   text,
  ADD COLUMN IF NOT EXISTS default_welcome_message text NOT NULL DEFAULT 'Hello! How can we help you?';

-- Phase 1 / 2 runtime hardening
ALTER TABLE public.widget_platform_settings
  ADD COLUMN IF NOT EXISTS typing_rate_limit_enabled   boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS typing_rate_limit_window_ms integer NOT NULL DEFAULT 2000,
  ADD COLUMN IF NOT EXISTS typing_rate_limit_max_events integer NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS realtime_stale_resubscribe_guard_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS realtime_reconnect_jitter_pct integer NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS realtime_token_ttl_seconds    integer NOT NULL DEFAULT 1800,
  ADD COLUMN IF NOT EXISTS realtime_idle_disposal_ms     integer NOT NULL DEFAULT 60000,
  ADD COLUMN IF NOT EXISTS realtime_pending_max          integer NOT NULL DEFAULT 256,
  ADD COLUMN IF NOT EXISTS realtime_message_dedupe_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS realtime_message_dedupe_window  integer NOT NULL DEFAULT 200;

-- Phase 3 observability / alerting
ALTER TABLE public.widget_platform_settings
  ADD COLUMN IF NOT EXISTS observability_metrics_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS observability_structured_logs_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS observability_log_level text NOT NULL DEFAULT 'info',
  ADD COLUMN IF NOT EXISTS alerting_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS alert_webhook_url text,
  ADD COLUMN IF NOT EXISTS alert_webhook_secret text,
  ADD COLUMN IF NOT EXISTS perf_memory_budget_mb integer NOT NULL DEFAULT 512;

-- Singleton guarantee
CREATE UNIQUE INDEX IF NOT EXISTS widget_platform_settings_singleton
  ON public.widget_platform_settings ((true));

-- updated_at touch trigger
CREATE OR REPLACE FUNCTION public.widget_platform_settings_touch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_widget_platform_settings_touch ON public.widget_platform_settings;
CREATE TRIGGER trg_widget_platform_settings_touch
  BEFORE UPDATE ON public.widget_platform_settings
  FOR EACH ROW EXECUTE FUNCTION public.widget_platform_settings_touch();

-- Grants: this row holds secrets (alert_webhook_secret) and admin-only
-- metadata (admin_notes, alert_webhook_url, updated_by). NO anon access.
-- All reads/writes go through the first-party backend with service_role.
REVOKE ALL   ON public.widget_platform_settings FROM anon;
GRANT SELECT ON public.widget_platform_settings TO authenticated;
GRANT ALL    ON public.widget_platform_settings TO service_role;

ALTER TABLE public.widget_platform_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated can read widget platform settings" ON public.widget_platform_settings;
CREATE POLICY "Authenticated can read widget platform settings"
  ON public.widget_platform_settings FOR SELECT TO authenticated USING (true);

-- Never expose the full row to anon.
DROP POLICY IF EXISTS "Anon can read widget platform settings" ON public.widget_platform_settings;

-- Seed the singleton row (no-op when one already exists).
INSERT INTO public.widget_platform_settings DEFAULT VALUES
ON CONFLICT DO NOTHING;

-- Helper RPC used by widget runtime paths.
-- SANITIZED: explicit allowlist of non-secret runtime fields only.
-- MUST NOT use to_jsonb(s.*) — the row contains alert_webhook_secret.
CREATE OR REPLACE FUNCTION public.get_widget_platform_settings()
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'max_message_length', s.max_message_length,
    'rate_limit_messages_per_minute', s.rate_limit_messages_per_minute,
    'default_welcome_message', s.default_welcome_message,
    'realtime_reconnect_jitter_pct', s.realtime_reconnect_jitter_pct,
    'realtime_pending_max', s.realtime_pending_max,
    'realtime_message_dedupe_enabled', s.realtime_message_dedupe_enabled,
    'realtime_message_dedupe_window', s.realtime_message_dedupe_window
  )
  FROM public.widget_platform_settings s
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.get_widget_platform_settings() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_widget_platform_settings() TO anon;
GRANT EXECUTE ON FUNCTION public.get_widget_platform_settings() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_widget_platform_settings() TO service_role;

