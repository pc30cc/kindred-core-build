-- Phase 1 hardening — add platform-level toggles for realtime/security/flood-protection
-- These are global, super-admin-only; future per-workspace overrides can layer on top.
ALTER TABLE public.widget_platform_settings
  ADD COLUMN IF NOT EXISTS typing_rate_limit_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS typing_rate_limit_window_ms integer NOT NULL DEFAULT 2000,
  ADD COLUMN IF NOT EXISTS typing_rate_limit_max_events integer NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS realtime_stale_resubscribe_guard_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.widget_platform_settings.typing_rate_limit_enabled IS 'Phase 1.1 — when true, /api/widget/action typing events are rate-limited per conversation. Overflow events are silently dropped.';
COMMENT ON COLUMN public.widget_platform_settings.typing_rate_limit_window_ms IS 'Phase 1.1 — typing rate limit window in milliseconds. Default 2000ms.';
COMMENT ON COLUMN public.widget_platform_settings.typing_rate_limit_max_events IS 'Phase 1.1 — max typing publishes allowed per window per conversation. Default 2.';
COMMENT ON COLUMN public.widget_platform_settings.realtime_stale_resubscribe_guard_enabled IS 'Phase 1.3 — when true, resubscribeAll loops abort immediately if the socket dies / generation rolls. Always-on diagnostic flag.';

-- Validation triggers to keep window/max-events within sane runtime bounds.
CREATE OR REPLACE FUNCTION public.widget_platform_settings_validate_phase1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.typing_rate_limit_window_ms < 250 OR NEW.typing_rate_limit_window_ms > 60000 THEN
    RAISE EXCEPTION 'typing_rate_limit_window_ms must be between 250 and 60000';
  END IF;
  IF NEW.typing_rate_limit_max_events < 1 OR NEW.typing_rate_limit_max_events > 100 THEN
    RAISE EXCEPTION 'typing_rate_limit_max_events must be between 1 and 100';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_widget_platform_settings_validate_phase1 ON public.widget_platform_settings;
CREATE TRIGGER trg_widget_platform_settings_validate_phase1
  BEFORE INSERT OR UPDATE ON public.widget_platform_settings
  FOR EACH ROW EXECUTE FUNCTION public.widget_platform_settings_validate_phase1();