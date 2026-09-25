/**
 * AI KB Builder — plan limit resolver.
 *
 * The crawl limits (pages, depth, jobs per month) are registry capabilities
 * and resolve exactly as GET /api/plans/workspace/:id/effective shows them:
 * workspace override ?? plan ?? registry default
 * (billing/servicePlanLimits.ts).
 *
 * Drafts per scan, characters and monthly credits read the legacy keys
 * `ai_kb_max_articles` / `ai_kb_max_chars` / `ai_kb_monthly_credits`, which
 * the registry does not define (LEGACY_PLAN_KEYS) and the snapshot does not
 * show; they keep safe per-plan fallbacks. The plan value always wins.
 */

import type { ServerConfig } from '../../config.js';
import { getWorkspacePlanInfo, getWorkspacePlanInfoDetailed } from '../../middleware/featureGating.js';
import { getServiceClient } from '../../supabase.js';
import { registryLimits, servicePlanIdentity, unregisteredLimits, type PlanLimitSource } from '../billing/servicePlanLimits.js';
import { readOk, readFailed, type ReadResult } from './readResult.js';

export interface AiKbLimits {
  maxPages: number;
  maxDepth: number;
  jobsPerMonth: number;
  maxArticles: number;
  maxChars: number;
  monthlyCredits: number;
}

/** Registry limits: override ?? plan ?? registry default. */
export const AI_KB_BUILDER_PLAN_KEYS = ['ai_kb_max_pages', 'ai_kb_max_depth', 'ai_kb_jobs_per_month'] as const;

/** Legacy keys the registry does not define, per plan slug. */
const LEGACY_FALLBACKS = {
  free: { ai_kb_max_articles: 3, ai_kb_max_chars: 10_000, ai_kb_monthly_credits: 10 },
  pro: { ai_kb_max_articles: 30, ai_kb_max_chars: 100_000, ai_kb_monthly_credits: 200 },
  business: { ai_kb_max_articles: 150, ai_kb_max_chars: 500_000, ai_kb_monthly_credits: 1000 },
  enterprise: { ai_kb_max_articles: 300, ai_kb_max_chars: 1_000_000, ai_kb_monthly_credits: 5000 },
};

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

function projectLimits(info: PlanLimitSource): { limits: AiKbLimits; planSlug: string | null } {
  const plan = registryLimits(info, AI_KB_BUILDER_PLAN_KEYS);
  const legacy = unregisteredLimits(info, LEGACY_FALLBACKS);
  return {
    planSlug: servicePlanIdentity(info).planSlug,
    limits: {
      maxPages: plan.ai_kb_max_pages,
      maxDepth: plan.ai_kb_max_depth,
      jobsPerMonth: plan.ai_kb_jobs_per_month,
      maxArticles: legacy.ai_kb_max_articles,
      maxChars: legacy.ai_kb_max_chars,
      monthlyCredits: legacy.ai_kb_monthly_credits,
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
  } catch (err) {
    console.error('[AiKb] monthly job count exception:', err instanceof Error ? err.message : String(err));
    return readFailed('job_usage_status_unavailable');
  }
}
