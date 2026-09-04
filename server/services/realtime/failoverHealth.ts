/**
 * Phase 6B — Per-provider health evaluator for the realtime failover engine.
 *
 * Scores each candidate provider as 'healthy' | 'degraded' | 'unhealthy' over
 * the configured `realtime_failover_health_window_seconds` window using
 * signals already available to the platform:
 *
 *   • centrifugo
 *       - direct CentrifugoDriver.health() probe (down → unhealthy)
 *       - error rate from realtime_metric_events (subscribe_failed,
 *         token_refresh_failed) over the window
 *       - p95 latency from perf_request_samples on the realtime route
 *         groups (operator_connect, subscribe)
 *
 *   • supabase_realtime
 *       - we don't run a server-side probe today, so we rely solely on
 *         publish-side error rates if/when supabase emits any failure
 *         metrics. Today this provider stays 'healthy' unless a future
 *         signal demotes it. Latency signal is reused from the same
 *         realtime route groups when supabase is the active publisher.
 *
 *   • polling_builtin
 *       - always 'healthy' — last-resort fallback by definition.
 *
 * Hard rules:
 *   • Never throws. On any error, returns 'unknown' for that provider
 *     (treated as healthy by the engine to fail-open).
 *   • Read-only. Does not mutate any tables.
 *   • Bounded query sizes (limit 5_000) — the metric tables already keep
 *     a short retention by the rollup ticker.
 */

import type { ServerConfig } from '../../config.js';
import {
  getCentrifugoDriver,
  loadRealtimeConfig,
} from './index.js';
import type { RealtimeProviderId, RealtimeFailoverPolicy } from './controlPlane.js';
import { getMonitoringCollector } from '../observability/collector/index.js';

export type ProviderHealthStatus =
  | 'healthy'
  | 'degraded'
  | 'unhealthy'
  | 'unknown';

export interface ProviderHealthSignal {
  provider: RealtimeProviderId;
  status: ProviderHealthStatus;
  /** 0–1 ratio over window. null if no samples. */
  error_rate: number | null;
  /** p95 in ms over window. null if no samples. */
  p95_latency_ms: number | null;
  sample_size: number;
  reason: string;
  checked_at: number;
}

export interface HealthSnapshot {
  window_seconds: number;
  evaluated_at: number;
  providers: Record<RealtimeProviderId, ProviderHealthSignal>;
}

const REALTIME_ERROR_METRICS = new Set<string>([
  'realtime.subscribe_failed',
  'realtime.token_refresh_failed',
  'realtime.channel_ownership_reject',
]);

const REALTIME_TOTAL_METRICS = new Set<string>([
  'realtime.subscribe_failed',
  'realtime.token_refresh_failed',
  'realtime.channel_ownership_reject',
  'realtime.token_minted',
  'realtime.reconnect_attempt',
]);

const REALTIME_PERF_ROUTE_GROUPS = [
  'realtime.operator_connect',
  'realtime.subscribe',
];

/**
 * Classify a provider's health from its observed error rate + p95 latency
 * against the configured thresholds.
 */
function classify(
  errorRate: number | null,
  p95: number | null,
  sample: number,
  policy: RealtimeFailoverPolicy,
): { status: ProviderHealthStatus; reason: string } {
  // Need a minimum sample to make a non-trivial call. Below that, we can
  // only rule on errorRate=null (no signal) → 'unknown'.
  const MIN_SAMPLE = 20;
  if (sample < MIN_SAMPLE && errorRate === null && p95 === null) {
    return { status: 'unknown', reason: 'insufficient_samples' };
  }
  // Hard unhealthy thresholds.
  if (errorRate !== null && errorRate >= policy.realtime_failover_error_threshold * 2) {
    return {
      status: 'unhealthy',
      reason: `error_rate=${(errorRate * 100).toFixed(1)}% over 2× threshold`,
    };
  }
  if (p95 !== null && p95 >= policy.realtime_failover_latency_threshold_ms * 2) {
    return {
      status: 'unhealthy',
      reason: `p95=${p95}ms over 2× latency threshold`,
    };
  }
  // Soft degraded thresholds.
  if (errorRate !== null && errorRate >= policy.realtime_failover_error_threshold) {
    return {
      status: 'degraded',
      reason: `error_rate=${(errorRate * 100).toFixed(1)}% over threshold`,
    };
  }
  if (p95 !== null && p95 >= policy.realtime_failover_latency_threshold_ms) {
    return {
      status: 'degraded',
      reason: `p95=${p95}ms over latency threshold`,
    };
  }
  return { status: 'healthy', reason: 'within thresholds' };
}

function windowSecondsFromSince(sinceIso: string): number {
  return Math.max(1, Math.round((Date.now() - new Date(sinceIso).getTime()) / 1000));
}

function fetchRealtimeMetricRates(
  driver: 'centrifugo' | 'supabase' | null,
  sinceIso: string,
): { errors: number; total: number } {
  try {
    const collector = getMonitoringCollector();
    const windowSeconds = windowSecondsFromSince(sinceIso);
    let errors = 0;
    let total = 0;
    for (const metric of REALTIME_TOTAL_METRICS) {
      const count = driver
        ? collector.queryRealtimeCountByDriver(metric, driver, windowSeconds)
        : collector.queryRealtimeCount(metric, windowSeconds);
      total += count;
      if (REALTIME_ERROR_METRICS.has(metric)) errors += count;
    }
    return { errors, total };
  } catch {
    return { errors: 0, total: 0 };
  }
}

function fetchRealtimeP95(sinceIso: string): { p95: number | null; sample: number } {
  try {
    const windowSeconds = windowSecondsFromSince(sinceIso);
    return getMonitoringCollector().queryPerfP95ForRouteGroups(REALTIME_PERF_ROUTE_GROUPS, windowSeconds);
  } catch {
    return { p95: null, sample: 0 };
  }
}

async function evaluateCentrifugo(
  config: ServerConfig,
  policy: RealtimeFailoverPolicy,
  sinceIso: string,
): Promise<ProviderHealthSignal> {
  // 1. Direct probe.
  let probeStatus: 'healthy' | 'degraded' | 'down' | 'unknown' = 'unknown';
  let probeMessage = '';
  try {
    const driver = await getCentrifugoDriver(config);
    if (driver) {
      const h = await driver.health();
      probeStatus = h.status;
      probeMessage = h.message;
    } else {
      // Not configured at all → unhealthy.
      return {
        provider: 'centrifugo',
        status: 'unhealthy',
        error_rate: null,
        p95_latency_ms: null,
        sample_size: 0,
        reason: 'centrifugo_not_configured',
        checked_at: Date.now(),
      };
    }
  } catch (err: any) {
    probeStatus = 'down';
    probeMessage = err?.message || 'probe_failed';
  }

  if (probeStatus === 'down') {
    return {
      provider: 'centrifugo',
      status: 'unhealthy',
      error_rate: null,
      p95_latency_ms: null,
      sample_size: 0,
      reason: `probe_down: ${probeMessage}`,
      checked_at: Date.now(),
    };
  }

  // 2. Aggregate metrics + perf — synchronous in-memory collector reads.
  const { errors, total } = fetchRealtimeMetricRates('centrifugo', sinceIso);
  const { p95, sample } = fetchRealtimeP95(sinceIso);
  const errorRate = total > 0 ? errors / total : null;
  const sampleSize = Math.max(total, sample);
  const cls = classify(errorRate, p95, sampleSize, policy);
  // Probe 'degraded' should never improve the picture.
  const status: ProviderHealthStatus =
    probeStatus === 'degraded' && cls.status === 'healthy' ? 'degraded' : cls.status;
  return {
    provider: 'centrifugo',
    status,
    error_rate: errorRate,
    p95_latency_ms: p95,
    sample_size: sampleSize,
    reason:
      probeStatus === 'degraded'
        ? `${cls.reason}; probe_degraded: ${probeMessage}`
        : cls.reason,
    checked_at: Date.now(),
  };
}

async function evaluateSupabase(
  config: ServerConfig,
  policy: RealtimeFailoverPolicy,
  sinceIso: string,
): Promise<ProviderHealthSignal> {
  // No direct probe — Supabase Realtime runs in the managed project.
  // Use error metrics tagged with driver=supabase and the same realtime
  // perf samples (which apply to whichever provider is active).
  const { errors, total } = fetchRealtimeMetricRates('supabase', sinceIso);
  const { p95, sample } = fetchRealtimeP95(sinceIso);
  const errorRate = total > 0 ? errors / total : null;
  const sampleSize = Math.max(total, sample);
  const cls = classify(errorRate, p95, sampleSize, policy);
  return {
    provider: 'supabase_realtime',
    status: cls.status,
    error_rate: errorRate,
    p95_latency_ms: p95,
    sample_size: sampleSize,
    reason: cls.reason,
    checked_at: Date.now(),
  };
}

function evaluatePolling(): ProviderHealthSignal {
  // Polling is the last-resort fallback. By construction it has no extra
  // failure mode beyond Postgres reachability, which the rest of the app
  // already depends on.
  return {
    provider: 'polling_builtin',
    status: 'healthy',
    error_rate: null,
    p95_latency_ms: null,
    sample_size: 0,
    reason: 'last_resort',
    checked_at: Date.now(),
  };
}

export async function evaluateProviderHealth(
  config: ServerConfig,
  policy: RealtimeFailoverPolicy,
): Promise<HealthSnapshot> {
  const windowS = Math.max(30, policy.realtime_failover_health_window_seconds);
  const sinceIso = new Date(Date.now() - windowS * 1000).toISOString();

  // Touch realtime config so a misconfiguration of centrifugo is reflected
  // even if probe accidentally returns ok.
  await loadRealtimeConfig(config).catch(() => null);

  const [centrifugo, supabase] = await Promise.all([
    evaluateCentrifugo(config, policy, sinceIso),
    evaluateSupabase(config, policy, sinceIso),
  ]);

  return {
    window_seconds: windowS,
    evaluated_at: Date.now(),
    providers: {
      centrifugo,
      supabase_realtime: supabase,
      polling_builtin: evaluatePolling(),
    },
  };
}