/**
 * LOGICAL AI EXECUTION IDEMPOTENCY (Core-side).
 *
 * One logical AI request === one runtime execution === one canonical usage /
 * accounting result, even if the caller replays it.
 *
 * Layers of retry in this system:
 *   1. provider-internal retry   — inside the AI Runtime, same logical request
 *   2. transport retry / replay  — Core repeating the SAME requestId
 *   3. a genuinely new request   — a NEW requestId
 *
 * Only (2) is deduplicated here: a repeat of the same `requestId` returns the
 * memoized result of the first execution instead of calling the runtime again,
 * so `ai_usage_logs` gains no second row and no second credit is consumed.
 *
 * Deliberately narrow and in-process:
 *   - no schema change, no new table, no billing redesign;
 *   - short TTL (a replay window, not a cache) so ordinary repeated prompts
 *     with fresh ids are never suppressed;
 *   - failures are memoized too, so a replay of a failed logical execution
 *     re-surfaces the same error without charging a second time.
 */

/** Replay window. Longer than any single runtime budget, far shorter than a session. */
const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 500;

interface Entry<T> {
  promise: Promise<T>;
  storedAt: number;
}

const inFlight = new Map<string, Entry<any>>();

function sweep(now: number): void {
  for (const [key, entry] of inFlight) {
    if (now - entry.storedAt > IDEMPOTENCY_TTL_MS) inFlight.delete(key);
  }
  if (inFlight.size > MAX_ENTRIES) {
    // Oldest-first eviction; Map preserves insertion order.
    const excess = inFlight.size - MAX_ENTRIES;
    let i = 0;
    for (const key of inFlight.keys()) {
      if (i++ >= excess) break;
      inFlight.delete(key);
    }
  }
}

/**
 * Runs `fn` at most once per `requestId` inside the replay window.
 * Without a `requestId` the call is executed normally (no dedup).
 */
export function withAiIdempotency<T>(requestId: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (!requestId) return fn();
  const now = Date.now();
  sweep(now);
  const existing = inFlight.get(requestId);
  if (existing) return existing.promise;

  const promise = fn();
  inFlight.set(requestId, { promise, storedAt: now });
  // Never let a rejected memo become an unhandled rejection while it waits for
  // a replay that may never arrive.
  promise.catch(() => undefined);
  return promise;
}

/** Test/ops helper: forget all memoized executions. */
export function resetAiIdempotency(): void {
  inFlight.clear();
}

/** Test helper: how many logical executions are currently memoized. */
export function aiIdempotencySize(): number {
  return inFlight.size;
}

/** Mints a stable id for one logical AI execution. */
export function newAiRequestId(): string {
  return `air_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}
