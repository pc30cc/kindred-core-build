/**
 * AI Agent — Phase 3 action idempotency (3.10).
 *
 * Stable identity = workspace + conversation + visitor message + action name
 * + normalized arguments. Claims are persisted atomically in
 * public.ai_agent_action_claims (PRIMARY KEY on idempotency_key): the INSERT
 * itself is the mutual-exclusion primitive, so two concurrent engine runs can
 * never both execute the same side effect. Historic keys still readable from
 * conversations.metadata.ai_executed_action_keys are honoured as duplicates.
 */
import { createHash } from 'node:crypto';
import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';

const MAX_KEYS = 50;
const META_KEY = 'ai_executed_action_keys';

export function buildIdempotencyKey(parts: {
  workspaceId: string;
  conversationId: string;
  visitorMessageId?: string | null;
  name: string;
  args: Record<string, unknown>;
}): string {
  const stable = JSON.stringify(
    Object.keys(parts.args || {}).sort().reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = (parts.args as any)[k];
      return acc;
    }, {}),
  );
  const raw = [parts.workspaceId, parts.conversationId, parts.visitorMessageId || '', parts.name, stable].join('|');
  return createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

export type ClaimResult = 'claimed' | 'duplicate';

export interface IdempotencyStore {
  /** Atomically claim the key. Only the winner receives 'claimed'. */
  claim(key: string, meta?: { actionName?: string }): Promise<ClaimResult>;
  /** Mark a claimed key as successfully completed. */
  complete(key: string): Promise<void>;
  /** Release a claim after a failed execution so a later retry may run. */
  fail(key: string): Promise<void>;
  /** Cheap pre-check (non-authoritative). */
  has(key: string): boolean | Promise<boolean>;
}

/** In-memory store — used by tests and as a per-process guard. */
export function createMemoryIdempotencyStore(seed: string[] = []): IdempotencyStore {
  const states = new Map<string, 'claimed' | 'completed' | 'failed'>();
  seed.forEach((k) => states.set(k, 'completed'));
  return {
    async claim(key) {
      const cur = states.get(key);
      if (cur === 'claimed' || cur === 'completed') return 'duplicate';
      states.set(key, 'claimed');
      return 'claimed';
    },
    async complete(key) { states.set(key, 'completed'); },
    async fail(key) { states.delete(key); },
    has: (k) => states.get(k) === 'claimed' || states.get(k) === 'completed',
  };
}

export function readExecutedActionKeys(metadata: any): string[] {
  const arr = (metadata || {})[META_KEY];
  return Array.isArray(arr) ? arr.filter((x: unknown) => typeof x === 'string') : [];
}

/**
 * Durable, atomic store backed by public.ai_agent_action_claims.
 *
 * claim()   → INSERT (PK conflict = someone else owns the key). A row left in
 *             'failed' state may be re-claimed by exactly one updater via a
 *             conditional UPDATE ... WHERE status = 'failed' RETURNING.
 * complete()→ status = 'completed' (permanent duplicate protection).
 * fail()    → status = 'failed' (explicit retryable state; never silently
 *             deleted, so the outcome stays observable).
 */
export function createConversationIdempotencyStore(
  config: ServerConfig,
  conversationId: string,
  existingKeys: string[],
  opts?: { workspaceId?: string },
): IdempotencyStore {
  const legacy = new Set(existingKeys);
  return {
    async claim(key, meta) {
      if (legacy.has(key)) return 'duplicate';
      try {
        const sb = getServiceClient(config);
        const { error } = await sb.from('ai_agent_action_claims').insert({
          idempotency_key: key,
          workspace_id: opts?.workspaceId || null,
          conversation_id: conversationId,
          action_name: meta?.actionName || 'unknown',
          status: 'claimed',
        });
        if (!error) return 'claimed';
        // Existing row: only a previously FAILED claim may be retried, and the
        // conditional update guarantees a single winner.
        const { data: retried } = await sb
          .from('ai_agent_action_claims')
          .update({ status: 'claimed', updated_at: new Date().toISOString() })
          .eq('idempotency_key', key)
          .eq('status', 'failed')
          .select('idempotency_key');
        return Array.isArray(retried) && retried.length ? 'claimed' : 'duplicate';
      } catch (err: any) {
        console.warn('[ai-agent.actions] idempotency claim failed:', err?.message || err);
        // Fail closed: never execute a side effect we could not claim.
        return 'duplicate';
      }
    },
    async complete(key) {
      legacy.add(key);
      try {
        const sb = getServiceClient(config);
        await sb.from('ai_agent_action_claims')
          .update({ status: 'completed', updated_at: new Date().toISOString() })
          .eq('idempotency_key', key);
      } catch (err: any) {
        console.warn('[ai-agent.actions] idempotency complete failed:', err?.message || err);
      }
    },
    async fail(key) {
      try {
        const sb = getServiceClient(config);
        await sb.from('ai_agent_action_claims')
          .update({ status: 'failed', updated_at: new Date().toISOString() })
          .eq('idempotency_key', key);
      } catch (err: any) {
        console.warn('[ai-agent.actions] idempotency fail failed:', err?.message || err);
      }
    },
    has: (k) => legacy.has(k),
  };
}
