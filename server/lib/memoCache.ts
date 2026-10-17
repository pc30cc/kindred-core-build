/**
 * A small per-process memo for hot read paths: keyed, single-flight,
 * stale-while-revalidate, bounded. Used by the widget config snapshot
 * (services/widget/configSnapshot.ts); meant for any other bootstrap-time
 * read that is invalidated through lib/cacheBus.ts.
 *
 *   - Single flight: concurrent misses for one key share one load.
 *   - Generation guard: a load running when its key (or the whole cache) is
 *     invalidated still answers the requests already waiting on it, but is
 *     never stored — it may have read the old values. A request arriving
 *     after the invalidation starts a fresh load instead of joining it.
 *   - Stale-while-revalidate: past its fresh lifetime an entry is served for
 *     up to `maxStaleMs` more while ONE background load runs. A background
 *     load that fails — or that `keepPrevious` rejects (a degraded answer
 *     over a good one) — keeps the old entry and is retried after
 *     `retryAfterMs`. Only entries `serveStale` accepts are served stale (a
 *     degraded or "not found" answer is not: past its short lifetime it is
 *     reloaded in the foreground, so a blip cannot outlive that lifetime).
 *   - expireAll(): every entry is past its lifetime at once but still
 *     servable stale, for "something may have changed" signals that name
 *     nothing in particular (the cache bus reconnecting): the next request
 *     is answered from the old copy and reloads it, instead of every key
 *     rebuilding in the foreground together.
 *   - Bounds: LRU of `max()` entries. "Negative" answers (the thing does not
 *     exist) live in their own, smaller LRU so a flood of made-up keys can
 *     never push real entries out.
 *   - A lifetime of 0 (`ttlMs` / `negativeTtlMs`) stores nothing; with
 *     `enabled()` false the cache is bypassed entirely (single flight stays).
 *
 * Values are shared between requests and must be treated as read-only.
 */

export interface MemoLoadContext {
  /** True for a stale-while-revalidate refresh nobody is waiting on. */
  background: boolean;
}

export interface MemoCacheOptions<V> {
  name: string;
  /** Fresh lifetime of a stored value, ms; 0 = do not store it. */
  ttlMs: (value: V) => number;
  /** LRU bound of the main map. */
  max: () => number;
  /** A "does not exist" answer: kept in the negative map. */
  isNegative?: (value: V) => boolean;
  /** LRU bound of the negative map. */
  negativeMax?: () => number;
  /** A new value that must not replace a still-servable previous one. */
  keepPrevious?: (previous: V, next: V) => boolean;
  /** May this value be served past its lifetime while it reloads? Default: yes. */
  serveStale?: (value: V) => boolean;
  /** False = bypass the cache (kill switch); single flight still applies. */
  enabled?: () => boolean;
  /** How long past its lifetime an entry may still be served. Default 10 min. */
  maxStaleMs?: number;
  /** Wait before the next background load after a failed one. Default 5 s. */
  retryAfterMs?: number;
}

interface Entry<V> {
  value: V;
  at: number;
  retryAt: number;
  /** Set by expireAll(): past its lifetime whatever its age. */
  expired: boolean;
}

interface Flight<V> {
  promise: Promise<V>;
  invalidated: boolean;
}

export class MemoCache<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly negatives = new Map<string, Entry<V>>();
  private readonly flights = new Map<string, Flight<V>>();
  private readonly maxStaleMs: number;
  private readonly retryAfterMs: number;

  constructor(private readonly opts: MemoCacheOptions<V>) {
    this.maxStaleMs = opts.maxStaleMs ?? 600_000;
    this.retryAfterMs = opts.retryAfterMs ?? 5_000;
  }

  /** The value for `key`: fresh from memory, stale while one reload runs, or loaded. */
  get(key: string, load: (ctx: MemoLoadContext) => Promise<V>): Promise<V> {
    if (this.opts.enabled && !this.opts.enabled()) {
      this.entries.clear();
      this.negatives.clear();
      return this.load(key, load, false);
    }
    const now = Date.now();
    const map = this.entries.has(key) ? this.entries : this.negatives;
    const hit = map.get(key);
    if (hit) {
      const age = now - hit.at;
      if (!hit.expired && age < this.opts.ttlMs(hit.value)) {
        touch(map, key, hit);
        return Promise.resolve(hit.value);
      }
      if (age <= this.maxStaleMs && (this.opts.serveStale?.(hit.value) ?? true)) {
        if (now >= hit.retryAt && !this.flights.has(key)) this.refresh(key, load);
        touch(map, key, hit);
        return Promise.resolve(hit.value);
      }
    }
    return this.load(key, load, false);
  }

  /** The stored value, fresh or stale, without loading. */
  peek(key: string): V | undefined {
    return (this.entries.get(key) ?? this.negatives.get(key))?.value;
  }

  /** Forget one key and disown its running load. */
  invalidate(key: string): void {
    this.entries.delete(key);
    this.negatives.delete(key);
    const flight = this.flights.get(key);
    if (flight) {
      flight.invalidated = true;
      this.flights.delete(key);
    }
  }

  /**
   * Forget every entry `match` selects, and disown EVERY running load (which
   * of them read the changed data cannot be known until they finish).
   */
  invalidateWhere(match: (value: V) => boolean): void {
    for (const [key, entry] of this.entries) if (match(entry.value)) this.entries.delete(key);
    for (const [key, entry] of this.negatives) if (match(entry.value)) this.negatives.delete(key);
    this.abandonFlights();
  }

  clear(): void {
    this.entries.clear();
    this.negatives.clear();
    this.abandonFlights();
  }

  /**
   * Every entry past its lifetime, still servable stale; running loads are
   * disowned (they may have read the values the signal is about).
   */
  expireAll(): void {
    for (const entry of this.entries.values()) {
      entry.expired = true;
      entry.retryAt = 0;
    }
    for (const entry of this.negatives.values()) {
      entry.expired = true;
      entry.retryAt = 0;
    }
    this.abandonFlights();
  }

  /** Stored entries: [main, negative]. */
  sizes(): [number, number] {
    return [this.entries.size, this.negatives.size];
  }

  private abandonFlights(): void {
    for (const flight of this.flights.values()) flight.invalidated = true;
    this.flights.clear();
  }

  private load(key: string, load: (ctx: MemoLoadContext) => Promise<V>, background: boolean): Promise<V> {
    const running = this.flights.get(key);
    if (running) return running.promise;
    const flight = { invalidated: false } as Flight<V>;
    // Registered before the load starts, so even a synchronous throw clears it.
    this.flights.set(key, flight);
    flight.promise = (async () => {
      try {
        const value = await load({ background });
        if (!flight.invalidated) this.store(key, value);
        return value;
      } finally {
        if (this.flights.get(key) === flight) this.flights.delete(key);
      }
    })();
    return flight.promise;
  }

  private refresh(key: string, load: (ctx: MemoLoadContext) => Promise<V>): void {
    this.load(key, load, true).catch((err: unknown) => {
      const entry = this.entries.get(key) ?? this.negatives.get(key);
      if (entry) entry.retryAt = Date.now() + this.retryAfterMs;
      if (!(err instanceof MemoBusyError)) {
        console.warn(`[${this.opts.name}] background reload failed:`, err instanceof Error ? err.message : err);
      }
    });
  }

  private store(key: string, value: V): void {
    const now = Date.now();
    const previous = this.entries.get(key) ?? this.negatives.get(key);
    // Kept only when it can still be served: keeping one serveStale refuses
    // would leave nothing servable, and every request would load again.
    if (
      previous &&
      now - previous.at <= this.maxStaleMs &&
      (this.opts.serveStale?.(previous.value) ?? true) &&
      this.opts.keepPrevious?.(previous.value, value)
    ) {
      previous.retryAt = now + this.retryAfterMs;
      return;
    }
    this.entries.delete(key);
    this.negatives.delete(key);
    if ((this.opts.enabled && !this.opts.enabled()) || this.opts.ttlMs(value) <= 0) return;
    const negative = !!this.opts.isNegative?.(value);
    const map = negative ? this.negatives : this.entries;
    map.set(key, { value, at: now, retryAt: 0, expired: false });
    const max = negative ? (this.opts.negativeMax?.() ?? this.opts.max()) : this.opts.max();
    while (map.size > Math.max(1, max)) map.delete(map.keys().next().value as string);
  }
}

function touch<V>(map: Map<string, Entry<V>>, key: string, entry: Entry<V>): void {
  map.delete(key);
  map.set(key, entry);
}

/** A load refused because the miss budget is spent (see RateGate). */
export class MemoBusyError extends Error {
  readonly status = 503;
  readonly code = 'CACHE_REBUILD_BUSY';
  constructor(name: string) {
    super(`${name}: too many cache rebuilds right now`);
    this.name = 'MemoBusyError';
  }
}

/**
 * A per-process token bucket for expensive cache misses: `perSecond()`
 * tokens a second, up to `burst()` saved. A request that finds none waits
 * (FIFO) up to `maxWaitMs` for one, then gets MemoBusyError; a background
 * refresh never waits (tryAcquire). `perSecond() === 0` = unlimited.
 */
export class RateGate {
  private tokens: number;
  private last = Date.now();
  private readonly waiters: Array<{ resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
  private drainTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly name: string,
    private readonly perSecond: () => number,
    private readonly burst: () => number,
    private readonly maxWaitMs = 3_000,
  ) {
    this.tokens = Math.max(1, burst());
  }

  private refill(): void {
    const now = Date.now();
    const rate = this.perSecond();
    this.tokens = Math.min(Math.max(1, this.burst()), this.tokens + ((now - this.last) / 1000) * rate);
    this.last = now;
  }

  tryAcquire(): boolean {
    if (this.perSecond() <= 0) return true;
    this.refill();
    if (this.waiters.length === 0 && this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  acquire(): Promise<void> {
    if (this.tryAcquire()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new MemoBusyError(this.name));
        }, this.maxWaitMs),
      };
      waiter.timer.unref?.();
      this.waiters.push(waiter);
      this.scheduleDrain();
    });
  }

  private scheduleDrain(): void {
    if (this.drainTimer || !this.waiters.length) return;
    const rate = Math.max(this.perSecond(), 0.001);
    const wait = Math.max(1, Math.ceil(((1 - Math.min(this.tokens, 1)) / rate) * 1000));
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      this.refill();
      while (this.waiters.length && (this.tokens >= 1 || this.perSecond() <= 0)) {
        if (this.perSecond() > 0) this.tokens -= 1;
        const waiter = this.waiters.shift()!;
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
      this.scheduleDrain();
    }, wait);
    this.drainTimer.unref?.();
  }

  /** Test-only: back to a full bucket, no waiters. */
  reset(): void {
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(new MemoBusyError(this.name));
    }
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.drainTimer = null;
    this.tokens = Math.max(1, this.burst());
    this.last = Date.now();
  }
}

/** A non-negative integer from the environment, or null when unset/invalid. */
export function envNonNegativeInt(name: string): number | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}
