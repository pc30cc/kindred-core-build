/**
 * Observability surface (server-only).
 *
 * Two outputs, gated independently by widget_platform_settings:
 *   1. Bounded in-memory counter → server/services/observability/collector/
 *      (admin panel reads this via getMonitoringCollector())
 *   2. Structured JSON log → stdout (log shipper reads this)
 *
 * Design rules:
 *   • Never throws. Recording is fire-and-forget; the realtime/widget hot
 *     path must never be blocked or affected by it.
 *   • Never stores message bodies, IPs, visitor IDs, tokens, or PII.
 *   • Tag values are bounded — short low-cardinality strings only.
 *   • Settings are cached for 60s.
 *   • Log level filtering is applied at emit time (debug<info<warn<error).
 */

import { getServiceClient } from '../../supabase.js';
import type { ServerConfig } from '../../config.js';
import { getMonitoringCollector } from './collector/index.js';

export type MetricSource = 'server' | 'widget' | 'operator';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface MetricEvent {
  metric: string;
  workspaceId?: string | null;
  conversationId?: string | null;
  driver?: string | null;
  source?: MetricSource;
  tags?: Record<string, string | number | boolean | null>;
}

export interface ObservabilityFlags {
  metricsEnabled: boolean;
  structuredLogsEnabled: boolean;
  logLevel: LogLevel;
}

const DEFAULT_FLAGS: ObservabilityFlags = {
  metricsEnabled: true,
  structuredLogsEnabled: true,
  logLevel: 'info',
};

const FLAG_CACHE_TTL_MS = 60_000;
let flagCache: { value: ObservabilityFlags; ts: number } | null = null;

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function normalizeLevel(raw: unknown): LogLevel {
  return raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error' ? raw : 'info';
}

export async function loadObservabilityFlags(config: ServerConfig): Promise<ObservabilityFlags> {
  const now = Date.now();
  if (flagCache && now - flagCache.ts < FLAG_CACHE_TTL_MS) return flagCache.value;
  try {
    const sb = getServiceClient(config);
    const { data } = await sb
      .from('widget_platform_settings')
      .select(
        'observability_metrics_enabled, observability_structured_logs_enabled, observability_log_level',
      )
      .limit(1)
      .maybeSingle();
    const value: ObservabilityFlags = {
      metricsEnabled: data?.observability_metrics_enabled !== false,
      structuredLogsEnabled: data?.observability_structured_logs_enabled !== false,
      logLevel: normalizeLevel(data?.observability_log_level),
    };
    flagCache = { value, ts: now };
    return value;
  } catch {
    flagCache = { value: DEFAULT_FLAGS, ts: now };
    return DEFAULT_FLAGS;
  }
}

export function __resetObservabilityFlagCacheForTests(): void {
  flagCache = null;
}

function sanitizeTags(
  tags?: Record<string, unknown>,
): Record<string, string | number | boolean | null> {
  if (!tags) return {};
  const out: Record<string, string | number | boolean | null> = {};
  let count = 0;
  for (const [k, v] of Object.entries(tags)) {
    if (count >= 10) break;
    if (typeof k !== 'string' || k.length > 64) continue;
    if (v === null || v === undefined) {
      out[k] = null;
    } else if (typeof v === 'boolean' || typeof v === 'number') {
      out[k] = v as boolean | number;
    } else {
      const s = String(v);
      out[k] = s.length > 128 ? s.slice(0, 128) : s;
    }
    count += 1;
  }
  return out;
}

export function emitMetric(config: ServerConfig, event: MetricEvent): void {
  if (!event.metric || typeof event.metric !== 'string' || event.metric.length > 64) {
    return;
  }
  const tags = sanitizeTags(event.tags);
  const source: MetricSource = event.source || 'server';

  void (async () => {
    let flags: ObservabilityFlags;
    try {
      flags = await loadObservabilityFlags(config);
    } catch {
      flags = DEFAULT_FLAGS;
    }

    if (flags.metricsEnabled) {
      // Live Monitoring: bounded in-memory collector only — see
      // server/services/observability/collector/. No Postgres write here
      // (realtime_metric_events was dropped; see the Live Monitoring
      // migration). Never throws — recordRealtimeMetric() only touches
      // in-memory structures.
      try {
        getMonitoringCollector().recordRealtimeMetric({
          metric: event.metric,
          workspaceId: event.workspaceId ?? null,
          conversationId: event.conversationId ?? null,
          driver: event.driver ?? null,
          source,
          tags,
        });
      } catch {
        // Never break the caller.
      }
    }

    if (flags.structuredLogsEnabled && LEVEL_RANK.info >= LEVEL_RANK[flags.logLevel]) {
      try {
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify({
            ts: new Date().toISOString(),
            level: 'info',
            kind: 'metric',
            metric: event.metric,
            workspace_id: event.workspaceId ?? null,
            conversation_id: event.conversationId ?? null,
            driver: event.driver ?? null,
            source,
            tags,
          }),
        );
      } catch {
        // Never crash on logging.
      }
    }
  })();
}

export function emitLog(
  config: ServerConfig,
  level: LogLevel,
  message: string,
  fields?: Record<string, unknown>,
): void {
  void (async () => {
    let flags: ObservabilityFlags;
    try {
      flags = await loadObservabilityFlags(config);
    } catch {
      flags = DEFAULT_FLAGS;
    }
    if (!flags.structuredLogsEnabled) return;
    if (LEVEL_RANK[level] < LEVEL_RANK[flags.logLevel]) return;
    try {
      // eslint-disable-next-line no-console
      const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
      fn(
        JSON.stringify({
          ts: new Date().toISOString(),
          level,
          kind: 'log',
          message,
          ...sanitizeTags(fields as Record<string, unknown>),
        }),
      );
    } catch {
      // Never crash on logging.
    }
  })();
}
