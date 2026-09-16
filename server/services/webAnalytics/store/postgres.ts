/**
 * POSTGRES WEB ANALYTICS STORE — the existing behaviour, behind the
 * interface.
 *
 * Every method delegates to the function that already served that report.
 * There is deliberately NO new logic here: this adapter exists so the S3
 * store has something to be compared against and eventually swapped for,
 * and the way to guarantee Phase 2 changes no answer is for this path to be
 * the same code it always was.
 *
 * The one method with real work is `getVisitorPageHistory`, because that
 * report lived inline in server/routes/visitors.ts rather than in a
 * service. It is moved here VERBATIM — same queries, same fallbacks, same
 * response shape — so the route keeps returning exactly what it returned.
 */

import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import * as reports from '../reportService.js';
import * as events from '../eventsService.js';
import type {
  FunnelStepDefinition, VisitorPageHistory, WebAnalyticsStore, WebAnalyticsStoreKind,
} from './types.js';

export class PostgresWebAnalyticsStore implements WebAnalyticsStore {
  readonly kind: WebAnalyticsStoreKind = 'postgres';

  constructor(private readonly config: ServerConfig) {}

  getOverview(workspaceId: string, range: reports.DateRange) {
    return reports.getOverview(this.config, workspaceId, range);
  }

  getSessionCount(workspaceId: string, range: reports.DateRange) {
    return reports.getSessionCount(this.config, workspaceId, range);
  }

  getTrafficSources(workspaceId: string, range: reports.DateRange, dimension: reports.TrafficSourceDimension) {
    return reports.getTrafficSources(this.config, workspaceId, range, dimension);
  }

  getGeography(workspaceId: string, range: reports.DateRange, dimension: reports.GeographyDimension) {
    return reports.getGeography(this.config, workspaceId, range, dimension);
  }

  getBrowsersSystems(workspaceId: string, range: reports.DateRange, dimension: reports.BrowsersSystemsDimension) {
    return reports.getBrowsersSystems(this.config, workspaceId, range, dimension);
  }

  getPages(workspaceId: string, range: reports.DateRange, kind: reports.PagesKind) {
    return reports.getPages(this.config, workspaceId, range, kind);
  }

  getClonedPages(workspaceId: string, range: reports.DateRange) {
    return reports.getClonedPages(this.config, workspaceId, range);
  }

  getSiteStructure(workspaceId: string, range: reports.DateRange) {
    return reports.getSiteStructure(this.config, workspaceId, range);
  }

  getTrackedEvents(workspaceId: string, range: reports.DateRange) {
    return events.getTrackedEvents(this.config, workspaceId, range);
  }

  getEventPropertyKeys(workspaceId: string, range: reports.DateRange, eventName: string) {
    return events.getEventPropertyKeys(this.config, workspaceId, range, eventName);
  }

  getEventPropertyBreakdown(
    workspaceId: string, range: reports.DateRange, eventName: string, propertyKey: string,
  ) {
    return events.getEventPropertyBreakdown(this.config, workspaceId, range, eventName, propertyKey);
  }

  /**
   * Funnel RESULTS from a step list.
   *
   * `events.computeFunnel` loads the definition itself, so this rebuilds the
   * identical timeline/cursor algorithm over the same two tables for a
   * caller-supplied step list — which is what lets the route hand the SAME
   * steps to both stores and compare the answers.
   */
  async computeFunnel(workspaceId: string, steps: FunnelStepDefinition[], range: reports.DateRange) {
    return events.computeFunnelSteps(this.config, workspaceId, steps as never, range);
  }

  async getVisitorPageHistory(
    workspaceId: string, sessionId: string, limit: number,
  ): Promise<VisitorPageHistory> {
    const sb = getServiceClient(this.config);

    // Recent pages (most-recent first) for the timeline.
    const { data, error } = await sb
      .from('visitor_page_views')
      .select('id, url, title, viewed_at')
      .eq('workspace_id', workspaceId)
      .eq('visitor_session_id', sessionId)
      .order('viewed_at', { ascending: false })
      .limit(limit);
    if (error) throw error;

    // Earliest page-view in this session = the landing/entry page.
    const { data: firstRows } = await sb
      .from('visitor_page_views')
      .select('id, url, title, viewed_at')
      .eq('workspace_id', workspaceId)
      .eq('visitor_session_id', sessionId)
      .order('viewed_at', { ascending: true })
      .limit(1);

    // Session-level entry context (referrer + started_at) so the UI can show
    // "came from X" even if no page-view rows exist yet.
    const { data: sess } = await sb
      .from('visitor_sessions')
      .select('referrer, started_at, current_page')
      .eq('workspace_id', workspaceId)
      .eq('id', sessionId)
      .maybeSingle();

    const items = (data ?? []) as VisitorPageHistory['items'];
    const firstPage = firstRows?.[0] as VisitorPageHistory['items'][number] | undefined;
    const session = sess as { referrer?: string | null; started_at?: string | null; current_page?: string | null } | null;

    return {
      items,
      entry: {
        landing_url: firstPage?.url ?? session?.current_page ?? null,
        landing_title: firstPage?.title ?? null,
        landed_at: firstPage?.viewed_at ?? session?.started_at ?? null,
        referrer: session?.referrer ?? null,
      },
      current: items[0]
        ? { url: items[0].url, title: items[0].title ?? null, viewed_at: items[0].viewed_at }
        : session?.current_page
          ? { url: session.current_page, title: null, viewed_at: session.started_at ?? null }
          : null,
    };
  }
}
