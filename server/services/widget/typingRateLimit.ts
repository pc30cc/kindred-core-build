/**
 * Phase 1.1 — Server-side typing rate limit.
 *
 * Per-conversation in-memory token-bucket-ish counter. The widget's
 * client-side throttle already paces typing pings, but a malicious or
 * buggy client can bypass it and pound /api/widget/action with
 * `action=typing` events directly. This limiter caps fan-out cost on the
 * realtime publisher and protects every other workspace from a noisy
 * tenant.
 *
 * Design rules (per spec):
 *   • scope: per conversation
 *   • default policy: max 2 publishes per 2000ms per conversation
 *   • overflow behavior: silently drop, NEVER error the widget
 *   • applies ONLY to action=typing — message send is unaffected
 *   • lightweight, in-memory, no provider abstraction needed
 *   • debug logs are gated behind `process.env.WIDGET_DEBUG`
 *
 * Memory hygiene: entries TTL out automatically — every check first
 * trims timestamps older than the window, and a periodic janitor sweeps
 * stale conversation entries every 5 minutes.
 */

interface Bucket {
  /** Sliding-window timestamps (ms epoch) of accepted publishes. */
  hits: number[];
  /** Last time this bucket was touched — used by the janitor. */
  lastSeen: number;
}

const buckets = new Map<string, Bucket>();

/** Janitor interval — drops conversation entries idle for >10 windows. */
const JANITOR_INTERVAL_MS = 5 * 60 * 1000;
let janitorTimer: ReturnType<typeof setInterval> | null = null;

function ensureJanitor(maxIdleMs: number): void {
  if (janitorTimer) return;
  janitorTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, b] of buckets) {
      if (now - b.lastSeen > maxIdleMs) buckets.delete(key);
    }
  }, JANITOR_INTERVAL_MS);
  // Don't keep the event loop alive just for this.
  // Node's NodeJS.Timeout has unref(); guard for environments that don't.
  if (typeof (janitorTimer as any)?.unref === 'function') {
    (janitorTimer as any).unref();
  }
}

export interface TypingRateLimitConfig {
  enabled: boolean;
  windowMs: number;
  maxEvents: number;
}

export const DEFAULT_TYPING_RATE_LIMIT: TypingRateLimitConfig = {
  enabled: true,
  windowMs: 2000,
  maxEvents: 2,
};

function debug(...args: unknown[]): void {
  if (process.env.WIDGET_DEBUG === '1' || process.env.WIDGET_DEBUG === 'true') {
    // eslint-disable-next-line no-console
    console.log('[widget-typing-rl]', ...args);
  }
}

/**
 * Returns true iff the typing event SHOULD be published. Returns false to
 * silently drop. Never throws — best-effort.
 */
export function checkTypingAllowed(
  conversationId: string,
  cfg: TypingRateLimitConfig = DEFAULT_TYPING_RATE_LIMIT,
): boolean {
  if (!cfg.enabled) return true;
  if (!conversationId) return true; // can't key — fall open (but caller should always pass one)

  // Defensive bounds — never let bad config DoS us.
  const windowMs = Math.max(250, Math.min(60_000, cfg.windowMs | 0 || 2000));
  const maxEvents = Math.max(1, Math.min(100, cfg.maxEvents | 0 || 2));

  ensureJanitor(windowMs * 10);

  const now = Date.now();
  const cutoff = now - windowMs;
  let bucket = buckets.get(conversationId);
  if (!bucket) {
    bucket = { hits: [], lastSeen: now };
    buckets.set(conversationId, bucket);
  }
  bucket.lastSeen = now;
  // Prune outside the window in-place.
  while (bucket.hits.length && bucket.hits[0] <= cutoff) bucket.hits.shift();

  if (bucket.hits.length >= maxEvents) {
    debug('drop', { conversationId, hits: bucket.hits.length, maxEvents, windowMs });
    return false;
  }
  bucket.hits.push(now);
  return true;
}

/** Test helper — clears all buckets. Not used in production paths. */
export function __resetTypingRateLimitForTests(): void {
  buckets.clear();
  if (janitorTimer) {
    clearInterval(janitorTimer);
    janitorTimer = null;
  }
}
