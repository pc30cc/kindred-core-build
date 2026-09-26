/**
 * SEO GSC Insights — plan-limit resolver.
 *
 * Every limit here is a registry capability and resolves exactly as
 * GET /api/plans/workspace/:id/effective shows it: workspace override ??
 * plan ?? registry default (billing/servicePlanLimits.ts). A platform admin
 * changes them per plan in the existing plan editor.
 *
 * The registry default is 0 properties (opt-in per plan) — the module itself
 * is also plan-gated (`seo_gsc_insights`), but the limit stays independently
 * enforced in case a workspace override enables the module without also
 * raising the property count.
 *
 * The UI NEVER hardcodes a limit number; every limit shown to the user comes
 * from the API response, which comes from here.
 */
import type { ServerConfig } from '../../config.js';
import { readServicePlanInfo, registryLimits, servicePlanIdentity } from '../billing/servicePlanLimits.js';

export interface SeoGscLimits {
  seo_gsc_max_properties: number;
  seo_gsc_sync_frequency_hours: number;
}

/** Registry limits: override ?? plan ?? registry default. */
export const SEO_GSC_PLAN_KEYS = [
  'seo_gsc_max_properties',
  'seo_gsc_sync_frequency_hours',
] as const satisfies readonly (keyof SeoGscLimits)[];

export interface ResolvedSeoGscLimits {
  limits: SeoGscLimits;
  planSlug: string | null;
  planName: string | null;
}

export async function resolveGscLimits(config: ServerConfig, workspaceId: string): Promise<ResolvedSeoGscLimits> {
  const info = await readServicePlanInfo(config, workspaceId);
  return { ...servicePlanIdentity(info), limits: registryLimits(info, SEO_GSC_PLAN_KEYS) };
}
