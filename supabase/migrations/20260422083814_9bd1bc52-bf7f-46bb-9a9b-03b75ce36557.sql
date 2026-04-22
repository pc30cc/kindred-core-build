-- Phase 2 — widget_platform_settings: add columns for transport hardening
-- (reconnect jitter, JWT TTL, memory cleanup, message dedupe).
ALTER TABLE public.widget_platform_settings
  ADD COLUMN IF NOT EXISTS realtime_reconnect_jitter_pct integer NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS realtime_token_ttl_seconds integer NOT NULL DEFAULT 1800,
  ADD COLUMN IF NOT EXISTS realtime_idle_disposal_ms integer NOT NULL DEFAULT 60000,
  ADD COLUMN IF NOT EXISTS realtime_pending_max integer NOT NULL DEFAULT 256,
  ADD COLUMN IF NOT EXISTS realtime_message_dedupe_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS realtime_message_dedupe_window integer NOT NULL DEFAULT 200;

-- Replace the Phase 1 validation trigger with a Phase 2 superset that
-- preserves the existing checks AND clamps the new Phase 2 columns.
CREATE OR REPLACE FUNCTION public.widget_platform_settings_validate_phase1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Phase 1 — typing rate limit
  IF NEW.typing_rate_limit_window_ms < 250 OR NEW.typing_rate_limit_window_ms > 60000 THEN
    RAISE EXCEPTION 'typing_rate_limit_window_ms must be between 250 and 60000';
  END IF;
  IF NEW.typing_rate_limit_max_events < 1 OR NEW.typing_rate_limit_max_events > 100 THEN
    RAISE EXCEPTION 'typing_rate_limit_max_events must be between 1 and 100';
  END IF;

  -- Phase 2 — reconnect jitter (0–50%)
  IF NEW.realtime_reconnect_jitter_pct < 0 OR NEW.realtime_reconnect_jitter_pct > 50 THEN
    RAISE EXCEPTION 'realtime_reconnect_jitter_pct must be between 0 and 50';
  END IF;
  -- Phase 2 — JWT TTL (5 min – 2 h)
  IF NEW.realtime_token_ttl_seconds < 300 OR NEW.realtime_token_ttl_seconds > 7200 THEN
    RAISE EXCEPTION 'realtime_token_ttl_seconds must be between 300 and 7200';
  END IF;
  -- Phase 2 — idle disposal (10s – 30min)
  IF NEW.realtime_idle_disposal_ms < 10000 OR NEW.realtime_idle_disposal_ms > 1800000 THEN
    RAISE EXCEPTION 'realtime_idle_disposal_ms must be between 10000 and 1800000';
  END IF;
  -- Phase 2 — pending callback hard cap (32–4096)
  IF NEW.realtime_pending_max < 32 OR NEW.realtime_pending_max > 4096 THEN
    RAISE EXCEPTION 'realtime_pending_max must be between 32 and 4096';
  END IF;
  -- Phase 2 — message dedupe ring window (16–4096)
  IF NEW.realtime_message_dedupe_window < 16 OR NEW.realtime_message_dedupe_window > 4096 THEN
    RAISE EXCEPTION 'realtime_message_dedupe_window must be between 16 and 4096';
  END IF;

  RETURN NEW;
END;
$$;