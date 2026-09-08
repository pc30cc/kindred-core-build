/**
 * SEO Site Explorer — plan-limit resolver, mirroring
 * server/services/seo/performanceLimits.ts exactly: source of truth is
 * `billing_plans.limits` jsonb, with tight hardcoded fallbacks that never
 * default to "unlimited". Free-plan fallback is 0 (opt-in per plan) since
 * every lookup costs the platform a real DataForSEO API call against a
 * domain the workspace doesn't necessarily own.
 *
 * The UI NEVER hardcodes a limit number; every limit shown to the user comes
 * from the API response, which comes from here.
 */
import type { ServerConfig } from '../../config.js';
import { getWorkspacePlanInfo } from '../../middleware/featureGating.js';
import { getServiceClient } from '../../supabase.js';

export interface SeoExplorerLimits {
  seo_explorer_max_backlinks_per_scan: number;
  seo_explorer_max_keywords_per_scan: number;
  seo_explorer_workspace_concurrent_scans: number;
  seo_explorer_scan_frequency_hours: number;
}

const FALLBACKS: Record<string, SeoExplorerLimits> = {
  free: {
    seo_explorer_max_backlinks_per_scan: 0,
    seo_explorer_max_keywords_per_scan: 0,
    seo_explorer_workspace_concurrent_scans: 1,
    seo_explorer_scan_frequency_hours: 168,
  },
  pro: {
    seo_explorer_max_backlinks_per_scan: 100,
    seo_explorer_max_keywords_per_scan: 100,
    seo_explorer_workspace_concurrent_scans: 1,
    seo_explorer_scan_frequency_hours: 168,
  },
  business: {
    seo_explorer_max_backlinks_per_scan: 500,
    seo_explorer_max_keywords_per_scan: 500,
    seo_explorer_workspace_concurrent_scans: 2,
    seo_explorer_scan_frequency_hours: 24,
  },
  enterprise: {
    // Treated as Business unless billing_plans.limits overrides — never unlimited.
    seo_explorer_max_backlinks_per_scan: 500,
    seo_explorer_max_keywords_per_scan: 500,
    seo_explorer_workspace_concurrent_scans: 2,
    seo_explorer_scan_frequency_hours: 24,
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

export interface ResolvedSeoExplorerLimits {
  limits: SeoExplorerLimits;
  planSlug: string | null;
  planName: string | null;
}

export async function resolveExplorerLimits(config: ServerConfig, workspaceId: string): Promise<ResolvedSeoExplorerLimits> {
  let info: { plan: any; limits: Record<string, number> } | null = null;
  try {
    info = await getWorkspacePlanInfo(config.supabaseUrl, config.supabaseServiceRoleKey, workspaceId);
  } catch {
    info = null;
  }
  const slug = (info?.plan?.slug || 'free') as string;
  const fallback = FALLBACKS[slug] || STRICT;
  const db = (info?.limits || {}) as Record<string, unknown>;
  const keys = Object.keys(fallback) as (keyof SeoExplorerLimits)[];
  const limits = {} as SeoExplorerLimits;
  for (const key of keys) limits[key] = num(db[key], fallback[key]);
  return { planSlug: slug, planName: info?.plan?.name || null, limits };
}

/** Backlink + keyword Explorer scans currently queued/running/processing for the whole workspace — one shared concurrency budget. */
export async function countActiveWorkspaceExplorerScans(config: ServerConfig, workspaceId: string): Promise<number> {
  const sb = getServiceClient(config);
  const [{ count: backlinkCount }, { count: keywordCount }] = await Promise.all([
    sb.from('seo_explorer_backlink_scans').select('*', { count: 'exact', head: true }).eq('workspace_id', workspaceId).in('status', ['queued', 'running', 'processing']),
    sb.from('seo_explorer_keyword_scans').select('*', { count: 'exact', head: true }).eq('workspace_id', workspaceId).in('status', ['queued', 'running', 'processing']),
  ]);
  return (backlinkCount || 0) + (keywordCount || 0);
}

/** Most recent Explorer backlink scan (any status) for this exact domain, for the frequency-limit check. */
export async function getMostRecentExplorerBacklinkScanStart(config: ServerConfig, workspaceId: string, domain: string): Promise<string | null> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('seo_explorer_backlink_scans')
    .select('created_at')
    .eq('workspace_id', workspaceId)
    .eq('target_domain', domain)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { created_at: string } | null)?.created_at ?? null;
}

/** Most recent Explorer keyword scan (any status) for this exact domain, for the frequency-limit check. */
export async function getMostRecentExplorerKeywordScanStart(config: ServerConfig, workspaceId: string, domain: string): Promise<string | null> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('seo_explorer_keyword_scans')
    .select('created_at')
    .eq('workspace_id', workspaceId)
    .eq('target_domain', domain)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { created_at: string } | null)?.created_at ?? null;
}
