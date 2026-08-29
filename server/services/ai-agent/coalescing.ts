/**
 * AI Agent — rapid visitor-message burst coalescing.
 *
 * Visitors type the way people talk:
 *
 *   "سلام"            → t+0
 *   "یه سوال دارم"     → t+1.8s
 *   "درباره API چت"    → t+3.5s
 *
 * Answering each fragment separately produces three irrelevant replies and
 * burns three provider calls. This module debounces the engine entry point
 * per conversation: a run waits a short window, and if a NEWER visitor
 * message arrives during that window the earlier run yields (the newer
 * message's own run will answer with the full combined context).
 *
 * Deliberately in-process and lock-free:
 *   - Core already runs the engine fire-and-forget per request.
 *   - The authoritative de-duplication is the freshness check in
 *     ./freshness.ts, which is DB-backed and works across processes.
 *   - This is a latency optimisation, not a correctness mechanism.
 *
 * Window is internal/platform-level (no owner UI): AI_RESPONSE_DEBOUNCE_MS.
 */

const DEFAULT_DEBOUNCE_MS = 1200;
/** Never add more than this much artificial latency, whatever the env says. */
const MAX_DEBOUNCE_MS = 4000;

export function resolveDebounceMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.AI_RESPONSE_DEBOUNCE_MS);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_DEBOUNCE_MS;
  return Math.min(Math.floor(raw), MAX_DEBOUNCE_MS);
}

/** conversationId → id of the newest visitor message seen in this process. */
const latestByConversation = new Map<string, { messageId: string; at: number }>();

/** Bound the map so a long-lived process cannot leak conversation ids. */
const MAX_TRACKED = 5000;

export function noteVisitorMessage(conversationId: string, messageId: string): void {
  if (!conversationId || !messageId) return;
  if (latestByConversation.size > MAX_TRACKED) latestByConversation.clear();
  latestByConversation.set(conversationId, { messageId, at: Date.now() });
}

export function latestKnownVisitorMessage(conversationId: string): string | null {
  return latestByConversation.get(conversationId)?.messageId ?? null;
}

export interface CoalesceResult {
  /** False when a newer visitor message superseded this one mid-window. */
  proceed: boolean;
  waitedMs: number;
  supersededByMessageId: string | null;
}

/**
 * Wait out the burst window for this conversation.
 *
 * Returns `proceed: false` when a newer visitor message landed while we
 * waited — the caller must abandon the run silently (no reply, no credits).
 */
export async function coalesceVisitorBurst(args: {
  conversationId: string;
  visitorMessageId: string;
  debounceMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}): Promise<CoalesceResult> {
  const { conversationId, visitorMessageId } = args;
  const debounceMs = args.debounceMs ?? resolveDebounceMs();
  noteVisitorMessage(conversationId, visitorMessageId);
  if (debounceMs <= 0) {
    return { proceed: true, waitedMs: 0, supersededByMessageId: null };
  }

  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const started = Date.now();
  await sleep(debounceMs);
  const waitedMs = Date.now() - started;

  const latest = latestKnownVisitorMessage(conversationId);
  if (latest && latest !== visitorMessageId) {
    return { proceed: false, waitedMs, supersededByMessageId: latest };
  }
  return { proceed: true, waitedMs, supersededByMessageId: null };
}

/** Test helper — clears the in-process burst tracker. */
export function __resetCoalescingState(): void {
  latestByConversation.clear();
}
