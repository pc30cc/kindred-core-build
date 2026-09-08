/**
 * SEO Rank Tracking — platform-wide (cross-workspace) visibility for Super
 * Admin. Mirrors server/services/seo/backlinkAdminStats.ts's shape, adapted
 * for a watchlist + check-history model instead of one-shot runs.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

export interface RankTrackingPlatformStats {
  totalTrackedKeywords: number;
  activeTrackedKeywords: number;
  workspacesUsed: number;
  checksLast24h: number;
}

export async function getRankTrackingPlatformStats(config: ServerConfig): Promise<RankTrackingPlatformStats> {
  const sb = getServiceClient(config);
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();

  const [total, active, workspaceRows, checksRecent] = await Promise.all([
    sb.from('seo_tracked_keywords').select('id', { count: 'exact', head: true }),
    sb.from('seo_tracked_keywords').select('id', { count: 'exact', head: true }).eq('is_active', true),
    sb.from('seo_tracked_keywords').select('workspace_id'),
    sb.from('seo_rank_checks').select('id', { count: 'exact', head: true }).gte('checked_at', since),
  ]);

  const uniqueWorkspaces = new Set((workspaceRows.data || []).map((r: { workspace_id: string }) => r.workspace_id));

  return {
    totalTrackedKeywords: total.count || 0,
    activeTrackedKeywords: active.count || 0,
    workspacesUsed: uniqueWorkspaces.size,
    checksLast24h: checksRecent.count || 0,
  };
}

export interface RecentRankCheckRow {
  id: string;
  workspace_id: string;
  workspace_name: string | null;
  keyword: string;
  position: number | null;
  provider: string;
  checked_at: string;
}

export async function listRecentRankChecksAcrossWorkspaces(config: ServerConfig, limit = 20): Promise<RecentRankCheckRow[]> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('seo_rank_checks')
    .select('id, workspace_id, position, provider, checked_at, tracked_keyword:tracked_keyword_id(keyword), workspaces(name)')
    .order('checked_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 100));
  if (error) throw new Error(`list_recent_rank_checks_failed: ${error.message}`);
  return ((data || []) as any[]).map((row) => ({
    id: row.id,
    workspace_id: row.workspace_id,
    workspace_name: row.workspaces?.name ?? null,
    keyword: row.tracked_keyword?.keyword ?? '—',
    position: row.position,
    provider: row.provider,
    checked_at: row.checked_at,
  }));
}
