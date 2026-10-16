/**
 * AI KB Builder — credit state for the AI Builder UI, and its usage log.
 * The worker pays from the AI wallet (aiKbWorkerWalletOnly.test.ts); there
 * is no separate credit ledger here.
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { readOk, readFailed, type ReadResult } from './readResult.js';
import { parseEntitlementResponse } from '../billing/entitlementParse.js';

/**
 * Read remaining AI credits for display in the AI Builder UI. Reads the
 * workspace_usage_counters row for the current period; falls back to plan
 * info for the limit. Best-effort, never throws.
 */
export async function readAiCreditState(
  config: ServerConfig,
  workspaceId: string,
): Promise<{ used: number; limit: number; remaining: number; period: string }> {
  const r = await readAiCreditStateDetailed(config, workspaceId);
  if (r.ok) return r.value;
  const period = new Date().toISOString().slice(0, 7);
  return { used: 0, limit: 0, remaining: 0, period };
}

/**
 * Phase 6-S5-R7.3 §3 — fail-closed credit state.
 *
 * "You have 0 credits left" is an actionable business statement. Emitting it
 * because the counter table or the entitlement RPC was unreachable is a
 * fabricated balance, so any read failure surfaces as
 * `credit_status_unavailable` and the UI renders a retry state instead.
 */
export async function readAiCreditStateDetailed(
  config: ServerConfig,
  workspaceId: string,
): Promise<ReadResult<{ used: number; limit: number; remaining: number; period: string }>> {
  const sb = getServiceClient(config);
  const period = new Date().toISOString().slice(0, 7); // YYYY-MM

  try {
    const { data: counter, error: counterError } = await sb
      .from('workspace_usage_counters')
      .select('ai_credits_used')
      .eq('workspace_id', workspaceId)
      .eq('period', period)
      .maybeSingle();
    if (counterError) {
      console.error('[AiKb] credit counter read failed:', counterError.message);
      return readFailed('credit_status_unavailable');
    }

    const rawUsed = (counter as { ai_credits_used?: unknown } | null)?.ai_credits_used;
    const used = typeof rawUsed === 'number' && Number.isFinite(rawUsed) ? rawUsed : 0;

    // Plan's ai_credits limit via the entitlement RPC.
    const { data, error } = await sb.rpc('check_workspace_entitlement', {
      _workspace_id: workspaceId,
      _feature: 'ai_credits',
    });
    const parsed = parseEntitlementResponse(data, error);
    if (parsed.outcome === 'unavailable') {
      console.error('[AiKb] credit entitlement unreadable:', parsed.reason);
      return readFailed('credit_status_unavailable');
    }

    const limit = parsed.outcome === 'allowed' ? (parsed.limit ?? 0) : 0;
    const remaining = limit === -1 ? -1 : Math.max(0, limit - used);
    return readOk({ used, limit, remaining, period });
  } catch (err: unknown) {
    console.error('[AiKb] credit state exception:', (err as { message?: string } | null)?.message);
    return readFailed('credit_status_unavailable');
  }
}

/**
 * Append a row to ai_kb_usage. Best-effort, never throws.
 */
export async function logAiKbUsage(
  config: ServerConfig,
  workspaceId: string,
  eventType: string,
  opts: { jobId?: string; generatedArticleId?: string; credits?: number; metadata?: Record<string, unknown> } = {},
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
  } catch (err: unknown) {
    console.warn('[ai-kb usage] insert failed:', (err as { message?: string } | null)?.message || err);
  }
}
