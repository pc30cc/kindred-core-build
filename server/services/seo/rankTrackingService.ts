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

// ─── Overview ────────────────────────────────────────────────────────────
// Pure rollup over already-persisted seo_tracked_keywords + seo_rank_checks
// — no new provider call, mirrors the "bounded query, aggregate in-process"
// convention used by Web Analytics' reportService.ts.

const RANK_CHECKS_ROW_CAP = 5000;

export interface RankTrackingMover {
  keywordId: string;
  keyword: string;
  previousPosition: number | null;
  currentPosition: number | null;
  delta: number | null;
}

export interface RankTrackingOverviewStats {
  totalKeywords: number;
  avgPosition: number | null;
  distribution: { top3: number; top10: number; top50: number; top100: number; notRanked: number };
  improved: number;
  declined: number;
  unchanged: number;
  topMovers: RankTrackingMover[];
}

export async function getRankTrackingOverview(config: ServerConfig, workspaceId: string, siteId: string): Promise<RankTrackingOverviewStats> {
  const sb = getServiceClient(config);
  const { data: keywordRows, error: kwError } = await sb
    .from('seo_tracked_keywords')
    .select('id, keyword, last_position')
    .eq('workspace_id', workspaceId)
    .eq('website_id', siteId)
    .eq('is_active', true)
    .limit(1000);
  if (kwError) throw new Error(`rank_tracking_overview_keywords_failed: ${kwError.message}`);
  const keywords = (keywordRows || []) as Array<{ id: string; keyword: string; last_position: number | null }>;

  const empty: RankTrackingOverviewStats = {
    totalKeywords: 0,
    avgPosition: null,
    distribution: { top3: 0, top10: 0, top50: 0, top100: 0, notRanked: 0 },
    improved: 0,
    declined: 0,
    unchanged: 0,
    topMovers: [],
  };
  if (keywords.length === 0) return empty;

  const keywordIds = keywords.map((k) => k.id);
  const { data: checkRows, error: checksError } = await sb
    .from('seo_rank_checks')
    .select('tracked_keyword_id, position, checked_at')
    .eq('website_id', siteId)
    .in('tracked_keyword_id', keywordIds)
    .order('checked_at', { ascending: false })
    .limit(RANK_CHECKS_ROW_CAP);
  if (checksError) throw new Error(`rank_tracking_overview_checks_failed: ${checksError.message}`);

  // Grouped while iterating an already checked_at-desc-sorted list, so each
  // group's [0] is the most recent check and [1] the one before it.
  const checksByKeyword = new Map<string, Array<{ position: number | null }>>();
  for (const row of (checkRows || []) as Array<{ tracked_keyword_id: string; position: number | null }>) {
    const list = checksByKeyword.get(row.tracked_keyword_id) || [];
    list.push(row);
    checksByKeyword.set(row.tracked_keyword_id, list);
  }

  const distribution = { top3: 0, top10: 0, top50: 0, top100: 0, notRanked: 0 };
  let positionSum = 0;
  let positionCount = 0;
  let improved = 0;
  let declined = 0;
  let unchanged = 0;
  const movers: RankTrackingMover[] = [];

  for (const kw of keywords) {
    const current = kw.last_position;
    if (current === null) distribution.notRanked += 1;
    else {
      positionSum += current;
      positionCount += 1;
      if (current <= 3) distribution.top3 += 1;
      else if (current <= 10) distribution.top10 += 1;
      else if (current <= 50) distribution.top50 += 1;
      else distribution.top100 += 1;
    }

    const history = checksByKeyword.get(kw.id) || [];
    const previous = history.length > 1 ? history[1].position : null;

    if (previous === null && current === null) unchanged += 1;
    else if (previous === null && current !== null) improved += 1;
    else if (previous !== null && current === null) declined += 1;
    else if (previous !== null && current !== null) {
      if (current < previous) improved += 1;
      else if (current > previous) declined += 1;
      else unchanged += 1;
    }

    if (previous !== null && current !== null && previous !== current) {
      movers.push({ keywordId: kw.id, keyword: kw.keyword, previousPosition: previous, currentPosition: current, delta: previous - current });
    }
  }

  movers.sort((a, b) => Math.abs(b.delta || 0) - Math.abs(a.delta || 0));

  return {
    totalKeywords: keywords.length,
    avgPosition: positionCount > 0 ? Math.round((positionSum / positionCount) * 10) / 10 : null,
    distribution,
    improved,
    declined,
    unchanged,
    topMovers: movers.slice(0, 10),
  };
}

// ─── Landscape ───────────────────────────────────────────────────────────

export interface RankTrackingLandscapePoint {
  date: string;
  avgPosition: number | null;
  keywordsChecked: number;
  top10Count: number;
}

export async function getRankTrackingLandscape(
  config: ServerConfig, workspaceId: string, siteId: string, opts: { days?: number } = {},
): Promise<{ points: RankTrackingLandscapePoint[] }> {
  const sb = getServiceClient(config);
  const days = Math.min(Math.max(opts.days ?? 90, 1), 365);
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - (days - 1));

  const { data, error } = await sb
    .from('seo_rank_checks')
    .select('position, checked_at')
    .eq('workspace_id', workspaceId)
    .eq('website_id', siteId)
    .gte('checked_at', since.toISOString())
    .order('checked_at', { ascending: true })
    .limit(RANK_CHECKS_ROW_CAP);
  if (error) throw new Error(`rank_tracking_landscape_failed: ${error.message}`);

  const byDate = new Map<string, { sum: number; count: number; top10: number; checked: number }>();
  for (const row of (data || []) as Array<{ position: number | null; checked_at: string }>) {
    const day = row.checked_at.slice(0, 10);
    const bucket = byDate.get(day) || { sum: 0, count: 0, top10: 0, checked: 0 };
    bucket.checked += 1;
    if (row.position !== null) {
      bucket.sum += row.position;
      bucket.count += 1;
      if (row.position <= 10) bucket.top10 += 1;
    }
    byDate.set(day, bucket);
  }

  const points = Array.from(byDate.entries())
    .map(([date, v]) => ({
      date,
      avgPosition: v.count > 0 ? Math.round((v.sum / v.count) * 10) / 10 : null,
      keywordsChecked: v.checked,
      top10Count: v.top10,
    }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  return { points };
}

export { SiteResolutionError };
