/**
 * AI Agent — Phase 3 action idempotency (3.10).
 *
 * Stable identity = workspace + conversation + visitor message + action name
 * + normalized arguments. Keys are persisted inside the EXISTING
 * conversations.metadata bag (no new table) under `ai_executed_action_keys`.
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

export interface IdempotencyStore {
  has(key: string): boolean | Promise<boolean>;
  add(key: string): void | Promise<void>;
}

/** In-memory store — used by tests and as a per-turn guard. */
export function createMemoryIdempotencyStore(seed: string[] = []): IdempotencyStore {
  const set = new Set(seed);
  return {
    has: (k) => set.has(k),
    add: (k) => { set.add(k); },
  };
}

export function readExecutedActionKeys(metadata: any): string[] {
  const arr = (metadata || {})[META_KEY];
  return Array.isArray(arr) ? arr.filter((x: unknown) => typeof x === 'string') : [];
}

/**
 * Persisted store backed by conversations.metadata. Reads the existing keys
 * once (caller supplies them from already-loaded state) and appends on write.
 */
export function createConversationIdempotencyStore(
  config: ServerConfig,
  conversationId: string,
  existingKeys: string[],
): IdempotencyStore {
  const set = new Set(existingKeys);
  return {
    has: (k) => set.has(k),
    add: async (k) => {
      if (set.has(k)) return;
      set.add(k);
      try {
        const sb = getServiceClient(config);
        const { data: row } = await sb
          .from('conversations')
          .select('metadata')
          .eq('id', conversationId)
          .maybeSingle();
        const meta: any = (row as any)?.metadata || {};
        const arr: string[] = readExecutedActionKeys(meta);
        if (!arr.includes(k)) arr.push(k);
        meta[META_KEY] = arr.slice(-MAX_KEYS);
        await sb.from('conversations').update({ metadata: meta }).eq('id', conversationId);
      } catch (err: any) {
        console.warn('[ai-agent.actions] idempotency persist failed:', err?.message || err);
      }
    },
  };
}
