/**
 * ANALYTICS OBJECT CACHE — the bridge between the storage drivers and the
 * embedded query engine.
 *
 * DuckDB reads local files here; the Analytics Primary is reached through
 * the SAME drivers and the SAME credentials every other analytics write
 * already uses (server/services/analytics/pool.ts →
 * resolveAnalyticsTopology). No second credential, no second endpoint
 * implementation, no extension download.
 *
 * ── Pruning happens on the KEY, before any byte moves ────────────
 *
 * Object keys are Hive-partitioned:
 *
 *   <prefix>workspace=<id>/year=2026/month=09/day=16/part-*.parquet
 *
 * so a listing plus a string comparison decides which objects a date range
 * needs. A one-day query fetches one day's objects, never a year's. This is
 * exactly the pruning DuckDB's own S3 reader would do from the partition
 * path, done a layer earlier — and it is why not using httpfs costs
 * essentially nothing (see ./duckdb.ts).
 *
 * ── Only content-unique keys are cached ──────────────────────────
 *
 * A LIVE object key (`part-<stamp>-<random>.parquet`) is unique per write,
 * so a file cached under it can never be stale: that key will never be
 * written again with different bytes.
 *
 * A SEALED object key (`backfill-000.parquet`) is DETERMINISTIC — that is
 * deliberate, and it is what makes re-sealing a day replace its objects
 * rather than duplicate them (server/services/analytics/backfill.ts). But it
 * also means the same key legitimately holds different bytes after a
 * re-seal — after a privacy erasure, for instance, when the whole point is
 * that the old values are gone. Caching those would serve the erased
 * content back.
 *
 * So sealed objects are fetched fresh on every query and only live objects
 * are cached. Sealed objects are the few large ones and live objects are the
 * many small ones, so this also caches the cheaper thing to keep — and no
 * invalidation logic is needed anywhere, because nothing cached can ever
 * become wrong.
 *
 * ── Workspace scoping is structural ──────────────────────────────
 *
 * Every listing is rooted at `<prefix>workspace=<id>/`, built from a
 * validated UUID. A query cannot widen its own prefix, and the files handed
 * to the engine are only ever the ones fetched under it — so one
 * workspace's report can never read another's objects, independently of
 * whatever the SQL says.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ServerConfig } from '../../config.js';
import { downloadWithConfig, listWithConfig, type StorageConfig } from '../storage/index.js';
import { readAnalyticsPool, resolveAnalyticsTopology } from './pool.js';
import { analyticsWorkspacePrefix, isContentUniqueAnalyticsKey } from './schema.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pages of a listing to walk per query. Bounded so one report cannot run unboundedly. */
const MAX_LIST_PAGES = 40;
/** Objects one query may read. A range wider than this is reported as truncated, never silently cut. */
const MAX_OBJECTS_PER_QUERY = 2_000;

/**
 * Where fetched objects live.
 *
 * Under the persistent volume when the deployment has one (the same
 * `/app/data` the MaxMind updater uses), otherwise the OS temp directory.
 * Either is correct — the cache is disposable by construction.
 */
function cacheRoot(): string {
  const configured = process.env.ANALYTICS_QUERY_CACHE_DIR?.trim();
  if (configured) return configured;
  const dataDir = '/app/data';
  try {
    if (fs.existsSync(dataDir) && fs.statSync(dataDir).isDirectory()) {
      return path.join(dataDir, 'analytics-query-cache');
    }
  } catch { /* fall through to temp */ }
  return path.join(os.tmpdir(), 'webyar-analytics-query-cache');
}

/** Total bytes the cache may hold before the oldest entries are evicted. */
const MAX_CACHE_BYTES = 2 * 1024 * 1024 * 1024;

export interface ObjectWindow {
  /** Inclusive, YYYY-MM-DD. */
  startDate: string;
  /** Inclusive, YYYY-MM-DD. */
  endDate: string;
}

export interface FetchedObjects {
  /** Absolute local paths the engine may read. Empty when the range holds no data. */
  files: string[];
  objectCount: number;
  bytes: number;
  /** The range needed more objects than one query may read. */
  truncated: boolean;
  /** Set when the analytics topology cannot answer at all. */
  unavailable?: string;
}

/**
 * Does this object key fall inside the requested day range?
 *
 * Compared as strings on the partition segments — no parsing, no timezone,
 * and no dependence on anything inside the file.
 */
function keyInRange(key: string, window: ObjectWindow): boolean {
  const year = /\/year=(\d{4})\//.exec(key)?.[1];
  const month = /\/month=(\d{2})\//.exec(key)?.[1];
  const day = /\/day=(\d{2})\//.exec(key)?.[1];
  if (!year || !month || !day) return false;
  const iso = `${year}-${month}-${day}`;
  return iso >= window.startDate && iso <= window.endDate;
}

/**
 * Will this key only ever hold these bytes? The rule lives in ./schema.ts
 * next to the key builders, because the replica sync needs exactly the same
 * answer and the two drifting apart is how deleted data comes back.
 */
const isContentUniqueKey = isContentUniqueAnalyticsKey;

function localPathFor(root: string, provider: string, key: string): string {
  // The object key is already structurally safe (no traversal, no absolute
  // path — assertSafeStorageKey rules), and it is re-sanitized here because
  // this value becomes a filesystem path.
  const safe = key.replace(/\.\./g, '_').replace(/^\/+/, '');
  return path.join(root, provider, safe);
}

/**
 * Fetch every analytics object a workspace's date range needs, and return
 * local paths for the engine.
 *
 * Reads from the ANALYTICS primary. It never consults the general storage
 * pool's primary — the two topologies are independent, and querying the
 * wrong one would read a bucket that holds no analytics at all.
 */
export async function fetchAnalyticsObjects(
  config: ServerConfig,
  workspaceId: string,
  window: ObjectWindow,
): Promise<FetchedObjects> {
  const empty: FetchedObjects = { files: [], objectCount: 0, bytes: 0, truncated: false };

  if (!UUID_RE.test(workspaceId)) {
    return { ...empty, unavailable: 'invalid workspace id' };
  }

  const pool = await readAnalyticsPool(config);
  if (!pool.enabled) return { ...empty, unavailable: 'analytics storage is disabled' };

  const topology = await resolveAnalyticsTopology(config, pool);
  if (!topology.primary) {
    return {
      ...empty,
      unavailable: topology.missingCredentials.length
        ? `the analytics primary has no stored credentials: ${topology.missingCredentials.join(', ')}`
        : 'no analytics primary is configured',
    };
  }

  const primary = topology.primary.config;
  const providerKey = topology.primary.name;

  // Every prefix the pool has written under: a range that spans a prefix
  // change must still see both sides of it.
  const prefixes = pool.knownPrefixes.length > 0 ? pool.knownPrefixes : [pool.prefix];

  const keys: string[] = [];
  let truncated = false;

  for (const prefix of prefixes) {
    const root = analyticsWorkspacePrefix(prefix, workspaceId);
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const listed = await listWithConfig(primary, root, cursor);
      if (!listed.success) {
        // A listing failure is not "no data" — saying so would report an
        // outage as an empty report.
        return { ...empty, unavailable: `listing failed: ${listed.error ?? 'unknown error'}` };
      }
      for (const raw of listed.keys ?? []) {
        const key = raw.replace(/^\/+/, '');
        if (!key.endsWith('.parquet')) continue;
        if (!keyInRange(key, window)) continue;
        if (keys.length >= MAX_OBJECTS_PER_QUERY) { truncated = true; break; }
        keys.push(key);
      }
      if (truncated || !listed.nextCursor) break;
      cursor = listed.nextCursor;
    }
    if (truncated) break;
  }

  if (keys.length === 0) return { ...empty, truncated };

  const root = cacheRoot();
  const files: string[] = [];
  let bytes = 0;

  for (const key of keys) {
    const local = localPathFor(root, providerKey, key);
    const cacheable = isContentUniqueKey(key);

    if (cacheable) {
      try {
        const cached = fs.statSync(local);
        files.push(local);
        bytes += cached.size;
        continue;
      } catch { /* not cached yet */ }
    }

    const downloaded = await fetchObject(primary, key);
    if (!downloaded) continue; // a vanished object (a concurrent re-seal) is not an error

    fs.mkdirSync(path.dirname(local), { recursive: true });
    // Write to a temp name and rename: a crash mid-write must never leave a
    // truncated file that the engine would then read as a corrupt Parquet.
    // A re-fetched sealed object overwrites the previous one atomically, so
    // a query never sees a half-written file.
    const staging = `${local}.partial-${process.pid}`;
    fs.writeFileSync(staging, downloaded);
    fs.renameSync(staging, local);

    files.push(local);
    bytes += downloaded.length;
  }

  pruneCache(root);
  return { files, objectCount: files.length, bytes, truncated };
}

async function fetchObject(primary: StorageConfig, key: string): Promise<Buffer | null> {
  try {
    const result = await downloadWithConfig(primary, key);
    if (!result.success || !result.data) return null;
    return result.data;
  } catch {
    return null;
  }
}

/**
 * Evict by total size, oldest first.
 *
 * No invalidation logic: an analytics object never changes, so a cached
 * file is either present and correct or absent. Best-effort — a failure to
 * prune costs disk, never correctness.
 */
function pruneCache(root: string): void {
  try {
    const entries: { file: string; size: number; mtime: number }[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else {
          const stat = fs.statSync(full);
          entries.push({ file: full, size: stat.size, mtime: stat.mtimeMs });
        }
      }
    };
    if (!fs.existsSync(root)) return;
    walk(root);

    let total = entries.reduce((sum, e) => sum + e.size, 0);
    if (total <= MAX_CACHE_BYTES) return;

    entries.sort((a, b) => a.mtime - b.mtime);
    for (const entry of entries) {
      if (total <= MAX_CACHE_BYTES) break;
      try { fs.unlinkSync(entry.file); total -= entry.size; } catch { /* already gone */ }
    }
  } catch { /* pruning is best-effort */ }
}

/** Test seam — empties the cache directory. */
export function __clearAnalyticsObjectCache(): void {
  try { fs.rmSync(cacheRoot(), { recursive: true, force: true }); } catch { /* nothing to clear */ }
}

/**
 * A DuckDB `read_parquet([...])` source built from already-fetched local
 * files.
 *
 * The file list is composed of paths this module produced, never of
 * anything a request supplied, and single quotes are escaped so a path
 * cannot terminate the literal. `union_by_name` lets files written under
 * different schema versions be read together — which is what makes the
 * APPEND-ONLY column rule in ./schema.ts actually pay off.
 */
export function parquetSource(files: string[]): string {
  const quoted = files.map((file) => `'${file.replace(/'/g, "''")}'`).join(', ');
  return `read_parquet([${quoted}], union_by_name = true)`;
}
