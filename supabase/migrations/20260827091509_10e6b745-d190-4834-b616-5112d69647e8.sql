REVOKE ALL ON public.widget_platform_settings FROM anon;
REVOKE ALL ON public.widget_platform_settings FROM authenticated;
GRANT ALL ON public.widget_platform_settings TO service_role;

ALTER TABLE public.widget_platform_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anon can read widget platform settings" ON public.widget_platform_settings;
DROP POLICY IF EXISTS "Authenticated can read widget platform settings" ON public.widget_platform_settings;

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