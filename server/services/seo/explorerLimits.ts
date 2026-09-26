/**
 * SEO Site Explorer — plan-limit resolver.
 *
 * Every limit here is a registry capability and resolves exactly as
 * GET /api/plans/workspace/:id/effective shows it: workspace override ??
 * plan ?? registry default (billing/servicePlanLimits.ts). A platform admin
 * changes them per plan in the existing plan editor.
 *
 * The per-scan registry defaults are 0 (opt-in per plan) since every lookup
 * costs the platform a real DataForSEO API call against a domain the
 * workspace doesn't necessarily own.
 *
 * The UI NEVER hardcodes a limit number; every limit shown to the user comes
 * from the API response, which comes from here.
 */
import type { ServerConfig } from '../../config.js';
import { readServicePlanInfo, registryLimits, servicePlanIdentity } from '../billing/servicePlanLimits.js';
import { getServiceClient } from '../../supabase.js';

export interface SeoExplorerLimits {
  seo_explorer_max_backlinks_per_scan: number;
  seo_explorer_max_keywords_per_scan: number;
  seo_explorer_workspace_concurrent_scans: number;
  seo_explorer_scan_frequency_hours: number;
}

/** Registry limits: override ?? plan ?? registry default. */
export const SEO_EXPLORER_PLAN_KEYS = [
  'seo_explorer_max_backlinks_per_scan',
  'seo_explorer_max_keywords_per_scan',
  'seo_explorer_workspace_concurrent_scans',
  'seo_explorer_scan_frequency_hours',
] as const satisfies readonly (keyof SeoExplorerLimits)[];

export interface ResolvedSeoExplorerLimits {
  limits: SeoExplorerLimits;
  planSlug: string | null;
  planName: string | null;
}

export async function resolveExplorerLimits(config: ServerConfig, workspaceId: string): Promise<ResolvedSeoExplorerLimits> {
  const info = await readServicePlanInfo(config, workspaceId);
  return { ...servicePlanIdentity(info), limits: registryLimits(info, SEO_EXPLORER_PLAN_KEYS) };
}

/** Backlink + keyword + competitor Explorer scans currently queued/running/processing for the whole workspace — one shared concurrency budget. */
export async function countActiveWorkspaceExplorerScans(config: ServerConfig, workspaceId: string): Promise<number> {
  const sb = getServiceClient(config);
  const [{ count: backlinkCount }, { count: keywordCount }, { count: competitorCount }] = await Promise.all([
    sb.from('seo_explorer_backlink_scans').select('*', { count: 'exact', head: true }).eq('workspace_id', workspaceId).in('status', ['queued', 'running', 'processing']),
    sb.from('seo_explorer_keyword_scans').select('*', { count: 'exact', head: true }).eq('workspace_id', workspaceId).in('status', ['queued', 'running', 'processing']),
    sb.from('seo_explorer_competitor_scans').select('*', { count: 'exact', head: true }).eq('workspace_id', workspaceId).in('status', ['queued', 'running', 'processing']),
  ]);
  return (backlinkCount || 0) + (keywordCount || 0) + (competitorCount || 0);
}

/** Most recent successfully completed Explorer backlink scan for this exact domain. Failed or in-progress attempts never start the cooldown. */
export async function getMostRecentCompletedExplorerBacklinkScan(config: ServerConfig, workspaceId: string, domain: string): Promise<string | null> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('seo_explorer_backlink_scans')
    .select('finished_at')
    .eq('workspace_id', workspaceId)
    .eq('target_domain', domain)
    .eq('status', 'completed')
    .not('finished_at', 'is', null)
    .order('finished_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { finished_at: string | null } | null)?.finished_at ?? null;
}

/** Most recent successfully completed Explorer keyword scan for this exact domain. Failed or in-progress attempts never start the cooldown. */
export async function getMostRecentCompletedExplorerKeywordScan(config: ServerConfig, workspaceId: string, domain: string): Promise<string | null> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('seo_explorer_keyword_scans')
    .select('finished_at')
    .eq('workspace_id', workspaceId)
    .eq('target_domain', domain)
    .eq('status', 'completed')
    .not('finished_at', 'is', null)
    .order('finished_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { finished_at: string | null } | null)?.finished_at ?? null;
}

/** Most recent successfully completed Explorer competitor scan for this exact domain. Failed or in-progress attempts never start the cooldown. */
export async function getMostRecentCompletedExplorerCompetitorScan(config: ServerConfig, workspaceId: string, domain: string): Promise<string | null> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('seo_explorer_competitor_scans')
    .select('finished_at')
    .eq('workspace_id', workspaceId)
    .eq('target_domain', domain)
    .eq('status', 'completed')
    .not('finished_at', 'is', null)
    .order('finished_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { finished_at: string | null } | null)?.finished_at ?? null;
}
