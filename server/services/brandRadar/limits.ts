/**
 * Brand Radar — plan-limit resolver.
 *
 * Every limit here is a registry capability and resolves exactly as
 * GET /api/plans/workspace/:id/effective shows it: workspace override ??
 * plan ?? registry default (billing/servicePlanLimits.ts). A platform admin
 * changes them per plan in the existing plan editor.
 */
import type { ServerConfig } from '../../config.js';
import { readServicePlanInfo, registryLimits, servicePlanIdentity } from '../billing/servicePlanLimits.js';

export interface BrandRadarLimits {
  brand_radar_max_topics: number;
  brand_radar_max_competitors: number;
  /** -1 = no minimum wait between "run checks now" triggers. */
  brand_radar_check_frequency_hours: number;
}

/** Registry limits: override ?? plan ?? registry default. */
export const BRAND_RADAR_PLAN_KEYS = [
  'brand_radar_max_topics',
  'brand_radar_max_competitors',
  'brand_radar_check_frequency_hours',
] as const satisfies readonly (keyof BrandRadarLimits)[];

export interface ResolvedBrandRadarLimits {
  limits: BrandRadarLimits;
  planSlug: string | null;
  planName: string | null;
}

export async function resolveBrandRadarLimits(config: ServerConfig, workspaceId: string): Promise<ResolvedBrandRadarLimits> {
  const info = await readServicePlanInfo(config, workspaceId);
  return { ...servicePlanIdentity(info), limits: registryLimits(info, BRAND_RADAR_PLAN_KEYS) };
}
