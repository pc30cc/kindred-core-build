/**
 * SEO Backlinks — business logic. Owns `seo_backlink_scans` and
 * `seo_backlinks`; mirrors server/services/seo/crawlService.ts's shape
 * exactly (resolve site → resolve limits → check concurrency/frequency →
 * enqueue a background_jobs row → return the created scan row).
 *
 * The generic `background_jobs` row only ever carries `{ scanId }` in its
 * payload — everything else the worker needs lives in the
 * `seo_backlink_scans` row this module creates.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { enqueueJob, requestJobCancel, cancelQueuedJob, getJob } from '../jobs/queue.js';
import { resolveWorkspaceSite, SiteResolutionError } from './siteResolver.js';
import { resolveBacklinksLimits, countActiveWorkspaceBacklinkScans, getMostRecentBacklinkScanStart } from './backlinksLimits.js';

export type BacklinkScanLimitReason = 'workspace_concurrency_limit' | 'frequency_limit' | 'module_not_available';

export class BacklinkScanLimitError extends Error {
  reason: BacklinkScanLimitReason;
  retryAfterSeconds?: number;
  constructor(reason: BacklinkScanLimitReason, message: string, retryAfterSeconds?: number) {
    super(message);
    this.reason = reason;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface SeoBacklinkScanRow {
  id: string;
  job_id: string;
  workspace_id: string;
  website_id: string;
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

export async function createBacklinkScan(
  config: ServerConfig,
  args: { workspaceId: string; siteId: string; userId: string },
): Promise<SeoBacklinkScanRow> {
  const site = await resolveWorkspaceSite(config, args.workspaceId, args.siteId);
  const { limits } = await resolveBacklinksLimits(config, args.workspaceId);

  if (limits.seo_backlinks_max_per_scan <= 0) {
    throw new BacklinkScanLimitError('module_not_available', 'Backlink analysis is not available on this plan');
  }

  const workspaceActive = await countActiveWorkspaceBacklinkScans(config, args.workspaceId);
  if (workspaceActive >= limits.seo_backlinks_workspace_concurrent_scans) {
    throw new BacklinkScanLimitError('workspace_concurrency_limit', 'Workspace has reached its concurrent backlink scan limit');
  }

  const lastStart = await getMostRecentBacklinkScanStart(config, site.id);
  if (lastStart) {
    const elapsedHours = (Date.now() - new Date(lastStart).getTime()) / 3_600_000;
    if (elapsedHours < limits.seo_backlinks_scan_frequency_hours) {
      const retryAfterSeconds = Math.max(0, Math.round((limits.seo_backlinks_scan_frequency_hours - elapsedHours) * 3600));
      throw new BacklinkScanLimitError('frequency_limit', 'This site was scanned too recently', retryAfterSeconds);
    }
  }

  const sb = getServiceClient(config);

  // job_id is NOT NULL + FK'd on seo_backlink_scans, so the background_jobs
  // row must exist first. Per background_jobs' own contract, the worker
  // looks the scan up by job_id and reads every business detail (target
  // URL, max_backlinks) from the seo_backlink_scans row itself — payload
  // stays generic (just {siteId}, for job-list observability).
  const job = await enqueueJob(config, {
    workspaceId: args.workspaceId,
    jobType: 'seo_backlink_scan',
    subjectType: 'seo_site',
    subjectId: site.id,
    createdBy: args.userId,
    payload: { siteId: site.id },
  });

  const { data, error } = await sb
    .from('seo_backlink_scans')
    .insert({
      job_id: job.id,
      workspace_id: args.workspaceId,
      website_id: site.id,
      target_url: site.canonicalUrl,
      provider: 'dataforseo',
      max_backlinks: limits.seo_backlinks_max_per_scan,
      created_by: args.userId,
    })
    .select('*')
    .single();
  if (error || !data) throw new Error(`create_backlink_scan_failed: ${error?.message}`);

  return data as SeoBacklinkScanRow;
}

export async function getBacklinkScan(config: ServerConfig, workspaceId: string, scanId: string): Promise<SeoBacklinkScanRow | null> {
  const sb = getServiceClient(config);
  const { data } = await sb.from('seo_backlink_scans').select('*').eq('id', scanId).eq('workspace_id', workspaceId).maybeSingle();
  return (data as SeoBacklinkScanRow | null) ?? null;
}

export async function getLatestBacklinkScanForSite(config: ServerConfig, workspaceId: string, siteId: string): Promise<SeoBacklinkScanRow | null> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('seo_backlink_scans')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('website_id', siteId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as SeoBacklinkScanRow | null) ?? null;
}

export async function listBacklinkScansForSite(
  config: ServerConfig,
  workspaceId: string,
  siteId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<{ scans: SeoBacklinkScanRow[]; total: number }> {
  const sb = getServiceClient(config);
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  const { data, count, error } = await sb
    .from('seo_backlink_scans')
    .select('*', { count: 'exact' })
    .eq('workspace_id', workspaceId)
    .eq('website_id', siteId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw new Error(`list_backlink_scans_failed: ${error.message}`);
  return { scans: (data || []) as SeoBacklinkScanRow[], total: count || 0 };
}

export interface BacklinkListFilters {
  dofollowOnly?: boolean;
  isNew?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
}

export async function listBacklinks(config: ServerConfig, workspaceId: string, scanId: string, filters: BacklinkListFilters = {}) {
  const sb = getServiceClient(config);
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const offset = Math.max(filters.offset ?? 0, 0);
  let query = sb.from('seo_backlinks').select('*', { count: 'exact' }).eq('workspace_id', workspaceId).eq('scan_id', scanId);
  if (filters.dofollowOnly) query = query.eq('is_dofollow', true);
  if (typeof filters.isNew === 'boolean') query = query.eq('is_new', filters.isNew);
  if (filters.search) query = query.ilike('source_domain', `%${filters.search}%`);
  const { data, count, error } = await query.order('domain_rank', { ascending: false, nullsFirst: false }).range(offset, offset + limit - 1);
  if (error) throw new Error(`list_backlinks_failed: ${error.message}`);
  return { backlinks: data || [], total: count || 0 };
}

/** Cooperative cancel: flags both the seo_backlink_scans row and its underlying job. */
export async function requestBacklinkScanCancel(config: ServerConfig, workspaceId: string, scanId: string): Promise<{ ok: boolean }> {
  const scan = await getBacklinkScan(config, workspaceId, scanId);
  if (!scan) return { ok: false };
  const sb = getServiceClient(config);
  await sb.from('seo_backlink_scans').update({ cancel_requested: true }).eq('id', scanId).in('status', ['queued', 'running', 'processing']);
  await requestJobCancel(config, scan.job_id);
  await cancelQueuedJob(config, scan.job_id);
  const job = await getJob(config, scan.job_id);
  if (job && job.status === 'cancelled') {
    await sb.from('seo_backlink_scans').update({ status: 'cancelled', finished_at: new Date().toISOString() }).eq('id', scanId).in('status', ['queued', 'running', 'processing']);
  }
  return { ok: true };
}

export { SiteResolutionError };
