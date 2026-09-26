/**
 * SEO Rank Tracking — plan-limit resolver.
 *
 * Every limit here is a registry capability and resolves exactly as
 * GET /api/plans/workspace/:id/effective shows it: workspace override ??
 * plan ?? registry default (billing/servicePlanLimits.ts). A platform admin
 * changes them per plan in the existing plan editor.
 *
 * Two limits here, neither shaped like a "per-request" cap:
 * `seo_rank_tracking_max_keywords` bounds the size of a site's persistent
 * watchlist (enforced when a keyword is added, in
 * server/services/seo/rankTrackingService.ts), and
 * `seo_rank_tracking_check_frequency_hours` is read by rankTrackingTicker.ts
 * to decide how often each tracked keyword is re-checked. Opt-in per plan
 * (registry default 0 keywords) because every check costs the platform real
 * money.
 */
import type { ServerConfig } from '../../config.js';
import { readServicePlanInfo, registryLimits, servicePlanIdentity } from '../billing/servicePlanLimits.js';
import { getServiceClient } from '../../supabase.js';

export interface SeoRankTrackingLimits {
  seo_rank_tracking_max_keywords: number;
  seo_rank_tracking_check_frequency_hours: number;
}

/** Registry limits: override ?? plan ?? registry default. */
export const SEO_RANK_TRACKING_PLAN_KEYS = [
  'seo_rank_tracking_max_keywords',
  'seo_rank_tracking_check_frequency_hours',
] as const satisfies readonly (keyof SeoRankTrackingLimits)[];

export interface ResolvedSeoRankTrackingLimits {
  limits: SeoRankTrackingLimits;
  planSlug: string | null;
  planName: string | null;
}

export async function resolveRankTrackingLimits(config: ServerConfig, workspaceId: string): Promise<ResolvedSeoRankTrackingLimits> {
  const info = await readServicePlanInfo(config, workspaceId);
  return { ...servicePlanIdentity(info), limits: registryLimits(info, SEO_RANK_TRACKING_PLAN_KEYS) };
}

export async function countActiveTrackedKeywords(config: ServerConfig, websiteId: string): Promise<number> {
  const sb = getServiceClient(config);
  const { count } = await sb
    .from('seo_tracked_keywords')
    .select('id', { count: 'exact', head: true })
    .eq('website_id', websiteId)
    .eq('is_active', true);
  return count || 0;
}
