/**
 * Live Monitoring collector — shared bounded-size constants.
 *
 * Every collector submodule pre-populates its Maps from these fixed key
 * sets (or hard-caps entry count with FIFO eviction) so memory usage never
 * grows with traffic volume, workspace count, or conversation count.
 */

export const MINUTE_SLOTS = 60;
export const HOURLY_SLOTS_REALTIME = 168; // 7 days
export const HOURLY_SLOTS_PERF = 24; // 24h — no 7d perf UI exists today
export const RECENT_EVENTS_CAPACITY = 1000;
export const PROCESS_TREND_CAPACITY = 120; // 2h at 60s cadence
export const RECONNECT_TTL_MAP_MAX = 5000;

// driver/source are open strings (e.g. call provider names), not a fixed
// enum — these are defensive per-bucket caps, not expected to ever trigger
// given the small number of distinct values actually used today.
export const MAX_DRIVER_KEYS_PER_BUCKET = 20;
export const MAX_SOURCE_KEYS_PER_BUCKET = 10;

// Defensive cap on distinct (route_group, method) keys — in practice there
// are exactly 5, one per perfHttpMiddleware() call site, all compile-time
// literals (never derived from request input).
export const MAX_PERF_ROUTE_KEYS = 50;

/**
 * Every metric name this server emits into Live Monitoring today —
 * server/services/observability/metrics.ts `emitMetric()` callers (see
 * server/routes/realtime.ts, server/routes/widget.ts) and
 * server/services/calls/metrics.ts's `CallMetricName` union. Anything not
 * in this set is dropped by the collector rather than silently growing an
 * unbounded Map — keep this list in sync with those call sites.
 */
export const KNOWN_REALTIME_METRICS: ReadonlySet<string> = new Set([
  // realtime.* — server/routes/realtime.ts
  'realtime.reconnect_attempt',
  'realtime.token_minted',
  'realtime.token_refresh_failed',
  'realtime.subscribe_failed',
  'realtime.channel_ownership_reject',
  'realtime.fallback_engaged',
  'realtime.ws_error',
  'realtime.policy_poll', // reconnect-labeling fix — see reconnectClassifier.ts
  // widget.* — server/routes/widget.ts
  'widget.typing_rate_limited',
  // call.* — server/services/calls/metrics.ts CallMetricName union
  'call.create.success',
  'call.create.failure',
  'call.token.success',
  'call.token.failure',
  'call.join.success',
  'call.join.failure',
  'call.setup.latency',
  'call.recording.start.success',
  'call.recording.start.failure',
  'call.recording.stop.success',
  'call.recording.stop.failure',
  'call.active.count',
  'call.webhook.received',
  'call.webhook.dedup',
  'call.provider.not_ready',
  'call.turn.missing',
]);

// Route groups actually instrumented by perfHttpMiddleware
// (server/services/observability/perf.ts / collector/perfCollector.ts).
export const PERF_ROUTE_GROUPS: ReadonlyArray<string> = [
  'realtime.operator_connect',
  'realtime.subscribe',
  'widget.bootstrap',
  'widget.session_refresh',
  'widget.action',
];

// Histogram bucket upper bounds (ms), moved verbatim from the pre-migration
// server/routes/adminPerf.ts so percentile approximation stays numerically
// identical to the original design.
export const BUCKET_EDGES_MS: ReadonlyArray<{ key: string; upper: number }> = [
  { key: '5', upper: 5 },
  { key: '10', upper: 10 },
  { key: '25', upper: 25 },
  { key: '50', upper: 50 },
  { key: '100', upper: 100 },
  { key: '200', upper: 200 },
  { key: '400', upper: 400 },
  { key: '800', upper: 800 },
  { key: '1500', upper: 1500 },
  { key: '3000', upper: 3000 },
  { key: '6000', upper: 6000 },
  { key: '12000', upper: 12000 },
  { key: '30000', upper: 30000 },
  { key: 'inf', upper: 60000 }, // upper sentinel for percentile interpolation
];
