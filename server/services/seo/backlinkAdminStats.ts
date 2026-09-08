/**
 * SEO Backlinks — platform-wide (cross-workspace) visibility for Super
 * Admin. Everything the workspace-scoped `backlinkService.ts` does is
 * scoped by `workspace_id`; this file is the deliberate exception, used
 * ONLY by admin routes gated by `requireAdmin` (server/routes/admin.ts).
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

export interface BacklinksPlatformStats {
  totalScans: number;
  completedScans: number;
  runningScans: number;
  failedScans: number;
  workspacesUsed: number;
  totalBacklinksFetched: number;
}

export async function getBacklinksPlatformStats(config: ServerConfig): Promise<BacklinksPlatformStats> {
  const sb = getServiceClient(config);

  const [total, completed, running, failed, workspaceRows, sumRows] = await Promise.all([
    sb.from('seo_backlink_scans').select('id', { count: 'exact', head: true }),
    sb.from('seo_backlink_scans').select('id', { count: 'exact', head: true }).eq('status', 'completed'),
    sb.from('seo_backlink_scans').select('id', { count: 'exact', head: true }).in('status', ['queued', 'running', 'processing']),
    sb.from('seo_backlink_scans').select('id', { count: 'exact', head: true }).eq('status', 'failed'),
    sb.from('seo_backlink_scans').select('workspace_id'),
    sb.from('seo_backlink_scans').select('total_backlinks').eq('status', 'completed'),
  ]);

  const uniqueWorkspaces = new Set((workspaceRows.data || []).map((r: { workspace_id: string }) => r.workspace_id));
  const totalBacklinksFetched = (sumRows.data || []).reduce((sum: number, r: { total_backlinks: number | null }) => sum + (r.total_backlinks || 0), 0);

  return {
    totalScans: total.count || 0,
    completedScans: completed.count || 0,
    runningScans: running.count || 0,
    failedScans: failed.count || 0,
    workspacesUsed: uniqueWorkspaces.size,
    totalBacklinksFetched,
  };
}

export interface RecentBacklinkScanRow {
  id: string;
  workspace_id: string;
  workspace_name: string | null;
  target_url: string;
  provider: string;
  status: string;
  total_backlinks: number | null;
  referring_domains: number | null;
  error_category: string | null;
  created_at: string;
  finished_at: string | null;
}

export async function listRecentBacklinkScansAcrossWorkspaces(config: ServerConfig, limit = 20): Promise<RecentBacklinkScanRow[]> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('seo_backlink_scans')
    .select('id, workspace_id, target_url, provider, status, total_backlinks, referring_domains, error_category, created_at, finished_at, workspaces(name)')
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 100));
  if (error) throw new Error(`list_recent_backlink_scans_failed: ${error.message}`);
  return ((data || []) as any[]).map((row) => ({
    id: row.id,
    workspace_id: row.workspace_id,
    workspace_name: row.workspaces?.name ?? null,
    target_url: row.target_url,
    provider: row.provider,
    status: row.status,
    total_backlinks: row.total_backlinks,
    referring_domains: row.referring_domains,
    error_category: row.error_category,
    created_at: row.created_at,
    finished_at: row.finished_at,
  }));
}
