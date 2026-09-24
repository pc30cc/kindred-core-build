/**
 * Resource guards for LIVE store reads (direct connectors):
 *
 *  - a bounded TTL cache for PUBLIC catalogue answers only,
 *  - single-flight, so N identical concurrent questions cost the store one
 *    request,
 *  - a per-connection concurrency cap and circuit breaker, so a slow or
 *    failing store gets fewer calls, not a retry storm.
 *
 * Why this is process-local and not Redis: the repository's Redis client is
 * an optional realtime-discovery index (server/lib/redisClient.ts), not a
 * general cache, and nothing here is a SECURITY decision — authorization and
 * identity are decided by the store on every private read, never by what a
 * cache holds. With several replicas each keeps its own small cache; the
 * worst case is one extra store call per replica per TTL, which is bounded
 * and documented (docs/commerce/OPENCART.md §Cache). Private (customer-bound)
 * data is NEVER cached across turns: re-validating the customer's session
 * costs the same store round trip as reading the data itself, so a private
 * cache would save nothing except the risk.
 */
import { CommerceError } from '../../../shared/commerce/types.js';

export interface CacheStats {
  entries: number;
  bytes: number;
  hits: number;
  misses: number;
  evictions: number;
  rejectedTooLarge: number;
}

export class BoundedTtlCache<T> {
  private readonly map = new Map<string, { value: T; expiresAt: number; bytes: number }>();
  private bytes = 0;
  private stats = { hits: 0, misses: 0, evictions: 0, rejectedTooLarge: 0 };

  constructor(
    private readonly maxEntries: number,
    private readonly maxBytes: number,
    private readonly maxEntryBytes: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): T | undefined {
    const hit = this.map.get(key);
    if (!hit) {
      this.stats.misses += 1;
      return undefined;
    }
    if (hit.expiresAt <= this.now()) {
      this.delete(key);
      this.stats.misses += 1;
      return undefined;
    }
    // LRU: re-insert as most recently used.
    this.map.delete(key);
    this.map.set(key, hit);
    this.stats.hits += 1;
    return hit.value;
  }

  set(key: string, value: T, ttlMs: number, bytes: number): boolean {
    if (bytes > this.maxEntryBytes || ttlMs <= 0) {
      this.stats.rejectedTooLarge += bytes > this.maxEntryBytes ? 1 : 0;
      return false;
    }
    this.delete(key);
    this.map.set(key, { value, expiresAt: this.now() + ttlMs, bytes });
    this.bytes += bytes;
    while (this.map.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.delete(oldest);
      this.stats.evictions += 1;
    }
    return true;
  }

  delete(key: string): void {
    const existing = this.map.get(key);
    if (existing) {
      this.bytes -= existing.bytes;
      this.map.delete(key);
    }
  }

  /** Drops every entry whose key starts with `prefix` (a connection or installation). */
  deletePrefix(prefix: string): void {
    for (const key of [...this.map.keys()]) if (key.startsWith(prefix)) this.delete(key);
  }

  clear(): void {
    this.map.clear();
    this.bytes = 0;
  }

  snapshot(): CacheStats {
    return { entries: this.map.size, bytes: this.bytes, ...this.stats };
  }
}

/** Identical in-flight requests share one promise; the map is capped. */
export class SingleFlight {
  private readonly inflight = new Map<string, Promise<unknown>>();
  public shared = 0;

  constructor(private readonly maxKeys: number) {}

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) {
      this.shared += 1;
      return existing as Promise<T>;
    }
    if (this.inflight.size >= this.maxKeys) return fn(); // never grow unbounded
    const p = fn().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  get size(): number {
    return this.inflight.size;
  }
}

interface BreakerState {
  failures: number;
  firstFailureAt: number;
  openUntil: number;
  inflight: number;
}

/**
 * Per-connection concurrency cap + circuit breaker.
 *
 * FAILURE_THRESHOLD consecutive transport failures within FAILURE_WINDOW_MS
 * open the circuit for OPEN_MS: calls fail fast with
 * commerce_live_unavailable instead of queueing on a dead store. After
 * OPEN_MS one call is let through (half-open); success closes it.
 */
export class ConnectionGuard {
  static readonly FAILURE_THRESHOLD = 3;
  static readonly FAILURE_WINDOW_MS = 60_000;
  static readonly OPEN_MS = 30_000;
  static readonly MAX_INFLIGHT = 4;
  static readonly MAX_TRACKED = 5_000;

  private readonly states = new Map<string, BreakerState>();
  public opened = 0;
  public rejected = 0;

  constructor(private readonly now: () => number = Date.now) {}

  private state(id: string): BreakerState {
    let s = this.states.get(id);
    if (!s) {
      if (this.states.size >= ConnectionGuard.MAX_TRACKED) {
        const oldest = this.states.keys().next().value as string | undefined;
        if (oldest !== undefined) this.states.delete(oldest);
      }
      s = { failures: 0, firstFailureAt: 0, openUntil: 0, inflight: 0 };
      this.states.set(id, s);
    }
    return s;
  }

  async run<T>(connectionId: string, fn: () => Promise<T>): Promise<T> {
    const s = this.state(connectionId);
    const now = this.now();
    if (s.openUntil > now) {
      this.rejected += 1;
      throw new CommerceError('commerce_live_unavailable', 'store circuit open');
    }
    if (s.inflight >= ConnectionGuard.MAX_INFLIGHT) {
      this.rejected += 1;
      throw new CommerceError('commerce_live_unavailable', 'store busy');
    }
    s.inflight += 1;
    try {
      const result = await fn();
      s.failures = 0;
      s.openUntil = 0;
      return result;
    } catch (err) {
      if (err instanceof CommerceError && (err.code === 'commerce_live_unavailable' || err.code === 'commerce_timeout')) {
        const t = this.now();
        if (!s.failures || t - s.firstFailureAt > ConnectionGuard.FAILURE_WINDOW_MS) {
          s.failures = 0;
          s.firstFailureAt = t;
        }
        s.failures += 1;
        if (s.failures >= ConnectionGuard.FAILURE_THRESHOLD) {
          s.openUntil = t + ConnectionGuard.OPEN_MS;
          s.failures = 0;
          this.opened += 1;
        }
      }
      throw err;
    } finally {
      s.inflight -= 1;
    }
  }

  isOpen(connectionId: string): boolean {
    return (this.states.get(connectionId)?.openUntil ?? 0) > this.now();
  }

  reset(): void {
    this.states.clear();
    this.opened = 0;
    this.rejected = 0;
  }
}

// ── process-wide instances (bounded) ────────────────────────────────────

/** 500 entries, 4 MB total, 24 KB per entry — the whole cache's worst case. */
export const PUBLIC_CACHE_LIMITS = { maxEntries: 500, maxBytes: 4 * 1024 * 1024, maxEntryBytes: 24 * 1024 } as const;

/** Freshness per kind of public answer (ms). Stock/price are also re-read when asked for explicitly. */
export const PUBLIC_TTL_MS = { search: 60_000, product: 60_000, reviews: 300_000, categories: 600_000 } as const;

export const publicCache = new BoundedTtlCache<unknown>(PUBLIC_CACHE_LIMITS.maxEntries, PUBLIC_CACHE_LIMITS.maxBytes, PUBLIC_CACHE_LIMITS.maxEntryBytes);
export const liveSingleFlight = new SingleFlight(200);
export const connectionGuard = new ConnectionGuard();
