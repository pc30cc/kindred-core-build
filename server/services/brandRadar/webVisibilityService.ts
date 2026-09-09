/**
 * BRAND RADAR — Web Visibility.
 *
 * Calls server/services/seo/rankTracking/index.ts's checkKeywordRank()
 * directly — the SAME DataForSEO adapter the Rank Tracker module uses —
 * rather than writing into seo_tracked_keywords, so Brand Radar's own small
 * brand/competitor term list never competes with a workspace's manual Rank
 * Tracker keyword quota. When the platform hasn't configured a rank-tracking
 * provider, this honestly reports `configured: false` rather than
 * fabricating a position.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { checkKeywordRank, getRankTrackingProviderInfo } from '../seo/rankTracking/index.js';
import { isRankTrackingError } from '../seo/rankTracking/types.js';

export interface WebVisibilityCheckResult {
  id: string;
  term: string;
  isOwnBrand: boolean;
  device: string;
  position: number | null;
  rankingUrl: string | null;
  createdAt: string;
}

function toResult(row: Record<string, any>): WebVisibilityCheckResult {
  return {
    id: row.id,
    term: row.term,
    isOwnBrand: row.is_own_brand,
    device: row.device,
    position: row.position,
    rankingUrl: row.ranking_url,
    createdAt: row.created_at,
  };
}

export async function isWebVisibilityAvailable(config: ServerConfig): Promise<boolean> {
  const info = await getRankTrackingProviderInfo(config);
  return info.configured && info.enabled;
}

export async function runWebVisibilityCheck(
  config: ServerConfig,
  args: { workspaceId: string; term: string; isOwnBrand: boolean; targetHost: string; userId: string },
): Promise<WebVisibilityCheckResult> {
  const { result } = await checkKeywordRank(config, { keyword: args.term, targetHost: args.targetHost, device: 'desktop' });

  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('brand_radar_web_checks')
    .insert({
      workspace_id: args.workspaceId,
      term: args.term,
      is_own_brand: args.isOwnBrand,
      device: 'desktop',
      position: result.position,
      ranking_url: result.rankingUrl,
      checked_by: args.userId,
    })
    .select('*')
    .single();
  if (error || !data) throw new Error(`brand_radar_web_check_save_failed: ${error?.message}`);
  return toResult(data);
}

export async function runAllTermsWebVisibility(
  config: ServerConfig,
  args: { workspaceId: string; brandName: string; competitorNames: string[]; targetHost: string; userId: string },
): Promise<{ results: WebVisibilityCheckResult[]; errors: Array<{ term: string; code: string }> }> {
  const terms: Array<{ term: string; isOwnBrand: boolean }> = [
    { term: args.brandName, isOwnBrand: true },
    ...args.competitorNames.map((c) => ({ term: c, isOwnBrand: false })),
  ];
  const results: WebVisibilityCheckResult[] = [];
  const errors: Array<{ term: string; code: string }> = [];
  for (const t of terms) {
    try {
      results.push(await runWebVisibilityCheck(config, { workspaceId: args.workspaceId, term: t.term, isOwnBrand: t.isOwnBrand, targetHost: args.targetHost, userId: args.userId }));
    } catch (err) {
      errors.push({ term: t.term, code: isRankTrackingError(err) ? err.code : 'rank_tracking_provider_error' });
    }
  }
  return { results, errors };
}

/** Most recent check per tracked term (the "current web visibility state"). */
export async function getLatestWebChecks(config: ServerConfig, workspaceId: string): Promise<WebVisibilityCheckResult[]> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('brand_radar_web_checks')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw new Error(`brand_radar_web_checks_read_failed: ${error.message}`);
  const rows = (data || []) as Record<string, any>[];
  const latestByTerm = new Map<string, Record<string, any>>();
  for (const row of rows) {
    const key = `${row.term.toLowerCase()}:${row.device}`;
    if (!latestByTerm.has(key)) latestByTerm.set(key, row);
  }
  return Array.from(latestByTerm.values()).map(toResult);
}

export async function getWebCheckHistory(config: ServerConfig, workspaceId: string, term?: string): Promise<WebVisibilityCheckResult[]> {
  const sb = getServiceClient(config);
  let query = sb.from('brand_radar_web_checks').select('*').eq('workspace_id', workspaceId).order('created_at', { ascending: false }).limit(100);
  if (term) query = query.eq('term', term);
  const { data, error } = await query;
  if (error) throw new Error(`brand_radar_web_checks_read_failed: ${error.message}`);
  return (data || []).map(toResult);
}
