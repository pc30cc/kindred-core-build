/**
 * SEO GSC Insights — plan-limit resolver, mirroring
 * server/services/seo/performanceLimits.ts exactly: source of truth is
 * `billing_plans.limits` jsonb, with tight hardcoded fallbacks that never
 * default to "unlimited". Free-plan fallback is 0 properties (opt-in per
 * plan) — the module itself is also plan-gated (`seo_gsc_insights`), but the
 * limit stays independently enforced in case a workspace override enables
 * the module without also raising the property count.
 *
 * The UI NEVER hardcodes a limit number; every limit shown to the user comes
 * from the API response, which comes from here.
 */
import type { ServerConfig } from '../../config.js';
import { getWorkspacePlanInfo } from '../../middleware/featureGating.js';

export interface SeoGscLimits {
  seo_gsc_max_properties: number;
  seo_gsc_sync_frequency_hours: number;
}

const FALLBACKS: Record<string, SeoGscLimits> = {
  free: {
    seo_gsc_max_properties: 0,
    seo_gsc_sync_frequency_hours: 24,
  },
  pro: {
    seo_gsc_max_properties: 1,
    seo_gsc_sync_frequency_hours: 12,
  },
  business: {
    seo_gsc_max_properties: 5,
    seo_gsc_sync_frequency_hours: 6,
  },
  enterprise: {
    // Treated as Business unless billing_plans.limits overrides — never unlimited.
    seo_gsc_max_properties: 5,
    seo_gsc_sync_frequency_hours: 6,
  },
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

export interface ResolvedSeoGscLimits {
  limits: SeoGscLimits;
  planSlug: string | null;
  planName: string | null;
}

export async function resolveGscLimits(config: ServerConfig, workspaceId: string): Promise<ResolvedSeoGscLimits> {
  let info: { plan: any; limits: Record<string, number> } | null = null;
  try {
    info = await getWorkspacePlanInfo(config.supabaseUrl, config.supabaseServiceRoleKey, workspaceId);
  } catch {
    info = null;
  }
  const slug = (info?.plan?.slug || 'free') as string;
  const fallback = FALLBACKS[slug] || STRICT;
  const db = (info?.limits || {}) as Record<string, unknown>;
  const keys = Object.keys(fallback) as (keyof SeoGscLimits)[];
  const limits = {} as SeoGscLimits;
  for (const key of keys) limits[key] = num(db[key], fallback[key]);
  return { planSlug: slug, planName: info?.plan?.name || null, limits };
}
