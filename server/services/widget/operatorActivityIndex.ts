/**
 * The cluster primary's copy of operator activity (cluster/hub.ts): the
 * newest interaction stamp per `workspace:user`, for the whole container,
 * when the backend runs several processes and no Redis index is configured
 * (operatorActivity.ts). Monotonic: an older stamp never replaces a newer
 * one. Bounded at MAX_ENTRIES; stamps older than PRUNE_AFTER_MS are dropped,
 * well past the 5-minute active threshold. Never reaches PostgreSQL.
 *
 * Pure: no imports.
 */

const MAX_ENTRIES = 20_000;
const PRUNE_AFTER_MS = 10 * 60_000;

const latest = new Map<string, number>();

export function stampOperatorActivity(key: string, at: number, now: number = Date.now()): void {
  if (!key || !Number.isFinite(at)) return;
  const current = latest.get(key);
  if (current !== undefined && current >= at) return;
  if (current === undefined && latest.size >= MAX_ENTRIES) {
    pruneOperatorActivity(now);
    // Still full: drop the tenth first stamped (Map order), the ones least
    // likely to still read as active, in one pass.
    if (latest.size >= MAX_ENTRIES) {
      let drop = Math.ceil(MAX_ENTRIES / 10);
      for (const k of latest.keys()) {
        if (drop-- <= 0) break;
        latest.delete(k);
      }
    }
  }
  latest.set(key, at);
}

/** The known stamps of `keys` (missing keys are left out). */
export function readOperatorActivity(keys: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of keys) {
    const v = latest.get(k);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export function pruneOperatorActivity(now: number = Date.now()): void {
  for (const [k, v] of latest) if (now - v > PRUNE_AFTER_MS) latest.delete(k);
}

export function operatorActivityIndexSize(): number {
  return latest.size;
}

/** Tests only. */
export function __resetOperatorActivityIndex(): void {
  latest.clear();
}
