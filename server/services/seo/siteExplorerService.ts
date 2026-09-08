/**
 * SEO Site Explorer — business logic. Owns `seo_explorer_backlink_scans` /
 * `seo_explorer_backlinks` and `seo_explorer_keyword_scans` /
 * `seo_explorer_keywords`. Mirrors server/services/seo/backlinkService.ts
 * and keywordResearchService.ts exactly, EXCEPT the resolve step: instead of
 * `resolveWorkspaceSite` (which requires a registered workspace_domains row
 * and returns 'site_not_found' for anything else), this resolves a raw
 * domain typed by the user via `normalizeExplorerDomain` — Site Explorer's
 * whole point is to work on domains the workspace never registered,
 * including competitors'.
 *
 * The frequency-limit check is keyed by (workspaceId, target_domain) instead
 * of a site id, since there is no persistent "site" row to key it by — the
 * scan history for a domain IS its own key.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { randomUUID } from 'node:crypto';
import { enqueueJob, requestJobCancel, cancelQueuedJob, getJob } from '../jobs/queue.js';
import { normalizeExplorerDomain } from './siteResolver.js';
import {
  resolveExplorerLimits, countActiveWorkspaceExplorerScans,
  getMostRecentExplorerBacklinkScanStart, getMostRecentExplorerKeywordScanStart,
} from './explorerLimits.js';

export type ExplorerScanLimitReason = 'invalid_domain' | 'workspace_concurrency_limit' | 'frequency_limit' | 'module_not_available';

export class ExplorerScanLimitError extends Error {
  reason: ExplorerScanLimitReason;
  retryAfterSeconds?: number;
  constructor(reason: ExplorerScanLimitReason, message: string, retryAfterSeconds?: number) {
    super(message);
    this.reason = reason;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface SeoExplorerBacklinkScanRow {
  id: string;
  job_id: string;
  workspace_id: string;
  target_domain: string;
  target_url: string;
  provider: string;
  max_backlinks: number;
  status: string;
  progress: number;
  progress_stage: string | null;
  total_backlinks: number | null;
  referring_domains: number | null;
  dofollow_count: number | null;
  nofollow_count: number | null;
  new_backlinks: number | null;
  lost_backlinks: number | null;
  cancel_requested: boolean;
  error_message: string | null;
  error_category: string | null;
  created_by: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SeoExplorerKeywordScanRow {
  id: string;
  job_id: string;
  workspace_id: string;
  target_domain: string;
  provider: string;
  max_keywords: number;
  status: string;
  progress: number;
  progress_stage: string | null;
  total_keywords: number | null;
  total_traffic_estimate: number | null;
  cancel_requested: boolean;
  error_message: string | null;
  error_category: string | null;
  created_by: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Backlinks by domain ────────────────────────────────────────────────

export async function createExplorerBacklinkScan(
  config: ServerConfig,
  args: { workspaceId: string; domain: string; userId: string },
): Promise<SeoExplorerBacklinkScanRow> {
  const resolved = normalizeExplorerDomain(args.domain);
  if (!resolved) throw new ExplorerScanLimitError('invalid_domain', 'Enter a valid domain, e.g. example.com');

  const { limits } = await resolveExplorerLimits(config, args.workspaceId);
  if (limits.seo_explorer_max_backlinks_per_scan <= 0) {
    throw new ExplorerScanLimitError('module_not_available', 'Site Explorer is not available on this plan');
  }

  const workspaceActive = await countActiveWorkspaceExplorerScans(config, args.workspaceId);
  if (workspaceActive >= limits.seo_explorer_workspace_concurrent_scans) {
    throw new ExplorerScanLimitError('workspace_concurrency_limit', 'Workspace has reached its concurrent Site Explorer lookup limit');
  }

  const lastStart = await getMostRecentExplorerBacklinkScanStart(config, args.workspaceId, resolved.canonicalHost);
  if (lastStart) {
    const elapsedHours = (Date.now() - new Date(lastStart).getTime()) / 3_600_000;
    if (elapsedHours < limits.seo_explorer_scan_frequency_hours) {
      const retryAfterSeconds = Math.max(0, Math.round((limits.seo_explorer_scan_frequency_hours - elapsedHours) * 3600));
      throw new ExplorerScanLimitError('frequency_limit', 'This domain was looked up too recently', retryAfterSeconds);
    }
  }

  const sb = getServiceClient(config);
  const job = await enqueueJob(config, {
    workspaceId: args.workspaceId,
    jobType: 'seo_explorer_backlink_scan',
    subjectType: 'seo_explorer_domain',
    subjectId: randomUUID(),
    createdBy: args.userId,
    payload: { domain: resolved.canonicalHost },
  });

  const { data, error } = await sb
    .from('seo_explorer_backlink_scans')
    .insert({
      job_id: job.id,
      workspace_id: args.workspaceId,
      target_domain: resolved.canonicalHost,
      target_url: resolved.canonicalUrl,
      provider: 'dataforseo',
      max_backlinks: limits.seo_explorer_max_backlinks_per_scan,
      created_by: args.userId,
    })
    .select('*')
    .single();
  if (error || !data) throw new Error(`create_explorer_backlink_scan_failed: ${error?.message}`);

  return data as SeoExplorerBacklinkScanRow;
}

export async function getExplorerBacklinkScan(config: ServerConfig, workspaceId: string, scanId: string): Promise<SeoExplorerBacklinkScanRow | null> {
  const sb = getServiceClient(config);
  const { data } = await sb.from('seo_explorer_backlink_scans').select('*').eq('id', scanId).eq('workspace_id', workspaceId).maybeSingle();
  return (data as SeoExplorerBacklinkScanRow | null) ?? null;
}

export async function getLatestExplorerBacklinkScanForDomain(config: ServerConfig, workspaceId: string, domain: string): Promise<SeoExplorerBacklinkScanRow | null> {
  const resolved = normalizeExplorerDomain(domain);
  if (!resolved) return null;
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('seo_explorer_backlink_scans')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('target_domain', resolved.canonicalHost)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as SeoExplorerBacklinkScanRow | null) ?? null;
}

export interface ExplorerBacklinkListFilters {
  dofollowOnly?: boolean;
  isNew?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
}

export async function listExplorerBacklinks(config: ServerConfig, workspaceId: string, scanId: string, filters: ExplorerBacklinkListFilters = {}) {
  const sb = getServiceClient(config);
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const offset = Math.max(filters.offset ?? 0, 0);
  let query = sb.from('seo_explorer_backlinks').select('*', { count: 'exact' }).eq('workspace_id', workspaceId).eq('scan_id', scanId);
  if (filters.dofollowOnly) query = query.eq('is_dofollow', true);
  if (typeof filters.isNew === 'boolean') query = query.eq('is_new', filters.isNew);
  if (filters.search) query = query.ilike('source_domain', `%${filters.search}%`);
  const { data, count, error } = await query.order('domain_rank', { ascending: false, nullsFirst: false }).range(offset, offset + limit - 1);
  if (error) throw new Error(`list_explorer_backlinks_failed: ${error.message}`);
  return { backlinks: data || [], total: count || 0 };
}

export async function requestExplorerBacklinkScanCancel(config: ServerConfig, workspaceId: string, scanId: string): Promise<{ ok: boolean }> {
  const scan = await getExplorerBacklinkScan(config, workspaceId, scanId);
  if (!scan) return { ok: false };
  const sb = getServiceClient(config);
  await sb.from('seo_explorer_backlink_scans').update({ cancel_requested: true }).eq('id', scanId).in('status', ['queued', 'running', 'processing']);
  await requestJobCancel(config, scan.job_id);
  await cancelQueuedJob(config, scan.job_id);
  const job = await getJob(config, scan.job_id);
  if (job && job.status === 'cancelled') {
    await sb.from('seo_explorer_backlink_scans').update({ status: 'cancelled', finished_at: new Date().toISOString() }).eq('id', scanId).in('status', ['queued', 'running', 'processing']);
  }
  return { ok: true };
}

// ─── Organic keywords by domain ─────────────────────────────────────────

export async function createExplorerKeywordScan(
  config: ServerConfig,
  args: { workspaceId: string; domain: string; userId: string },
): Promise<SeoExplorerKeywordScanRow> {
  const resolved = normalizeExplorerDomain(args.domain);
  if (!resolved) throw new ExplorerScanLimitError('invalid_domain', 'Enter a valid domain, e.g. example.com');

  const { limits } = await resolveExplorerLimits(config, args.workspaceId);
  if (limits.seo_explorer_max_keywords_per_scan <= 0) {
    throw new ExplorerScanLimitError('module_not_available', 'Site Explorer is not available on this plan');
  }

  const workspaceActive = await countActiveWorkspaceExplorerScans(config, args.workspaceId);
  if (workspaceActive >= limits.seo_explorer_workspace_concurrent_scans) {
    throw new ExplorerScanLimitError('workspace_concurrency_limit', 'Workspace has reached its concurrent Site Explorer lookup limit');
  }

  const lastStart = await getMostRecentExplorerKeywordScanStart(config, args.workspaceId, resolved.canonicalHost);
  if (lastStart) {
    const elapsedHours = (Date.now() - new Date(lastStart).getTime()) / 3_600_000;
    if (elapsedHours < limits.seo_explorer_scan_frequency_hours) {
      const retryAfterSeconds = Math.max(0, Math.round((limits.seo_explorer_scan_frequency_hours - elapsedHours) * 3600));
      throw new ExplorerScanLimitError('frequency_limit', 'This domain was looked up too recently', retryAfterSeconds);
    }
  }

  const sb = getServiceClient(config);
  const job = await enqueueJob(config, {
    workspaceId: args.workspaceId,
    jobType: 'seo_explorer_keyword_scan',
    subjectType: 'seo_explorer_domain',
    subjectId: randomUUID(),
    createdBy: args.userId,
    payload: { domain: resolved.canonicalHost },
  });

  const { data, error } = await sb
    .from('seo_explorer_keyword_scans')
    .insert({
      job_id: job.id,
      workspace_id: args.workspaceId,
      target_domain: resolved.canonicalHost,
      provider: 'dataforseo',
      max_keywords: limits.seo_explorer_max_keywords_per_scan,
      created_by: args.userId,
    })
    .select('*')
    .single();
  if (error || !data) throw new Error(`create_explorer_keyword_scan_failed: ${error?.message}`);

  return data as SeoExplorerKeywordScanRow;
}

export async function getExplorerKeywordScan(config: ServerConfig, workspaceId: string, scanId: string): Promise<SeoExplorerKeywordScanRow | null> {
  const sb = getServiceClient(config);
  const { data } = await sb.from('seo_explorer_keyword_scans').select('*').eq('id', scanId).eq('workspace_id', workspaceId).maybeSingle();
  return (data as SeoExplorerKeywordScanRow | null) ?? null;
}

export async function getLatestExplorerKeywordScanForDomain(config: ServerConfig, workspaceId: string, domain: string): Promise<SeoExplorerKeywordScanRow | null> {
  const resolved = normalizeExplorerDomain(domain);
  if (!resolved) return null;
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('seo_explorer_keyword_scans')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('target_domain', resolved.canonicalHost)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as SeoExplorerKeywordScanRow | null) ?? null;
}

export interface ExplorerKeywordResultFilters {
  search?: string;
  limit?: number;
  offset?: number;
}

export async function listExplorerKeywords(config: ServerConfig, workspaceId: string, scanId: string, filters: ExplorerKeywordResultFilters = {}) {
  const sb = getServiceClient(config);
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
  const offset = Math.max(filters.offset ?? 0, 0);
  let query = sb.from('seo_explorer_keywords').select('*', { count: 'exact' }).eq('workspace_id', workspaceId).eq('scan_id', scanId);
  if (filters.search) query = query.ilike('keyword', `%${filters.search}%`);
  const { data, count, error } = await query.order('search_volume', { ascending: false, nullsFirst: false }).range(offset, offset + limit - 1);
  if (error) throw new Error(`list_explorer_keywords_failed: ${error.message}`);
  return { results: data || [], total: count || 0 };
}

export async function requestExplorerKeywordScanCancel(config: ServerConfig, workspaceId: string, scanId: string): Promise<{ ok: boolean }> {
  const scan = await getExplorerKeywordScan(config, workspaceId, scanId);
  if (!scan) return { ok: false };
  const sb = getServiceClient(config);
  await sb.from('seo_explorer_keyword_scans').update({ cancel_requested: true }).eq('id', scanId).in('status', ['queued', 'running', 'processing']);
  await requestJobCancel(config, scan.job_id);
  await cancelQueuedJob(config, scan.job_id);
  const job = await getJob(config, scan.job_id);
  if (job && job.status === 'cancelled') {
    await sb.from('seo_explorer_keyword_scans').update({ status: 'cancelled', finished_at: new Date().toISOString() }).eq('id', scanId).in('status', ['queued', 'running', 'processing']);
  }
  return { ok: true };
}

// ─── Domain history ──────────────────────────────────────────────────────

export interface ExplorerHistoryEntry {
  domain: string;
  lastLookedUpAt: string;
}

/** Distinct domains this workspace has explored, most recent first — the recents list for the search box. */
export async function listExplorerHistory(config: ServerConfig, workspaceId: string, limit = 10): Promise<ExplorerHistoryEntry[]> {
  const sb = getServiceClient(config);
  const [backlinkScans, keywordScans] = await Promise.all([
    sb.from('seo_explorer_backlink_scans').select('target_domain, created_at').eq('workspace_id', workspaceId).order('created_at', { ascending: false }).limit(50),
    sb.from('seo_explorer_keyword_scans').select('target_domain, created_at').eq('workspace_id', workspaceId).order('created_at', { ascending: false }).limit(50),
  ]);
  const byDomain = new Map<string, string>();
  for (const row of [...(backlinkScans.data || []), ...(keywordScans.data || [])] as Array<{ target_domain: string; created_at: string }>) {
    const existing = byDomain.get(row.target_domain);
    if (!existing || row.created_at > existing) byDomain.set(row.target_domain, row.created_at);
  }
  return Array.from(byDomain.entries())
    .map(([domain, lastLookedUpAt]) => ({ domain, lastLookedUpAt }))
    .sort((a, b) => (a.lastLookedUpAt < b.lastLookedUpAt ? 1 : -1))
    .slice(0, limit);
}
