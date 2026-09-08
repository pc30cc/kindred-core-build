/**
 * Web Analytics — plan-limit resolver, mirroring
 * server/services/seo/performanceLimits.ts exactly.
 */
import type { ServerConfig } from '../../config.js';
import { getWorkspacePlanInfo } from '../../middleware/featureGating.js';

export interface WebAnalyticsLimits {
  web_analytics_max_funnels: number;
}

const FALLBACKS: Record<string, WebAnalyticsLimits> = {
  free: { web_analytics_max_funnels: 0 },
  pro: { web_analytics_max_funnels: 3 },
  business: { web_analytics_max_funnels: 10 },
  enterprise: { web_analytics_max_funnels: 10 },
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

export interface ResolvedWebAnalyticsLimits {
  limits: WebAnalyticsLimits;
  planSlug: string | null;
  planName: string | null;
}

export async function resolveWebAnalyticsLimits(config: ServerConfig, workspaceId: string): Promise<ResolvedWebAnalyticsLimits> {
  let info: { plan: any; limits: Record<string, number> } | null = null;
  try {
    info = await getWorkspacePlanInfo(config.supabaseUrl, config.supabaseServiceRoleKey, workspaceId);
  } catch {
    info = null;
  }
  const slug = (info?.plan?.slug || 'free') as string;
  const fallback = FALLBACKS[slug] || STRICT;
  const db = (info?.limits || {}) as Record<string, unknown>;
  const keys = Object.keys(fallback) as (keyof WebAnalyticsLimits)[];
  const limits = {} as WebAnalyticsLimits;
  for (const key of keys) limits[key] = num(db[key], fallback[key]);
  return { planSlug: slug, planName: info?.plan?.name || null, limits };
}
