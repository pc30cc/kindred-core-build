/**
 * ANALYTICS WRITER — buffer → Parquet → Analytics Primary → Analytics Replicas.
 *
 * ── The small-files rule ─────────────────────────────────────────
 *
 * One event is never one object. Rows accumulate in a per-workspace,
 * per-UTC-day buffer and are flushed as ONE Parquet file when any of three
 * operator-configured thresholds trips first: `batchRows`, `batchBytes`
 * (estimated input size, not compressed output), or `flushIntervalMs`.
 *
 * The buffer is in-process and deliberately so. The requirement is to reuse
 * existing infrastructure, and the existing infrastructure for "do this
 * periodically inside the running backend" is the ticker pattern that
 * alerting, auto-actions, enforcement and rank-tracking all use. Routing
 * every page view through `background_jobs` would replace one PostgreSQL
 * insert with two — the opposite of the point. `background_jobs` IS used
 * here, for the long-running walks it is good at: replica back-fill and the
 * historical migration (./backfill.ts).
 *
 * Unlike the other tickers, the flush timer takes NO cross-replica lease.
 * Each backend process owns its own buffer, so every process must flush its
 * own; a lease would mean one process's rows sit unwritten until it happens
 * to win a lease it does not need.
 *
 * Durability: rows live in memory between flushes, so an ungraceful kill
 * loses at most one flush interval. Phase 1 dual-writes — PostgreSQL still
 * holds every row and is still the read source — so that window costs
 * nothing, and the flush also runs on shutdown. Cutting reads over to S3
 * (Phase 3) must not happen until this is reconsidered; it is listed as an
 * explicit Phase 2 prerequisite.
 *
 * ── Write semantics ──────────────────────────────────────────────
 *
 * The Analytics Primary is canonical. A batch counts as written only once
 * the primary accepts it; if the primary fails, the rows go BACK on the
 * buffer for the next flush and nothing is marked successful.
 *
 * A replica failure is different: the primary already holds the object, so
 * the batch stands. The replica is marked dirty durably (which clears its
 * promotion readiness) and surfaced in the admin panel for re-sync. Widget
 * tracking is never affected by either case — ingestion is fire-and-forget
 * and cannot throw into a request handler.
 */

import { createHash } from 'node:crypto';
import type { ServerConfig } from '../../config.js';
import { emitLog, emitMetric } from '../observability/metrics.js';
import { uploadWithConfig, type StorageConfig } from '../storage/index.js';
import {
  markAnalyticsReplicaDirty,
  markAnalyticsReplicationUncertain,
  readAnalyticsPool,
  recordAnalyticsError,
  recordAnalyticsWrite,
  resolveAnalyticsTopology,
  type AnalyticsStoragePool,
} from './pool.js';
import { writeParquet } from './parquet.js';
import {
  ANALYTICS_COLUMNS,
  analyticsObjectKey,
  rowToParquet,
  type AnalyticsEventRow,
} from './schema.js';

/** Rough input size of one row — drives the `batchBytes` threshold. */
function estimateRowBytes(row: AnalyticsEventRow): number {
  let bytes = 64; // fixed-width columns + per-row overhead
  for (const value of Object.values(row)) {
    if (typeof value === 'string') bytes += value.length;
  }
  return bytes;
}

interface Batch {
  workspaceId: string;
  /** UTC day key (YYYY-MM-DD) — one object per workspace-day, never mixed. */
  day: string;
  rows: AnalyticsEventRow[];
  bytes: number;
  firstAt: number;
}

/** Keyed by `workspaceId|day` so one flush never straddles a partition boundary. */
const buffers = new Map<string, Batch>();

/** Guards against a timer tick overlapping a threshold-triggered flush. */
let flushing = false;

export interface AnalyticsObjectMetadata {
  objectKey: string;
  rowCount: number;
  bytes: number;
  /** SHA-256 of the exact bytes written — the primary/replica equality proof. */
  checksum: string;
  schemaVersion: number;
  createdAt: string;
}

export function bufferedRowCount(): number {
  let total = 0;
  for (const batch of buffers.values()) total += batch.rows.length;
  return total;
}

/** Test seam — drops buffered rows without writing them. */
export function __resetAnalyticsBuffer(): void {
  buffers.clear();
  flushing = false;
}

function dayKeyOf(row: AnalyticsEventRow): string {
  return new Date(row.occurred_at).toISOString().slice(0, 10);
}

/**
 * Add one row to the buffer. Never throws, never awaits storage: the caller
 * is a widget request handler and must not wait on, or fail because of, the
 * analytics lake.
 */
export function enqueueAnalyticsRow(
  config: ServerConfig,
  pool: AnalyticsStoragePool,
  row: AnalyticsEventRow,
): void {
  const day = dayKeyOf(row);
  const key = `${row.workspace_id}|${day}`;
  let batch = buffers.get(key);
  if (!batch) {
    batch = { workspaceId: row.workspace_id, day, rows: [], bytes: 0, firstAt: Date.now() };
    buffers.set(key, batch);
  }
  batch.rows.push(row);
  batch.bytes += estimateRowBytes(row);

  if (batch.rows.length >= pool.batchRows || batch.bytes >= pool.batchBytes) {
    void flushAnalytics(config, { reason: 'threshold' });
  }
}

function isDue(batch: Batch, pool: AnalyticsStoragePool, force: boolean): boolean {
  if (force) return true;
  if (batch.rows.length >= pool.batchRows) return true;
  if (batch.bytes >= pool.batchBytes) return true;
  return Date.now() - batch.firstAt >= pool.flushIntervalMs;
}

export interface FlushResult {
  objects: number;
  rows: number;
  bytes: number;
  failures: number;
}

/**
 * Flush every batch that has met a threshold (or all of them, when forced).
 *
 * Serialized by the `flushing` guard so the interval tick and a
 * threshold-triggered flush can never both drain the same batch and write
 * the same rows to two objects.
 */
export async function flushAnalytics(
  config: ServerConfig,
  opts?: { reason?: string; force?: boolean },
): Promise<FlushResult> {
  const empty: FlushResult = { objects: 0, rows: 0, bytes: 0, failures: 0 };
  if (flushing) return empty;
  if (buffers.size === 0) return empty;

  flushing = true;
  try {
    let pool: AnalyticsStoragePool;
    try {
      pool = await readAnalyticsPool(config);
    } catch (err: unknown) {
      // Cannot tell whether analytics is even enabled — keep the rows and
      // retry on the next tick rather than dropping them.
      emitLog(config, 'warn', 'analytics_pool_read_failed', {
        error: err instanceof Error ? err.message : 'unknown',
      });
      return empty;
    }

    if (!pool.enabled) {
      // Disabled after rows were already buffered: drop them rather than
      // grow memory forever. PostgreSQL still holds every one of them.
      buffers.clear();
      return empty;
    }

    const topology = await resolveAnalyticsTopology(config, pool);
    if (!topology.primary) {
      const reason = topology.missingCredentials.length
        ? `analytics primary has no stored credentials: ${topology.missingCredentials.join(', ')}`
        : 'no analytics primary is configured';
      await recordAnalyticsError(config, reason);
      emitMetric(config, { metric: 'analytics_s3_primary_write_failures', tags: { reason: 'no_primary' } });
      return empty;
    }

    const due = [...buffers.entries()].filter(([, batch]) => isDue(batch, pool, opts?.force === true));
    const result: FlushResult = { objects: 0, rows: 0, bytes: 0, failures: 0 };
    let anyReplicated = false;

    for (const [key, batch] of due) {
      // Detach before any I/O: rows that arrive mid-flush belong to the next
      // object, and a failure puts exactly this set back.
      buffers.delete(key);

      const outcome = await writeBatch(config, pool, topology.primary, topology.replicas, batch);
      if (!outcome.ok) {
        result.failures++;
        requeue(batch);
        continue;
      }
      result.objects++;
      result.rows += outcome.metadata!.rowCount;
      result.bytes += outcome.metadata!.bytes;
      if (outcome.replicated) anyReplicated = true;
    }

    if (result.objects > 0) {
      await recordAnalyticsWrite(config, {
        objects: result.objects,
        bytes: result.bytes,
        rows: result.rows,
        replicated: anyReplicated,
      });
      emitMetric(config, { metric: 'analytics_s3_objects_written', tags: { count: result.objects } });
      emitMetric(config, { metric: 'analytics_s3_rows_written', tags: { count: result.rows } });
      emitMetric(config, { metric: 'analytics_s3_bytes_written', tags: { count: result.bytes } });
      emitLog(config, 'info', 'analytics_flush', {
        reason: opts?.reason ?? 'tick',
        objects: result.objects,
        rows: result.rows,
        bytes: result.bytes,
        failures: result.failures,
      });
    }

    emitMetric(config, { metric: 'analytics_s3_buffer_rows', tags: { count: bufferedRowCount() } });
    return result;
  } finally {
    flushing = false;
  }
}

/**
 * Put a failed batch's rows back at the FRONT of their buffer so the next
 * flush retries them. Retry is the flush loop itself — the same "try again
 * next tick" contract every other ticker in this codebase uses — rather
 * than a bespoke retry queue.
 */
function requeue(batch: Batch): void {
  const key = `${batch.workspaceId}|${batch.day}`;
  const existing = buffers.get(key);
  if (!existing) {
    buffers.set(key, batch);
    return;
  }
  existing.rows = [...batch.rows, ...existing.rows];
  existing.bytes += batch.bytes;
  existing.firstAt = Math.min(existing.firstAt, batch.firstAt);
}

interface BatchOutcome {
  ok: boolean;
  metadata?: AnalyticsObjectMetadata;
  replicated?: boolean;
  error?: string;
}

/**
 * Encode one batch and write it: primary first, then — only on success —
 * the identical bytes under the identical key to every replica.
 */
async function writeBatch(
  config: ServerConfig,
  pool: AnalyticsStoragePool,
  primary: { name: string; config: StorageConfig },
  replicas: { name: string; config: StorageConfig }[],
  batch: Batch,
): Promise<BatchOutcome> {
  let buffer: Buffer;
  let objectKey: string;
  try {
    const file = writeParquet(ANALYTICS_COLUMNS, batch.rows.map(rowToParquet), {
      createdBy: 'webyar-web-analytics',
    });
    buffer = file.buffer;
    // The object's day partition comes from the batch's day key, not from
    // "now" — a flush that crosses midnight must still file its rows under
    // the day they happened.
    objectKey = analyticsObjectKey(pool.prefix, batch.workspaceId, new Date(`${batch.day}T00:00:00.000Z`));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'parquet encode failed';
    await recordAnalyticsError(config, `encode_failed: ${message}`);
    emitMetric(config, { metric: 'analytics_s3_primary_write_failures', tags: { reason: 'encode' } });
    emitLog(config, 'error', 'analytics_encode_failed', { error: message, rows: batch.rows.length });
    // Unencodable rows would fail identically forever — dropping them is the
    // only way the buffer drains, and PostgreSQL still holds them.
    return { ok: false, error: message };
  }

  const metadata: AnalyticsObjectMetadata = {
    objectKey,
    rowCount: batch.rows.length,
    bytes: buffer.length,
    checksum: createHash('sha256').update(buffer).digest('hex'),
    schemaVersion: batch.rows[0]?.schema_version ?? 0,
    createdAt: new Date().toISOString(),
  };

  const primaryResult = await uploadWithConfig(primary.config, {
    fileKey: objectKey,
    data: buffer,
    contentType: 'application/vnd.apache.parquet',
  });

  if (!primaryResult.success) {
    const message = primaryResult.error ?? 'unknown error';
    await recordAnalyticsError(config, `primary_write_failed[${primary.name}]: ${message}`);
    emitMetric(config, {
      metric: 'analytics_s3_primary_write_failures',
      tags: { provider: primary.name },
    });
    emitLog(config, 'error', 'analytics_primary_write_failed', {
      provider: primary.name, object_key: objectKey, rows: metadata.rowCount, error: message,
    });
    return { ok: false, error: message };
  }

  const replicated = await replicateObject(config, pool, replicas, buffer, metadata);
  return { ok: true, metadata, replicated };
}

/**
 * Copy one canonical object to every analytics replica — same key, same
 * bytes, therefore the same checksum.
 *
 * The topology walked here is the ANALYTICS one. It never consults
 * `storagePool.primary` or the general replica list, which is why an
 * analytics write goes Arvan → R2 even when general storage is set up as
 * Bunny → Arvan.
 */
async function replicateObject(
  config: ServerConfig,
  pool: AnalyticsStoragePool,
  replicas: { name: string; config: StorageConfig }[],
  buffer: Buffer,
  metadata: AnalyticsObjectMetadata,
): Promise<boolean> {
  if (!pool.replicationEnabled || replicas.length === 0) return false;

  const outcomes = await Promise.all(
    replicas.map(async (replica) => {
      try {
        const result = await uploadWithConfig(replica.config, {
          fileKey: metadata.objectKey,
          data: buffer,
          contentType: 'application/vnd.apache.parquet',
        });
        return { name: replica.name, ok: result.success, error: result.error };
      } catch (err: unknown) {
        return { name: replica.name, ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );

  let anyOk = false;
  for (const outcome of outcomes) {
    if (outcome.ok) {
      anyOk = true;
      continue;
    }
    // The primary holds the object; this replica does not. Record the gap
    // durably so promotion stays blocked until a fresh full sync proves it
    // caught up — the browser is not part of this decision.
    await markAnalyticsReplicaDirty(
      config,
      outcome.name,
      `mirror_upload_failed: ${outcome.error ?? 'unknown'}`,
    );
    emitMetric(config, {
      metric: 'analytics_s3_replica_write_failures',
      tags: { provider: outcome.name },
    });
    emitLog(config, 'warn', 'analytics_replica_write_failed', {
      provider: outcome.name, object_key: metadata.objectKey, error: outcome.error ?? 'unknown',
    });
  }
  return anyOk;
}

/**
 * Replication could not even be resolved for an object the primary already
 * accepted — every replica may now be missing it and none may be trusted.
 */
export async function reportReplicationUnresolved(
  config: ServerConfig,
  reason: string,
): Promise<void> {
  await markAnalyticsReplicationUncertain(config, reason);
  emitMetric(config, { metric: 'analytics_s3_replica_write_failures', tags: { reason: 'unresolved' } });
}

/**
 * Write one already-built set of rows straight through, bypassing the
 * buffer. Used by the back-fill worker, which already batches by design and
 * must not have its objects interleaved with live traffic.
 */
export async function writeAnalyticsObject(
  config: ServerConfig,
  pool: AnalyticsStoragePool,
  primary: { name: string; config: StorageConfig },
  replicas: { name: string; config: StorageConfig }[],
  workspaceId: string,
  day: string,
  rows: AnalyticsEventRow[],
): Promise<BatchOutcome> {
  if (rows.length === 0) return { ok: true };
  return writeBatch(config, pool, primary, replicas, {
    workspaceId, day, rows, bytes: 0, firstAt: Date.now(),
  });
}
