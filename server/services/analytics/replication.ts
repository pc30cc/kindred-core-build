/**
 * ANALYTICS REPLICA SYNC — back-fill a replica from the ANALYTICS primary.
 *
 * This is the catch-up counterpart to mirror-on-write, for objects written
 * before a replica was added or while it was unreachable.
 *
 * Why this exists instead of calling syncStorageReplica()
 * ------------------------------------------------------
 * The general sync (server/services/storage/index.ts) is proven and its
 * semantics are exactly what is wanted — bounded batches, server-persisted
 * cursor, readiness only for a complete zero-failure walk. But it resolves
 * its source from `storagePool.primary` and records its progress on the
 * general pool's entries. Pointed at analytics it would copy FROM the
 * general primary (Bunny), which for this feature is simply the wrong
 * bucket, and it would mark the GENERAL pool's replica state.
 *
 * So this module reuses the same SEMANTICS and the same low-level storage
 * primitives — `listWithConfig`, `downloadWithConfig`, `uploadWithConfig`,
 * the shared driver table — over the analytics topology and the analytics
 * state. No storage driver is duplicated; the only thing that differs is
 * which pool answers "primary", "replicas" and "where does progress live".
 *
 * Everything it walks is under the analytics prefix, so a run can never
 * touch `workspace/`, `users/` or `platform/`.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ServerConfig } from '../../config.js';
import {
  downloadWithConfig, listWithConfig, uploadWithConfig, type StorageConfig,
} from '../storage/index.js';
import { duckDbAvailability, queryAnalytics } from './duckdb.js';
import { writeParquet } from './parquet.js';
import {
  persistAnalyticsReplicaSync,
  readAnalyticsPool,
  resolveAnalyticsTopology,
  type AnalyticsStoragePool,
  type AnalyticsSyncState,
} from './pool.js';
import { isContentUniqueAnalyticsKey } from './schema.js';

const SYNC_DEFAULT_LIMIT = 100;
const SYNC_MAX_LIMIT = 500;
/** Pages of the TARGET listing consulted per batch. Bounded: overrunning it only costs a re-copy. */
const EXISTING_SCAN_MAX_PAGES = 10;

interface SyncCursor { p: string | null; o: number }

function encodeCursor(cursor: SyncCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(raw: string | null | undefined): SyncCursor {
  if (!raw) return { p: null, o: 0 };
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<SyncCursor>;
    return {
      p: typeof parsed.p === 'string' ? parsed.p : null,
      o: typeof parsed.o === 'number' && parsed.o >= 0 ? Math.floor(parsed.o) : 0,
    };
  } catch {
    return { p: null, o: 0 };
  }
}

function canonicalKey(key: string): string {
  return key.replace(/^\/+/, '');
}

export interface AnalyticsSyncReport {
  target: string;
  prefix: string;
  batch: { scanned: number; copied: number; skipped: number; failed: number };
  total: { scanned: number; copied: number; skipped: number; failed: number };
  errors: string[];
  nextCursor: string | null;
  done: boolean;
  /** The walk covered the whole analytics namespace with no failures. */
  markedSynchronized: boolean;
}

export interface AnalyticsSyncResult {
  ok: boolean;
  report?: AnalyticsSyncReport;
  error?: string;
}

export interface AnalyticsSyncOptions {
  target: string;
  /** Sub-prefix WITHIN the analytics namespace, e.g. `workspace=<id>/`. Never an absolute key. */
  prefix?: string;
  limit?: number;
  restart?: boolean;
}

/** Keys the target already holds under `prefix`, over a bounded number of pages. */
async function listExistingKeys(config: StorageConfig, prefix: string): Promise<Set<string>> {
  const existing = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < EXISTING_SCAN_MAX_PAGES; page++) {
    const listed = await listWithConfig(config, prefix, cursor);
    if (!listed.success) break; // treat as "holds nothing known" — copies, never skips
    for (const key of listed.keys ?? []) existing.add(canonicalKey(key));
    if (!listed.nextCursor) break;
    cursor = listed.nextCursor;
  }
  return existing;
}

/**
 * Copy at most `limit` objects from the analytics primary to one replica,
 * then return. The walk's position and running totals are persisted on the
 * ANALYTICS pool, so the caller only ever asks for the next batch and
 * promotion readiness is decided from state the server recorded itself —
 * never from a number a browser sent back.
 */
export async function syncAnalyticsReplica(
  serverConfig: ServerConfig,
  opts: AnalyticsSyncOptions,
): Promise<AnalyticsSyncResult> {
  const pool = await readAnalyticsPool(serverConfig);
  if (!pool.primary) return { ok: false, error: 'No analytics primary is configured' };
  if (opts.target === pool.primary) return { ok: false, error: 'The analytics primary cannot be synced onto itself' };
  if (!pool.replicas.includes(opts.target)) {
    return { ok: false, error: `${opts.target} is not an analytics replica` };
  }

  const topology = await resolveAnalyticsTopology(serverConfig, {
    ...pool,
    // Resolve the target even when replication is switched off: a sync is
    // exactly how an operator catches a replica up before turning it back on.
    replicationEnabled: true,
    replicas: [opts.target],
  });
  if (!topology.primary) {
    return { ok: false, error: `The analytics primary (${pool.primary}) has no stored credentials` };
  }
  const target = topology.replicas.find((r) => r.name === opts.target);
  if (!target) {
    return { ok: false, error: `${opts.target} has no stored credentials — configure it in Providers → Storage` };
  }

  const stored = pool.replicaState[opts.target]?.sync ?? null;
  const continuable = !opts.restart && !!stored && !stored.done && stored.from === pool.primary;

  // Resuming without naming a prefix continues the walk actually in flight.
  // Defaulting to the whole namespace instead would abandon a prefix-scoped
  // walk halfway and let it claim the readiness only a full walk may grant.
  const requestedSuffix =
    opts.prefix !== undefined ? opts.prefix
      : continuable ? stored!.prefix.slice(pool.prefix.length)
        : '';

  // Every walk is confined to the analytics namespace: the operator's
  // sub-prefix is appended to it, never substituted for it, so a crafted
  // value can never reach `workspace/` or `users/`.
  const suffix = requestedSuffix.replace(/^\/+/, '').replace(/\.\./g, '').replace(/\\/g, '');
  const prefix = `${pool.prefix}${suffix}`;

  const limit = Math.min(Math.max(opts.limit ?? SYNC_DEFAULT_LIMIT, 1), SYNC_MAX_LIMIT);
  const resumable = continuable && stored!.prefix === prefix;

  const cursor = decodeCursor(resumable ? stored!.cursor : null);
  const runningTotal = resumable
    ? { ...stored!.total }
    : { scanned: 0, copied: 0, skipped: 0, failed: 0 };
  const walkStartedAt = resumable ? stored!.startedAt : new Date().toISOString();

  const listed = await listWithConfig(topology.primary.config, prefix, cursor.p ?? undefined);
  if (!listed.success) {
    return { ok: false, error: listed.error ?? 'Listing the analytics primary failed' };
  }

  // Sorted so an offset into this page addresses the same key on any
  // re-listing, whatever order the provider walked its objects in.
  const pageKeys = (listed.keys ?? []).map(canonicalKey).sort();
  const batchKeys = pageKeys.slice(cursor.o, cursor.o + limit);
  const existing = await listExistingKeys(target.config, prefix);

  const batch = { scanned: batchKeys.length, copied: 0, skipped: 0, failed: 0 };
  const errors: string[] = [];

  for (const key of batchKeys) {
    // "The replica already has this name" only means "already has this data"
    // for content-unique keys. A sealed object's key is deterministic, so a
    // re-seal changes the bytes behind a name the replica still holds — and
    // skipping it would leave the replica serving pre-erasure data forever.
    // See isContentUniqueAnalyticsKey in ./schema.ts.
    if (existing.has(key) && isContentUniqueAnalyticsKey(key)) {
      batch.skipped++;
      continue;
    }
    const downloaded = await downloadWithConfig(topology.primary.config, key);
    if (!downloaded.success || !downloaded.data) {
      batch.failed++;
      if (errors.length < 10) errors.push(`${key}: ${downloaded.error ?? 'download failed'}`);
      continue;
    }
    const uploaded = await uploadWithConfig(target.config, {
      fileKey: key,
      data: downloaded.data,
      contentType: 'application/vnd.apache.parquet',
    });
    if (uploaded.success) {
      batch.copied++;
    } else {
      batch.failed++;
      if (errors.length < 10) errors.push(`${key}: ${uploaded.error ?? 'upload failed'}`);
    }
  }

  const consumed = cursor.o + batchKeys.length;
  const nextCursor: SyncCursor | null =
    consumed < pageKeys.length
      ? { p: cursor.p, o: consumed }
      : listed.nextCursor
        ? { p: listed.nextCursor, o: 0 }
        : null;

  const total = {
    scanned: runningTotal.scanned + batch.scanned,
    copied: runningTotal.copied + batch.copied,
    skipped: runningTotal.skipped + batch.skipped,
    failed: runningTotal.failed + batch.failed,
  };

  const done = nextCursor === null;
  // Readiness is earned ONLY by a completed walk of the whole analytics
  // namespace with nothing left unfixed. A workspace-scoped or partly failed
  // walk proves nothing about the objects it never looked at.
  const markedSynchronized = done && total.failed === 0 && prefix === pool.prefix;

  const nextSync: AnalyticsSyncState = {
    prefix,
    from: pool.primary,
    startedAt: walkStartedAt,
    cursor: nextCursor ? encodeCursor(nextCursor) : null,
    total,
    done,
    updatedAt: new Date().toISOString(),
  };

  const persisted = await persistAnalyticsReplicaSync(serverConfig, {
    provider: opts.target,
    sync: nextSync,
    markSynced: markedSynchronized,
    expectedPrimary: pool.primary,
    walkStartedAt,
  });

  if (!persisted.ok) {
    return {
      ok: false,
      error:
        persisted.error === 'primary_changed'
          ? 'The analytics primary changed while this sync was running — the walk was abandoned. Start it again.'
          : persisted.error === 'replica_removed'
            ? 'This vendor was removed from the analytics replicas while the sync was running.'
            : persisted.error === 'replication_gap_during_walk'
              ? 'A mirrored analytics write failed while this sync was running, so the walk cannot prove the replica is complete. Run it again.'
              : `Could not record sync progress: ${persisted.error}`,
    };
  }


  return {
    ok: true,
    report: {
      target: opts.target,
      prefix,
      batch,
      total,
      errors,
      nextCursor: nextSync.cursor,
      done,
      markedSynchronized,
    },
  };
}

// ─── Integrity ───────────────────────────────────────────────────

export interface ObjectIntegrity {
  provider: string;
  present: boolean;
  bytes?: number;
  checksum?: string;
  error?: string;
}

/**
 * Verify that one object is byte-identical on the primary and on every
 * replica. Used by the admin verification action and by the backfill's
 * spot-check — deliberately per-object rather than a manifest table: the
 * requirement is to be able to prove a write, not to build an object
 * catalogue that then has to be kept in sync with reality.
 */
export async function verifyAnalyticsObject(
  serverConfig: ServerConfig,
  objectKey: string,
): Promise<{ ok: boolean; primary: ObjectIntegrity | null; replicas: ObjectIntegrity[] }> {
  const pool = await readAnalyticsPool(serverConfig);
  const topology = await resolveAnalyticsTopology(serverConfig, { ...pool, replicationEnabled: true });
  if (!topology.primary) return { ok: false, primary: null, replicas: [] };

  const read = async (name: string, config: StorageConfig): Promise<ObjectIntegrity> => {
    try {
      const result = await downloadWithConfig(config, objectKey);
      if (!result.success || !result.data) {
        return { provider: name, present: false, error: result.error ?? 'not found' };
      }
      return {
        provider: name,
        present: true,
        bytes: result.data.length,
        checksum: createHash('sha256').update(result.data).digest('hex'),
      };
    } catch (err: unknown) {
      return { provider: name, present: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  const primary = await read(topology.primary.name, topology.primary.config);
  const replicas = await Promise.all(topology.replicas.map((r) => read(r.name, r.config)));

  const ok =
    primary.present && replicas.every((r) => r.present && r.checksum === primary.checksum);
  return { ok, primary, replicas };
}

/**
 * A real analytics round trip against one vendor.
 *
 * Stronger than the general provider test, which proves only an upload and
 * a delete. Analytics additionally needs LIST (replica sync walks it), a
 * byte-identical GET, and — since Phase 2 — the ability for the embedded
 * query engine to actually READ a Parquet object back from this vendor.
 * So the object written here is a real Parquet file, and when the engine is
 * available it is queried and its contents verified before deletion:
 *
 *   write test parquet → read it back → query it → verify → delete
 *
 * This never touches the general storage pool's state. It writes under the
 * analytics prefix, with the analytics vendor's credentials, and removes
 * what it wrote.
 */
export async function testAnalyticsProvider(
  serverConfig: ServerConfig,
  provider: string,
  config: StorageConfig,
  prefix: string,
): Promise<{
  success: boolean;
  latencyMs: number;
  steps: Record<string, boolean>;
  /** Present when the engine is absent: the object contract still passed. */
  querySkippedReason?: string;
  error?: string;
}> {
  const started = Date.now();
  const key = `${prefix}_healthcheck/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.parquet`;
  // A real Parquet file with known contents — the same writer the pipeline
  // uses, so a codec or runtime problem shows up here rather than on the
  // first real flush.
  const probe = writeParquet(
    [{ name: 'probe_id', type: 'utf8' }, { name: 'n', type: 'int32' }],
    [{ probe_id: 'a', n: 1 }, { probe_id: 'b', n: 2 }, { probe_id: 'c', n: 3 }],
    { createdBy: 'webyar-analytics-healthcheck' },
  );
  const payload = probe.buffer;
  const steps: Record<string, boolean> = { put: false, get: false, list: false, query: false, delete: false };
  let querySkippedReason: string | undefined;

  const cleanup = async () => {
    try {
      const { deleteWithConfig } = await import('../storage/index.js');
      const removed = await deleteWithConfig(config, key);
      steps.delete = removed.success;
    } catch { steps.delete = false; }
  };

  try {
    const put = await uploadWithConfig(config, {
      fileKey: key, data: payload, contentType: 'application/vnd.apache.parquet',
    });
    if (!put.success) {
      return { success: false, latencyMs: Date.now() - started, steps, error: put.error ?? 'upload failed' };
    }
    steps.put = true;

    const get = await downloadWithConfig(config, key);
    steps.get = get.success && !!get.data && get.data.equals(payload);

    const listed = await listWithConfig(config, `${prefix}_healthcheck/`);
    steps.list = listed.success;

    // Query the bytes that came BACK from the vendor, not the ones we built
    // — that is what proves this vendor can serve the read path.
    if (steps.get && get.data) {
      const engine = await duckDbAvailability();
      if (engine.available === false) {
        // Not a failure of the vendor: the object contract passed and the
        // engine is optional. Reported so the panel can say which it was.
        querySkippedReason = engine.reason;
        steps.query = true;
      } else {
        steps.query = await probeQuery(serverConfig, get.data);
      }
    }

    await cleanup();

    const success = steps.put && steps.get && steps.list && steps.query && steps.delete;
    return {
      success,
      latencyMs: Date.now() - started,
      steps,
      querySkippedReason,
      error: success
        ? undefined
        : !steps.get ? 'the object could not be read back identically'
          : !steps.list ? `listing is not supported for ${provider}`
            : !steps.query ? 'the query engine could not read the test Parquet object back'
              : 'the test object could not be deleted',
    };
  } catch (err: unknown) {
    await cleanup();
    return {
      success: false,
      latencyMs: Date.now() - started,
      steps,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Write the fetched bytes to a scratch file and make the engine aggregate
 * them, exactly as a report would. Anything less — parsing the footer
 * ourselves, say — would prove the file is well-formed without proving the
 * engine can use it.
 */
async function probeQuery(serverConfig: ServerConfig, bytes: Buffer): Promise<boolean> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-probe-'));
  const file = path.join(dir, 'probe.parquet');
  try {
    fs.writeFileSync(file, bytes);
    const rows = await queryAnalytics<{ n: unknown; total: unknown }>(
      serverConfig,
      `SELECT count(*) AS n, sum(n) AS total FROM read_parquet('${file.replace(/'/g, "''")}')`,
      { label: 'healthcheck' },
    );
    const row = rows[0];
    return !!row && Number(row.n) === 3 && Number(row.total) === 6;
  } catch {
    return false;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* scratch dir */ }
  }
}
