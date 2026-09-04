-- Live Monitoring migration (step A of 2): drop the SQL functions that read
-- the raw telemetry tables. Safe to run now — nothing calls these RPCs
-- anymore:
--   • evaluate_alert_rules() was replaced by the TypeScript
--     evaluateAlertRulesInMemory() (server/services/observability/alertEvaluator.ts),
--     which reads the bounded in-memory Live Monitoring collector instead of
--     these tables, and still writes alert_events in the identical shape.
--   • perf_metrics_rollup_and_prune() / realtime_metrics_rollup_and_prune()
--     had no caller left — the old rollup ticker (server/services/observability/rollupTicker.ts)
--     was deleted; the collector's self-rolling ring buffers age out data on
--     every write, so no rollup/prune job is needed at all.
--
-- Step B (125_observability_drop_raw_tables.sql) drops the underlying tables
-- and must land after this one.
DROP FUNCTION IF EXISTS public.evaluate_alert_rules();
DROP FUNCTION IF EXISTS public.perf_metrics_rollup_and_prune();
DROP FUNCTION IF EXISTS public.realtime_metrics_rollup_and_prune();
