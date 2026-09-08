/**
 * Bot Analytics — plan-limit resolver, mirroring
 * ../webAnalytics/limits.ts exactly.
 */
import type { ServerConfig } from '../../config.js';
import { getWorkspacePlanInfo } from '../../middleware/featureGating.js';

export interface BotAnalyticsLimits {
  bot_analytics_max_log_lines: number;
}

const FALLBACKS: Record<string, BotAnalyticsLimits> = {
  free: { bot_analytics_max_log_lines: 0 },
  pro: { bot_analytics_max_log_lines: 50_000 },
  business: { bot_analytics_max_log_lines: 150_000 },
  enterprise: { bot_analytics_max_log_lines: 300_000 },
};
const STRICT = FALLBACKS.free;

function num(v: unknown, fallback: number): number {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

export interface ResolvedBotAnalyticsLimits {
  limits: BotAnalyticsLimits;
  planSlug: string | null;
  planName: string | null;
}

export async function resolveBotAnalyticsLimits(config: ServerConfig, workspaceId: string): Promise<ResolvedBotAnalyticsLimits> {
  let info: { plan: any; limits: Record<string, number> } | null = null;
  try {
    info = await getWorkspacePlanInfo(config.supabaseUrl, config.supabaseServiceRoleKey, workspaceId);
  } catch {
    info = null;
  }
  const slug = (info?.plan?.slug || 'free') as string;
  const fallback = FALLBACKS[slug] || STRICT;
  const db = (info?.limits || {}) as Record<string, unknown>;
  const keys = Object.keys(fallback) as (keyof BotAnalyticsLimits)[];
  const limits = {} as BotAnalyticsLimits;
  for (const key of keys) limits[key] = num(db[key], fallback[key]);
  return { planSlug: slug, planName: info?.plan?.name || null, limits };
}
