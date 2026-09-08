/**
 * SEO Keyword Research — plan-limit resolver, mirroring
 * server/services/seo/backlinksLimits.ts exactly: source of truth is
 * `billing_plans.limits` jsonb, with tight hardcoded fallbacks that never
 * default to "unlimited". Opt-in per plan (Free fallback is 0) because a
 * vendor lookup costs the platform real money.
 */
import type { ServerConfig } from '../../config.js';
import { getWorkspacePlanInfo } from '../../middleware/featureGating.js';
import { getServiceClient } from '../../supabase.js';

export interface SeoKeywordsLimits {
  seo_keywords_max_per_lookup: number;
  seo_keywords_workspace_concurrent_runs: number;
  seo_keywords_lookup_frequency_hours: number;
}

const FALLBACKS: Record<string, SeoKeywordsLimits> = {
  free: { seo_keywords_max_per_lookup: 0, seo_keywords_workspace_concurrent_runs: 0, seo_keywords_lookup_frequency_hours: 24 },
  pro: { seo_keywords_max_per_lookup: 50, seo_keywords_workspace_concurrent_runs: 1, seo_keywords_lookup_frequency_hours: 24 },
  business: { seo_keywords_max_per_lookup: 500, seo_keywords_workspace_concurrent_runs: 2, seo_keywords_lookup_frequency_hours: 1 },
  enterprise: { seo_keywords_max_per_lookup: 500, seo_keywords_workspace_concurrent_runs: 2, seo_keywords_lookup_frequency_hours: 1 },
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

export interface ResolvedSeoKeywordsLimits {
  limits: SeoKeywordsLimits;
  planSlug: string | null;
  planName: string | null;
}

export async function resolveKeywordsLimits(config: ServerConfig, workspaceId: string): Promise<ResolvedSeoKeywordsLimits> {
  let info: { plan: any; limits: Record<string, number> } | null = null;
  try {
    info = await getWorkspacePlanInfo(config.supabaseUrl, config.supabaseServiceRoleKey, workspaceId);
  } catch {
    info = null;
  }
  const slug = (info?.plan?.slug || 'free') as string;
  const fallback = FALLBACKS[slug] || STRICT;
  const db = (info?.limits || {}) as Record<string, unknown>;
  const keys = Object.keys(fallback) as (keyof SeoKeywordsLimits)[];
  const limits = {} as SeoKeywordsLimits;
  for (const key of keys) limits[key] = num(db[key], fallback[key]);
  return { planSlug: slug, planName: info?.plan?.name || null, limits };
}

export async function countActiveWorkspaceKeywordRuns(config: ServerConfig, workspaceId: string): Promise<number> {
  const sb = getServiceClient(config);
  const { count } = await sb
    .from('seo_keyword_research_runs')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .in('status', ['queued', 'running', 'processing']);
  return count || 0;
}

export async function getMostRecentKeywordRunStart(config: ServerConfig, websiteId: string): Promise<string | null> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('seo_keyword_research_runs')
    .select('created_at')
    .eq('website_id', websiteId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { created_at: string } | null)?.created_at ?? null;
}
