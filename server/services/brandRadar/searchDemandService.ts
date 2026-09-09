/**
 * BRAND RADAR — Search Demand.
 *
 * Reuses server/services/seo/gsc/index.ts's querySearchAnalytics() against
 * the workspace's already-connected, already-primary GSC property (Phase 2
 * — see database/migrations/143_seo_gsc_insights.sql), filtered locally to
 * queries containing the brand or a tracked competitor name. Real Search
 * Console data only; when no GSC property is connected this honestly
 * reports `available: false` rather than fabricating search volume.
 */
import type { ServerConfig } from '../../config.js';
import { listProperties, querySearchAnalytics } from '../seo/gsc/index.js';
import { isGscError } from '../seo/gsc/types.js';

const ROW_LIMIT = 5000;

export interface SearchDemandRow {
  term: string;
  isOwnBrand: boolean;
  clicks: number;
  impressions: number;
  ctr: number;
  avgPosition: number;
  matchedQueries: number;
}

export interface SearchDemandResult {
  available: boolean;
  propertyUrl: string | null;
  rows: SearchDemandRow[];
}

function matchesTerm(query: string, term: string): boolean {
  return query.toLowerCase().includes(term.trim().toLowerCase());
}

export async function getSearchDemand(
  config: ServerConfig,
  args: { workspaceId: string; brandName: string; competitorNames: string[]; startDate: string; endDate: string },
): Promise<SearchDemandResult> {
  const properties = await listProperties(config, args.workspaceId);
  const primary = properties.find((p) => p.isPrimary) || properties[0];
  if (!primary) return { available: false, propertyUrl: null, rows: [] };

  let queryRows: Array<{ keys: string[]; clicks: number; impressions: number; ctr: number; position: number }>;
  try {
    const result = await querySearchAnalytics(config, args.workspaceId, primary.id, {
      startDate: args.startDate,
      endDate: args.endDate,
      dimensions: ['query'],
      rowLimit: ROW_LIMIT,
    });
    queryRows = result.rows;
  } catch (err) {
    if (isGscError(err)) return { available: false, propertyUrl: primary.siteUrl, rows: [] };
    throw err;
  }

  const terms: Array<{ term: string; isOwnBrand: boolean }> = [
    { term: args.brandName, isOwnBrand: true },
    ...args.competitorNames.map((c) => ({ term: c, isOwnBrand: false })),
  ];

  const rows: SearchDemandRow[] = terms.map(({ term, isOwnBrand }) => {
    const matched = queryRows.filter((r) => matchesTerm(r.keys[0] || '', term));
    const clicks = matched.reduce((sum, r) => sum + r.clicks, 0);
    const impressions = matched.reduce((sum, r) => sum + r.impressions, 0);
    const weightedPosition = matched.reduce((sum, r) => sum + r.position * r.impressions, 0);
    return {
      term,
      isOwnBrand,
      clicks,
      impressions,
      ctr: impressions > 0 ? Math.round((clicks / impressions) * 1000) / 10 : 0,
      avgPosition: impressions > 0 ? Math.round((weightedPosition / impressions) * 10) / 10 : 0,
      matchedQueries: matched.length,
    };
  });

  return { available: true, propertyUrl: primary.siteUrl, rows };
}
