/**
 * SEO Backlinks — plan-limit resolver, mirroring server/services/seo/limits.ts
 * exactly: source of truth is `billing_plans.limits` jsonb, with tight
 * hardcoded fallbacks that never default to "unlimited". A platform admin can
 * change these per-plan today via the existing POST /api/billing/admin/plans
 * editor — no new admin UI is required for this file.
 *
 * Unlike the SEO crawl module (always on, defaultValue: true in the
 * registry), backlink scans call a paid external vendor per request, so the
 * Free-plan fallback is 0 (the module is opt-in per plan).
 *
 * The UI NEVER hardcodes a limit number; every limit shown to the user comes
 * from the API response, which comes from here.
 */
import type { ServerConfig } from '../../config.js';
import { getWorkspacePlanInfo } from '../../middleware/featureGating.js';
import { getServiceClient } from '../../supabase.js';

export interface SeoBacklinksLimits {
  seo_backlinks_max_per_scan: number;
  seo_backlinks_workspace_concurrent_scans: number;
  seo_backlinks_scan_frequency_hours: number;
}

const FALLBACKS: Record<string, SeoBacklinksLimits> = {
  free: {
    seo_backlinks_max_per_scan: 0,
    seo_backlinks_workspace_concurrent_scans: 0,
    seo_backlinks_scan_frequency_hours: 168,
  },
  pro: {
    seo_backlinks_max_per_scan: 1000,
    seo_backlinks_workspace_concurrent_scans: 1,
    seo_backlinks_scan_frequency_hours: 168,
  },
  business: {
    seo_backlinks_max_per_scan: 10_000,
    seo_backlinks_workspace_concurrent_scans: 2,
    seo_backlinks_scan_frequency_hours: 24,
  },
  enterprise: {
    // Treated as Business unless billing_plans.limits overrides — never unlimited.
    seo_backlinks_max_per_scan: 10_000,
    seo_backlinks_workspace_concurrent_scans: 2,
    seo_backlinks_scan_frequency_hours: 24,
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

export interface ResolvedSeoBacklinksLimits {
  limits: SeoBacklinksLimits;
  planSlug: string | null;
  planName: string | null;
}

export async function resolveBacklinksLimits(config: ServerConfig, workspaceId: string): Promise<ResolvedSeoBacklinksLimits> {
  let info: { plan: any; limits: Record<string, number> } | null = null;
  try {
    info = await getWorkspacePlanInfo(config.supabaseUrl, config.supabaseServiceRoleKey, workspaceId);
  } catch {
    info = null;
  }
  const slug = (info?.plan?.slug || 'free') as string;
  const fallback = FALLBACKS[slug] || STRICT;
  const db = (info?.limits || {}) as Record<string, unknown>;
  const keys = Object.keys(fallback) as (keyof SeoBacklinksLimits)[];
  const limits = {} as SeoBacklinksLimits;
  for (const key of keys) limits[key] = num(db[key], fallback[key]);
  return { planSlug: slug, planName: info?.plan?.name || null, limits };
}

/** Concurrent (queued/running/processing) backlink scans for a whole workspace. */
export async function countActiveWorkspaceBacklinkScans(config: ServerConfig, workspaceId: string): Promise<number> {
  const sb = getServiceClient(config);
  const { count } = await sb
    .from('seo_backlink_scans')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .in('status', ['queued', 'running', 'processing']);
  return count || 0;
}

/** Most recent backlink scan (any status) started for this site, for the frequency-limit check. */
export async function getMostRecentBacklinkScanStart(config: ServerConfig, websiteId: string): Promise<string | null> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('seo_backlink_scans')
    .select('created_at')
    .eq('website_id', websiteId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { created_at: string } | null)?.created_at ?? null;
}
