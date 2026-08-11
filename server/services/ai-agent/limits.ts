/**
 * AI Agent / Train — plan-limit resolver for Web Pages and File ingestion.
 *
 * Source of truth: billing_plans.limits jsonb. Hardcoded fallbacks are
 * intentionally tight (Free) and never default to "unlimited".
 *
 * KEY SEPARATION (follow-up to Phase 7 finding): ai_kb_max_pages /
 * ai_kb_max_depth / ai_kb_jobs_per_month are also read by
 * server/services/ai-kb/limits.ts, which gates the separate AI KB Builder
 * feature -- despite the previous version of this comment's claim, those
 * three keys were NOT distinct; both resolvers read the exact same
 * `billing_plans.limits` JSON keys, so a platform admin changing one
 * product's allowance silently changed the other's too.
 *
 * server/services/ai-kb/limits.ts is the historical/canonical owner of
 * those three keys (see docs/PLAN_DATA_RECONCILIATION.md and the origin
 * seed migration, which seeds them together with AI-KB-Builder-only
 * max_articles/max_chars/monthly_credits as one coherent block) and is
 * left completely untouched. This resolver now prefers new,
 * AI-Agent-specific `ai_agent_web_source_*` keys and falls back to the
 * historical shared key ONLY when the new key is absent -- so every
 * existing plan (which only ever had the shared key) keeps its exact
 * current effective limit. ai_kb_file_count / ai_kb_file_size_mb were
 * already AI-Agent-exclusive (ai-kb/limits.ts never reads them) and are
 * unchanged.
 */

import type { ServerConfig } from '../../config.js';
import { getWorkspacePlanInfo } from '../../middleware/featureGating.js';

export interface AiAgentDataLimits {
  ai_kb_max_pages: number;
  ai_kb_max_depth: number;
  ai_kb_jobs_per_month: number;
  ai_kb_file_count: number;
  ai_kb_file_size_mb: number;
}

const FALLBACKS: Record<string, AiAgentDataLimits> = {
  free: {
    ai_kb_max_pages: 10, ai_kb_max_depth: 1, ai_kb_jobs_per_month: 2,
    ai_kb_file_count: 3, ai_kb_file_size_mb: 2,
  },
  pro: {
    ai_kb_max_pages: 500, ai_kb_max_depth: 3, ai_kb_jobs_per_month: 20,
    ai_kb_file_count: 50, ai_kb_file_size_mb: 20,
  },
  business: {
    ai_kb_max_pages: 2000, ai_kb_max_depth: 4, ai_kb_jobs_per_month: 100,
    ai_kb_file_count: 200, ai_kb_file_size_mb: 50,
  },
  enterprise: {
    // Treated as Business unless billing_plans.limits overrides — never unlimited.
    ai_kb_max_pages: 2000, ai_kb_max_depth: 4, ai_kb_jobs_per_month: 100,
    ai_kb_file_count: 200, ai_kb_file_size_mb: 50,
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

export interface ResolvedAiAgentLimits {
  limits: AiAgentDataLimits;
  planSlug: string | null;
  planName: string | null;
}

export async function resolveAiAgentDataLimits(
  config: ServerConfig,
  workspaceId: string,
): Promise<ResolvedAiAgentLimits> {
  let info: { plan: any; limits: Record<string, number> } | null = null;
  try {
    info = await getWorkspacePlanInfo(
      config.supabaseUrl,
      config.supabaseServiceRoleKey,
      workspaceId,
    );
  } catch {
    info = null;
  }
  const slug = (info?.plan?.slug || 'free') as string;
  const fallback = FALLBACKS[slug] || STRICT;
  const dbLimits = (info?.limits || {}) as Record<string, unknown>;
  // New AI-Agent-specific keys win when present; otherwise fall back to the
  // historical shared key (still owned by ai-kb/limits.ts) so every
  // existing plan's effective AI Agent limit is unchanged.
  const legacyMaxPages = num(dbLimits.ai_kb_max_pages, fallback.ai_kb_max_pages);
  const legacyMaxDepth = num(dbLimits.ai_kb_max_depth, fallback.ai_kb_max_depth);
  const legacyJobsPerMonth = num(dbLimits.ai_kb_jobs_per_month, fallback.ai_kb_jobs_per_month);
  return {
    planSlug: slug,
    planName: info?.plan?.name || null,
    limits: {
      ai_kb_max_pages: num(dbLimits.ai_agent_web_source_max_pages, legacyMaxPages),
      ai_kb_max_depth: num(dbLimits.ai_agent_web_source_max_depth, legacyMaxDepth),
      ai_kb_jobs_per_month: num(dbLimits.ai_agent_web_source_jobs_per_month, legacyJobsPerMonth),
      ai_kb_file_count: num(dbLimits.ai_kb_file_count, fallback.ai_kb_file_count),
      ai_kb_file_size_mb: num(dbLimits.ai_kb_file_size_mb, fallback.ai_kb_file_size_mb),
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