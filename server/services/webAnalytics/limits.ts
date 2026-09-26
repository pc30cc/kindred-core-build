/**
 * Web Analytics — plan-limit resolver.
 *
 * Every limit here is a registry capability and resolves exactly as
 * GET /api/plans/workspace/:id/effective shows it: workspace override ??
 * plan ?? registry default (billing/servicePlanLimits.ts). A platform admin
 * changes them per plan in the existing plan editor.
 */
import type { ServerConfig } from '../../config.js';
import { readServicePlanInfo, registryLimits, servicePlanIdentity } from '../billing/servicePlanLimits.js';

export interface WebAnalyticsLimits {
  web_analytics_max_funnels: number;
}

/** Registry limits: override ?? plan ?? registry default. */
export const WEB_ANALYTICS_PLAN_KEYS = [
  'web_analytics_max_funnels',
] as const satisfies readonly (keyof WebAnalyticsLimits)[];

export interface ResolvedWebAnalyticsLimits {
  limits: WebAnalyticsLimits;
  planSlug: string | null;
  planName: string | null;
}

export async function resolveWebAnalyticsLimits(config: ServerConfig, workspaceId: string): Promise<ResolvedWebAnalyticsLimits> {
  const info = await readServicePlanInfo(config, workspaceId);
  return { ...servicePlanIdentity(info), limits: registryLimits(info, WEB_ANALYTICS_PLAN_KEYS) };
}
