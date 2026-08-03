/**
 * AI KB Builder — plan limit resolver.
 *
 * Reads from billing_plans.limits jsonb (resolved via existing
 * getWorkspacePlanInfo helper) and falls back to safe hard-coded defaults
 * keyed by plan slug. DB always wins when a key is present.
 */

import type { ServerConfig } from '../../config.js';
import { getWorkspacePlanInfo, getWorkspacePlanInfoDetailed } from '../../middleware/featureGating.js';
import { getServiceClient } from '../../supabase.js';
import { readOk, readFailed, type ReadResult } from './readResult.js';

export interface AiKbLimits {
  maxPages: number;
  maxDepth: number;
  jobsPerMonth: number;
  maxArticles: number;
  maxChars: number;
  monthlyCredits: number;
}

const FALLBACKS: Record<string, AiKbLimits> = {
  free: {
    maxPages: 3, maxDepth: 1, jobsPerMonth: 1,
    maxArticles: 3, maxChars: 10_000, monthlyCredits: 10,
  },
  pro: {
    maxPages: 25, maxDepth: 2, jobsPerMonth: 5,
    maxArticles: 30, maxChars: 100_000, monthlyCredits: 200,
  },
  business: {
    maxPages: 100, maxDepth: 3, jobsPerMonth: 20,
    maxArticles: 150, maxChars: 500_000, monthlyCredits: 1000,
  },
  enterprise: {
    maxPages: 200, maxDepth: 3, jobsPerMonth: 50,
    maxArticles: 300, maxChars: 1_000_000, monthlyCredits: 5000,
  },
};

const STRICT_DEFAULT = FALLBACKS.free;

function num(v: any, fallback: number): number {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

export async function resolveAiKbLimits(
  config: ServerConfig,
  workspaceId: string,
): Promise<{ limits: AiKbLimits; planSlug: string | null }> {
  const info = await getWorkspacePlanInfo(
    config.supabaseUrl,
    config.supabaseServiceRoleKey,
    workspaceId,
  );
  return projectLimits(info);
}

function projectLimits(
  info: { plan: any; limits: Record<string, number> },
): { limits: AiKbLimits; planSlug: string | null } {
  const slug = (info.plan?.slug || 'free') as string;
  const fallback = FALLBACKS[slug] || STRICT_DEFAULT;
  const dbLimits = info.limits || {};

  return {
    planSlug: slug,
    limits: {
      maxPages: num(dbLimits.ai_kb_max_pages, fallback.maxPages),
      maxDepth: num(dbLimits.ai_kb_max_depth, fallback.maxDepth),
      jobsPerMonth: num(dbLimits.ai_kb_jobs_per_month, fallback.jobsPerMonth),
      maxArticles: num(dbLimits.ai_kb_max_articles, fallback.maxArticles),
      maxChars: num(dbLimits.ai_kb_max_chars, fallback.maxChars),
      monthlyCredits: num(dbLimits.ai_kb_monthly_credits, fallback.monthlyCredits),
    },
  };
}

/**
 * Phase 6-S5-R7.3 §3 — fail-closed limit resolution.
 *
 * Silently degrading an unreadable plan to the Free fallback shows the
 * customer limits that are not theirs and can wrongly block a scan, so an
 * unreadable plan is reported as `plan_status_unavailable`.
 */
export async function resolveAiKbLimitsDetailed(
  config: ServerConfig,
  workspaceId: string,
): Promise<ReadResult<{ limits: AiKbLimits; planSlug: string | null }>> {
  const info = await getWorkspacePlanInfoDetailed(
    config.supabaseUrl,
    config.supabaseServiceRoleKey,
    workspaceId,
  );
  if (!info.ok) return readFailed('plan_status_unavailable');
  return readOk(projectLimits(info.value));
}

/**
 * Count this workspace's AI KB jobs in the current calendar month so we can
 * compare against limits.jobsPerMonth before enqueuing a new one.
 */
export async function countJobsThisMonth(config: ServerConfig, workspaceId: string): Promise<number> {
  const r = await countJobsThisMonthDetailed(config, workspaceId);
  return r.ok ? r.value : 0;
}

/**
 * Fail-closed job counter. A failed count must NOT read as "0 jobs used" —
 * that would hand out unlimited scans during an outage.
 */
export async function countJobsThisMonthDetailed(
  config: ServerConfig,
  workspaceId: string,
): Promise<ReadResult<number>> {
  const sb = getServiceClient(config);
  const startOfMonth = new Date();
  startOfMonth.setUTCDate(1);
  startOfMonth.setUTCHours(0, 0, 0, 0);
  try {
    const { count, error } = await sb
      .from('ai_kb_jobs')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .gte('created_at', startOfMonth.toISOString());
    if (error) {
      console.error('[AiKb] monthly job count failed:', error.message);
      return readFailed('job_usage_status_unavailable');
    }
    if (typeof count !== 'number') return readFailed('job_usage_status_unavailable');
    return readOk(count);
  } catch (err: any) {
    console.error('[AiKb] monthly job count exception:', err?.message);
    return readFailed('job_usage_status_unavailable');
  }
}
