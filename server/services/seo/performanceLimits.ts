/**
 * SEO Performance Auditing — plan-limit resolver.
 *
 * Every limit here is a registry capability and resolves exactly as
 * GET /api/plans/workspace/:id/effective shows it: workspace override ??
 * plan ?? registry default (billing/servicePlanLimits.ts). A platform admin
 * changes them per plan in the existing plan editor.
 *
 * The registry default is 0 pages (opt-in per plan) since each audited page
 * costs the platform a real PageSpeed Insights API call.
 *
 * The UI NEVER hardcodes a limit number; every limit shown to the user comes
 * from the API response, which comes from here.
 */
import type { ServerConfig } from '../../config.js';
import { readServicePlanInfo, registryLimits, servicePlanIdentity } from '../billing/servicePlanLimits.js';
import { getServiceClient } from '../../supabase.js';

export interface SeoPerformanceLimits {
  seo_performance_max_pages_per_audit: number;
  seo_performance_audit_frequency_hours: number;
}

/** Registry limits: override ?? plan ?? registry default. */
export const SEO_PERFORMANCE_PLAN_KEYS = [
  'seo_performance_max_pages_per_audit',
  'seo_performance_audit_frequency_hours',
] as const satisfies readonly (keyof SeoPerformanceLimits)[];

export interface ResolvedSeoPerformanceLimits {
  limits: SeoPerformanceLimits;
  planSlug: string | null;
  planName: string | null;
}

export async function resolvePerformanceLimits(config: ServerConfig, workspaceId: string): Promise<ResolvedSeoPerformanceLimits> {
  const info = await readServicePlanInfo(config, workspaceId);
  return { ...servicePlanIdentity(info), limits: registryLimits(info, SEO_PERFORMANCE_PLAN_KEYS) };
}

/** Most recent performance audit (any status) started for this crawl, for the frequency-limit check. */
export async function getMostRecentPerformanceAuditStart(config: ServerConfig, crawlId: string): Promise<string | null> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('seo_performance_audits')
    .select('created_at')
    .eq('crawl_id', crawlId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { created_at: string } | null)?.created_at ?? null;
}
