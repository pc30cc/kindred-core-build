/**
 * SEO Keyword Research — business logic. Owns `seo_keyword_research_runs`
 * and `seo_keyword_results`; mirrors server/services/seo/backlinkService.ts's
 * shape exactly (resolve site → resolve limits → check concurrency/
 * frequency → enqueue a background_jobs row → return the created run row).
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { enqueueJob, requestJobCancel, cancelQueuedJob, getJob } from '../jobs/queue.js';
import { resolveWorkspaceSite, SiteResolutionError } from './siteResolver.js';
import { resolveKeywordsLimits, countActiveWorkspaceKeywordRuns, getMostRecentKeywordRunStart } from './keywordsLimits.js';

export type KeywordRunLimitReason = 'workspace_concurrency_limit' | 'frequency_limit' | 'module_not_available' | 'too_many_keywords';

export class KeywordRunLimitError extends Error {
  reason: KeywordRunLimitReason;
  retryAfterSeconds?: number;
  constructor(reason: KeywordRunLimitReason, message: string, retryAfterSeconds?: number) {
    super(message);
    this.reason = reason;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface SeoKeywordResearchRunRow {
  id: string;
  job_id: string;
  workspace_id: string;
  website_id: string;
  seed_keywords: string[];
  provider: string;
  max_keywords: number;
  status: string;
  progress: number;
  progress_stage: string | null;
  total_keywords: number | null;
  cancel_requested: boolean;
  error_message: string | null;
  error_category: string | null;
  created_by: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

const MAX_SEED_KEYWORDS_INPUT = 1000;

/** Trims, dedupes and bounds the raw client input. Real limit enforcement happens against the plan below. */
function normalizeSeedKeywords(raw: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of raw) {
    const trimmed = k.trim().slice(0, 200);
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= MAX_SEED_KEYWORDS_INPUT) break;
  }
  return out;
}

export async function createKeywordResearchRun(
  config: ServerConfig,
  args: { workspaceId: string; siteId: string; userId: string; seedKeywords: string[] },
): Promise<SeoKeywordResearchRunRow> {
  const site = await resolveWorkspaceSite(config, args.workspaceId, args.siteId);
  const { limits } = await resolveKeywordsLimits(config, args.workspaceId);

  if (limits.seo_keywords_max_per_lookup <= 0) {
    throw new KeywordRunLimitError('module_not_available', 'Keyword research is not available on this plan');
  }

  const seedKeywords = normalizeSeedKeywords(args.seedKeywords);
  if (seedKeywords.length === 0) {
    throw new KeywordRunLimitError('too_many_keywords', 'At least one keyword is required');
  }
  if (seedKeywords.length > limits.seo_keywords_max_per_lookup) {
    throw new KeywordRunLimitError('too_many_keywords', `This plan allows up to ${limits.seo_keywords_max_per_lookup} keywords per lookup`);
  }

  const workspaceActive = await countActiveWorkspaceKeywordRuns(config, args.workspaceId);
  if (workspaceActive >= limits.seo_keywords_workspace_concurrent_runs) {
    throw new KeywordRunLimitError('workspace_concurrency_limit', 'Workspace has reached its concurrent keyword lookup limit');
  }

  const sb = getServiceClient(config);
  const job = await enqueueJob(config, {
    workspaceId: args.workspaceId,
    jobType: 'seo_keyword_research',
    subjectType: 'seo_site',
    subjectId: site.id,
    createdBy: args.userId,
    payload: { siteId: site.id },
  });

  const { data, error } = await sb
    .from('seo_keyword_research_runs')
    .insert({
      job_id: job.id,
      workspace_id: args.workspaceId,
      website_id: site.id,
      seed_keywords: seedKeywords,
      provider: 'dataforseo',
      max_keywords: limits.seo_keywords_max_per_lookup,
      created_by: args.userId,
    })
    .select('*')
    .single();
  if (error || !data) throw new Error(`create_keyword_run_failed: ${error?.message}`);

  return data as SeoKeywordResearchRunRow;
}

export async function getKeywordResearchRun(config: ServerConfig, workspaceId: string, runId: string): Promise<SeoKeywordResearchRunRow | null> {
  const sb = getServiceClient(config);
  const { data } = await sb.from('seo_keyword_research_runs').select('*').eq('id', runId).eq('workspace_id', workspaceId).maybeSingle();
  return (data as SeoKeywordResearchRunRow | null) ?? null;
}

export async function getLatestKeywordResearchRunForSite(config: ServerConfig, workspaceId: string, siteId: string): Promise<SeoKeywordResearchRunRow | null> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('seo_keyword_research_runs')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('website_id', siteId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as SeoKeywordResearchRunRow | null) ?? null;
}

export async function listKeywordResearchRunsForSite(
  config: ServerConfig,
  workspaceId: string,
  siteId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<{ runs: SeoKeywordResearchRunRow[]; total: number }> {
  const sb = getServiceClient(config);
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  const { data, count, error } = await sb
    .from('seo_keyword_research_runs')
    .select('*', { count: 'exact' })
    .eq('workspace_id', workspaceId)
    .eq('website_id', siteId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw new Error(`list_keyword_runs_failed: ${error.message}`);
  return { runs: (data || []) as SeoKeywordResearchRunRow[], total: count || 0 };
}

export interface KeywordResultFilters {
  search?: string;
  seedOnly?: boolean;
  limit?: number;
  offset?: number;
}

export async function listKeywordResults(config: ServerConfig, workspaceId: string, runId: string, filters: KeywordResultFilters = {}) {
  const sb = getServiceClient(config);
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
  const offset = Math.max(filters.offset ?? 0, 0);
  let query = sb.from('seo_keyword_results').select('*', { count: 'exact' }).eq('workspace_id', workspaceId).eq('run_id', runId);
  if (filters.seedOnly) query = query.eq('is_seed', true);
  if (filters.search) query = query.ilike('keyword', `%${filters.search}%`);
  const { data, count, error } = await query.order('search_volume', { ascending: false, nullsFirst: false }).range(offset, offset + limit - 1);
  if (error) throw new Error(`list_keyword_results_failed: ${error.message}`);
  return { results: data || [], total: count || 0 };
}

export async function requestKeywordRunCancel(config: ServerConfig, workspaceId: string, runId: string): Promise<{ ok: boolean }> {
  const run = await getKeywordResearchRun(config, workspaceId, runId);
  if (!run) return { ok: false };
  const sb = getServiceClient(config);
  await sb.from('seo_keyword_research_runs').update({ cancel_requested: true }).eq('id', runId).in('status', ['queued', 'running', 'processing']);
  await requestJobCancel(config, run.job_id);
  await cancelQueuedJob(config, run.job_id);
  const job = await getJob(config, run.job_id);
  if (job && job.status === 'cancelled') {
    await sb.from('seo_keyword_research_runs').update({ status: 'cancelled', finished_at: new Date().toISOString() }).eq('id', runId).in('status', ['queued', 'running', 'processing']);
  }
  return { ok: true };
}

export { SiteResolutionError };
