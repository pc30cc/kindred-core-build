/**
 * Brand Radar — plan-limit resolver, mirroring
 * ../webAnalytics/limits.ts and ../botAnalytics/limits.ts exactly.
 */
import type { ServerConfig } from '../../config.js';
import { getWorkspacePlanInfo } from '../../middleware/featureGating.js';

export interface BrandRadarLimits {
  brand_radar_max_topics: number;
  brand_radar_max_competitors: number;
  /** -1 = no minimum wait between "run checks now" triggers. */
  brand_radar_check_frequency_hours: number;
}

const FALLBACKS: Record<string, BrandRadarLimits> = {
  free: { brand_radar_max_topics: 0, brand_radar_max_competitors: 0, brand_radar_check_frequency_hours: -1 },
  pro: { brand_radar_max_topics: 5, brand_radar_max_competitors: 3, brand_radar_check_frequency_hours: 24 },
  business: { brand_radar_max_topics: 10, brand_radar_max_competitors: 5, brand_radar_check_frequency_hours: 12 },
  enterprise: { brand_radar_max_topics: 10, brand_radar_max_competitors: 5, brand_radar_check_frequency_hours: 12 },
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

export interface ResolvedBrandRadarLimits {
  limits: BrandRadarLimits;
  planSlug: string | null;
  planName: string | null;
}

export async function resolveBrandRadarLimits(config: ServerConfig, workspaceId: string): Promise<ResolvedBrandRadarLimits> {
  let info: { plan: any; limits: Record<string, number> } | null = null;
  try {
    info = await getWorkspacePlanInfo(config.supabaseUrl, config.supabaseServiceRoleKey, workspaceId);
  } catch {
    info = null;
  }
  const slug = (info?.plan?.slug || 'free') as string;
  const fallback = FALLBACKS[slug] || STRICT;
  const db = (info?.limits || {}) as Record<string, unknown>;
  const keys = Object.keys(fallback) as (keyof BrandRadarLimits)[];
  const limits = {} as BrandRadarLimits;
  for (const key of keys) limits[key] = num(db[key], fallback[key]);
  return { planSlug: slug, planName: info?.plan?.name || null, limits };
}
