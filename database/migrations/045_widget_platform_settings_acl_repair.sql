-- 045_widget_platform_settings_acl_repair.sql
--
-- Security repair for installs that already applied the first revision of
-- 044_widget_platform_settings.sql, which granted anon full-table SELECT and
-- (re)created `get_widget_platform_settings()` as `to_jsonb(s.*)`. That row
-- contains secrets (alert_webhook_secret) and admin-only metadata
-- (alert_webhook_url, admin_notes, updated_by).
--
-- Functional behaviour of 044 (table, singleton index, seed row, backend
-- self-heal) is intentionally left untouched.
--
-- Idempotent: safe to re-run.

-- 1. Remove anon full-table access.
DROP POLICY IF EXISTS "Anon can read widget platform settings" ON public.widget_platform_settings;
REVOKE ALL ON public.widget_platform_settings FROM anon;

-- Authenticated dashboards keep read access; writes stay service_role only.
GRANT SELECT ON public.widget_platform_settings TO authenticated;
GRANT ALL    ON public.widget_platform_settings TO service_role;

ALTER TABLE public.widget_platform_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated can read widget platform settings" ON public.widget_platform_settings;
CREATE POLICY "Authenticated can read widget platform settings"
  ON public.widget_platform_settings FOR SELECT TO authenticated USING (true);

-- 2. Replace the unsafe getter with a sanitized allowlist.
--    MUST NOT use to_jsonb(s.*).
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

-- 3. Explicit EXECUTE privileges (PostgreSQL grants PUBLIC EXECUTE by default).
REVOKE ALL ON FUNCTION public.get_widget_platform_settings() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_widget_platform_settings() TO anon;
GRANT EXECUTE ON FUNCTION public.get_widget_platform_settings() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_widget_platform_settings() TO service_role;
