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
 * ── Durability ───────────────────────────────────────────────────
 *
 * Rows live in memory between flushes. Two mechanisms make that safe, and
 * which one carries the weight depends on `writeMode`:
 *
 *   dual_write — PostgreSQL holds every row, so the day's seal
 *                (./sealing.ts) rebuilds whatever a crash lost. The spool
 *                below is an optimisation here, not a requirement.
 *   s3_only    — PostgreSQL never receives the row, so there is nothing to
 *                rebuild from. Every accepted row is appended to a
 *                crash-safe local log (./spool.ts) BEFORE the buffer sees
 *                it, and replayed on the next boot if it never reached S3.
 *
 * `s3_only` is gated on the spool being writable for exactly that reason —
 * see `analyticsDurabilityReadiness` below.
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
  appendRows as appendToSpool,
  commitSpool,
  replaySpool,
  spoolAvailability,
  spoolStats,
} from './spool.js';
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

/**
 * Hard ceiling on rows held across ALL buffers.
 *
 * Without it a sustained outage — S3 unreachable, every flush failing and
 * requeueing — grows memory until the process is OOM-killed, which loses
 * every workspace's buffer AND takes the API down with it. Shedding the
 * oldest rows instead keeps the process alive and costs nothing that is
 * not recoverable: PostgreSQL holds every dropped row, and the day's seal
 * rebuilds the whole day from that source (./sealing.ts).
 *
 * Deliberately generous — roughly a hundred full batches — so it is only
 * ever reached by a real outage, never by ordinary burst traffic.
 */
const MAX_BUFFERED_ROWS = 1_000_000;

/**
 * Drop the oldest buffered rows until the ceiling is respected.
 *
 * Oldest first because they are the ones a seal will cover soonest: a
 * closed day is rebuilt on the next cycle, while the current day's rows
 * still have flushes ahead of them.
 */
function shedOldestRows(config: ServerConfig): void {
  let buffered = bufferedRowCount();
  if (buffered <= MAX_BUFFERED_ROWS) return;

  const oldestFirst = [...buffers.entries()].sort((a, b) => a[1].firstAt - b[1].firstAt);
  let shed = 0;
  for (const [key, batch] of oldestFirst) {
    if (buffered <= MAX_BUFFERED_ROWS) break;
    buffers.delete(key);
    buffered -= batch.rows.length;
    shed += batch.rows.length;
  }

  emitMetric(config, { metric: 'analytics_s3_buffer_shed_rows', tags: { count: shed } });
  emitLog(config, 'error', 'analytics_buffer_overflow', {
    shed_rows: shed,
    remaining_rows: buffered,
    note: 'rows remain in PostgreSQL and are restored when the day is sealed',
  });
}

/** Guards against a timer tick overlapping a threshold-triggered flush. */
let flushing = false;

/**
 * Spool on even under `dual_write`?
 *
 * Off by default: `dual_write` already has PostgreSQL as its backstop, so
 * spooling there buys resilience the seal already provides at the cost of a
 * disk write per event. It exists so an operator can exercise the spool —
 * and prove it works on THEIR volume — before flipping `s3_only`, which is
 * the whole point of the readiness gate below.
 */
function spoolEnabled(): boolean {
  return process.env.ANALYTICS_SPOOL_ENABLED === '1';
}

export interface DurabilityReadiness {
  /** Safe to run `writeMode: 's3_only'` on this deployment? */
  ready: boolean;
  spoolEnabled: boolean;
  available: boolean;
  dir: string;
  reason?: string;
  stats: ReturnType<typeof spoolStats>;
}

/**
 * Is durable ingestion actually working HERE?
 *
 * Answers by probing the real directory rather than by reading a setting,
 * because the thing that goes wrong in production is a volume that is not
 * mounted, not a flag that is not set. The cutover readiness card and the
 * `s3_only` gate both read this.
 */
export function analyticsDurabilityReadiness(): DurabilityReadiness {
  const availability = spoolAvailability();
  return {
    ready: availability.available,
    spoolEnabled: spoolEnabled(),
    available: availability.available,
    dir: availability.dir,
    reason: availability.reason,
    stats: spoolStats(),
  };
}

/**
 * Replay whatever a previous process left unacknowledged, back into the
 * buffer, so the normal flush path drains it.
 *
 * Runs once at startup, before the flush ticker starts. Rows are put back
 * through the same buffer the live path uses, so they are subject to the
 * same batching, the same ceiling and the same day partitioning — replay is
 * not a second write path with its own bugs.
 */
export function replaySpooledRows(config: ServerConfig): { rows: number; segments: number } {
  const replayed = replaySpool(config);
  for (const row of replayed.rows) {
    if (!row || typeof row.workspace_id !== 'string' || !row.workspace_id) continue;
    const day = dayKeyOf(row);
    const key = `${row.workspace_id}|${day}`;
    let batch = buffers.get(key);
    if (!batch) {
      batch = { workspaceId: row.workspace_id, day, rows: [], bytes: 0, firstAt: Date.now() };
      buffers.set(key, batch);
    }
    batch.rows.push(row);
    batch.bytes += estimateRowBytes(row);
  }
  // Re-append to THIS process's segment: the replayed files were deleted, so
  // without this a second crash before the next flush would lose them again.
  if (replayed.rows.length > 0) appendToSpool(config, replayed.rows);
  return { rows: replayed.rows.length, segments: replayed.segments };
}

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

/**
 * The UTC day a row belongs to.
 *
 * Defensive about the timestamp because this runs on the widget request
 * path: `new Date(NaN).toISOString()` THROWS, and a single malformed row
 * reaching an ingest call site must not throw out of enqueue. A row with an
 * unusable timestamp is filed under today — it still lands in the lake, and
 * the day's seal rebuilds it from PostgreSQL with the correct value anyway.
 */
function dayKeyOf(row: AnalyticsEventRow): string {
  const millis = Number(row.occurred_at);
  const when = Number.isFinite(millis) ? new Date(millis) : new Date();
  const iso = Number.isNaN(when.getTime()) ? new Date() : when;
  return iso.toISOString().slice(0, 10);
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
  // Disk BEFORE memory. The caller has already told the widget the event
  // was accepted, so under `s3_only` the row has to outlive this process
  // from here on. Under `dual_write` a failure is tolerable (PostgreSQL has
  // the row and the seal rebuilds the day), so this never throws either way.
  if (pool.writeMode === 's3_only' || spoolEnabled()) {
    appendToSpool(config, [row]);
  }

  const day = dayKeyOf(row);
  const key = `${row.workspace_id}|${day}`;
  let batch = buffers.get(key);
  if (!batch) {
    batch = { workspaceId: row.workspace_id, day, rows: [], bytes: 0, firstAt: Date.now() };
    buffers.set(key, batch);
  }
  batch.rows.push(row);
  batch.bytes += estimateRowBytes(row);
  shedOldestRows(config);

  if (batch.rows.length >= pool.batchRows || batch.bytes >= pool.batchBytes) {
    // Explicitly caught, never a bare `void`: this runs on a widget request
    // path, and an unhandled rejection here would take the whole process
    // down under Node's default policy — losing every workspace's buffer to
    // punish one failed flush.
    void flushAnalytics(config, { reason: 'threshold' }).catch((err: unknown) => {
      emitLog(config, 'warn', 'analytics_threshold_flush_threw', {
        error: err instanceof Error ? err.message : 'unknown',
      });
    });
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
        if (!outcome.drop) requeue(batch);
        continue;
      }
      result.objects++;
      result.rows += outcome.metadata!.rowCount;
      result.bytes += outcome.metadata!.bytes;
      if (outcome.replicated) anyReplicated = true;
    }

    // A failed cycle put rows back; enforce the ceiling before the next one.
    if (result.failures > 0) shedOldestRows(config);

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

    // Acknowledge the spool only when NOTHING is left buffered: that is the
    // only moment at which "every row this process accepted is in S3" holds.
    // A partial drain leaves the log intact and replays the remainder.
    if ((pool.writeMode === 's3_only' || spoolEnabled()) && result.failures === 0 && buffers.size === 0) {
      commitSpool(config);
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
  /** The failure is permanent for these rows — requeueing them would never succeed. */
  drop?: boolean;
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
    // Unencodable rows fail identically on every retry, so requeueing them
    // is a poison pill: the batch never drains and grows on each tick. They
    // are dropped here — PostgreSQL still holds every one of them, and the
    // day's seal rebuilds the whole day from that source.
    return { ok: false, error: message, drop: true };
  }

  const metadata: AnalyticsObjectMetadata = {
    objectKey,
    rowCount: batch.rows.length,
    bytes: buffer.length,
    checksum: createHash('sha256').update(buffer).digest('hex'),
    schemaVersion: batch.rows[0]?.schema_version ?? 0,
    createdAt: new Date().toISOString(),
  };

  // uploadWithConfig resolves {success:false} for a provider-level refusal
  // but THROWS for a network-level failure (fetchWithTimeout). Both must
  // land on the same path: the batch is already detached from the buffer,
  // so an escaping exception would destroy rows instead of requeueing them.
  let primaryResult: Awaited<ReturnType<typeof uploadWithConfig>>;
  try {
    primaryResult = await uploadWithConfig(primary.config, {
      fileKey: objectKey,
      data: buffer,
      contentType: 'application/vnd.apache.parquet',
    });
  } catch (err: unknown) {
    primaryResult = { success: false, error: err instanceof Error ? err.message : String(err) };
  }

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
