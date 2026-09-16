/**
 * ANALYTICS INGEST — the ONLY surface the tracking routes touch.
 *
 * Every function here is fire-and-forget by contract: it returns `void`,
 * never throws, never awaits storage, and never delays the caller. The
 * callers are widget endpoints on a visitor's page load, and the rule from
 * the requirements is explicit — a failure in the analytics lake must not
 * break widget tracking, but it must not be silent either. So failures land
 * in the existing observability surface (emitLog / emitMetric) and on the
 * Analytics Storage admin panel, never in the visitor's response.
 *
 * Phase 1 is DUAL-WRITE. Each call site keeps its existing PostgreSQL
 * insert exactly as it was and adds one call here. Nothing reads from S3
 * yet; this exists to prove the pipeline against real traffic before any
 * cutover is proposed.
 *
 * The pool is cached briefly so a page view does not cost a config read.
 */

import type { ServerConfig } from '../../config.js';
import { emitLog } from '../observability/metrics.js';
import { readAnalyticsPool, type AnalyticsStoragePool } from './pool.js';
import { enqueueAnalyticsRow } from './writer.js';
import { buildEventRow, type AnalyticsEventType, type SessionDimensions } from './schema.js';

export type { SessionDimensions };

const POOL_CACHE_TTL_MS = 30_000;
let poolCache: { value: AnalyticsStoragePool; ts: number } | null = null;
let poolInFlight: Promise<AnalyticsStoragePool | null> | null = null;

/** Test seam — forces the next ingest call to re-read the pool. */
export function __resetAnalyticsPoolCache(): void {
  poolCache = null;
  poolInFlight = null;
}

async function activePool(config: ServerConfig): Promise<AnalyticsStoragePool | null> {
  const now = Date.now();
  if (poolCache && now - poolCache.ts < POOL_CACHE_TTL_MS) {
    return poolCache.value.enabled ? poolCache.value : null;
  }
  // Collapse concurrent refreshes — a burst of page views must not turn
  // into a burst of identical config reads.
  if (!poolInFlight) {
    poolInFlight = readAnalyticsPool(config)
      .then((pool) => {
        poolCache = { value: pool, ts: Date.now() };
        return pool.enabled ? pool : null;
      })
      .catch(() => null)
      .finally(() => { poolInFlight = null; });
  }
  return poolInFlight;
}

function record(
  config: ServerConfig,
  eventType: AnalyticsEventType,
  input: {
    workspaceId: string;
    occurredAt?: Date | string | null;
    url?: string | null;
    title?: string | null;
    eventName?: string | null;
    properties?: Record<string, unknown> | null;
    session: SessionDimensions;
  },
): void {
  if (!input.workspaceId) return;
  void (async () => {
    try {
      const pool = await activePool(config);
      if (!pool) return;
      enqueueAnalyticsRow(config, pool, buildEventRow({ ...input, eventType }));
    } catch (err: unknown) {
      // Loud enough to diagnose, quiet enough never to reach the visitor.
      emitLog(config, 'warn', 'analytics_ingest_failed', {
        event_type: eventType,
        error: err instanceof Error ? err.message : 'unknown',
      });
    }
  })();
}

/**
 * Is the analytics lake actually accepting rows right now?
 *
 * Exists so a call site that must do EXTRA work to assemble a row — the
 * widget heartbeat reads the session's dimensions with a query it would not
 * otherwise issue — can skip that work entirely while the feature is off.
 * It is answered from the same short-lived cache the ingest path uses, so
 * asking costs nothing, and the feature ships disabled.
 *
 * This is a hint, not a gate: `record*` re-checks, so a race here can only
 * cost one skipped row, never a wrong write.
 */
export async function analyticsIngestEnabled(config: ServerConfig): Promise<boolean> {
  try {
    return (await activePool(config)) !== null;
  } catch {
    return false;
  }
}

/** A visitor loaded a page. Mirrors the `visitor_page_views` insert next to it. */
export function recordPageView(
  config: ServerConfig,
  input: {
    workspaceId: string;
    url?: string | null;
    title?: string | null;
    occurredAt?: Date | string | null;
    session: SessionDimensions;
  },
): void {
  record(config, 'page_view', input);
}

/**
 * A brand-new visitor session was created. Carries the first-touch
 * attribution the session row was just given, so the lake holds the session
 * dimensions even for a session whose only page view failed to record.
 */
export function recordSessionStart(
  config: ServerConfig,
  input: {
    workspaceId: string;
    url?: string | null;
    title?: string | null;
    occurredAt?: Date | string | null;
    session: SessionDimensions;
  },
): void {
  record(config, 'session_start', input);
}

/** `window.gsAnalytics.track(name, properties)` — mirrors the `web_analytics_events` insert. */
export function recordCustomEvent(
  config: ServerConfig,
  input: {
    workspaceId: string;
    eventName: string;
    properties?: Record<string, unknown> | null;
    url?: string | null;
    occurredAt?: Date | string | null;
    session: SessionDimensions;
  },
): void {
  record(config, 'custom_event', input);
}

/**
 * Map a `visitor_sessions` row (or the equivalent fields straight off a
 * tracking request) onto the analytics session dimensions.
 *
 * Every call site has the same problem — the row's column names, the
 * request body's field names and the schema's camelCase names all differ,
 * and geo lives in two generations of column (`country`/`city` from the
 * original tracker, `geo_*` from MaxMind enrichment, the latter preferred
 * exactly as reportService.ts prefers it). Doing that mapping once here is
 * what keeps five call sites from each inventing their own slightly
 * different version.
 *
 * `overrides` carries values the CURRENT request knows better than the
 * stored row — a browser/os/device that the widget just reported, for
 * instance, which the session row may not have been updated with yet.
 *
 * Deliberately absent: `ip_hash` and `ip_raw`. They exist on the session
 * row, no Web Analytics report reads them, and the lake does not collect
 * them (see the privacy note in ./schema.ts).
 */
export function analyticsSessionFrom(
  sessionId: string | null | undefined,
  visitorId: string | null | undefined,
  row: Record<string, unknown> | null | undefined,
  overrides?: {
    browser?: unknown; device?: unknown; os?: unknown; language?: unknown; referrer?: unknown;
  },
): SessionDimensions {
  const str = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() ? value : null;
  const pick = (override: unknown, stored: unknown): string | null => str(override) ?? str(stored);
  const r = row ?? {};

  return {
    visitorId: str(visitorId),
    sessionId: str(sessionId),
    sessionStartedAt: str(r.started_at),
    referrer: pick(overrides?.referrer, r.referrer),
    utmSource: str(r.utm_source),
    utmMedium: str(r.utm_medium),
    utmCampaign: str(r.utm_campaign),
    utmTerm: str(r.utm_term),
    utmContent: str(r.utm_content),
    browser: pick(overrides?.browser, r.browser),
    device: pick(overrides?.device, r.device),
    os: pick(overrides?.os, r.os),
    language: pick(overrides?.language, r.language),
    // MaxMind-resolved values win over the original tracker's, matching
    // reportService.ts's resolveCountryName/resolveCity precedence.
    country: str(r.geo_country_name) ?? str(r.country),
    countryCode: str(r.geo_country_code) ?? str(r.country),
    city: str(r.geo_city) ?? str(r.city),
  };
}
