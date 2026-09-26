/**
 * SEO crawl — plan-limit resolver.
 *
 * The four plan capabilities (pages, depth, concurrent audits, re-audit
 * cooldown) resolve exactly as GET /api/plans/workspace/:id/effective shows
 * them: workspace override ?? plan ?? registry default
 * (billing/servicePlanLimits.ts). A platform admin changes them per plan in
 * the existing plan editor.
 *
 * The per-fetch tuning knobs (timeouts, byte caps, crawl delay/concurrency,
 * run duration, per-site concurrency) are not plan capabilities — the
 * registry deliberately leaves them out — so they keep tight per-plan
 * fallbacks here that never default to "unlimited"; a plan or override value
 * still wins.
 *
 * The UI NEVER hardcodes a limit number; every limit shown to the user comes
 * from the API response, which comes from here.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import {
  readServicePlanInfo,
  registryLimits,
  servicePlanIdentity,
  unregisteredLimits,
} from '../billing/servicePlanLimits.js';

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

/** Registry limits: override ?? plan ?? registry default. */
export const SEO_CRAWL_PLAN_KEYS = [
  'seo_max_pages_per_crawl',
  'seo_max_depth',
  'seo_workspace_concurrent_jobs',
  'seo_crawl_frequency_hours',
] as const;

type SeoCrawlTuning = Omit<SeoCrawlLimits, (typeof SEO_CRAWL_PLAN_KEYS)[number]>;

const BUSINESS_TUNING: SeoCrawlTuning = {
  seo_max_duration_seconds: 3600, seo_request_timeout_ms: 12_000, seo_max_response_bytes: 4_000_000,
  seo_max_total_bytes: 4_000_000_000, seo_crawl_concurrency: 6, seo_crawl_delay_ms: 150, seo_site_concurrent_jobs: 1,
};

/** Tuning knobs the registry does not define, per plan slug. */
const TUNING_FALLBACKS = {
  free: {
    seo_max_duration_seconds: 300, seo_request_timeout_ms: 10_000, seo_max_response_bytes: 2_000_000,
    seo_max_total_bytes: 100_000_000, seo_crawl_concurrency: 2, seo_crawl_delay_ms: 500, seo_site_concurrent_jobs: 1,
  },
  pro: {
    seo_max_duration_seconds: 1800, seo_request_timeout_ms: 10_000, seo_max_response_bytes: 3_000_000,
    seo_max_total_bytes: 1_000_000_000, seo_crawl_concurrency: 4, seo_crawl_delay_ms: 250, seo_site_concurrent_jobs: 1,
  },
  business: BUSINESS_TUNING,
  // Treated as Business unless billing_plans.limits overrides — never unlimited.
  enterprise: BUSINESS_TUNING,
} satisfies Record<string, SeoCrawlTuning>;

export interface ResolvedSeoLimits {
  limits: SeoCrawlLimits;
  planSlug: string | null;
  planName: string | null;
}

export async function resolveSeoLimits(config: ServerConfig, workspaceId: string): Promise<ResolvedSeoLimits> {
  const info = await readServicePlanInfo(config, workspaceId);
  return {
    ...servicePlanIdentity(info),
    limits: { ...unregisteredLimits(info, TUNING_FALLBACKS), ...registryLimits(info, SEO_CRAWL_PLAN_KEYS) },
  };
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
