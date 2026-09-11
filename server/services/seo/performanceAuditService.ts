/**
 * SEO Performance Auditing — business logic. Owns `seo_performance_audits`
 * and `seo_performance_results`; mirrors server/services/seo/backlinkService.ts's
 * shape (resolve crawl → resolve limits → check frequency → select
 * candidate pages → enqueue a background_jobs row → insert one pending
 * result row per selected page → return the created audit row).
 *
 * Unlike Backlinks (one vendor call per scan), a performance audit fetches
 * Core Web Vitals for up to the plan's `seo_performance_max_pages_per_audit`
 * pages of the crawl, so it pre-creates one `seo_performance_results` row
 * per selected page (status='pending') for the worker to fill in.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { enqueueJob, requestJobCancel, cancelQueuedJob, getJob } from '../jobs/queue.js';
import { getCrawl } from './crawlService.js';
import { resolvePerformanceLimits, getMostRecentPerformanceAuditStart } from './performanceLimits.js';

export type PerformanceAuditLimitReason = 'crawl_not_found' | 'frequency_limit' | 'module_not_available';

export class PerformanceAuditLimitError extends Error {
  reason: PerformanceAuditLimitReason;
  retryAfterSeconds?: number;
  constructor(reason: PerformanceAuditLimitReason, message: string, retryAfterSeconds?: number) {
    super(message);
    this.reason = reason;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface SeoPerformanceAuditRow {
  id: string;
  job_id: string;
  workspace_id: string;
  website_id: string;
  crawl_id: string;
  provider: string;
  max_pages: number;
  status: string;
  progress: number;
  progress_stage: string | null;
  pages_audited: number | null;
  cancel_requested: boolean;
  error_message: string | null;
  error_category: string | null;
  created_by: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

const CANDIDATE_FETCH_LIMIT = 500;

async function selectCandidatePages(
  sb: ReturnType<typeof getServiceClient>,
  crawlId: string,
  maxPages: number,
): Promise<{ id: string; url: string }[]> {
  const { data } = await sb
    .from('seo_pages')
    .select('id, url, discovered_via, incoming_internal_links_count')
    .eq('crawl_id', crawlId)
    .eq('is_indexable', true)
    .lt('http_status', 400)
    .gte('http_status', 200)
    .limit(CANDIDATE_FETCH_LIMIT);
  const rows = (data || []) as { id: string; url: string; discovered_via: string; incoming_internal_links_count: number }[];
  rows.sort((a, b) => {
    const aStart = a.discovered_via === 'start' ? 1 : 0;
    const bStart = b.discovered_via === 'start' ? 1 : 0;
    if (aStart !== bStart) return bStart - aStart;
    return (b.incoming_internal_links_count || 0) - (a.incoming_internal_links_count || 0);
  });
  return rows.slice(0, maxPages).map((r) => ({ id: r.id, url: r.url }));
}

export async function createPerformanceAudit(
  config: ServerConfig,
  args: { workspaceId: string; crawlId: string; userId: string },
): Promise<SeoPerformanceAuditRow> {
  const crawl = await getCrawl(config, args.workspaceId, args.crawlId);
  if (!crawl) throw new PerformanceAuditLimitError('crawl_not_found', 'Crawl not found');

  const { limits } = await resolvePerformanceLimits(config, args.workspaceId);
  if (limits.seo_performance_max_pages_per_audit <= 0) {
    throw new PerformanceAuditLimitError('module_not_available', 'Performance auditing is not available on this plan');
  }

  const sb = getServiceClient(config);
  const candidates = await selectCandidatePages(sb, args.crawlId, limits.seo_performance_max_pages_per_audit);

  // job_id is NOT NULL + FK'd on seo_performance_audits, so the
  // background_jobs row must exist first. Payload stays generic (just
  // {crawlId}, for job-list observability) — the worker reads everything
  // else from the seo_performance_audits row itself.
  const job = await enqueueJob(config, {
    workspaceId: args.workspaceId,
    jobType: 'seo_performance_audit',
    subjectType: 'seo_crawl',
    subjectId: args.crawlId,
    createdBy: args.userId,
    payload: { crawlId: args.crawlId },
  });

  const { data: audit, error } = await sb
    .from('seo_performance_audits')
    .insert({
      job_id: job.id,
      workspace_id: args.workspaceId,
      website_id: crawl.website_id,
      crawl_id: args.crawlId,
      provider: 'pagespeed',
      max_pages: limits.seo_performance_max_pages_per_audit,
      created_by: args.userId,
    })
    .select('*')
    .single();
  if (error || !audit) throw new Error(`create_performance_audit_failed: ${error?.message}`);
  const auditRow = audit as SeoPerformanceAuditRow;

  if (candidates.length > 0) {
    const rows = candidates.map((p) => ({
      crawl_id: args.crawlId,
      workspace_id: args.workspaceId,
      page_id: p.id,
      url: p.url,
      status: 'pending',
      audit_id: auditRow.id,
    }));
    await sb.from('seo_performance_results').insert(rows);
  }

  return auditRow;
}

export async function getPerformanceAudit(config: ServerConfig, workspaceId: string, auditId: string): Promise<SeoPerformanceAuditRow | null> {
  const sb = getServiceClient(config);
  const { data } = await sb.from('seo_performance_audits').select('*').eq('id', auditId).eq('workspace_id', workspaceId).maybeSingle();
  return (data as SeoPerformanceAuditRow | null) ?? null;
}

export async function getLatestPerformanceAuditForCrawl(config: ServerConfig, workspaceId: string, crawlId: string): Promise<SeoPerformanceAuditRow | null> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('seo_performance_audits')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('crawl_id', crawlId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as SeoPerformanceAuditRow | null) ?? null;
}

export async function listPerformanceResults(config: ServerConfig, workspaceId: string, auditId: string) {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('seo_performance_results')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('audit_id', auditId)
    .order('performance_score', { ascending: true, nullsFirst: false });
  if (error) throw new Error(`list_performance_results_failed: ${error.message}`);
  return data || [];
}

/** Cooperative cancel: flags both the seo_performance_audits row and its underlying job. */
export async function requestPerformanceAuditCancel(config: ServerConfig, workspaceId: string, auditId: string): Promise<{ ok: boolean }> {
  const audit = await getPerformanceAudit(config, workspaceId, auditId);
  if (!audit) return { ok: false };
  const sb = getServiceClient(config);
  await sb.from('seo_performance_audits').update({ cancel_requested: true }).eq('id', auditId).in('status', ['queued', 'running', 'processing']);
  await requestJobCancel(config, audit.job_id);
  await cancelQueuedJob(config, audit.job_id);
  const job = await getJob(config, audit.job_id);
  if (job && job.status === 'cancelled') {
    await sb.from('seo_performance_audits').update({ status: 'cancelled', finished_at: new Date().toISOString() }).eq('id', auditId).in('status', ['queued', 'running', 'processing']);
  }
  return { ok: true };
}
