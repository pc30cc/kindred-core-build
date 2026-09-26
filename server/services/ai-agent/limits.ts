/**
 * AI Agent / Train — plan-limit resolver for Web Pages and File ingestion.
 *
 * Every limit resolves exactly as GET /api/plans/workspace/:id/effective
 * shows it: workspace override ?? plan ?? registry default
 * (billing/servicePlanLimits.ts).
 *
 * KEY SEPARATION (follow-up to Phase 7 finding): ai_kb_max_pages /
 * ai_kb_max_depth / ai_kb_jobs_per_month are also read by
 * server/services/ai-kb/limits.ts, which gates the separate AI KB Builder
 * feature, so a platform admin changing one product's allowance used to
 * change the other's too. server/services/ai-kb/limits.ts is the
 * historical/canonical owner of those three keys (see
 * docs/PLAN_DATA_RECONCILIATION.md and the origin seed migration). This
 * resolver reads the AI-Agent-specific `ai_agent_web_source_*` keys, whose
 * registry entries document the historical shared key as their legacy
 * fallback when the plan leaves them unset — the snapshot applies the same
 * alias (effectiveEntitlements.ts LEGACY_LIMIT_ALIASES), so every existing
 * plan (which only ever had the shared key) keeps its effective limit.
 * ai_kb_file_count / ai_kb_file_size_mb were always AI-Agent-exclusive.
 */

import type { ServerConfig } from '../../config.js';
import { readServicePlanInfo, registryLimits, servicePlanIdentity } from '../billing/servicePlanLimits.js';

export interface AiAgentDataLimits {
  ai_kb_max_pages: number;
  ai_kb_max_depth: number;
  ai_kb_jobs_per_month: number;
  ai_kb_file_count: number;
  ai_kb_file_size_mb: number;
}

/** Registry limits: override ?? plan (legacy alias included) ?? registry default. */
export const AI_AGENT_DATA_PLAN_KEYS = [
  'ai_agent_web_source_max_pages',
  'ai_agent_web_source_max_depth',
  'ai_agent_web_source_jobs_per_month',
  'ai_kb_file_count',
  'ai_kb_file_size_mb',
] as const;

export interface ResolvedAiAgentLimits {
  limits: AiAgentDataLimits;
  planSlug: string | null;
  planName: string | null;
}

export async function resolveAiAgentDataLimits(
  config: ServerConfig,
  workspaceId: string,
): Promise<ResolvedAiAgentLimits> {
  const info = await readServicePlanInfo(config, workspaceId);
  const limits = registryLimits(info, AI_AGENT_DATA_PLAN_KEYS);
  return {
    ...servicePlanIdentity(info),
    limits: {
      ai_kb_max_pages: limits.ai_agent_web_source_max_pages,
      ai_kb_max_depth: limits.ai_agent_web_source_max_depth,
      ai_kb_jobs_per_month: limits.ai_agent_web_source_jobs_per_month,
      ai_kb_file_count: limits.ai_kb_file_count,
      ai_kb_file_size_mb: limits.ai_kb_file_size_mb,
    },
  };
}

/** Count workspace's Data Hub sync jobs in the current calendar month. */
export async function countSourceJobsThisMonth(
  config: ServerConfig,
  workspaceId: string,
): Promise<number> {
  const { getServiceClient } = await import('../../supabase.js');
  const sb = getServiceClient(config);
  const start = new Date();
  start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
  const { count } = await sb
    .from('ai_source_sync_jobs')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .gte('created_at', start.toISOString());
  return count || 0;
}