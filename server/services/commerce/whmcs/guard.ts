/**
 * Protecting the MERCHANT's WHMCS from Web Yar (and Web Yar from a sick
 * WHMCS): per-installation and per-identity rate limits, concurrency caps,
 * and a circuit breaker. All in-process and bounded — no Redis, no new
 * service. Per-process means a multi-worker deployment multiplies the
 * ceilings by the worker count; the ceilings are chosen so even that product
 * stays far below what a WHMCS host serves for its own client area.
 *
 * Nothing here is a security control. Authorization is decided by the WHMCS
 * addon on every call; these only decide whether a call is ATTEMPTED.
 */

/** Map with a hard key cap; the oldest key goes first. */
function capKeys<K, V>(map: Map<K, V>, max: number, keep?: (v: V) => boolean): void {
  if (map.size <= max) return;
  for (const [key, value] of map) {
    if (map.size <= max) return;
    if (keep && keep(value)) continue;
    map.delete(key);
  }
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done) return;
    map.delete(oldest.value);
  }
}

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly opts: { capacity: number; refillPerSecond: number; maxKeys: number; now?: () => number },
  ) {}

  take(key: string): boolean {
    const now = (this.opts.now ?? Date.now)();
    const b = this.buckets.get(key) ?? { tokens: this.opts.capacity, at: now };
    const refilled = Math.min(this.opts.capacity, b.tokens + ((now - b.at) / 1000) * this.opts.refillPerSecond);
    if (refilled < 1) {
      this.buckets.set(key, { tokens: refilled, at: now });
      return false;
    }
    this.buckets.delete(key);
    this.buckets.set(key, { tokens: refilled - 1, at: now });
    capKeys(this.buckets, this.opts.maxKeys);
    return true;
  }

  size(): number {
    return this.buckets.size;
  }

  clear(): void {
    this.buckets.clear();
  }
}

export class ConcurrencyLimiter {
  private readonly active = new Map<string, number>();

  constructor(private readonly opts: { max: number; maxKeys: number }) {}

  /** A release function, or null when `key` is already at its cap. */
  acquire(key: string): (() => void) | null {
    const n = this.active.get(key) ?? 0;
    if (n >= this.opts.max) return null;
    if (!this.active.has(key) && this.active.size >= this.opts.maxKeys) return null;
    this.active.set(key, n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.active.get(key) ?? 1) - 1;
      if (left <= 0) this.active.delete(key);
      else this.active.set(key, left);
    };
  }

  size(): number {
    return this.active.size;
  }
}

export type BreakerState = 'closed' | 'open' | 'half_open';

interface BreakerEntry {
  state: BreakerState;
  failures: number;
  openedAt: number;
  probeInFlight: boolean;
}

export class CircuitBreaker {
  private readonly entries = new Map<string, BreakerEntry>();

  constructor(
    private readonly opts: { failureThreshold: number; openMs: number; maxKeys: number; now?: () => number },
  ) {}

  private clock(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** Whether a call may go out now. An open breaker lets exactly one probe through after `openMs`. */
  allow(key: string): boolean {
    const e = this.entries.get(key);
    if (!e || e.state === 'closed') return true;
    if (e.state === 'open') {
      if (this.clock() - e.openedAt < this.opts.openMs) return false;
      e.state = 'half_open';
      e.probeInFlight = true;
      return true;
    }
    // half_open: one probe at a time.
    if (e.probeInFlight) return false;
    e.probeInFlight = true;
    return true;
  }

  /** Returns the state it moved OUT of when a transition happened (for write-on-change health). */
  onSuccess(key: string): BreakerState | null {
    const e = this.entries.get(key);
    if (!e) return null;
    const from = e.state;
    this.entries.delete(key);
    return from === 'closed' ? null : from;
  }

  onFailure(key: string): 'opened' | null {
    const now = this.clock();
    const e = this.entries.get(key) ?? { state: 'closed' as BreakerState, failures: 0, openedAt: 0, probeInFlight: false };
    e.failures += 1;
    e.probeInFlight = false;
    let opened: 'opened' | null = null;
    if (e.state === 'half_open' || e.failures >= this.opts.failureThreshold) {
      if (e.state !== 'open') opened = e.state === 'half_open' ? null : 'opened';
      e.state = 'open';
      e.openedAt = now;
    }
    this.entries.set(key, e);
    // Never evict an open breaker to make room — that would re-admit traffic to a failing host.
    capKeys(this.entries, this.opts.maxKeys, (v) => v.state !== 'closed');
    return opened;
  }

  state(key: string): BreakerState {
    return this.entries.get(key)?.state ?? 'closed';
  }

  size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}
