import { onInvalidate } from '../../lib/cacheBus.js';
import { canonicalWorkspaceId } from '../../lib/workspaceId.js';

/**
 * The workspace-level part of the call widget bootstrap, kept per process for
 * a short time.
 *
 * Everything in GET /api/call-widget/bootstrap except the session token, the
 * visitor block, the active call and the URLs built from the request is the
 * same for every visitor of a workspace: its settings row, the platform
 * switches, provider readiness, recording capability, departments, ringback
 * links, avatar link, edition, template and "powered by" rows. It cost ~10
 * sequential database round trips on EVERY page view of EVERY visitor
 * (src/test/callWidget/bootstrapDbCost.test.ts). It is now read once per
 * workspace per TTL per process; concurrent misses share one load.
 *
 * Keys name a workspace only (`ws:<uuid, lower case>` or `pk:<public key>`),
 * never anything else the caller chooses, so the set of keys is bounded by
 * the workspaces that exist. A key that names none ("not found", or no call
 * center row) is kept in its own small map for a shorter time: made-up ids
 * cannot push real workspaces out.
 *
 * Freshness: a settings or department save publishes `widget:<workspace>`,
 * a platform change `platform` (lib/cacheBus.ts), which drops the entry on
 * every process at once; without the bus, other processes see it within
 * TTL_MS — the same order as the caches this data already comes through
 * (platform settings 30 s, control plane 30 s, entitlements 60 s, edition
 * 60 s, origin rules 60 s).
 */
const TTL_MS = 30_000;
/** A key that names no workspace: short, so a new row shows up soon. */
const NEGATIVE_TTL_MS = 10_000;
const MAX_ENTRIES = 5_000;
const MAX_NEGATIVE_ENTRIES = 1_000;

type Entry<T> = { at: number; workspaceId: string | null; value: Promise<T> };
/** Loaded values for workspaces that exist. Map order = age (oldest first). */
const entries = new Map<string, Entry<unknown>>();
/** Loaded values for keys that name no workspace. */
const negatives = new Map<string, Entry<unknown>>();
/** Loads in progress (shared by concurrent misses). */
const inflight = new Map<string, Entry<unknown>>();

/**
 * Drop one workspace's entries (any key it was looked up by), or all. Loads
 * in progress that may be that workspace's (its `ws:` key, and every `pk:`
 * load, whose workspace is known only once it ends) are never stored
 * afterwards: they may have read the old row. Other workspaces' loads are.
 */
export function invalidateCallWidgetBootstrapCache(workspaceId?: string | null): void {
  if (!workspaceId) { inflight.clear(); entries.clear(); negatives.clear(); return; }
  const id = sameId(workspaceId);
  const byId = `ws:${id}`;
  for (const key of [...inflight.keys()]) {
    if (key === byId || key.startsWith('pk:')) inflight.delete(key);
  }
  for (const map of [entries, negatives]) {
    for (const [key, entry] of map) {
      if ((entry.workspaceId && sameId(entry.workspaceId) === id) || key === byId) map.delete(key);
    }
  }
}

/** One spelling per workspace id (lib/workspaceId.ts), lower case for anything else. */
function sameId(workspaceId: string): string {
  return canonicalWorkspaceId(workspaceId) ?? workspaceId.toLowerCase();
}

// The bus (lib/cacheBus.ts): a workspace's widget inputs, or anything
// platform-wide (the call center switches, providers, edition). A resync
// (the bus reconnected; nothing known changed) is skipped: these entries
// live 30 s, which already bounds what a missed notification can leave.
onInvalidate('widget', (workspaceId, { resync }) => {
  if (!resync) invalidateCallWidgetBootstrapCache(workspaceId);
});
onInvalidate('platform', (_key, { resync }) => {
  if (!resync) invalidateCallWidgetBootstrapCache();
});

function keep(map: Map<string, Entry<unknown>>, max: number, key: string, entry: Entry<unknown>) {
  map.set(key, entry);
  if (map.size > max) {
    // Map keeps insertion order: the first key is the oldest.
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

/**
 * Memoize `load` under `key`. `workspaceOf` names the workspace a loaded
 * value belongs to (for invalidation by id when it was looked up by public
 * key); a value that names none (or null) is a negative entry, kept
 * NEGATIVE_TTL_MS. A failed load is not kept.
 */
export function memoCallWidgetBootstrap<T>(
  key: string,
  load: () => Promise<T>,
  workspaceOf: (value: T) => string | null,
): Promise<T> {
  const now = Date.now();
  const hit = entries.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.value as Promise<T>;
  if (hit) entries.delete(key);
  const miss = negatives.get(key);
  if (miss && now - miss.at < NEGATIVE_TTL_MS) return miss.value as Promise<T>;
  if (miss) negatives.delete(key);
  const pending = inflight.get(key);
  if (pending) return pending.value as Promise<T>;

  const entry: Entry<T> = { at: now, workspaceId: null, value: undefined as unknown as Promise<T> };
  entry.value = load().then(
    (value) => {
      // Not stored when an invalidation came in meanwhile.
      if (inflight.get(key) === entry) {
        inflight.delete(key);
        entry.workspaceId = value == null ? null : workspaceOf(value);
        if (entry.workspaceId) keep(entries, MAX_ENTRIES, key, entry as Entry<unknown>);
        else keep(negatives, MAX_NEGATIVE_ENTRIES, key, entry as Entry<unknown>);
      }
      return value;
    },
    (err) => {
      if (inflight.get(key) === entry) inflight.delete(key);
      throw err;
    },
  );
  inflight.set(key, entry as Entry<unknown>);
  return entry.value;
}
