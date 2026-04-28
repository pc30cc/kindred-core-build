/**
 * AI KB Builder — credit helper.
 *
 * Thin wrapper over the existing deductAICredits RPC so the worker and the
 * route handlers share one entry point. We do NOT introduce a separate
 * credit ledger — AI KB consumes the same workspace AI credits used by
 * /api/ai/complete.
 */

import type { ServerConfig } from '../../config.js';
import { deductAICredits } from '../../middleware/featureGating.js';
import { getServiceClient } from '../../supabase.js';

export interface CreditDeductionResult {
  success: boolean;
  credits_used?: number;
  credits_limit?: number;
  credits_remaining?: number;
  reason?: string;
}

export async function consumeAiCredits(
  config: ServerConfig,
  workspaceId: string,
  credits: number = 1,
): Promise<CreditDeductionResult> {
  return deductAICredits(
    config.supabaseUrl,
    config.supabaseServiceRoleKey,
    workspaceId,
    credits,
  );
}

/**
 * Read remaining AI credits for display in the AI Builder UI. Reads the
 * workspace_usage_counters row for the current period; falls back to plan
 * info for the limit. Best-effort, never throws.
 */
export async function readAiCreditState(
  config: ServerConfig,
  workspaceId: string,
): Promise<{ used: number; limit: number; remaining: number; period: string }> {
  const sb = getServiceClient(config);
  const period = new Date().toISOString().slice(0, 7); // YYYY-MM

  const { data: counter } = await sb
    .from('workspace_usage_counters')
    .select('ai_credits_used')
    .eq('workspace_id', workspaceId)
    .eq('period', period)
    .maybeSingle();

  const used = (counter as any)?.ai_credits_used ?? 0;

  // Get the plan's ai_credits limit via the entitlement RPC.
  let limit = 0;
  try {
    const { data } = await sb.rpc('check_workspace_entitlement', {
      _workspace_id: workspaceId,
      _feature: 'ai_credits',
    });
    if (data && (data as any).allowed) {
      const raw = (data as any).limit;
      limit = typeof raw === 'number' ? raw : Number(raw) || 0;
    }
  } catch {
    // Best effort.
  }

  const remaining = limit === -1 ? -1 : Math.max(0, limit - used);
  return { used, limit, remaining, period };
}

/**
 * Append a row to ai_kb_usage. Best-effort, never throws.
 */
export async function logAiKbUsage(
  config: ServerConfig,
  workspaceId: string,
  eventType: string,
  opts: { jobId?: string; generatedArticleId?: string; credits?: number; metadata?: Record<string, any> } = {},
): Promise<void> {
  try {
    const sb = getServiceClient(config);
    await sb.from('ai_kb_usage').insert({
      workspace_id: workspaceId,
      job_id: opts.jobId ?? null,
      generated_article_id: opts.generatedArticleId ?? null,
      event_type: eventType,
      credits: opts.credits ?? 0,
      metadata: opts.metadata ?? {},
    });
  } catch (err: any) {
    console.warn('[ai-kb usage] insert failed:', err?.message || err);
  }
}
