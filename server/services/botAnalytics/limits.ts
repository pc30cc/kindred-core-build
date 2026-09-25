/**
 * Bot Analytics — plan-limit resolver.
 *
 * Every limit here is a registry capability and resolves exactly as
 * GET /api/plans/workspace/:id/effective shows it: workspace override ??
 * plan ?? registry default (billing/servicePlanLimits.ts). A platform admin
 * changes them per plan in the existing plan editor.
 */
import type { ServerConfig } from '../../config.js';
import { readServicePlanInfo, registryLimits, servicePlanIdentity } from '../billing/servicePlanLimits.js';

export interface BotAnalyticsLimits {
  bot_analytics_max_log_lines: number;
}

/** Registry limits: override ?? plan ?? registry default. */
export const BOT_ANALYTICS_PLAN_KEYS = [
  'bot_analytics_max_log_lines',
] as const satisfies readonly (keyof BotAnalyticsLimits)[];

export interface ResolvedBotAnalyticsLimits {
  limits: BotAnalyticsLimits;
  planSlug: string | null;
  planName: string | null;
}

export async function resolveBotAnalyticsLimits(config: ServerConfig, workspaceId: string): Promise<ResolvedBotAnalyticsLimits> {
  const info = await readServicePlanInfo(config, workspaceId);
  return { ...servicePlanIdentity(info), limits: registryLimits(info, BOT_ANALYTICS_PLAN_KEYS) };
}
