/**
 * WEB ANALYTICS — EVENT SCHEMA AND OBJECT LAYOUT
 *
 * ── Why ONE unified dataset rather than three ────────────────────
 *
 * The alternative was separate `sessions`, `page_views` and `custom_events`
 * datasets. This codebase's own reports decide it: every Web Analytics
 * report in server/services/webAnalytics/reportService.ts is a SESSION
 * dimension (browser / os / device / country / language / referrer / utm)
 * crossed with a PAGE-VIEW measure. With separate datasets every single
 * report becomes a join across two Parquet datasets — in an embedded engine
 * that means reading both sides and shuffling, for every tile on the page.
 *
 * With one dataset the session dimensions are denormalized onto every row,
 * and each report collapses to a single scan with no join at all:
 *
 *   sessions        = COUNT(DISTINCT session_id)
 *   unique visitors = COUNT(DISTINCT visitor_id)     ← see the note below
 *   pageviews       = COUNT(*) WHERE event_type = 'page_view'
 *   any breakdown   = GROUP BY browser | country | utm_source | …
 *
 * The cost is repeating ~12 short, low-cardinality strings per row. That is
 * precisely the shape columnar storage exists for: those columns are long
 * runs of identical values, and ZSTD reduces them to near nothing. Paying a
 * few bytes per row to delete every join from the read path is the right
 * trade at this scale, and it keeps ONE writer, ONE buffer, ONE partition
 * layout and ONE backfill instead of three of each.
 *
 * ── Unique visitors ──────────────────────────────────────────────
 *
 * The PostgreSQL report path computes "unique visitors" as the number of
 * SESSION rows (`new Set(sessions.map(s => s.id)).size` in
 * reportService.ts) — so one person returning three times counts as three
 * visitors. That is a bug, and it is not fixable in the old shape because
 * `visitor_page_views` has no visitor column at all.
 *
 * This dataset carries `visitor_id` on every row precisely so the S3 read
 * path can compute it correctly. Phase 1 does not change the PostgreSQL
 * report (reads are not cut over yet), but the data needed to fix it is
 * being written from the first flush.
 *
 * ── Privacy ──────────────────────────────────────────────────────
 *
 * This dataset collects strictly LESS identifying data than the PostgreSQL
 * tables it shadows. `visitor_sessions` holds `ip_hash` and, when a
 * workspace opts in, `ip_raw`; neither is carried here, because no Web
 * Analytics report reads them. Geography arrives already resolved to
 * country/city, which is what the reports actually use.
 *
 * URLs and referrers are stored with their query string REMOVED (see
 * `sanitizeUrl`). The existing reports already group by path — every
 * caller runs the URL through `normalizePath`, which strips query and hash
 * — so nothing downstream loses information, while session tokens, reset
 * links and email addresses that routinely ride in query strings never
 * reach long-term storage. UTM values are still captured, from the fields
 * the widget already parses them into.
 */

import { ANALYTICS_SCHEMA_VERSION } from './pool.js';
import type { ParquetColumn, ParquetValue } from './parquet.js';

export { ANALYTICS_SCHEMA_VERSION };

/**
 * `session_end` is never emitted by the live pipeline — nothing in the
 * running system observes a session ending (`visitor_sessions.last_seen_at`
 * is mutable and has no terminal transition), and inventing one would mean
 * a new timer and a new state machine. The backfill DOES emit it, because a
 * historical session's end is known: its final `last_seen_at`.
 *
 * Live session duration is therefore derived in the query engine as
 * MAX(occurred_at) − MIN(session_started_at) per session_id, from columns
 * every row already carries. No extra machinery, no unreliable events.
 */
export type AnalyticsEventType = 'session_start' | 'session_end' | 'page_view' | 'custom_event';

export interface AnalyticsEventRow {
  schema_version: number;
  event_id: string;
  workspace_id: string;
  visitor_id: string | null;
  session_id: string | null;
  event_type: AnalyticsEventType;
  occurred_at: number;
  ingested_at: number;
  /** Denormalized session start, so session-level measures need no join. */
  session_started_at: number | null;
  /**
   * Denormalized `visitor_sessions.last_seen_at` as of THIS event.
   *
   * Session duration is `last_seen_at - started_at`, and PostgreSQL reads
   * both straight off the session row. Deriving the end from MAX(occurred_at)
   * instead gave a different — smaller — number whenever a session's last
   * activity produced no analytics event, so the two paths disagreed. The
   * value is carried on every row so no join is needed.
   *
   * A rebuild (./backfill.ts) reads the session row ONCE and stamps the same
   * final value onto every row it emits for that session, so on a sealed day
   * MAX of this column is exactly the session row's `last_seen_at` however
   * few of the session's rows a query happens to touch. On the live speed
   * layer it is the value as of the most recent event, which the day's seal
   * then corrects.
   */
  session_last_seen_at: number | null;
  url: string | null;
  /** Query/hash-stripped path — what every existing report groups by. */
  path: string | null;
  title: string | null;
  referrer: string | null;
  referrer_domain: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_term: string | null;
  utm_content: string | null;
  browser: string | null;
  device: string | null;
  os: string | null;
  language: string | null;
  country: string | null;
  country_code: string | null;
  city: string | null;
  event_name: string | null;
  /** JSON object as text. Kept as text so a property-shape change is never a schema change. */
  properties: string | null;
}

/**
 * Column order is the physical column order in every written file.
 *
 * APPEND-ONLY. Every column is OPTIONAL in Parquet, so a reader given both
 * an old and a new file sees NULLs for columns that did not exist yet
 * rather than failing — which is what lets a schema addition ship without
 * rewriting history. Reordering or removing a column is NOT safe and must
 * bump ANALYTICS_SCHEMA_VERSION with a documented read path for both.
 */
export const ANALYTICS_COLUMNS: ParquetColumn[] = [
  { name: 'schema_version', type: 'int32' },
  { name: 'event_id', type: 'utf8' },
  { name: 'workspace_id', type: 'utf8' },
  { name: 'visitor_id', type: 'utf8' },
  { name: 'session_id', type: 'utf8' },
  { name: 'event_type', type: 'utf8' },
  { name: 'occurred_at', type: 'timestamp_ms' },
  { name: 'ingested_at', type: 'timestamp_ms' },
  { name: 'session_started_at', type: 'timestamp_ms' },
  { name: 'session_last_seen_at', type: 'timestamp_ms' },
  { name: 'url', type: 'utf8' },
  { name: 'path', type: 'utf8' },
  { name: 'title', type: 'utf8' },
  { name: 'referrer', type: 'utf8' },
  { name: 'referrer_domain', type: 'utf8' },
  { name: 'utm_source', type: 'utf8' },
  { name: 'utm_medium', type: 'utf8' },
  { name: 'utm_campaign', type: 'utf8' },
  { name: 'utm_term', type: 'utf8' },
  { name: 'utm_content', type: 'utf8' },
  { name: 'browser', type: 'utf8' },
  { name: 'device', type: 'utf8' },
  { name: 'os', type: 'utf8' },
  { name: 'language', type: 'utf8' },
  { name: 'country', type: 'utf8' },
  { name: 'country_code', type: 'utf8' },
  { name: 'city', type: 'utf8' },
  { name: 'event_name', type: 'utf8' },
  { name: 'properties', type: 'utf8' },
];

export function rowToParquet(row: AnalyticsEventRow): Record<string, ParquetValue> {
  return row as unknown as Record<string, ParquetValue>;
}

// ─── Field normalization ─────────────────────────────────────────

const MAX_URL = 2048;
const MAX_TITLE = 300;
const MAX_SHORT = 200;

export function truncate(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/**
 * Drops the query string and fragment from a URL before it is stored.
 *
 * Analytics needs the page, not the parameters: every report path in this
 * repo already calls normalizePath(), which strips both. Keeping them would
 * mean a long-lived object store accumulating whatever the workspace's own
 * pages happen to put in a query string — password-reset tokens, one-time
 * links, email addresses — for no reporting benefit at all.
 */
export function sanitizeUrl(raw: unknown): string | null {
  const value = truncate(raw, MAX_URL);
  if (!value) return null;
  const withoutHash = value.split('#')[0] ?? '';
  const withoutQuery = withoutHash.split('?')[0] ?? '';
  return withoutQuery || null;
}

/** Path component of a sanitized URL, matching reportService.normalizePath(). */
export function urlPath(sanitized: string | null): string | null {
  if (!sanitized) return null;
  let path = sanitized;
  const schemeIndex = path.indexOf('://');
  if (schemeIndex >= 0) {
    const afterScheme = path.slice(schemeIndex + 3);
    const slash = afterScheme.indexOf('/');
    path = slash >= 0 ? afterScheme.slice(slash) : '/';
  }
  if (!path.startsWith('/')) path = `/${path}`;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return path || '/';
}

/** Registrable host of a referrer, `null` for a direct visit or an unparseable value. */
export function referrerHost(raw: unknown): string | null {
  const value = truncate(raw, MAX_URL);
  if (!value) return null;
  try {
    return new URL(value).hostname.replace(/^www\./i, '') || null;
  } catch {
    return null;
  }
}

export interface SessionDimensions {
  visitorId?: string | null;
  sessionId?: string | null;
  sessionStartedAt?: string | Date | null;
  sessionLastSeenAt?: string | Date | null;
  referrer?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  utmTerm?: string | null;
  utmContent?: string | null;
  browser?: string | null;
  device?: string | null;
  os?: string | null;
  language?: string | null;
  country?: string | null;
  countryCode?: string | null;
  city?: string | null;
}

function toMillis(value: string | Date | null | undefined): number | null {
  if (!value) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

let counter = 0;

/**
 * Event id: time-ordered and unique per process, without pulling in a UUID
 * dependency. Uniqueness only has to hold within the lake — a duplicate
 * would show up as a double-counted event, which the counter rules out even
 * when two events share a millisecond.
 */
export function newEventId(): string {
  counter = (counter + 1) % 0xffffff;
  return `${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Build one analytics row, applying every truncation and privacy rule in one place. */
export function buildEventRow(input: {
  workspaceId: string;
  eventType: AnalyticsEventType;
  occurredAt?: Date | string | null;
  url?: string | null;
  title?: string | null;
  eventName?: string | null;
  properties?: Record<string, unknown> | null;
  session: SessionDimensions;
}): AnalyticsEventRow {
  const now = Date.now();
  const url = sanitizeUrl(input.url);
  const referrer = sanitizeUrl(input.session.referrer);

  return {
    schema_version: ANALYTICS_SCHEMA_VERSION,
    event_id: newEventId(),
    workspace_id: input.workspaceId,
    visitor_id: truncate(input.session.visitorId, 120),
    session_id: truncate(input.session.sessionId, 64),
    event_type: input.eventType,
    occurred_at: toMillis(input.occurredAt ?? null) ?? now,
    ingested_at: now,
    session_started_at: toMillis(input.session.sessionStartedAt ?? null),
    session_last_seen_at: toMillis(input.session.sessionLastSeenAt ?? null),
    url,
    path: urlPath(url),
    title: truncate(input.title, MAX_TITLE),
    referrer,
    referrer_domain: referrerHost(input.session.referrer),
    utm_source: truncate(input.session.utmSource, MAX_SHORT),
    utm_medium: truncate(input.session.utmMedium, MAX_SHORT),
    utm_campaign: truncate(input.session.utmCampaign, MAX_SHORT),
    utm_term: truncate(input.session.utmTerm, MAX_SHORT),
    utm_content: truncate(input.session.utmContent, MAX_SHORT),
    browser: truncate(input.session.browser, 80),
    device: truncate(input.session.device, 80),
    os: truncate(input.session.os, 80),
    language: truncate(input.session.language, 35),
    country: truncate(input.session.country, 100),
    country_code: truncate(input.session.countryCode, 8),
    city: truncate(input.session.city, 120),
    event_name: truncate(input.eventName, 100),
    properties: input.properties && Object.keys(input.properties).length > 0
      ? JSON.stringify(input.properties).slice(0, 4000)
      : null,
  };
}

// ─── Object layout ───────────────────────────────────────────────

/**
 * Partitioned by workspace and DAY:
 *
 *   analytics/web/workspace=<id>/year=2026/month=09/day=16/part-<ts>-<id>.parquet
 *
 * Day, not hour, because every Web Analytics API takes a day-granular range
 * (`startDate`/`endDate` are YYYY-MM-DD in
 * server/services/webAnalytics/reportService.ts), so day partitions prune
 * exactly as precisely as hour partitions would while producing a fraction
 * of the objects. Hour partitioning on a workspace with modest traffic is
 * the small-files problem with extra steps.
 *
 * `workspace=` comes FIRST so that a single-workspace query — which is every
 * query, since every report is workspace-scoped — prunes to one prefix
 * before it looks at dates, and so a workspace's whole analytics footprint
 * is one listable, purgeable prefix.
 *
 * Hive-style `key=value` segments are what every Parquet reader (DuckDB
 * included) turns into partition COLUMNS automatically, so the day filter
 * costs no file reads at all.
 *
 * The `analytics/` root is its own namespace, disjoint from the general
 * storage roots (`workspace/`, `users/`, `platform/`): analytics can be
 * synced, purged and accounted for on its own, and a general-storage sync
 * never touches it.
 */
export function analyticsDayPrefix(prefix: string, workspaceId: string, when: Date): string {
  const year = when.getUTCFullYear();
  const month = String(when.getUTCMonth() + 1).padStart(2, '0');
  const day = String(when.getUTCDate()).padStart(2, '0');
  return `${prefix}workspace=${workspaceId}/year=${year}/month=${month}/day=${day}/`;
}

export function analyticsObjectKey(prefix: string, workspaceId: string, when: Date): string {
  const stamp = when.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return `${analyticsDayPrefix(prefix, workspaceId, when)}part-${stamp}-${suffix}.parquet`;
}

/** Everything one workspace owns — the unit a workspace-scoped purge would walk. */
export function analyticsWorkspacePrefix(prefix: string, workspaceId: string): string {
  return `${prefix}workspace=${workspaceId}/`;
}
