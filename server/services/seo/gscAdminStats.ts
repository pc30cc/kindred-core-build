/**
 * SEO GSC Insights — platform-wide (cross-workspace) visibility for Super
 * Admin. Mirrors server/services/seo/backlinkAdminStats.ts's shape. Used
 * ONLY by admin routes gated by `requireAdmin` (server/routes/admin.ts).
 *
 * Unlike the other SEO modules there is no vendor credential stored in the
 * database to report on — the Google OAuth client id/secret live in the
 * server environment (server/services/seo/gsc/oauthConfig.ts). What IS
 * platform-wide here is workspace adoption: how many workspaces connected
 * their own Google account, and how many Search Console properties they
 * linked.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

export interface GscPlatformStats {
  totalConnections: number;
  activeConnections: number;
  revokedConnections: number;
  errorConnections: number;
  totalPropertiesLinked: number;
}

export async function getGscPlatformStats(config: ServerConfig): Promise<GscPlatformStats> {
  const sb = getServiceClient(config);

  const [total, active, revoked, error, properties] = await Promise.all([
    sb.from('seo_gsc_connections').select('id', { count: 'exact', head: true }),
    sb.from('seo_gsc_connections').select('id', { count: 'exact', head: true }).eq('status', 'active'),
    sb.from('seo_gsc_connections').select('id', { count: 'exact', head: true }).eq('status', 'revoked'),
    sb.from('seo_gsc_connections').select('id', { count: 'exact', head: true }).eq('status', 'error'),
    sb.from('seo_gsc_properties').select('id', { count: 'exact', head: true }),
  ]);

  return {
    totalConnections: total.count || 0,
    activeConnections: active.count || 0,
    revokedConnections: revoked.count || 0,
    errorConnections: error.count || 0,
    totalPropertiesLinked: properties.count || 0,
  };
}

export interface RecentGscConnectionRow {
  workspace_id: string;
  workspace_name: string | null;
  google_account_email: string | null;
  status: string;
  properties_linked: number;
  created_at: string;
}

export async function listRecentGscConnectionsAcrossWorkspaces(config: ServerConfig, limit = 20): Promise<RecentGscConnectionRow[]> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('seo_gsc_connections')
    .select('workspace_id, google_account_email, status, created_at, workspaces(name)')
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 100));
  if (error) throw new Error(`list_recent_gsc_connections_failed: ${error.message}`);

  const rows = (data || []) as any[];
  const workspaceIds = rows.map((r) => r.workspace_id);
  const { data: propertyCounts } = workspaceIds.length
    ? await sb.from('seo_gsc_properties').select('workspace_id').in('workspace_id', workspaceIds)
    : { data: [] as { workspace_id: string }[] };
  const countByWorkspace = new Map<string, number>();
  for (const p of propertyCounts || []) {
    countByWorkspace.set(p.workspace_id, (countByWorkspace.get(p.workspace_id) || 0) + 1);
  }

  return rows.map((row) => ({
    workspace_id: row.workspace_id,
    workspace_name: row.workspaces?.name ?? null,
    google_account_email: row.google_account_email,
    status: row.status,
    properties_linked: countByWorkspace.get(row.workspace_id) || 0,
    created_at: row.created_at,
  }));
}
