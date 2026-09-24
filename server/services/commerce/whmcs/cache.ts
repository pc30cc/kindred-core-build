/**
 * Bounded, TTL'd, per-process cache with request coalescing (single-flight).
 *
 * Why a new one: the repo has several ad-hoc Map caches (entitlements, AI
 * idempotency, observability flags), each private to its module and shaped
 * for one value type; none offers a byte budget or coalescing, and Redis is
 * optional infrastructure this feature must not require. This is the smallest
 * thing that satisfies the WHMCS constraints:
 *
 *   - every entry has a TTL; there is no "forever" entry;
 *   - a hard cap on entry COUNT and on total BYTES, plus a per-entry size cap
 *     (oversized values are simply not cached);
 *   - eviction is LRU (Map insertion order, refreshed on hit);
 *   - identical concurrent loads share one in-flight promise, and the
 *     in-flight table is itself bounded (past the cap a load just runs);
 *   - a load that FAILS is never cached, so an auth/permission error can
 *     never be replayed from cache — and never replaced by stale data.
 *
 * Multi-worker deployments get one cache per process. That is a cost
 * property (N workers may each make the first call), never a correctness
 * one: private entries are only served after a live access check (see
 * whmcs/gateway.ts), and a key embeds everything that scopes a value.
 */

export interface CacheStats {
  entries: number;
  bytes: number;
  inflight: number;
  hits: number;
  misses: number;
  coalesced: number;
  evictions: number;
}

interface Entry<V> {
  value: V;
  bytes: number;
  storedAt: number;
  expiresAt: number;
}

export interface BoundedCacheOptions {
  maxEntries: number;
  maxBytes: number;
  maxEntryBytes: number;
  maxInflight: number;
  now?: () => number;
}

export class BoundedTtlCache<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly inflight = new Map<string, Promise<V>>();
  private totalBytes = 0;
  private readonly now: () => number;
  private readonly stats = { hits: 0, misses: 0, coalesced: 0, evictions: 0 };

  constructor(private readonly opts: BoundedCacheOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** Fresh entry or undefined. `maxAgeMs` lets a caller demand something younger than the entry's TTL. */
  get(key: string, maxAgeMs?: number): { value: V; ageMs: number } | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      this.stats.misses += 1;
      return undefined;
    }
    const now = this.now();
    const ageMs = now - entry.storedAt;
    if (entry.expiresAt <= now || (maxAgeMs !== undefined && ageMs > maxAgeMs)) {
      if (entry.expiresAt <= now) this.remove(key);
      this.stats.misses += 1;
      return undefined;
    }
    // LRU touch.
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.stats.hits += 1;
    return { value: entry.value, ageMs };
  }

  set(key: string, value: V, ttlMs: number, bytes: number): boolean {
    if (ttlMs <= 0 || bytes > this.opts.maxEntryBytes || bytes > this.opts.maxBytes) return false;
    this.remove(key);
    const now = this.now();
    this.entries.set(key, { value, bytes, storedAt: now, expiresAt: now + ttlMs });
    this.totalBytes += bytes;
    this.evict();
    return true;
  }

  delete(key: string): void {
    this.remove(key);
  }

  /** Drops every entry whose key starts with `prefix` (e.g. one grant's private data). */
  deletePrefix(prefix: string): number {
    let n = 0;
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) {
        this.remove(key);
        n += 1;
      }
    }
    return n;
  }

  /**
   * Single-flight: while a load for `key` is running, every other caller for
   * the same key awaits that same promise instead of starting its own.
   */
  coalesce(key: string, load: () => Promise<V>): { promise: Promise<V>; shared: boolean } {
    const running = this.inflight.get(key);
    if (running) {
      this.stats.coalesced += 1;
      return { promise: running, shared: true };
    }
    if (this.inflight.size >= this.opts.maxInflight) return { promise: load(), shared: false };
    const promise = load().finally(() => {
      if (this.inflight.get(key) === promise) this.inflight.delete(key);
    });
    this.inflight.set(key, promise);
    return { promise, shared: false };
  }

  snapshot(): CacheStats {
    return {
      entries: this.entries.size,
      bytes: this.totalBytes,
      inflight: this.inflight.size,
      ...this.stats,
    };
  }

  clear(): void {
    this.entries.clear();
    this.inflight.clear();
    this.totalBytes = 0;
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.totalBytes -= entry.bytes;
  }

  private evict(): void {
    const now = this.now();
    // Expired first, then least-recently-used, until both caps hold.
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.opts.maxEntries && this.totalBytes <= this.opts.maxBytes) break;
      if (entry.expiresAt <= now) {
        this.remove(key);
        this.stats.evictions += 1;
      }
    }
    while (this.entries.size > this.opts.maxEntries || this.totalBytes > this.opts.maxBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.remove(oldest.value);
      this.stats.evictions += 1;
    }
  }
}
