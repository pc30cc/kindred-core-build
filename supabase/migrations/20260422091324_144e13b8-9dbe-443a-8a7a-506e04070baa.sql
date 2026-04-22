-- Phase 3 — observability / metrics surface for realtime + widget security.
-- Lightweight, aggregated, admin-only. No raw event spam, no PII.

-- 1) Raw counter events (7-day retention).
--    One row per "interesting" thing the server (or, later, a sampled
--    widget beacon) wants to count. Designed to be cheap to insert and
--    cheap to roll up. We never store message bodies, IPs, or visitor
--    identifiers here — only the metric name + dimensions.
CREATE TABLE IF NOT EXISTS public.realtime_metric_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  metric          text NOT NULL,
  -- Optional dimensions; all nullable so callers only set what's relevant.
  workspace_id    uuid NULL,
  conversation_id uuid NULL,
  driver          text NULL,    -- 'centrifugo' | 'supabase' | 'polling' | NULL
  source          text NOT NULL DEFAULT 'server', -- 'server' | 'widget' | 'operator'
  -- Free-form low-cardinality tags (e.g. {"reason":"pending_evicted_overflow"}).
  -- Strictly bounded: caller MUST keep this shape small.
  tags            jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS realtime_metric_events_occurred_at_idx
  ON public.realtime_metric_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS realtime_metric_events_metric_time_idx
  ON public.realtime_metric_events (metric, occurred_at DESC);
CREATE INDEX IF NOT EXISTS realtime_metric_events_workspace_time_idx
  ON public.realtime_metric_events (workspace_id, occurred_at DESC)
  WHERE workspace_id IS NOT NULL;

ALTER TABLE public.realtime_metric_events ENABLE ROW LEVEL SECURITY;

-- Only global admins can read raw events. Service role inserts.
CREATE POLICY "Global admins can read realtime metric events"
  ON public.realtime_metric_events
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Service role full access realtime_metric_events"
  ON public.realtime_metric_events
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 2) Hourly rollup (90-day retention).
--    Populated by a small janitor job (or on-demand by the admin page).
CREATE TABLE IF NOT EXISTS public.realtime_metric_hourly (
  bucket_hour  timestamptz NOT NULL,
  metric       text NOT NULL,
  driver       text NOT NULL DEFAULT '_all_',
  count        bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_hour, metric, driver)
);

CREATE INDEX IF NOT EXISTS realtime_metric_hourly_metric_idx
  ON public.realtime_metric_hourly (metric, bucket_hour DESC);

ALTER TABLE public.realtime_metric_hourly ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Global admins can read realtime metric hourly"
  ON public.realtime_metric_hourly
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Service role full access realtime_metric_hourly"
  ON public.realtime_metric_hourly
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 3) Janitor: roll up the previous full hour and prune retention windows.
--    Designed to be called by a cron / periodic worker. Idempotent —
--    re-running for the same hour upserts the same totals.
CREATE OR REPLACE FUNCTION public.realtime_metrics_rollup_and_prune()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rolled_up integer := 0;
  pruned_raw integer := 0;
  pruned_hourly integer := 0;
BEGIN
  -- Roll up the *previous* full hour (so we never double-count the
  -- currently-filling bucket).
  WITH hr AS (
    SELECT
      date_trunc('hour', occurred_at) AS bucket_hour,
      metric,
      COALESCE(driver, '_all_')       AS driver,
      COUNT(*)::bigint                AS c
    FROM public.realtime_metric_events
    WHERE occurred_at >= date_trunc('hour', now()) - interval '1 hour'
      AND occurred_at <  date_trunc('hour', now())
    GROUP BY 1,2,3
  )
  INSERT INTO public.realtime_metric_hourly (bucket_hour, metric, driver, count)
  SELECT bucket_hour, metric, driver, c FROM hr
  ON CONFLICT (bucket_hour, metric, driver)
  DO UPDATE SET count = EXCLUDED.count;
  GET DIAGNOSTICS rolled_up = ROW_COUNT;

  -- Prune raw events older than 7 days.
  DELETE FROM public.realtime_metric_events
   WHERE occurred_at < now() - interval '7 days';
  GET DIAGNOSTICS pruned_raw = ROW_COUNT;

  -- Prune hourly rollups older than 90 days.
  DELETE FROM public.realtime_metric_hourly
   WHERE bucket_hour < now() - interval '90 days';
  GET DIAGNOSTICS pruned_hourly = ROW_COUNT;

  RETURN jsonb_build_object(
    'rolled_up', rolled_up,
    'pruned_raw', pruned_raw,
    'pruned_hourly', pruned_hourly,
    'ran_at', now()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.realtime_metrics_rollup_and_prune() FROM public;
GRANT EXECUTE ON FUNCTION public.realtime_metrics_rollup_and_prune() TO service_role;

-- 4) Phase 3 settings on widget_platform_settings.
ALTER TABLE public.widget_platform_settings
  ADD COLUMN IF NOT EXISTS observability_metrics_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS observability_structured_logs_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS observability_log_level text NOT NULL DEFAULT 'info';

-- Replace the Phase 1+2 validation trigger with a Phase 3 superset.
CREATE OR REPLACE FUNCTION public.widget_platform_settings_validate_phase1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Phase 1
  IF NEW.typing_rate_limit_window_ms < 250 OR NEW.typing_rate_limit_window_ms > 60000 THEN
    RAISE EXCEPTION 'typing_rate_limit_window_ms must be between 250 and 60000';
  END IF;
  IF NEW.typing_rate_limit_max_events < 1 OR NEW.typing_rate_limit_max_events > 100 THEN
    RAISE EXCEPTION 'typing_rate_limit_max_events must be between 1 and 100';
  END IF;

  -- Phase 2
  IF NEW.realtime_reconnect_jitter_pct < 0 OR NEW.realtime_reconnect_jitter_pct > 50 THEN
    RAISE EXCEPTION 'realtime_reconnect_jitter_pct must be between 0 and 50';
  END IF;
  IF NEW.realtime_token_ttl_seconds < 300 OR NEW.realtime_token_ttl_seconds > 7200 THEN
    RAISE EXCEPTION 'realtime_token_ttl_seconds must be between 300 and 7200';
  END IF;
  IF NEW.realtime_idle_disposal_ms < 10000 OR NEW.realtime_idle_disposal_ms > 1800000 THEN
    RAISE EXCEPTION 'realtime_idle_disposal_ms must be between 10000 and 1800000';
  END IF;
  IF NEW.realtime_pending_max < 32 OR NEW.realtime_pending_max > 4096 THEN
    RAISE EXCEPTION 'realtime_pending_max must be between 32 and 4096';
  END IF;
  IF NEW.realtime_message_dedupe_window < 16 OR NEW.realtime_message_dedupe_window > 4096 THEN
    RAISE EXCEPTION 'realtime_message_dedupe_window must be between 16 and 4096';
  END IF;

  -- Phase 3
  IF NEW.observability_log_level NOT IN ('debug','info','warn','error') THEN
    RAISE EXCEPTION 'observability_log_level must be one of debug|info|warn|error';
  END IF;

  RETURN NEW;
END;
$$;
