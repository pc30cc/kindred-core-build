/**
 * SEO Rank Tracking — plan-limit resolver, mirroring
 * server/services/seo/backlinksLimits.ts's shape. Two limits here, neither
 * shaped like a "per-request" cap: `seo_rank_tracking_max_keywords` bounds
 * the size of a site's persistent watchlist (enforced when a keyword is
 * added, in server/services/seo/rankTrackingService.ts), and
 * `seo_rank_tracking_check_frequency_hours` is read by
 * rankTrackingTicker.ts to decide how often each tracked keyword is
 * re-checked. Opt-in per plan (Free fallback is 0) because every check
 * costs the platform real money.
 */
import type { ServerConfig } from '../../config.js';
import { getWorkspacePlanInfo } from '../../middleware/featureGating.js';
import { getServiceClient } from '../../supabase.js';

export interface SeoRankTrackingLimits {
  seo_rank_tracking_max_keywords: number;
  seo_rank_tracking_check_frequency_hours: number;
}

const FALLBACKS: Record<string, SeoRankTrackingLimits> = {
  free: { seo_rank_tracking_max_keywords: 0, seo_rank_tracking_check_frequency_hours: 168 },
  pro: { seo_rank_tracking_max_keywords: 25, seo_rank_tracking_check_frequency_hours: 168 },
  business: { seo_rank_tracking_max_keywords: 200, seo_rank_tracking_check_frequency_hours: 24 },
  enterprise: { seo_rank_tracking_max_keywords: 200, seo_rank_tracking_check_frequency_hours: 24 },
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

export interface ResolvedSeoRankTrackingLimits {
  limits: SeoRankTrackingLimits;
  planSlug: string | null;
  planName: string | null;
}

export async function resolveRankTrackingLimits(config: ServerConfig, workspaceId: string): Promise<ResolvedSeoRankTrackingLimits> {
  let info: { plan: any; limits: Record<string, number> } | null = null;
  try {
    info = await getWorkspacePlanInfo(config.supabaseUrl, config.supabaseServiceRoleKey, workspaceId);
  } catch {
    info = null;
  }
  const slug = (info?.plan?.slug || 'free') as string;
  const fallback = FALLBACKS[slug] || STRICT;
  const db = (info?.limits || {}) as Record<string, unknown>;
  const keys = Object.keys(fallback) as (keyof SeoRankTrackingLimits)[];
  const limits = {} as SeoRankTrackingLimits;
  for (const key of keys) limits[key] = num(db[key], fallback[key]);
  return { planSlug: slug, planName: info?.plan?.name || null, limits };
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
