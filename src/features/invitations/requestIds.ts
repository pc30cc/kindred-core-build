/**
 * WORKSPACE INVITATIONS v5.1 — client-side request-id book (B.1).
 *
 * The Express API requires a stable UUID `requestId` on every retryable
 * mutation. The contract implemented here:
 *
 *   - one UUID per *logical* action, kept in memory only (never localStorage,
 *     sessionStorage, cookies, URLs, logs or analytics),
 *   - an automatic/transport retry of the same logical action reuses the UUID,
 *   - a genuinely new action (different intent, or an explicit reset such as
 *     "send me a new code") mints a fresh UUID.
 *
 * The "intent" string is a caller-supplied, non-secret discriminator (e.g. the
 * OTP code length + a hash-free marker, policy version ids). Never pass raw
 * secrets: intents may live in memory for the page lifetime.
 */

import { useRef } from 'react';

export interface RequestIdBook {
  /**
   * Stable UUID for `key`. When `intent` differs from the intent recorded for
   * the current UUID, the action is a new logical action and a new UUID is
   * minted.
   */
  get(key: string, intent?: string): string;
  /** Force the next `get(key)` to mint a new UUID (explicit new action). */
  reset(key: string): void;
  /** Drop every entry (flow abandoned / page unmounted). */
  clear(): void;
  /**
   * Safe inspection interface for tests and assertions: returns the retained
   * keys and intents. Intents are contractually NON-SECRET (revision counters,
   * policy version ids); this interface exists so a test can PROVE no raw
   * token, password or OTP code is retained.
   */
  entries(): Array<{ key: string; intent: string }>;
}

function randomUuid(): string {
  const c: any = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Deterministically-shaped fallback for non-secure test contexts.
  const bytes = new Uint8Array(16);
  (c?.getRandomValues ? c.getRandomValues(bytes) : bytes.forEach((_, i) => (bytes[i] = Math.floor(Math.random() * 256))));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createRequestIdBook(generate: () => string = randomUuid): RequestIdBook {
  const entries = new Map<string, { id: string; intent: string }>();
  return {
    get(key, intent = '') {
      const current = entries.get(key);
      if (current && current.intent === intent) return current.id;
      const id = generate();
      entries.set(key, { id, intent });
      return id;
    },
    reset(key) {
      entries.delete(key);
    },
    clear() {
      entries.clear();
    },
    entries() {
      return Array.from(entries.entries()).map(([key, v]) => ({ key, intent: v.intent }));
    },
  };
}

/** React binding: one book per component instance, memory-only. */
export function useRequestIdBook(): RequestIdBook {
  const ref = useRef<RequestIdBook | null>(null);
  if (!ref.current) ref.current = createRequestIdBook();
  return ref.current;
}
