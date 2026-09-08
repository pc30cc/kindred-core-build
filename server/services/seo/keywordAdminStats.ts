/**
 * SEO Keyword Research — platform-wide (cross-workspace) visibility for
 * Super Admin. Mirrors server/services/seo/backlinkAdminStats.ts exactly.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

export interface KeywordsPlatformStats {
  totalRuns: number;
  completedRuns: number;
  runningRuns: number;
  failedRuns: number;
  workspacesUsed: number;
  totalKeywordsLookedUp: number;
}

export async function getKeywordsPlatformStats(config: ServerConfig): Promise<KeywordsPlatformStats> {
  const sb = getServiceClient(config);

  const [total, completed, running, failed, workspaceRows, sumRows] = await Promise.all([
    sb.from('seo_keyword_research_runs').select('id', { count: 'exact', head: true }),
    sb.from('seo_keyword_research_runs').select('id', { count: 'exact', head: true }).eq('status', 'completed'),
    sb.from('seo_keyword_research_runs').select('id', { count: 'exact', head: true }).in('status', ['queued', 'running', 'processing']),
    sb.from('seo_keyword_research_runs').select('id', { count: 'exact', head: true }).eq('status', 'failed'),
    sb.from('seo_keyword_research_runs').select('workspace_id'),
    sb.from('seo_keyword_research_runs').select('total_keywords').eq('status', 'completed'),
  ]);

  const uniqueWorkspaces = new Set((workspaceRows.data || []).map((r: { workspace_id: string }) => r.workspace_id));
  const totalKeywordsLookedUp = (sumRows.data || []).reduce((sum: number, r: { total_keywords: number | null }) => sum + (r.total_keywords || 0), 0);

  return {
    totalRuns: total.count || 0,
    completedRuns: completed.count || 0,
    runningRuns: running.count || 0,
    failedRuns: failed.count || 0,
    workspacesUsed: uniqueWorkspaces.size,
    totalKeywordsLookedUp,
  };
}

export interface RecentKeywordRunRow {
  id: string;
  workspace_id: string;
  workspace_name: string | null;
  seed_keywords: string[];
  provider: string;
  status: string;
  total_keywords: number | null;
  error_category: string | null;
  created_at: string;
  finished_at: string | null;
}

export async function listRecentKeywordRunsAcrossWorkspaces(config: ServerConfig, limit = 20): Promise<RecentKeywordRunRow[]> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('seo_keyword_research_runs')
    .select('id, workspace_id, seed_keywords, provider, status, total_keywords, error_category, created_at, finished_at, workspaces(name)')
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 100));
  if (error) throw new Error(`list_recent_keyword_runs_failed: ${error.message}`);
  return ((data || []) as any[]).map((row) => ({
    id: row.id,
    workspace_id: row.workspace_id,
    workspace_name: row.workspaces?.name ?? null,
    seed_keywords: row.seed_keywords || [],
    provider: row.provider,
    status: row.status,
    total_keywords: row.total_keywords,
    error_category: row.error_category,
    created_at: row.created_at,
    finished_at: row.finished_at,
  }));
}
