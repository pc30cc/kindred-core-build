/**
 * WEB ANALYTICS STORE — one interface, two backings.
 *
 * The report routes (server/routes/webAnalytics.ts) and the visitor page
 * history route do not know where analytics data lives. They ask a store.
 *
 *   PostgresWebAnalyticsStore  — the existing reportService/eventsService
 *                                path, unchanged. The official answer.
 *   S3ParquetWebAnalyticsStore — the same questions answered by DuckDB over
 *                                Parquet on the Analytics Primary.
 *
 * The interface is deliberately the SHAPE OF THE EXISTING REPORTS, not a
 * general query language: every method returns exactly the type the route
 * already serializes, so swapping the backing cannot change an API
 * response. That is the whole point — the frontend contract is fixed, and
 * the abstraction exists to make the source swappable underneath it, not to
 * invent a new data layer.
 *
 * Phase 2 runs PostgreSQL as the official source and S3 in shadow. Nothing
 * here selects S3 as the answer; ./index.ts decides, and in this build it
 * always decides PostgreSQL.
 */

import type {
  BreakdownRow, BrowsersSystemsDimension, ClonedPageGroup, DateRange, GeographyDimension,
  OverviewStats, PageRow, PagesKind, SiteStructureNode, TrafficSourceDimension,
} from '../reportService.js';
import type { EventPropertyValueRow, FunnelStepResult, TrackedEventRow } from '../eventsService.js';

/** One page in a visitor's session timeline — the shape the Visitor Detail panel already consumes. */
export interface VisitorPageHistoryItem {
  id: string | number;
  url: string;
  title: string | null;
  viewed_at: string;
}

export interface VisitorPageHistory {
  items: VisitorPageHistoryItem[];
  entry: {
    landing_url: string | null;
    landing_title: string | null;
    landed_at: string | null;
    referrer: string | null;
  };
  current: { url: string; title: string | null; viewed_at: string | null } | null;
}

export interface FunnelStepDefinition {
  type: 'pageview' | 'event';
  label?: string;
  eventName?: string;
  value?: string;
  matcher?: 'exact' | 'contains';
}

export type WebAnalyticsStoreKind = 'postgres' | 's3';

/**
 * Every question the Web Analytics surface asks.
 *
 * A store that cannot answer one throws; it never returns an empty result
 * to stand in for "unavailable", because an empty report and a broken
 * backend must never look the same.
 */
export interface WebAnalyticsStore {
  readonly kind: WebAnalyticsStoreKind;

  getOverview(workspaceId: string, range: DateRange): Promise<OverviewStats>;
  getSessionCount(workspaceId: string, range: DateRange): Promise<number>;

  getTrafficSources(
    workspaceId: string, range: DateRange, dimension: TrafficSourceDimension,
  ): Promise<{ rows: BreakdownRow[]; truncated: boolean }>;

  getGeography(
    workspaceId: string, range: DateRange, dimension: GeographyDimension,
  ): Promise<{ rows: BreakdownRow[]; truncated: boolean }>;

  getBrowsersSystems(
    workspaceId: string, range: DateRange, dimension: BrowsersSystemsDimension,
  ): Promise<{ rows: BreakdownRow[]; truncated: boolean }>;

  getPages(
    workspaceId: string, range: DateRange, kind: PagesKind,
  ): Promise<{ rows: PageRow[]; truncated: boolean }>;

  getClonedPages(workspaceId: string, range: DateRange): Promise<{ rows: ClonedPageGroup[]; truncated: boolean }>;
  getSiteStructure(workspaceId: string, range: DateRange): Promise<{ root: SiteStructureNode; truncated: boolean }>;

  getTrackedEvents(workspaceId: string, range: DateRange): Promise<{ rows: TrackedEventRow[]; truncated: boolean }>;
  getEventPropertyKeys(workspaceId: string, range: DateRange, eventName: string): Promise<string[]>;
  getEventPropertyBreakdown(
    workspaceId: string, range: DateRange, eventName: string, propertyKey: string,
  ): Promise<{ rows: EventPropertyValueRow[]; truncated: boolean }>;

  /**
   * Funnel RESULTS only. The funnel DEFINITION stays in PostgreSQL —
   * `web_analytics_funnels` is small, mutable configuration and has no
   * business in an append-only columnar store.
   */
  computeFunnel(
    workspaceId: string, steps: FunnelStepDefinition[], range: DateRange,
  ): Promise<FunnelStepResult[]>;

  getVisitorPageHistory(
    workspaceId: string, sessionId: string, limit: number,
  ): Promise<VisitorPageHistory>;
}
