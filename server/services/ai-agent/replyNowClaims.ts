/**
 * AI Agent — durable idempotency store for "AI Reply Now".
 *
 * Correctness boundary for duplicate suppression. The in-process Map inside
 * replyNow.ts stays as a fast local optimization, but the authoritative
 * mutual exclusion lives here, in public.ai_agent_reply_now_claims
 * (migration 059), so two Core replicas that receive the same
 * (workspace, conversation, operation, idempotency key) collapse to exactly
 * ONE engine generation.
 *
 * Lifecycle:
 *   claim()    → INSERT (PK conflict = someone else owns the key)
 *                  ├─ existing 'completed' → duplicate_completed (+ result)
 *                  ├─ existing 'running' and not expired → duplicate_running
 *                  └─ 'failed' / expired 'running' → conditional re-claim,
 *                     single winner via UPDATE ... RETURNING
 *   complete() → status='completed' + memoized result (bounded by expires_at)
 *   fail()     → status='failed' (retryable; never silently deleted)
 *
 * No database transaction is held open across the AI provider call.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

export const REPLY_NOW_OPERATION = 'ai_reply_now';
/** A running claim older than this is considered abandoned and re-claimable. */
export const CLAIM_TTL_MS = 10 * 60 * 1000;

export interface ClaimScope {
  workspaceId: string;
  conversationId: string;
  idempotencyKey: string;
  operation?: string;
}

export type ClaimState = 'claimed' | 'duplicate_running' | 'duplicate_completed';

export interface ClaimOutcome<T = unknown> {
  state: ClaimState;
  result?: T | null;
}

export function buildClaimKey(scope: ClaimScope): string {
  return [
    scope.workspaceId,
    scope.conversationId,
    scope.operation || REPLY_NOW_OPERATION,
    scope.idempotencyKey,
  ].join(':');
}

function isExpired(row: any, now: number): boolean {
  const exp = row?.expires_at ? new Date(row.expires_at).getTime() : 0;
  return !exp || exp <= now;
}

export async function claimReplyNow<T = unknown>(
  config: ServerConfig,
  scope: ClaimScope,
): Promise<ClaimOutcome<T>> {
  const sb = getServiceClient(config);
  const key = buildClaimKey(scope);
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const expiresIso = new Date(now + CLAIM_TTL_MS).toISOString();

  const { error } = await sb.from('ai_agent_reply_now_claims').insert({
    claim_key: key,
    workspace_id: scope.workspaceId,
    conversation_id: scope.conversationId,
    operation: scope.operation || REPLY_NOW_OPERATION,
    idempotency_key: scope.idempotencyKey,
    status: 'running',
    claimed_at: nowIso,
    expires_at: expiresIso,
    updated_at: nowIso,
  });
  if (!error) return { state: 'claimed' };

  // Someone already owns the key — inspect the winner's state.
  const { data: existing } = await sb
    .from('ai_agent_reply_now_claims')
    .select('status,result,expires_at')
    .eq('claim_key', key)
    .maybeSingle();

  if (existing && (existing as any).status === 'completed' && !isExpired(existing, now)) {
    return { state: 'duplicate_completed', result: ((existing as any).result ?? null) as T };
  }

  const retryable =
    !existing ||
    (existing as any).status === 'failed' ||
    ((existing as any).status === 'running' && isExpired(existing, now));

  if (retryable) {
    // Exactly one retrying caller may take over an abandoned/failed claim.
    const { data: won } = await sb
      .from('ai_agent_reply_now_claims')
      .update({ status: 'running', claimed_at: nowIso, expires_at: expiresIso, result: null, updated_at: nowIso })
      .eq('claim_key', key)
      .neq('status', 'running')
      .select('claim_key');
    if (Array.isArray(won) && won.length) return { state: 'claimed' };

    // Expired 'running' takeover (status is still 'running', so the guard
    // above cannot match): scope the update by the stale claim timestamp.
    if ((existing as any)?.status === 'running') {
      const { data: takeover } = await sb
        .from('ai_agent_reply_now_claims')
        .update({ status: 'running', claimed_at: nowIso, expires_at: expiresIso, result: null, updated_at: nowIso })
        .eq('claim_key', key)
        .lt('expires_at', nowIso)
        .select('claim_key');
      if (Array.isArray(takeover) && takeover.length) return { state: 'claimed' };
    }
  }

  return { state: 'duplicate_running' };
}

export async function completeReplyNowClaim(
  config: ServerConfig,
  scope: ClaimScope,
  result: unknown,
): Promise<void> {
  try {
    const sb = getServiceClient(config);
    await sb
      .from('ai_agent_reply_now_claims')
      .update({
        status: 'completed',
        result: (result ?? null) as any,
        expires_at: new Date(Date.now() + CLAIM_TTL_MS).toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('claim_key', buildClaimKey(scope));
  } catch (err: any) {
    console.warn('[ai-agent.replyNow] claim complete failed:', err?.message || err);
  }
}

export async function failReplyNowClaim(config: ServerConfig, scope: ClaimScope): Promise<void> {
  try {
    const sb = getServiceClient(config);
    await sb
      .from('ai_agent_reply_now_claims')
      .update({ status: 'failed', result: null, updated_at: new Date().toISOString() })
      .eq('claim_key', buildClaimKey(scope));
  } catch (err: any) {
    console.warn('[ai-agent.replyNow] claim fail failed:', err?.message || err);
  }
}

/** Reads a completed result, used while polling a claim owned by a peer. */
export async function readReplyNowClaim<T = unknown>(
  config: ServerConfig,
  scope: ClaimScope,
): Promise<{ status: string | null; result: T | null }> {
  try {
    const sb = getServiceClient(config);
    const { data } = await sb
      .from('ai_agent_reply_now_claims')
      .select('status,result')
      .eq('claim_key', buildClaimKey(scope))
      .maybeSingle();
    return { status: ((data as any)?.status as string) || null, result: (((data as any)?.result) ?? null) as T };
  } catch {
    return { status: null, result: null };
  }
}
