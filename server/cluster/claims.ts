/**
 * Exclusive claims, held for the whole container by the cluster primary
 * (cluster/hub.ts): `take` succeeds for one holder of a (namespace, key) at a
 * time, the holder releases it, and every claim of a worker that exited is
 * released (releaseOwner). Used where one process kept a Set of the things it
 * was doing (the visitor transcript, services/visitorTranscript.ts).
 *
 * A claim may carry the taker's token (cluster/client.ts, hubClaim): a
 * release that names a token frees only that take, so a worker that gave up
 * waiting for its answer can free a take that landed after all without
 * touching a claim another request of the same worker holds.
 *
 * Pure: no I/O. Bounded: a claim older than MAX_AGE_MS is dropped, and at
 * the cap a take is refused rather than the set growing without bound.
 */

const MAX_AGE_MS = 10 * 60_000;
const MAX_CLAIMS = 100_000;

export class ClaimSet {
  private readonly claims = new Map<string, { owner: number; since: number; token: string | null }>();
  private lastFullGcAt = 0;

  constructor(private readonly maxClaims: number = MAX_CLAIMS) {}

  private static id(ns: string, key: string): string {
    return `${ns}\u0000${key}`;
  }

  take(ns: string, key: string, owner: number, now: number = Date.now(), token: string | null = null): boolean {
    const id = ClaimSet.id(ns, key);
    const current = this.claims.get(id);
    if (current && now - current.since <= MAX_AGE_MS) return false;
    if (!current && this.claims.size >= this.maxClaims) {
      // At most one sweep a second, so a flood at the cap stays linear.
      if (now - this.lastFullGcAt >= 1_000) {
        this.lastFullGcAt = now;
        this.gc(now);
      }
      if (this.claims.size >= this.maxClaims) return false;
    }
    this.claims.set(id, { owner, since: now, token });
    return true;
  }

  /**
   * Releases the claim when `owner` holds it (any holder when owner is
   * undefined) and, when a token is given, only the take that carried it.
   */
  release(ns: string, key: string, owner?: number, token: string | null = null): boolean {
    const id = ClaimSet.id(ns, key);
    const current = this.claims.get(id);
    if (!current || (owner !== undefined && current.owner !== owner)) return false;
    if (token !== null && current.token !== token) return false;
    this.claims.delete(id);
    return true;
  }

  releaseOwner(owner: number): number {
    let n = 0;
    for (const [id, c] of [...this.claims]) {
      if (c.owner === owner) {
        this.claims.delete(id);
        n += 1;
      }
    }
    return n;
  }

  gc(now: number = Date.now()): void {
    for (const [id, c] of [...this.claims]) if (now - c.since > MAX_AGE_MS) this.claims.delete(id);
  }

  get size(): number {
    return this.claims.size;
  }
}
