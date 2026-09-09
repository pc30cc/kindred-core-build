/**
 * BRAND RADAR — combined Overview + Competitors comparison, aggregating the
 * three domain services (AI Visibility, Web Visibility, Search Demand)
 * against the workspace's own latest stored results. Computes nothing new
 * from a vendor itself — this is a read-only rollup over what the other
 * three services already persisted.
 */
import type { ServerConfig } from '../../config.js';
import type { BrandRadarSettings } from './settingsService.js';
import { getLatestAiChecksByTopic, type AiVisibilityCheckResult } from './aiVisibilityService.js';
import { getLatestWebChecks, isWebVisibilityAvailable, type WebVisibilityCheckResult } from './webVisibilityService.js';
import { getSearchDemand, type SearchDemandResult } from './searchDemandService.js';
import { textMentionsName } from './mentionDetection.js';

export interface BrandRadarOverview {
  hasSettings: boolean;
  brandName: string | null;
  competitorCount: number;
  topicCount: number;
  aiVisibility: {
    totalChecks: number;
    mentionRate: number | null;
    latestCheckedAt: string | null;
  };
  webVisibility: {
    available: boolean;
    ownPosition: number | null;
    checkedAt: string | null;
  };
  searchDemand: {
    available: boolean;
    clicks: number;
    impressions: number;
  };
}

export async function getOverview(
  config: ServerConfig,
  args: { workspaceId: string; settings: BrandRadarSettings | null; topicCount: number; startDate: string; endDate: string },
): Promise<BrandRadarOverview> {
  if (!args.settings) {
    return {
      hasSettings: false,
      brandName: null,
      competitorCount: 0,
      topicCount: 0,
      aiVisibility: { totalChecks: 0, mentionRate: null, latestCheckedAt: null },
      webVisibility: { available: false, ownPosition: null, checkedAt: null },
      searchDemand: { available: false, clicks: 0, impressions: 0 },
    };
  }

  const [aiChecks, webChecks, webAvailable, searchDemand] = await Promise.all([
    getLatestAiChecksByTopic(config, args.workspaceId),
    getLatestWebChecks(config, args.workspaceId),
    isWebVisibilityAvailable(config),
    getSearchDemand(config, {
      workspaceId: args.workspaceId,
      brandName: args.settings.brandName,
      competitorNames: args.settings.competitorNames,
      startDate: args.startDate,
      endDate: args.endDate,
    }),
  ]);

  const mentionRate = aiChecks.length > 0
    ? Math.round((aiChecks.filter((c) => c.brandMentioned).length / aiChecks.length) * 1000) / 10
    : null;
  const latestCheckedAt = aiChecks.reduce<string | null>((latest, c) => (!latest || c.createdAt > latest ? c.createdAt : latest), null);

  const ownWebCheck = webChecks.find((c) => c.isOwnBrand);
  const brandDemand = searchDemand.rows.find((r) => r.isOwnBrand);

  return {
    hasSettings: true,
    brandName: args.settings.brandName,
    competitorCount: args.settings.competitorNames.length,
    topicCount: args.topicCount,
    aiVisibility: { totalChecks: aiChecks.length, mentionRate, latestCheckedAt },
    webVisibility: { available: webAvailable, ownPosition: ownWebCheck?.position ?? null, checkedAt: ownWebCheck?.createdAt ?? null },
    searchDemand: { available: searchDemand.available, clicks: brandDemand?.clicks || 0, impressions: brandDemand?.impressions || 0 },
  };
}

export interface CompetitorRow {
  name: string;
  isOwnBrand: boolean;
  aiMentionRate: number | null;
  webPosition: number | null;
  searchClicks: number | null;
}

export async function getCompetitors(
  config: ServerConfig,
  args: { workspaceId: string; settings: BrandRadarSettings; startDate: string; endDate: string },
): Promise<{ rows: CompetitorRow[]; webAvailable: boolean; searchDemand: SearchDemandResult }> {
  const [aiChecks, webChecks, webAvailable, searchDemand] = await Promise.all([
    getLatestAiChecksByTopic(config, args.workspaceId),
    getLatestWebChecks(config, args.workspaceId),
    isWebVisibilityAvailable(config),
    getSearchDemand(config, {
      workspaceId: args.workspaceId,
      brandName: args.settings.brandName,
      competitorNames: args.settings.competitorNames,
      startDate: args.startDate,
      endDate: args.endDate,
    }),
  ]);

  const names: Array<{ name: string; isOwnBrand: boolean }> = [
    { name: args.settings.brandName, isOwnBrand: true },
    ...args.settings.competitorNames.map((c) => ({ name: c, isOwnBrand: false })),
  ];

  const rows: CompetitorRow[] = names.map(({ name, isOwnBrand }) => {
    const aiMentionRate = aiChecks.length > 0
      ? Math.round((aiChecks.filter((c: AiVisibilityCheckResult) => (isOwnBrand ? c.brandMentioned : textMentionsName(c.responseText, name))).length / aiChecks.length) * 1000) / 10
      : null;
    const webCheck = webChecks.find((c: WebVisibilityCheckResult) => c.term.toLowerCase() === name.toLowerCase());
    const demandRow = searchDemand.rows.find((r) => r.term.toLowerCase() === name.toLowerCase());
    return {
      name,
      isOwnBrand,
      aiMentionRate,
      webPosition: webCheck?.position ?? null,
      searchClicks: searchDemand.available ? (demandRow?.clicks ?? 0) : null,
    };
  });

  return { rows, webAvailable, searchDemand };
}
