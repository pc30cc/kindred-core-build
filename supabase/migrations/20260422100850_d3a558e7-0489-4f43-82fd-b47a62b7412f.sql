-- Phase 5A — Performance / latency observability surface (server-side only).
-- Lightweight, aggregated, admin-only. No PII, no message bodies, no IPs.

-- 1) Raw HTTP request samples (7-day retention).
--    One row per instrumented request. Bounded set of routes only.
--    duration_ms is stored as integer (millisecond precision is enough for
--    p50/p95/p99 of HTTP work).
CREATE TABLE IF NOT EXISTS public.perf_request_samples (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  route_group   text NOT NULL,         -- e.g. 'realtime.operator_connect'
  method        text NOT NULL,         -- 'GET' | 'POST' | ...
  status_group  text NOT NULL,         -- '2xx' | '3xx' | '4xx' | '5xx'
  status_code   smallint NOT NULL,
  duration_ms   integer NOT NULL,
  is_error      boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS perf_request_samples_occurred_at_idx
  ON public.perf_request_samples (occurred_at DESC);
CREATE INDEX IF NOT EXISTS perf_request_samples_route_time_idx
  ON public.perf_request_samples (route_group, occurred_at DESC);

ALTER TABLE public.perf_request_samples ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Global admins can read perf request samples"
  ON public.perf_request_samples
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Service role full access perf_request_samples"
  ON public.perf_request_samples
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 2) Hourly rollup (90-day retention).
--    Stores count, error_count, sum_ms, and the per-bucket histogram needed
--    to reconstruct approximate percentiles cheaply. Buckets are linear up
--    to 1s and log-spaced beyond that — enough granularity for p50/p95/p99
--    of HTTP responses without storing raw samples beyond 7 days.
CREATE TABLE IF NOT EXISTS public.perf_request_hourly (
  bucket_hour  timestamptz NOT NULL,
  route_group  text NOT NULL,
  method       text NOT NULL,
  status_group text NOT NULL,
  count        bigint NOT NULL DEFAULT 0,
  error_count  bigint NOT NULL DEFAULT 0,
  sum_ms       bigint NOT NULL DEFAULT 0,
  max_ms       integer NOT NULL DEFAULT 0,
  -- Histogram: jsonb mapping upper-bound (ms) → count.
  -- Bucket edges (ms): 5,10,25,50,100,200,400,800,1500,3000,6000,12000,30000,+Inf
  histogram    jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (bucket_hour, route_group, method, status_group)
);

CREATE INDEX IF NOT EXISTS perf_request_hourly_route_idx
  ON public.perf_request_hourly (route_group, bucket_hour DESC);

ALTER TABLE public.perf_request_hourly ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Global admins can read perf request hourly"
  ON public.perf_request_hourly
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Service role full access perf_request_hourly"
  ON public.perf_request_hourly
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 3) Process samples (24-hour retention).
--    Periodically sampled by the in-process ticker. Cheap; one row per minute.
CREATE TABLE IF NOT EXISTS public.perf_process_samples (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  event_loop_lag_ms numeric(10,3) NOT NULL,
  rss_bytes       bigint NOT NULL,
  heap_used_bytes bigint NOT NULL,
  heap_total_bytes bigint NOT NULL,
  uptime_seconds  bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS perf_process_samples_time_idx
  ON public.perf_process_samples (occurred_at DESC);

ALTER TABLE public.perf_process_samples ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Global admins can read perf process samples"
  ON public.perf_process_samples
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Service role full access perf_process_samples"
  ON public.perf_process_samples
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 4) Rollup + prune function. Run by the existing observability ticker.
--    Aggregates previous full hour into perf_request_hourly with a
--    pre-built histogram for percentile reconstruction. Idempotent.
CREATE OR REPLACE FUNCTION public.perf_metrics_rollup_and_prune()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rolled_up integer := 0;
  pruned_samples integer := 0;
  pruned_hourly integer := 0;
  pruned_process integer := 0;
BEGIN
  WITH hr AS (
    SELECT
      date_trunc('hour', occurred_at) AS bucket_hour,
      route_group,
      method,
      status_group,
      COUNT(*)::bigint AS c,
      COUNT(*) FILTER (WHERE is_error)::bigint AS ec,
      COALESCE(SUM(duration_ms),0)::bigint AS sum_ms,
      COALESCE(MAX(duration_ms),0)::integer AS max_ms,
      jsonb_build_object(
        '5',     COUNT(*) FILTER (WHERE duration_ms <= 5),
        '10',    COUNT(*) FILTER (WHERE duration_ms > 5    AND duration_ms <= 10),
        '25',    COUNT(*) FILTER (WHERE duration_ms > 10   AND duration_ms <= 25),
        '50',    COUNT(*) FILTER (WHERE duration_ms > 25   AND duration_ms <= 50),
        '100',   COUNT(*) FILTER (WHERE duration_ms > 50   AND duration_ms <= 100),
        '200',   COUNT(*) FILTER (WHERE duration_ms > 100  AND duration_ms <= 200),
        '400',   COUNT(*) FILTER (WHERE duration_ms > 200  AND duration_ms <= 400),
        '800',   COUNT(*) FILTER (WHERE duration_ms > 400  AND duration_ms <= 800),
        '1500',  COUNT(*) FILTER (WHERE duration_ms > 800  AND duration_ms <= 1500),
        '3000',  COUNT(*) FILTER (WHERE duration_ms > 1500 AND duration_ms <= 3000),
        '6000',  COUNT(*) FILTER (WHERE duration_ms > 3000 AND duration_ms <= 6000),
        '12000', COUNT(*) FILTER (WHERE duration_ms > 6000 AND duration_ms <= 12000),
        '30000', COUNT(*) FILTER (WHERE duration_ms > 12000 AND duration_ms <= 30000),
        'inf',   COUNT(*) FILTER (WHERE duration_ms > 30000)
      ) AS histogram
    FROM public.perf_request_samples
    WHERE occurred_at >= date_trunc('hour', now()) - interval '1 hour'
      AND occurred_at <  date_trunc('hour', now())
    GROUP BY 1,2,3,4
  )
  INSERT INTO public.perf_request_hourly
    (bucket_hour, route_group, method, status_group, count, error_count, sum_ms, max_ms, histogram)
  SELECT bucket_hour, route_group, method, status_group, c, ec, sum_ms, max_ms, histogram FROM hr
  ON CONFLICT (bucket_hour, route_group, method, status_group)
  DO UPDATE SET
    count       = EXCLUDED.count,
    error_count = EXCLUDED.error_count,
    sum_ms      = EXCLUDED.sum_ms,
    max_ms      = GREATEST(perf_request_hourly.max_ms, EXCLUDED.max_ms),
    histogram   = EXCLUDED.histogram;
  GET DIAGNOSTICS rolled_up = ROW_COUNT;

  -- Prune raw request samples older than 7 days.
  DELETE FROM public.perf_request_samples
   WHERE occurred_at < now() - interval '7 days';
  GET DIAGNOSTICS pruned_samples = ROW_COUNT;

  -- Prune hourly rollups older than 90 days.
  DELETE FROM public.perf_request_hourly
   WHERE bucket_hour < now() - interval '90 days';
  GET DIAGNOSTICS pruned_hourly = ROW_COUNT;

  -- Prune process samples older than 24 hours (high-frequency, low value beyond a day).
  DELETE FROM public.perf_process_samples
   WHERE occurred_at < now() - interval '24 hours';
  GET DIAGNOSTICS pruned_process = ROW_COUNT;

  RETURN jsonb_build_object(
    'rolled_up', rolled_up,
    'pruned_samples', pruned_samples,
    'pruned_hourly', pruned_hourly,
    'pruned_process', pruned_process,
    'ran_at', now()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.perf_metrics_rollup_and_prune() FROM public;
GRANT EXECUTE ON FUNCTION public.perf_metrics_rollup_and_prune() TO service_role;