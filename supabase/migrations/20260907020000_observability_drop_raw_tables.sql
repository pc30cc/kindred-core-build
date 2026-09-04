-- Live Monitoring migration (step B of 2): drop the raw high-frequency
-- telemetry tables and their now-redundant hourly rollups. Must run after
-- 124_observability_drop_raw_functions.sql (evaluate_alert_rules() and the
-- two rollup_and_prune() functions, which selected from these tables, are
-- already gone by this point).
--
-- Pre-conditions verified before this migration was written (see the LiveMon
-- final report for the full audit): zero remaining application writers or
-- readers of these 5 tables — server/services/observability/metrics.ts and
-- perf.ts write only to the bounded in-memory Live Monitoring collector
-- (server/services/observability/collector/), server/routes/adminMetrics.ts,
-- adminPerf.ts and server/services/realtime/failoverHealth.ts read only from
-- that same collector, and no VIEW, TRIGGER, or FOREIGN KEY in any migration
-- references these tables outside their own creation files.
--
-- realtime_metric_events / realtime_metric_hourly: created by
--   supabase/migrations/20260422091324_144e13b8-9dbe-443a-8a7a-506e04070baa.sql
-- perf_request_samples / perf_request_hourly / perf_process_samples: created by
--   supabase/migrations/20260422100850_d3a558e7-0489-4f43-82fd-b47a62b7412f.sql
--
-- This does not touch alert_rules or alert_events — those remain normal,
-- persisted Postgres tables (admin-configured rules and the historical alert
-- audit trail), unaffected by this migration.
DROP TABLE IF EXISTS public.realtime_metric_events;
DROP TABLE IF EXISTS public.realtime_metric_hourly;
DROP TABLE IF EXISTS public.perf_request_samples;
DROP TABLE IF EXISTS public.perf_request_hourly;
DROP TABLE IF EXISTS public.perf_process_samples;
