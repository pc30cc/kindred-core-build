/**
 * SEO Keyword Research — plan-limit resolver.
 *
 * Every limit here is a registry capability and resolves exactly as
 * GET /api/plans/workspace/:id/effective shows it: workspace override ??
 * plan ?? registry default (billing/servicePlanLimits.ts). A platform admin
 * changes them per plan in the existing plan editor.
 *
 * Opt-in per plan (registry default 0 keywords per lookup) because a vendor
 * lookup costs the platform real money.
 */
import type { ServerConfig } from '../../config.js';
import { readServicePlanInfo, registryLimits, servicePlanIdentity } from '../billing/servicePlanLimits.js';
import { getServiceClient } from '../../supabase.js';

export interface SeoKeywordsLimits {
  seo_keywords_max_per_lookup: number;
  seo_keywords_workspace_concurrent_runs: number;
  seo_keywords_lookup_frequency_hours: number;
}

/** Registry limits: override ?? plan ?? registry default. */
export const SEO_KEYWORDS_PLAN_KEYS = [
  'seo_keywords_max_per_lookup',
  'seo_keywords_workspace_concurrent_runs',
  'seo_keywords_lookup_frequency_hours',
] as const satisfies readonly (keyof SeoKeywordsLimits)[];

export interface ResolvedSeoKeywordsLimits {
  limits: SeoKeywordsLimits;
  planSlug: string | null;
  planName: string | null;
}

export async function resolveKeywordsLimits(config: ServerConfig, workspaceId: string): Promise<ResolvedSeoKeywordsLimits> {
  const info = await readServicePlanInfo(config, workspaceId);
  return { ...servicePlanIdentity(info), limits: registryLimits(info, SEO_KEYWORDS_PLAN_KEYS) };
}

export async function countActiveWorkspaceKeywordRuns(config: ServerConfig, workspaceId: string): Promise<number> {
  const sb = getServiceClient(config);
  const { count } = await sb
    .from('seo_keyword_research_runs')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .in('status', ['queued', 'running', 'processing']);
  return count || 0;
}

export async function getMostRecentKeywordRunStart(config: ServerConfig, websiteId: string): Promise<string | null> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('seo_keyword_research_runs')
    .select('created_at')
    .eq('website_id', websiteId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { created_at: string } | null)?.created_at ?? null;
}
