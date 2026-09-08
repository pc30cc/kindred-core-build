/**
 * SEO Performance Auditing — platform-wide (cross-workspace) visibility for
 * Super Admin. Mirrors server/services/seo/backlinkAdminStats.ts exactly.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

export interface PerformancePlatformStats {
  totalAudits: number;
  completedAudits: number;
  runningAudits: number;
  failedAudits: number;
  workspacesUsed: number;
  totalPagesAudited: number;
}

export async function getPerformancePlatformStats(config: ServerConfig): Promise<PerformancePlatformStats> {
  const sb = getServiceClient(config);

  const [total, completed, running, failed, workspaceRows, sumRows] = await Promise.all([
    sb.from('seo_performance_audits').select('id', { count: 'exact', head: true }),
    sb.from('seo_performance_audits').select('id', { count: 'exact', head: true }).eq('status', 'completed'),
    sb.from('seo_performance_audits').select('id', { count: 'exact', head: true }).in('status', ['queued', 'running', 'processing']),
    sb.from('seo_performance_audits').select('id', { count: 'exact', head: true }).eq('status', 'failed'),
    sb.from('seo_performance_audits').select('workspace_id'),
    sb.from('seo_performance_audits').select('pages_audited').eq('status', 'completed'),
  ]);

  const uniqueWorkspaces = new Set((workspaceRows.data || []).map((r: { workspace_id: string }) => r.workspace_id));
  const totalPagesAudited = (sumRows.data || []).reduce((sum: number, r: { pages_audited: number | null }) => sum + (r.pages_audited || 0), 0);

  return {
    totalAudits: total.count || 0,
    completedAudits: completed.count || 0,
    runningAudits: running.count || 0,
    failedAudits: failed.count || 0,
    workspacesUsed: uniqueWorkspaces.size,
    totalPagesAudited,
  };
}

export interface RecentPerformanceAuditRow {
  id: string;
  workspace_id: string;
  workspace_name: string | null;
  crawl_id: string;
  provider: string;
  status: string;
  pages_audited: number | null;
  error_category: string | null;
  created_at: string;
  finished_at: string | null;
}

export async function listRecentPerformanceAuditsAcrossWorkspaces(config: ServerConfig, limit = 20): Promise<RecentPerformanceAuditRow[]> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('seo_performance_audits')
    .select('id, workspace_id, crawl_id, provider, status, pages_audited, error_category, created_at, finished_at, workspaces(name)')
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 100));
  if (error) throw new Error(`list_recent_performance_audits_failed: ${error.message}`);
  return ((data || []) as any[]).map((row) => ({
    id: row.id,
    workspace_id: row.workspace_id,
    workspace_name: row.workspaces?.name ?? null,
    crawl_id: row.crawl_id,
    provider: row.provider,
    status: row.status,
    pages_audited: row.pages_audited,
    error_category: row.error_category,
    created_at: row.created_at,
    finished_at: row.finished_at,
  }));
}
