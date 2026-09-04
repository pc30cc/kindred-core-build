/**
 * SEO crawl — plan-limit resolver, mirroring server/services/ai-agent/limits.ts
 * exactly: source of truth is `billing_plans.limits` jsonb, with tight
 * hardcoded fallbacks that never default to "unlimited". A platform admin can
 * change these per-plan today via the existing POST /api/billing/admin/plans
 * editor — no new admin UI is required for this feature.
 *
 * The UI NEVER hardcodes a limit number; every limit shown to the user comes
 * from the API response, which comes from here.
 */
import type { ServerConfig } from '../../config.js';
import { getWorkspacePlanInfo } from '../../middleware/featureGating.js';
import { getServiceClient } from '../../supabase.js';

export interface SeoCrawlLimits {
  seo_max_pages_per_crawl: number;
  seo_max_depth: number;
  seo_max_duration_seconds: number;
  seo_request_timeout_ms: number;
  seo_max_response_bytes: number;
  seo_max_total_bytes: number;
  seo_crawl_concurrency: number;
  seo_crawl_delay_ms: number;
  seo_workspace_concurrent_jobs: number;
  seo_site_concurrent_jobs: number;
  seo_crawl_frequency_hours: number;
}

const FALLBACKS: Record<string, SeoCrawlLimits> = {
  free: {
    seo_max_pages_per_crawl: 100, seo_max_depth: 3, seo_max_duration_seconds: 300,
    seo_request_timeout_ms: 10_000, seo_max_response_bytes: 2_000_000, seo_max_total_bytes: 100_000_000,
    seo_crawl_concurrency: 2, seo_crawl_delay_ms: 500,
    seo_workspace_concurrent_jobs: 1, seo_site_concurrent_jobs: 1, seo_crawl_frequency_hours: 24,
  },
  pro: {
    seo_max_pages_per_crawl: 2000, seo_max_depth: 6, seo_max_duration_seconds: 1800,
    seo_request_timeout_ms: 10_000, seo_max_response_bytes: 3_000_000, seo_max_total_bytes: 1_000_000_000,
    seo_crawl_concurrency: 4, seo_crawl_delay_ms: 250,
    seo_workspace_concurrent_jobs: 2, seo_site_concurrent_jobs: 1, seo_crawl_frequency_hours: 6,
  },
  business: {
    seo_max_pages_per_crawl: 10_000, seo_max_depth: 8, seo_max_duration_seconds: 3600,
    seo_request_timeout_ms: 12_000, seo_max_response_bytes: 4_000_000, seo_max_total_bytes: 4_000_000_000,
    seo_crawl_concurrency: 6, seo_crawl_delay_ms: 150,
    seo_workspace_concurrent_jobs: 3, seo_site_concurrent_jobs: 1, seo_crawl_frequency_hours: 1,
  },
  enterprise: {
    // Treated as Business unless billing_plans.limits overrides — never unlimited.
    seo_max_pages_per_crawl: 10_000, seo_max_depth: 8, seo_max_duration_seconds: 3600,
    seo_request_timeout_ms: 12_000, seo_max_response_bytes: 4_000_000, seo_max_total_bytes: 4_000_000_000,
    seo_crawl_concurrency: 6, seo_crawl_delay_ms: 150,
    seo_workspace_concurrent_jobs: 3, seo_site_concurrent_jobs: 1, seo_crawl_frequency_hours: 1,
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

export interface ResolvedSeoLimits {
  limits: SeoCrawlLimits;
  planSlug: string | null;
  planName: string | null;
}

export async function resolveSeoLimits(config: ServerConfig, workspaceId: string): Promise<ResolvedSeoLimits> {
  let info: { plan: any; limits: Record<string, number> } | null = null;
  try {
    info = await getWorkspacePlanInfo(config.supabaseUrl, config.supabaseServiceRoleKey, workspaceId);
  } catch {
    info = null;
  }
  const slug = (info?.plan?.slug || 'free') as string;
  const fallback = FALLBACKS[slug] || STRICT;
  const db = (info?.limits || {}) as Record<string, unknown>;
  const keys = Object.keys(fallback) as (keyof SeoCrawlLimits)[];
  const limits = {} as SeoCrawlLimits;
  for (const key of keys) limits[key] = num(db[key], fallback[key]);
  return { planSlug: slug, planName: info?.plan?.name || null, limits };
}

/** Concurrent (queued/running/processing) SEO crawl jobs for a whole workspace. */
export async function countActiveWorkspaceCrawls(config: ServerConfig, workspaceId: string): Promise<number> {
  const sb = getServiceClient(config);
  const { count } = await sb
    .from('seo_crawls')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .in('status', ['queued', 'running', 'processing']);
  return count || 0;
}

/** Concurrent (queued/running/processing) SEO crawl jobs for one site. */
export async function countActiveSiteCrawls(config: ServerConfig, websiteId: string): Promise<number> {
  const sb = getServiceClient(config);
  const { count } = await sb
    .from('seo_crawls')
    .select('id', { count: 'exact', head: true })
    .eq('website_id', websiteId)
    .in('status', ['queued', 'running', 'processing']);
  return count || 0;
}

/** Most recent crawl (any status) started for this site, for the frequency-limit check. */
export async function getMostRecentCrawlStart(config: ServerConfig, websiteId: string): Promise<string | null> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('seo_crawls')
    .select('created_at')
    .eq('website_id', websiteId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { created_at: string } | null)?.created_at ?? null;
}
