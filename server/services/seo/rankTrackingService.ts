/**
 * SEO Rank Tracking — business logic. Owns `seo_tracked_keywords` and
 * `seo_rank_checks`. Unlike backlinks/keyword-research, this module has NO
 * background_jobs job type — a tracked keyword is a persistent watchlist
 * entry, and its rank is refreshed by server/services/seo/rankTrackingTicker.ts
 * on a schedule, not by a one-shot user-triggered run.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { resolveWorkspaceSite, SiteResolutionError } from './siteResolver.js';
import { resolveRankTrackingLimits, countActiveTrackedKeywords } from './rankTrackingLimits.js';

export type TrackedKeywordLimitReason = 'module_not_available' | 'max_keywords_reached' | 'duplicate_keyword';

export class TrackedKeywordLimitError extends Error {
  reason: TrackedKeywordLimitReason;
  constructor(reason: TrackedKeywordLimitReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

export interface SeoTrackedKeywordRow {
  id: string;
  workspace_id: string;
  website_id: string;
  keyword: string;
  device: 'desktop' | 'mobile';
  location_code: number | null;
  is_active: boolean;
  last_position: number | null;
  last_ranking_url: string | null;
  last_checked_at: string | null;
  next_check_at: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export async function addTrackedKeyword(
  config: ServerConfig,
  args: { workspaceId: string; siteId: string; userId: string; keyword: string; device?: 'desktop' | 'mobile' },
): Promise<SeoTrackedKeywordRow> {
  const site = await resolveWorkspaceSite(config, args.workspaceId, args.siteId);
  const { limits } = await resolveRankTrackingLimits(config, args.workspaceId);

  if (limits.seo_rank_tracking_max_keywords <= 0) {
    throw new TrackedKeywordLimitError('module_not_available', 'Rank tracking is not available on this plan');
  }

  const keyword = args.keyword.trim().slice(0, 200);
  if (!keyword) throw new TrackedKeywordLimitError('duplicate_keyword', 'Keyword is required');
  const device = args.device === 'mobile' ? 'mobile' : 'desktop';

  const activeCount = await countActiveTrackedKeywords(config, site.id);
  if (activeCount >= limits.seo_rank_tracking_max_keywords) {
    throw new TrackedKeywordLimitError('max_keywords_reached', `This plan allows up to ${limits.seo_rank_tracking_max_keywords} tracked keywords per site`);
  }

  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('seo_tracked_keywords')
    .insert({
      workspace_id: args.workspaceId,
      website_id: site.id,
      keyword,
      device,
      created_by: args.userId,
      next_check_at: new Date().toISOString(),
    })
    .select('*')
    .single();
  if (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new TrackedKeywordLimitError('duplicate_keyword', 'This keyword is already tracked for this site and device');
    }
    throw new Error(`add_tracked_keyword_failed: ${error.message}`);
  }
  return data as SeoTrackedKeywordRow;
}

/**
 * On-demand rank check for one tracked keyword. Uses the exact same code
 * path as the scheduled ticker so a manual refresh and a scheduled refresh
 * can never diverge.
 */
export async function checkTrackedKeywordNow(
  config: ServerConfig,
  workspaceId: string,
  keywordId: string,
): Promise<SeoTrackedKeywordRow> {
  const sb = getServiceClient(config);
  const { data: row } = await sb
    .from('seo_tracked_keywords')
    .select('*')
    .eq('id', keywordId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (!row) throw new TrackedKeywordLimitError('duplicate_keyword', 'Tracked keyword not found');
  const kw = row as SeoTrackedKeywordRow;
  const { checkOneKeyword } = await import('./rankTrackingTicker.js');
  await checkOneKeyword(config, {
    id: kw.id,
    workspace_id: kw.workspace_id,
    website_id: kw.website_id,
    keyword: kw.keyword,
    device: kw.device,
    location_code: kw.location_code,
  });
  const { data: fresh } = await sb.from('seo_tracked_keywords').select('*').eq('id', keywordId).maybeSingle();
  return (fresh || kw) as SeoTrackedKeywordRow;
}

export async function removeTrackedKeyword(config: ServerConfig, workspaceId: string, keywordId: string): Promise<{ ok: boolean }> {
  const sb = getServiceClient(config);
  const { error } = await sb.from('seo_tracked_keywords').delete().eq('id', keywordId).eq('workspace_id', workspaceId);
  return { ok: !error };
}

export async function listTrackedKeywordsForSite(
  config: ServerConfig,
  workspaceId: string,
  siteId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<{ keywords: SeoTrackedKeywordRow[]; total: number }> {
  const sb = getServiceClient(config);
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  const { data, count, error } = await sb
    .from('seo_tracked_keywords')
    .select('*', { count: 'exact' })
    .eq('workspace_id', workspaceId)
    .eq('website_id', siteId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw new Error(`list_tracked_keywords_failed: ${error.message}`);
  return { keywords: (data || []) as SeoTrackedKeywordRow[], total: count || 0 };
}

export async function listRankChecksForKeyword(
  config: ServerConfig,
  workspaceId: string,
  keywordId: string,
  opts: { limit?: number } = {},
) {
  const sb = getServiceClient(config);
  const limit = Math.min(Math.max(opts.limit ?? 90, 1), 365);
  const { data, error } = await sb
    .from('seo_rank_checks')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('tracked_keyword_id', keywordId)
    .order('checked_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`list_rank_checks_failed: ${error.message}`);
  return { checks: (data || []).reverse() };
}

export { SiteResolutionError };
