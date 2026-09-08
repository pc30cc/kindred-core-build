/**
 * SEO Site Explorer — platform-wide (cross-workspace) visibility for Super
 * Admin. Mirrors server/services/seo/backlinkAdminStats.ts's shape, merged
 * across the two Explorer scan kinds (backlinks + organic keywords) since
 * they share one module/limit budget (seo_site_explorer).
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

export interface ExplorerPlatformStats {
  totalLookups: number;
  completedLookups: number;
  runningLookups: number;
  failedLookups: number;
  workspacesUsed: number;
  backlinkLookups: number;
  keywordLookups: number;
}

export async function getExplorerPlatformStats(config: ServerConfig): Promise<ExplorerPlatformStats> {
  const sb = getServiceClient(config);

  const [
    bTotal, bCompleted, bRunning, bFailed, bWorkspaces,
    kTotal, kCompleted, kRunning, kFailed, kWorkspaces,
  ] = await Promise.all([
    sb.from('seo_explorer_backlink_scans').select('id', { count: 'exact', head: true }),
    sb.from('seo_explorer_backlink_scans').select('id', { count: 'exact', head: true }).eq('status', 'completed'),
    sb.from('seo_explorer_backlink_scans').select('id', { count: 'exact', head: true }).in('status', ['queued', 'running', 'processing']),
    sb.from('seo_explorer_backlink_scans').select('id', { count: 'exact', head: true }).eq('status', 'failed'),
    sb.from('seo_explorer_backlink_scans').select('workspace_id'),
    sb.from('seo_explorer_keyword_scans').select('id', { count: 'exact', head: true }),
    sb.from('seo_explorer_keyword_scans').select('id', { count: 'exact', head: true }).eq('status', 'completed'),
    sb.from('seo_explorer_keyword_scans').select('id', { count: 'exact', head: true }).in('status', ['queued', 'running', 'processing']),
    sb.from('seo_explorer_keyword_scans').select('id', { count: 'exact', head: true }).eq('status', 'failed'),
    sb.from('seo_explorer_keyword_scans').select('workspace_id'),
  ]);

  const uniqueWorkspaces = new Set<string>([
    ...((bWorkspaces.data || []) as { workspace_id: string }[]).map((r) => r.workspace_id),
    ...((kWorkspaces.data || []) as { workspace_id: string }[]).map((r) => r.workspace_id),
  ]);

  return {
    totalLookups: (bTotal.count || 0) + (kTotal.count || 0),
    completedLookups: (bCompleted.count || 0) + (kCompleted.count || 0),
    runningLookups: (bRunning.count || 0) + (kRunning.count || 0),
    failedLookups: (bFailed.count || 0) + (kFailed.count || 0),
    workspacesUsed: uniqueWorkspaces.size,
    backlinkLookups: bTotal.count || 0,
    keywordLookups: kTotal.count || 0,
  };
}

export interface RecentExplorerLookupRow {
  id: string;
  workspace_id: string;
  workspace_name: string | null;
  kind: 'backlinks' | 'keywords';
  target_domain: string;
  status: string;
  result_count: number | null;
  created_at: string;
}

export async function listRecentExplorerLookupsAcrossWorkspaces(config: ServerConfig, limit = 20): Promise<RecentExplorerLookupRow[]> {
  const sb = getServiceClient(config);
  const capped = Math.min(Math.max(limit, 1), 100);

  const [backlinkScans, keywordScans] = await Promise.all([
    sb.from('seo_explorer_backlink_scans')
      .select('id, workspace_id, target_domain, status, total_backlinks, created_at, workspaces(name)')
      .order('created_at', { ascending: false })
      .limit(capped),
    sb.from('seo_explorer_keyword_scans')
      .select('id, workspace_id, target_domain, status, total_keywords, created_at, workspaces(name)')
      .order('created_at', { ascending: false })
      .limit(capped),
  ]);
  if (backlinkScans.error) throw new Error(`list_recent_explorer_backlink_scans_failed: ${backlinkScans.error.message}`);
  if (keywordScans.error) throw new Error(`list_recent_explorer_keyword_scans_failed: ${keywordScans.error.message}`);

  const rows: RecentExplorerLookupRow[] = [
    ...((backlinkScans.data || []) as any[]).map((row) => ({
      id: row.id,
      workspace_id: row.workspace_id,
      workspace_name: row.workspaces?.name ?? null,
      kind: 'backlinks' as const,
      target_domain: row.target_domain,
      status: row.status,
      result_count: row.total_backlinks,
      created_at: row.created_at,
    })),
    ...((keywordScans.data || []) as any[]).map((row) => ({
      id: row.id,
      workspace_id: row.workspace_id,
      workspace_name: row.workspaces?.name ?? null,
      kind: 'keywords' as const,
      target_domain: row.target_domain,
      status: row.status,
      result_count: row.total_keywords,
      created_at: row.created_at,
    })),
  ];

  return rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, capped);
}
