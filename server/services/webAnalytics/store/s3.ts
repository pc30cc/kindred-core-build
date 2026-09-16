/**
 * S3 / PARQUET WEB ANALYTICS STORE — the same reports, computed by DuckDB.
 *
 * ── No ROW_CAP, and no rows in Node ──────────────────────────────
 *
 * The PostgreSQL path loads up to ROW_CAP (20,000) rows per report and
 * aggregates them in JavaScript — which both caps how much data a report
 * can be right about and pulls every row through the event loop. This path
 * does neither: every COUNT, COUNT(DISTINCT), GROUP BY, MIN, MAX and ORDER
 * BY below runs inside the engine, and what crosses back into Node is the
 * result table — tens of rows, not millions. There is no row limit on the
 * scan anywhere in this file.
 *
 * ── Matching the existing semantics exactly ──────────────────────
 *
 * Parity is only meaningful if both stores answer the SAME question, so the
 * SQL reproduces reportService.ts's definitions deliberately, including the
 * ones that are a little surprising:
 *
 *   sessions    — sessions STARTED inside the range. A page view in range
 *                 belonging to an earlier session counts toward `pageviews`
 *                 but its session is NOT counted (reportService loads the
 *                 two with independent filters).
 *   pageviews   — page-view rows in range, regardless of session.
 *   breakdowns  — one row per session started in range, keyed by a session
 *                 dimension, carrying that session's in-range page views.
 *   bounce rate — share of those sessions with <= 1 page view in range.
 *
 * Two definitions deliberately DIVERGE, and both are reported as known
 * divergences by the parity runner rather than papered over:
 *
 *   uniqueVisitors — PostgreSQL counts SESSION rows, so one person visiting
 *                    three times counts as three. This path counts
 *                    COUNT(DISTINCT visitor_id), which is what the number
 *                    has always claimed to mean. The lake is the only place
 *                    it CAN be computed: `visitor_page_views` has no
 *                    visitor column at all.
 *   avgDuration    — PostgreSQL measures to `visitor_sessions.last_seen_at`,
 *                    a mutable column bumped by heartbeats that emit no
 *                    event. The lake measures to the last recorded EVENT.
 *                    A session idling with an open tab therefore looks
 *                    shorter here, and that is the more defensible number,
 *                    but it is not the same one.
 *
 * ── Workspace scoping ────────────────────────────────────────────
 *
 * Twice, independently: the files handed to the engine are only the ones
 * fetched under `workspace=<id>/` (./objectCache.ts), AND every query
 * carries `WHERE workspace_id = $1` as a BOUND parameter. No request value
 * is ever concatenated into SQL.
 */

import type { ServerConfig } from '../../../config.js';
import { num, queryAnalytics, str } from '../../analytics/duckdb.js';
import { fetchAnalyticsObjects, parquetSource } from '../../analytics/objectCache.js';
import { classifyChannel, referrerDomain, type Channel } from '../channels.js';
import { continentForCountry, CONTINENT_NAMES } from '../continents.js';
import type {
  BreakdownRow, BrowsersSystemsDimension, ClonedPageGroup, DateRange, GeographyDimension,
  OverviewStats, PageRow, PagesKind, SiteStructureNode, TrafficSourceDimension,
} from '../reportService.js';
import type { EventPropertyValueRow, FunnelStepResult, TrackedEventRow } from '../eventsService.js';
import type {
  FunnelStepDefinition, VisitorPageHistory, WebAnalyticsStore, WebAnalyticsStoreKind,
} from './types.js';

/**
 * reportService's `normalizePath` in SQL.
 *
 * Despite the name it does NOT reduce a URL to its path: it strips the
 * query and hash and one trailing slash, and keeps the scheme and host. The
 * lake stores a true `path` column as well, but the pages reports group by
 * THIS expression, because parity is only meaningful when both sides answer
 * the same question — and changing what "Top Pages" groups by is a
 * user-visible change, not a read-path change.
 */
const NORMALIZED_PAGE = `
  CASE
    WHEN url IS NULL THEN NULL
    WHEN length(url) > 1 AND ends_with(url, '/') THEN left(url, length(url) - 1)
    ELSE url
  END`;

const CHANNEL_LABELS: Record<Channel, string> = {
  direct: 'Direct',
  organic_search: 'Organic Search',
  paid_search: 'Paid Search',
  organic_social: 'Organic Social',
  paid_social: 'Paid Social',
  email: 'Email',
  referral: 'Referral',
  other: 'Other',
};

/** Raised when the lake cannot answer at all — never confused with "no data". */
export class AnalyticsSourceUnavailable extends Error {
  constructor(reason: string) {
    super(`analytics_s3_unavailable: ${reason}`);
    this.name = 'AnalyticsSourceUnavailable';
  }
}

interface Scan {
  source: string;
  /** Exclusive upper bound — the range's end day plus one. */
  startIso: string;
  endExclusiveIso: string;
  objectCount: number;
  empty: boolean;
}

function rangeBounds(range: DateRange): { startIso: string; endExclusiveIso: string } {
  const start = new Date(`${range.startDate}T00:00:00.000Z`);
  const end = new Date(`${range.endDate}T00:00:00.000Z`);
  return {
    startIso: start.toISOString(),
    endExclusiveIso: new Date(end.getTime() + 24 * 60 * 60 * 1000).toISOString(),
  };
}

/**
 * The session-level projection every breakdown is built on.
 *
 * One row per session STARTED in range, carrying its dimensions and its
 * in-range page-view count. Dimensions use max() because a session's rows
 * all carry the same value EXCEPT where async geo enrichment filled a
 * column in after the first page view — max() ignores NULLs and so prefers
 * the enriched value, which is what the PostgreSQL path reads too.
 */
const SESSION_CTE = `
  events AS (
    SELECT * FROM __SOURCE__ WHERE workspace_id = $1
  ),
  in_range AS (
    SELECT * FROM events
    WHERE occurred_at >= $2::TIMESTAMP AND occurred_at < $3::TIMESTAMP
  ),
  page_views AS (
    SELECT * FROM in_range WHERE event_type = 'page_view'
  ),
  session_pv AS (
    SELECT session_id, count(*) AS views FROM page_views
    WHERE session_id IS NOT NULL GROUP BY session_id
  ),
  sessions AS (
    SELECT
      e.session_id,
      min(e.session_started_at) AS started_at,
      max(e.occurred_at)        AS last_at,
      max(e.visitor_id)         AS visitor_id,
      max(e.referrer)           AS referrer,
      max(e.referrer_domain)    AS referrer_domain,
      max(e.utm_source)         AS utm_source,
      max(e.utm_medium)         AS utm_medium,
      max(e.utm_campaign)       AS utm_campaign,
      max(e.browser)            AS browser,
      max(e.os)                 AS os,
      max(e.device)             AS device,
      max(e.language)           AS language,
      max(e.country)            AS country,
      max(e.country_code)       AS country_code,
      max(e.city)               AS city,
      coalesce(max(p.views), 0) AS views
    FROM in_range e
    LEFT JOIN session_pv p ON p.session_id = e.session_id
    WHERE e.session_id IS NOT NULL
    GROUP BY e.session_id
    HAVING min(e.session_started_at) >= $2::TIMESTAMP
       AND min(e.session_started_at) <  $3::TIMESTAMP
  )
`;

export class S3ParquetWebAnalyticsStore implements WebAnalyticsStore {
  readonly kind: WebAnalyticsStoreKind = 's3';

  constructor(private readonly config: ServerConfig) {}

  /** Prune to the range's objects, fetch them, and build the engine's source expression. */
  private async scan(workspaceId: string, range: DateRange): Promise<Scan> {
    const fetched = await fetchAnalyticsObjects(this.config, workspaceId, {
      startDate: range.startDate,
      endDate: range.endDate,
    });
    if (fetched.unavailable) throw new AnalyticsSourceUnavailable(fetched.unavailable);

    const bounds = rangeBounds(range);
    return {
      source: fetched.files.length > 0 ? parquetSource(fetched.files) : '',
      ...bounds,
      objectCount: fetched.objectCount,
      empty: fetched.files.length === 0,
    };
  }

  private async run<T>(scan: Scan, body: string, label: string, extraParams: string[] = []): Promise<T[]> {
    const sql = `WITH ${SESSION_CTE.replace('__SOURCE__', scan.source)}\n${body}`;
    return queryAnalytics<T>(this.config, sql, {
      params: [this.workspaceId, scan.startIso, scan.endExclusiveIso, ...extraParams],
      label,
    });
  }

  /** Set for the duration of one report call — every query binds it as $1. */
  private workspaceId = '';

  private async prepare(workspaceId: string, range: DateRange): Promise<Scan> {
    this.workspaceId = workspaceId;
    return this.scan(workspaceId, range);
  }

  // ─── Overview ──────────────────────────────────────────────────

  async getOverview(workspaceId: string, range: DateRange): Promise<OverviewStats> {
    const scan = await this.prepare(workspaceId, range);
    if (scan.empty) {
      return {
        sessions: 0, pageviews: 0, avgPagesPerSession: 0, uniqueVisitors: 0,
        bounceRate: 0, avgVisitDurationSeconds: 0, trend: [], topChannels: [], topPages: [],
        truncated: false,
      };
    }

    const [totals] = await this.run<Record<string, unknown>>(scan, `
      SELECT
        (SELECT count(*) FROM sessions)                                     AS sessions,
        (SELECT count(*) FROM page_views)                                   AS pageviews,
        (SELECT count(DISTINCT visitor_id) FROM sessions
          WHERE visitor_id IS NOT NULL)                                     AS unique_visitors,
        (SELECT count(*) FROM sessions WHERE views <= 1)                    AS bounced,
        (SELECT coalesce(sum(greatest(0, epoch(last_at) - epoch(started_at))), 0)
           FROM sessions)                                                   AS duration_seconds
    `, 'overview.totals');

    const trendRows = await this.run<Record<string, unknown>>(scan, `
      SELECT day, sum(sessions) AS sessions, sum(pageviews) AS pageviews FROM (
        SELECT strftime(started_at, '%Y-%m-%d') AS day, count(*) AS sessions, 0 AS pageviews
        FROM sessions GROUP BY 1
        UNION ALL
        SELECT strftime(occurred_at, '%Y-%m-%d') AS day, 0 AS sessions, count(*) AS pageviews
        FROM page_views GROUP BY 1
      ) GROUP BY day ORDER BY day
    `, 'overview.trend');

    const topPageRows = await this.run<Record<string, unknown>>(scan, `
      SELECT ${NORMALIZED_PAGE} AS path, count(*) AS views FROM page_views
      WHERE url IS NOT NULL GROUP BY 1 ORDER BY views DESC, path LIMIT 5
    `, 'overview.topPages');

    const channelRows = await this.channelBreakdown(scan);

    const sessions = num(totals?.sessions);
    const pageviews = num(totals?.pageviews);
    const bounced = num(totals?.bounced);
    const durationSeconds = num(totals?.duration_seconds);

    return {
      sessions,
      pageviews,
      avgPagesPerSession: sessions > 0 ? Math.round((pageviews / sessions) * 10) / 10 : 0,
      // The corrected definition — see this file's header.
      uniqueVisitors: num(totals?.unique_visitors),
      bounceRate: sessions > 0 ? Math.round((bounced / sessions) * 1000) / 10 : 0,
      avgVisitDurationSeconds: sessions > 0 ? Math.round(durationSeconds / sessions) : 0,
      trend: trendRows.map((row) => ({
        date: String(row.day),
        sessions: num(row.sessions),
        pageviews: num(row.pageviews),
      })),
      topChannels: channelRows.slice(0, 5),
      topPages: topPageRows.map((row) => ({ path: String(row.path), views: num(row.views) })),
      // No ROW_CAP on this path: a result is never a truncated prefix of the
      // real answer, so this is structurally false rather than computed.
      truncated: false,
    };
  }

  async getSessionCount(workspaceId: string, range: DateRange): Promise<number> {
    const scan = await this.prepare(workspaceId, range);
    if (scan.empty) return 0;
    const [row] = await this.run<Record<string, unknown>>(scan, 'SELECT count(*) AS n FROM sessions', 'sessionCount');
    return num(row?.n);
  }

  // ─── Breakdowns ────────────────────────────────────────────────

  /**
   * sessions + pageviews grouped by one session dimension.
   *
   * `buildBreakdown` in reportService drops sessions whose key is null and
   * sorts by sessions desc — reproduced here so the two stores order
   * identically and a parity diff means a real difference.
   */
  private async breakdown(scan: Scan, column: string, label: string): Promise<BreakdownRow[]> {
    if (scan.empty) return [];
    // `buildBreakdown` in reportService buckets a null/empty key under
    // '(unknown)' rather than dropping the session — so sessions always sum
    // to the total. Filtering them out here instead would make every
    // breakdown quietly disagree with the overview.
    const rows = await this.run<Record<string, unknown>>(scan, `
      SELECT coalesce(nullif(${column}, ''), '(unknown)') AS key,
             count(*) AS sessions, coalesce(sum(views), 0) AS pageviews
      FROM sessions
      GROUP BY 1 ORDER BY sessions DESC, key
    `, label);
    return rows.map((row) => ({
      key: String(row.key),
      label: String(row.key),
      sessions: num(row.sessions),
      pageviews: num(row.pageviews),
    }));
  }

  /**
   * Channel classification stays in TypeScript.
   *
   * `classifyChannel` is real branching logic over referrer + utm_source +
   * utm_medium (server/services/webAnalytics/channels.ts). Re-expressing it
   * as a SQL CASE would be a SECOND implementation that silently drifts
   * from the first — so the engine groups by the raw inputs (a handful of
   * rows, not a scan) and the shared function classifies them. The
   * aggregation is still entirely in the engine.
   */
  private async channelBreakdown(scan: Scan): Promise<BreakdownRow[]> {
    if (scan.empty) return [];
    const rows = await this.run<Record<string, unknown>>(scan, `
      SELECT referrer, utm_source, utm_medium,
             count(*) AS sessions, coalesce(sum(views), 0) AS pageviews
      FROM sessions GROUP BY 1, 2, 3
    `, 'trafficSources.channel');

    const buckets = new Map<string, { sessions: number; pageviews: number }>();
    for (const row of rows) {
      const channel = classifyChannel({
        referrer: str(row.referrer),
        utmSource: str(row.utm_source),
        utmMedium: str(row.utm_medium),
      });
      const bucket = buckets.get(channel) ?? { sessions: 0, pageviews: 0 };
      bucket.sessions += num(row.sessions);
      bucket.pageviews += num(row.pageviews);
      buckets.set(channel, bucket);
    }
    return [...buckets.entries()]
      .map(([key, value]) => ({
        key,
        label: CHANNEL_LABELS[key as Channel] || key,
        sessions: value.sessions,
        pageviews: value.pageviews,
      }))
      .sort((a, b) => b.sessions - a.sessions || (a.key < b.key ? -1 : 1));
  }

  async getTrafficSources(workspaceId: string, range: DateRange, dimension: TrafficSourceDimension) {
    const scan = await this.prepare(workspaceId, range);
    if (dimension === 'channel') {
      return { rows: await this.channelBreakdown(scan), truncated: false };
    }
    if (dimension === 'campaign') {
      return { rows: await this.breakdown(scan, 'utm_campaign', 'trafficSources.campaign'), truncated: false };
    }
    // `source` is utm_source falling back to the referrer's registrable
    // domain, and `referrerDomain(null)` is '(direct)' — a named bucket, not
    // an unknown one. Both fallbacks are reproduced exactly.
    return {
      rows: await this.breakdown(
        scan,
        "coalesce(nullif(utm_source, ''), nullif(referrer_domain, ''), '(direct)')",
        'trafficSources.source',
      ),
      truncated: false,
    };
  }

  async getGeography(workspaceId: string, range: DateRange, dimension: GeographyDimension) {
    const scan = await this.prepare(workspaceId, range);
    if (dimension === 'country') {
      return { rows: await this.breakdown(scan, 'country', 'geography.country'), truncated: false };
    }
    if (dimension === 'city') {
      return { rows: await this.breakdown(scan, 'city', 'geography.city'), truncated: false };
    }
    if (dimension === 'language') {
      return { rows: await this.breakdown(scan, 'language', 'geography.language'), truncated: false };
    }
    // Continent is derived from the country code by a lookup table, so the
    // engine groups by code and the shared mapping does the rest.
    const rows = await this.breakdown(scan, 'country_code', 'geography.continent');
    const buckets = new Map<string, { sessions: number; pageviews: number }>();
    for (const row of rows) {
      const continent = continentForCountry(row.key);
      if (!continent) continue;
      const bucket = buckets.get(continent) ?? { sessions: 0, pageviews: 0 };
      bucket.sessions += row.sessions;
      bucket.pageviews += row.pageviews;
      buckets.set(continent, bucket);
    }
    return {
      rows: [...buckets.entries()]
        .map(([key, value]) => ({ key, label: CONTINENT_NAMES[key] || key, ...value }))
        .sort((a, b) => b.sessions - a.sessions || (a.key < b.key ? -1 : 1)),
      truncated: false,
    };
  }

  async getBrowsersSystems(workspaceId: string, range: DateRange, dimension: BrowsersSystemsDimension) {
    const scan = await this.prepare(workspaceId, range);
    return { rows: await this.breakdown(scan, dimension, `browsersSystems.${dimension}`), truncated: false };
  }

  // ─── Pages ─────────────────────────────────────────────────────

  async getPages(workspaceId: string, range: DateRange, kind: PagesKind) {
    const scan = await this.prepare(workspaceId, range);
    if (scan.empty) return { rows: [] as PageRow[], truncated: false };

    if (kind === 'top') {
      const rows = await this.run<Record<string, unknown>>(scan, `
        SELECT ${NORMALIZED_PAGE} AS path, count(*) AS views FROM page_views
        WHERE url IS NOT NULL GROUP BY 1 ORDER BY views DESC, path
      `, 'pages.top');
      return { rows: rows.map((r) => ({ path: String(r.path), views: num(r.views) })), truncated: false };
    }

    if (kind === 'entry' || kind === 'exit') {
      // First / last page view per session, chronologically — the engine's
      // window function replaces the JS sort-per-session the other path does.
      const order = kind === 'entry' ? 'ASC' : 'DESC';
      // A subquery, not a second WITH: the shared session CTE is already a
      // WITH clause and SQL allows only one per statement.
      const rows = await this.run<Record<string, unknown>>(scan, `
        SELECT path, count(*) AS views FROM (
          SELECT ${NORMALIZED_PAGE} AS path, row_number() OVER (
            PARTITION BY session_id ORDER BY occurred_at ${order}, event_id ${order}
          ) AS rn
          FROM page_views WHERE session_id IS NOT NULL AND url IS NOT NULL
        ) ranked
        WHERE rn = 1
        GROUP BY path ORDER BY views DESC, path
      `, `pages.${kind}`);
      return { rows: rows.map((r) => ({ path: String(r.path), views: num(r.views) })), truncated: false };
    }

    // "new": paths whose first EVER view falls inside the range. Needs
    // history before the range, so the scan is widened to everything up to
    // the range end and the comparison is done in the engine.
    const widened = await this.prepare(workspaceId, { startDate: '1970-01-01', endDate: range.endDate });
    if (widened.empty) return { rows: [], truncated: false };
    const rows = await queryAnalytics<Record<string, unknown>>(this.config, `
      WITH events AS (SELECT * FROM ${widened.source} WHERE workspace_id = $1),
      pv AS (SELECT ${NORMALIZED_PAGE} AS path, occurred_at FROM events WHERE event_type = 'page_view' AND url IS NOT NULL),
      first_seen AS (SELECT path, min(occurred_at) AS first_at FROM pv GROUP BY path)
      SELECT pv.path AS path, count(*) AS views
      FROM pv JOIN first_seen f ON f.path = pv.path
      WHERE f.first_at >= $2::TIMESTAMP
        AND pv.occurred_at >= $2::TIMESTAMP AND pv.occurred_at < $3::TIMESTAMP
      GROUP BY pv.path ORDER BY views DESC, path
    `, {
      params: [workspaceId, rangeBounds(range).startIso, rangeBounds(range).endExclusiveIso],
      label: 'pages.new',
    });
    return { rows: rows.map((r) => ({ path: String(r.path), views: num(r.views) })), truncated: false };
  }

  async getClonedPages(workspaceId: string, range: DateRange) {
    const scan = await this.prepare(workspaceId, range);
    if (scan.empty) return { rows: [] as ClonedPageGroup[], truncated: false };

    const rows = await this.run<Record<string, unknown>>(scan, `
      SELECT ${NORMALIZED_PAGE} AS path, url, count(*) AS views FROM page_views
      WHERE url IS NOT NULL
      GROUP BY 1, url ORDER BY path, views DESC, url
    `, 'pages.cloned');

    const groups = new Map<string, ClonedPageGroup>();
    for (const row of rows) {
      const path = String(row.path);
      const group = groups.get(path) ?? { normalizedPath: path, totalViews: 0, variants: [] };
      group.variants.push({ url: String(row.url), views: num(row.views) });
      group.totalViews += num(row.views);
      groups.set(path, group);
    }
    return {
      // Only paths reached by more than one raw URL are "cloned".
      rows: [...groups.values()]
        .filter((group) => group.variants.length > 1)
        .sort((a, b) => b.totalViews - a.totalViews),
      truncated: false,
    };
  }

  async getSiteStructure(workspaceId: string, range: DateRange) {
    const scan = await this.prepare(workspaceId, range);
    const root: SiteStructureNode = { segment: '/', path: '/', views: 0, children: [] };
    if (scan.empty) return { root, truncated: false };

    const rows = await this.run<Record<string, unknown>>(scan, `
      SELECT ${NORMALIZED_PAGE} AS path, count(*) AS views FROM page_views
      WHERE url IS NOT NULL GROUP BY 1
    `, 'pages.siteStructure');

    // The tree is built from the per-path counts, not from raw rows: the
    // engine has already collapsed millions of views into one row per path.
    const nodeByPath = new Map<string, SiteStructureNode>([['/', root]]);
    for (const row of rows) {
      const path = String(row.path);
      const views = num(row.views);
      root.views += views;
      if (path === '/') continue;
      let currentPath = '';
      let parent = root;
      for (const segment of path.split('/').filter(Boolean)) {
        currentPath += `/${segment}`;
        let node = nodeByPath.get(currentPath);
        if (!node) {
          node = { segment, path: currentPath, views: 0, children: [] };
          nodeByPath.set(currentPath, node);
          parent.children.push(node);
        }
        node.views += views;
        parent = node;
      }
    }
    const sortChildren = (node: SiteStructureNode) => {
      node.children.sort((a, b) => b.views - a.views);
      node.children.forEach(sortChildren);
    };
    sortChildren(root);
    return { root, truncated: false };
  }

  // ─── Events ────────────────────────────────────────────────────

  async getTrackedEvents(workspaceId: string, range: DateRange) {
    const scan = await this.prepare(workspaceId, range);
    if (scan.empty) return { rows: [] as TrackedEventRow[], truncated: false };

    const [totals] = await this.run<Record<string, unknown>>(scan, 'SELECT count(*) AS n FROM sessions', 'events.sessionTotal');
    const totalSessions = num(totals?.n);

    const rows = await this.run<Record<string, unknown>>(scan, `
      SELECT event_name, count(*) AS n, count(DISTINCT session_id) AS sessions
      FROM in_range WHERE event_type = 'custom_event' AND event_name IS NOT NULL
      GROUP BY event_name ORDER BY n DESC, event_name
    `, 'events.tracked');

    return {
      rows: rows.map((row) => {
        const uniqueSessions = num(row.sessions);
        return {
          eventName: String(row.event_name),
          count: num(row.n),
          uniqueSessions,
          conversionRate: totalSessions > 0 ? uniqueSessions / totalSessions : 0,
        };
      }),
      truncated: false,
    };
  }

  async getEventPropertyKeys(workspaceId: string, range: DateRange, eventName: string): Promise<string[]> {
    const scan = await this.prepare(workspaceId, range);
    if (scan.empty) return [];
    // `properties` is stored as JSON text, so the keys come out of the
    // engine's JSON functions rather than a scan in Node.
    const rows = await this.run<Record<string, unknown>>(scan, `
      SELECT DISTINCT unnest(json_keys(properties)) AS key
      FROM in_range
      WHERE event_type = 'custom_event' AND event_name = $4 AND properties IS NOT NULL
      ORDER BY key
    `, 'events.propertyKeys', [eventName]);
    return rows.map((row) => String(row.key));
  }

  async getEventPropertyBreakdown(
    workspaceId: string, range: DateRange, eventName: string, propertyKey: string,
  ) {
    const scan = await this.prepare(workspaceId, range);
    if (scan.empty) return { rows: [] as EventPropertyValueRow[], truncated: false };
    const rows = await this.run<Record<string, unknown>>(scan, `
      SELECT json_extract_string(properties, '$.' || $5) AS value, count(*) AS n
      FROM in_range
      WHERE event_type = 'custom_event' AND event_name = $4 AND properties IS NOT NULL
        AND json_extract_string(properties, '$.' || $5) IS NOT NULL
      GROUP BY 1 ORDER BY n DESC, value
    `, 'events.propertyValues', [eventName, propertyKey]);
    return {
      rows: rows.map((row) => ({ value: String(row.value), count: num(row.n) })),
      truncated: false,
    };
  }

  /**
   * Funnel results — ordered subsequence matching, per session.
   *
   * reportService's algorithm walks each session's time-sorted timeline
   * with a strictly increasing cursor: step i must match an entry AFTER the
   * one step i-1 matched. That ordering is the whole point of a funnel, so
   * it is reproduced exactly: each step's earliest qualifying position is
   * computed in the engine, and the cursor advances step by step.
   */
  async computeFunnel(
    workspaceId: string, steps: FunnelStepDefinition[], range: DateRange,
  ): Promise<FunnelStepResult[]> {
    const scan = await this.prepare(workspaceId, range);
    const labelOf = (step: FunnelStepDefinition, index: number) =>
      step.label || (step.type === 'event' ? step.eventName ?? `Step ${index + 1}` : step.value ?? `Step ${index + 1}`);

    if (scan.empty || steps.length === 0) {
      return steps.map((step, index) => ({
        label: labelOf(step, index), sessions: 0, conversionFromPrevious: index === 0 ? 100 : 0, conversionFromStart: 0,
      }));
    }

    // Sessions still "alive" after each step, with the timestamp their last
    // matched step happened at — the cursor, carried in SQL.
    let alive = new Map<string, string>();
    const counts: number[] = [];

    for (let index = 0; index < steps.length; index++) {
      const step = steps[index];
      const predicate = step.type === 'event'
        ? "event_type = 'custom_event' AND event_name = $4"
        : step.matcher === 'contains'
          ? `event_type = 'page_view' AND url IS NOT NULL AND contains(${NORMALIZED_PAGE}, $4)`
          : `event_type = 'page_view' AND ${NORMALIZED_PAGE} = $4`;
      const needle = step.type === 'event' ? (step.eventName ?? '') : (step.value ?? '');

      const rows = await this.run<Record<string, unknown>>(scan, `
        SELECT session_id, min(occurred_at) AS at
        FROM in_range
        WHERE session_id IS NOT NULL AND ${predicate}
        ${index === 0 ? '' : 'AND occurred_at > $5::TIMESTAMP'}
        GROUP BY session_id
      `, `funnel.step${index}`, index === 0 ? [needle] : [needle, new Date(0).toISOString()]);

      if (index === 0) {
        alive = new Map(rows.map((row) => [String(row.session_id), String(row.at)]));
      } else {
        // Keep only sessions whose match for THIS step happened strictly
        // after their match for the previous one.
        const next = new Map<string, string>();
        for (const row of rows) {
          const sessionId = String(row.session_id);
          const previousAt = alive.get(sessionId);
          if (!previousAt) continue;
          const at = String(row.at);
          if (at > previousAt) next.set(sessionId, at);
        }
        alive = next;
      }
      counts.push(alive.size);
    }

    const start = counts[0] || 0;
    return steps.map((step, index) => ({
      label: labelOf(step, index),
      sessions: counts[index] ?? 0,
      conversionFromPrevious: index === 0
        ? 100
        : (counts[index - 1] ?? 0) > 0 ? Math.round(((counts[index] ?? 0) / counts[index - 1]) * 1000) / 10 : 0,
      conversionFromStart: start > 0 ? Math.round(((counts[index] ?? 0) / start) * 1000) / 10 : 0,
    }));
  }

  // ─── Visitor page history ──────────────────────────────────────

  /**
   * One session's page timeline.
   *
   * Scoped to the session's own days rather than the whole lake: the
   * session's rows carry `session_started_at`, so a bounded window around
   * it is enough, and a single session's history never needs a full scan.
   */
  async getVisitorPageHistory(
    workspaceId: string, sessionId: string, limit: number,
  ): Promise<VisitorPageHistory> {
    // A visitor session is short-lived; a generous window costs a few
    // objects and avoids a full-history scan for a detail panel.
    const today = new Date();
    const start = new Date(today.getTime() - 90 * 24 * 60 * 60 * 1000);
    const range: DateRange = {
      startDate: start.toISOString().slice(0, 10),
      endDate: today.toISOString().slice(0, 10),
    };
    const scan = await this.prepare(workspaceId, range);

    const empty: VisitorPageHistory = {
      items: [],
      entry: { landing_url: null, landing_title: null, landed_at: null, referrer: null },
      current: null,
    };
    if (scan.empty) return empty;

    const rows = await queryAnalytics<Record<string, unknown>>(this.config, `
      WITH events AS (SELECT * FROM ${scan.source} WHERE workspace_id = $1 AND session_id = $2)
      SELECT event_id, url, title, occurred_at, referrer, session_started_at, event_type
      FROM events ORDER BY occurred_at DESC, event_id DESC
    `, { params: [workspaceId, sessionId], label: 'visitorPageHistory' });

    const pageViews = rows.filter((row) => row.event_type === 'page_view');
    const items = pageViews.slice(0, limit).map((row) => ({
      id: String(row.event_id),
      url: String(row.url ?? ''),
      title: str(row.title),
      viewed_at: toIso(row.occurred_at),
    }));

    const oldest = pageViews[pageViews.length - 1];
    const sessionStart = rows.length > 0 ? rows[rows.length - 1] : undefined;

    return {
      items,
      entry: {
        landing_url: oldest ? String(oldest.url ?? '') : null,
        landing_title: oldest ? str(oldest.title) : null,
        landed_at: oldest ? toIso(oldest.occurred_at) : (sessionStart ? toIso(sessionStart.session_started_at) : null),
        referrer: sessionStart ? str(sessionStart.referrer) : null,
      },
      current: items[0] ?? null,
    };
  }
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number' || typeof value === 'bigint') return new Date(Number(value)).toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}
