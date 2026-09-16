-- 194 — Stop the autovacuum storm on the singleton lease/heartbeat tables.
--
-- Disk IO finding. Postgres decides a table needs vacuuming when
--
--     n_dead_tup > autovacuum_vacuum_threshold
--                  + autovacuum_vacuum_scale_factor * n_live_tup
--
-- which with the defaults (50 and 0.2) is tuned for tables where 20% of the
-- rows turning over is a meaningful event. On a table holding THREE rows the
-- scale factor contributes 0.6, so the trigger point is effectively the bare
-- floor of 50 dead tuples — and these tables are written thousands of times
-- a day by machinery, not by users.
--
-- Measured over 63 days in production:
--
--   observability_ticker_lease    3 live rows, 64 kB  -> 2,931 autovacuums (46/day)
--   channel_worker_heartbeats     1 live row,  80 kB  -> 2,029 autovacuums (32/day)
--   billing_v2_worker_health      5 live rows, 64 kB  ->   530 autovacuums  (8/day)
--   operator_presence_live        4 live rows, 56 kB  ->   511 autovacuums  (8/day)
--   ai_billing_recovery_lease     1 live row,  64 kB  ->   215 autovacuums  (3/day)
--
-- ~98 vacuum passes a day, plus a comparable number of ANALYZE passes, on
-- about 300 kB of data in total. Each pass is a real unit of disk work — it
-- reads the table and its indexes, writes back cleaned pages, updates the
-- visibility map and emits its own WAL — and none of it reclaims anything
-- that matters, because these tables cannot grow: they hold exactly one row
-- per lease, per worker or per node.
--
-- ANALYZE is even less useful here. Re-sampling statistics for a three-row
-- table produces the same plan it produced last time; 2,935 autoanalyzes of
-- observability_ticker_lease taught the planner nothing it did not already
-- know after the first one.
--
-- So: a flat threshold, no scale factor. Vacuum when there is genuinely a
-- meaningful pile of dead tuples, not when a counter ticks past 50.
--
-- This is SAFE with respect to transaction-ID wraparound, which is the one
-- thing a vacuum here must never stop doing. Anti-wraparound vacuums are
-- governed by autovacuum_freeze_max_age, a completely separate trigger that
-- these settings do not touch — a table that goes a long time without a
-- dead-tuple vacuum still gets frozen on schedule.
--
-- fillfactor leaves free space on each page for update chains to stay on the
-- page they started on. That is what makes a HOT update possible at all, and
-- with migration 193 removing the index that was forcing heartbeat updates
-- off the HOT path, it is worth giving them the room to actually take it:
-- a HOT update writes no new index tuples and its dead predecessor can be
-- reclaimed in-page by the opportunistic pruner, without any vacuum at all.
--
-- Only tables that are structurally incapable of growing are listed. Tables
-- that accumulate rows over time (alert_events, slo_breach_events,
-- visitor_sessions) keep the defaults on purpose: for those, a stale
-- threshold really would degrade planning as the row count climbs.

DO $tune$
DECLARE
  _tbl text;
  _tables text[] := ARRAY[
    'observability_ticker_lease',
    'channel_worker_heartbeats',
    'billing_v2_worker_health',
    'operator_presence_live',
    'ai_billing_recovery_lease',
    'realtime_failover_state'
  ];
BEGIN
  FOREACH _tbl IN ARRAY _tables LOOP
    -- The self-host and hosted chains do not carry an identical table set at
    -- every point in their history, so each one is applied only if present.
    IF to_regclass('public.' || _tbl) IS NULL THEN
      RAISE NOTICE 'skipping %: not present in this chain', _tbl;
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TABLE public.%I SET ('
      || 'autovacuum_vacuum_threshold = 1000, '
      || 'autovacuum_vacuum_scale_factor = 0, '
      || 'autovacuum_analyze_threshold = 1000, '
      || 'autovacuum_analyze_scale_factor = 0, '
      || 'fillfactor = 70'
      || ')',
      _tbl
    );
  END LOOP;
END
$tune$;
