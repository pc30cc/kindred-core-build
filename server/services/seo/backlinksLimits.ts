/**
 * SEO Backlinks — plan-limit resolver.
 *
 * Every limit here is a registry capability and resolves exactly as
 * GET /api/plans/workspace/:id/effective shows it: workspace override ??
 * plan ?? registry default (billing/servicePlanLimits.ts). A platform admin
 * changes them per plan in the existing plan editor.
 *
 * Unlike the SEO crawl module (always on, defaultValue: true in the
 * registry), backlink scans call a paid external vendor per request, so the
 * registry default is 0 backlinks per scan (the module is opt-in per plan).
 *
 * The UI NEVER hardcodes a limit number; every limit shown to the user comes
 * from the API response, which comes from here.
 */
import type { ServerConfig } from '../../config.js';
import { readServicePlanInfo, registryLimits, servicePlanIdentity } from '../billing/servicePlanLimits.js';
import { getServiceClient } from '../../supabase.js';

export interface SeoBacklinksLimits {
  seo_backlinks_max_per_scan: number;
  seo_backlinks_workspace_concurrent_scans: number;
  seo_backlinks_scan_frequency_hours: number;
}

/** Registry limits: override ?? plan ?? registry default. */
export const SEO_BACKLINKS_PLAN_KEYS = [
  'seo_backlinks_max_per_scan',
  'seo_backlinks_workspace_concurrent_scans',
  'seo_backlinks_scan_frequency_hours',
] as const satisfies readonly (keyof SeoBacklinksLimits)[];

export interface ResolvedSeoBacklinksLimits {
  limits: SeoBacklinksLimits;
  planSlug: string | null;
  planName: string | null;
}

export async function resolveBacklinksLimits(config: ServerConfig, workspaceId: string): Promise<ResolvedSeoBacklinksLimits> {
  const info = await readServicePlanInfo(config, workspaceId);
  return { ...servicePlanIdentity(info), limits: registryLimits(info, SEO_BACKLINKS_PLAN_KEYS) };
}

/** Concurrent (queued/running/processing) backlink scans for a whole workspace. */
export async function countActiveWorkspaceBacklinkScans(config: ServerConfig, workspaceId: string): Promise<number> {
  const sb = getServiceClient(config);
  const { count } = await sb
    .from('seo_backlink_scans')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .in('status', ['queued', 'running', 'processing']);
  return count || 0;
}

/** Most recent backlink scan (any status) started for this site, for the frequency-limit check. */
export async function getMostRecentBacklinkScanStart(config: ServerConfig, websiteId: string): Promise<string | null> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('seo_backlink_scans')
    .select('created_at')
    .eq('website_id', websiteId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { created_at: string } | null)?.created_at ?? null;
}
