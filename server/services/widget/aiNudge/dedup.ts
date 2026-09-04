/**
 * AI Proactive Nudge — bounded in-process dedup cache.
 *
 * If the exact same visitor journey fingerprint was evaluated by AI within
 * DEDUP_TTL_MS, a repeat evaluate request short-circuits without a second
 * AI call. This is NOT a durable store — a process restart clears it, and
 * that is fine, since the client-side smart-engine gate + server-side
 * cooldown/max-per-session checks (backed by widget_ai_nudges rows) are the
 * durable anti-spam layer. This cache exists purely to avoid paying for two
 * near-simultaneous AI calls for the same context (double-tab, retry, etc).
 *
 * Bounded FIFO eviction — same pattern as
 * server/services/observability/collector/reconnectClassifier.ts.
 */

const DEDUP_TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 5000;

interface Entry {
  fingerprint: string;
  at: number;
}

const cache = new Map<string, Entry>();

function key(workspaceId: string, sessionId: string): string {
  return `${workspaceId}:${sessionId}`;
}

/** Returns true if this exact fingerprint was already evaluated recently for this session. */
export function isDuplicateAiNudgeContext(workspaceId: string, sessionId: string, fingerprint: string): boolean {
  const k = key(workspaceId, sessionId);
  const entry = cache.get(k);
  if (!entry) return false;
  if (Date.now() - entry.at > DEDUP_TTL_MS) return false;
  return entry.fingerprint === fingerprint;
}

export function recordAiNudgeEvaluation(workspaceId: string, sessionId: string, fingerprint: string): void {
  const k = key(workspaceId, sessionId);
  if (!cache.has(k) && cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.delete(k);
  cache.set(k, { fingerprint, at: Date.now() });
}

export function __resetAiNudgeDedupForTests(): void {
  cache.clear();
}
