/**
 * SEO Performance Auditing — plan-limit resolver, mirroring
 * server/services/seo/backlinksLimits.ts exactly: source of truth is
 * `billing_plans.limits` jsonb, with tight hardcoded fallbacks that never
 * default to "unlimited". Free-plan fallback is 0 (opt-in per plan) since
 * each audited page costs the platform a real PageSpeed Insights API call.
 *
 * The UI NEVER hardcodes a limit number; every limit shown to the user comes
 * from the API response, which comes from here.
 */
import type { ServerConfig } from '../../config.js';
import { getWorkspacePlanInfo } from '../../middleware/featureGating.js';
import { getServiceClient } from '../../supabase.js';

export interface SeoPerformanceLimits {
  seo_performance_max_pages_per_audit: number;
  seo_performance_audit_frequency_hours: number;
}

const FALLBACKS: Record<string, SeoPerformanceLimits> = {
  free: {
    seo_performance_max_pages_per_audit: 0,
    seo_performance_audit_frequency_hours: 168,
  },
  pro: {
    seo_performance_max_pages_per_audit: 5,
    seo_performance_audit_frequency_hours: 168,
  },
  business: {
    seo_performance_max_pages_per_audit: 20,
    seo_performance_audit_frequency_hours: 24,
  },
  enterprise: {
    // Treated as Business unless billing_plans.limits overrides — never unlimited.
    seo_performance_max_pages_per_audit: 20,
    seo_performance_audit_frequency_hours: 24,
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

export interface ResolvedSeoPerformanceLimits {
  limits: SeoPerformanceLimits;
  planSlug: string | null;
  planName: string | null;
}

export async function resolvePerformanceLimits(config: ServerConfig, workspaceId: string): Promise<ResolvedSeoPerformanceLimits> {
  let info: { plan: any; limits: Record<string, number> } | null = null;
  try {
    info = await getWorkspacePlanInfo(config.supabaseUrl, config.supabaseServiceRoleKey, workspaceId);
  } catch {
    info = null;
  }
  const slug = (info?.plan?.slug || 'free') as string;
  const fallback = FALLBACKS[slug] || STRICT;
  const db = (info?.limits || {}) as Record<string, unknown>;
  const keys = Object.keys(fallback) as (keyof SeoPerformanceLimits)[];
  const limits = {} as SeoPerformanceLimits;
  for (const key of keys) limits[key] = num(db[key], fallback[key]);
  return { planSlug: slug, planName: info?.plan?.name || null, limits };
}

/** Most recent performance audit (any status) started for this crawl, for the frequency-limit check. */
export async function getMostRecentPerformanceAuditStart(config: ServerConfig, crawlId: string): Promise<string | null> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('seo_performance_audits')
    .select('created_at')
    .eq('crawl_id', crawlId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { created_at: string } | null)?.created_at ?? null;
}
