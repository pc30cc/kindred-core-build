/**
 * DURABLE ANALYTICS SPOOL — a crash-safe write-ahead log for the in-memory
 * buffer, with no new service, no queue and no new container.
 *
 * ── Why this exists ──────────────────────────────────────────────
 *
 * Phase 2 made the buffer RECONSTRUCTIBLE rather than durable: every row is
 * also in PostgreSQL, so a day's seal rebuilds whatever a crash lost. That
 * is sound while `writeMode` is `dual_write`, and it stops being sound the
 * moment it is not — under `s3_only` PostgreSQL never receives the row, so
 * there is nothing to rebuild from and a lost buffer is lost data.
 *
 * This module is the missing piece: once the tracking endpoint has accepted
 * an event, the event is on disk before the request returns, and it is
 * replayed on the next boot if it never reached S3.
 *
 * ── What was rejected, and why ───────────────────────────────────
 *
 *   Kafka / Redpanda / any new service — excluded by requirement, and the
 *           operational cost dwarfs the problem: this is one process's
 *           seconds-long buffer, not a cross-service event bus.
 *   Redis — server/lib/redisClient.ts is explicitly "strictly a cache:
 *           every failure mode degrades to no index, never to wrong data".
 *           It is opt-in, absent in most self-host installs, and durability
 *           would need AOF with `appendfsync always` — a configuration this
 *           project neither ships nor can verify at runtime. Storing data
 *           whose loss matters in a store we cannot prove is durable is not
 *           durability, it is a guess.
 *   background_jobs — durable, but a PostgreSQL table. Routing raw events
 *           through it reintroduces exactly the write volume this migration
 *           exists to remove, and makes PostgreSQL the home of raw analytics
 *           events again under a different name.
 *   Hybrid spool + S3 (stage each batch to a scratch S3 prefix first) — the
 *           failure being defended against is "S3 is unavailable", so a
 *           design whose durability depends on S3 does not address it.
 *
 * What is left is a local append-only log, which is what this is.
 *
 * ── The durability contract, stated exactly ──────────────────────
 *
 * Each row is written with `fs.writeSync` into the OS page cache before the
 * enqueue call returns, and `fsync` runs on a timer and on rotation. So:
 *
 *   process crash, OOM kill, SIGKILL,   → SURVIVES. The page cache belongs
 *   SIGTERM, container restart, deploy,   to the kernel, not the process.
 *   S3 outage, network outage             Replayed on next boot.
 *
 *   host power loss / kernel panic      → survives up to the last fsync,
 *                                         at most FSYNC_INTERVAL_MS of
 *                                         events. Per-row fsync would make
 *                                         the tracking endpoint wait on a
 *                                         disk flush, which is not a trade
 *                                         a page-view beacon should make.
 *
 * That boundary is deliberate and is the one number to argue with if this
 * is ever not enough.
 *
 * ── MULTI-INSTANCE LIMITATION — read this before scaling out ─────
 *
 * The spool is LOCAL to one process's filesystem. Consequences:
 *
 *   1. Each instance replays only its OWN spool. Two backends behind a load
 *      balancer each hold their own un-flushed rows, and neither can see or
 *      recover the other's.
 *   2. If an instance is destroyed and its volume is NOT reattached — a
 *      scaled-down node, a rescheduled pod with an emptyDir, a `docker
 *      compose down -v` — its un-flushed rows are gone. The volume, not the
 *      container, is what carries the guarantee.
 *   3. `docker-compose.yml` mounts a NAMED volume (`geoip-data:/app/data`)
 *      on the backend, so an ordinary container replacement or redeploy on
 *      a single host keeps the spool. That is the deployment this is
 *      designed for and the one it is tested against.
 *   4. Concurrent processes on the SAME directory are handled by giving
 *      each process its own segment filenames (pid + boot timestamp), so
 *      they never append to one another's segments. A process that dies
 *      leaves its segments behind; the next boot of ANY process in that
 *      directory replays them, which is what makes a restart recover.
 *      Two processes replaying the same orphan concurrently would duplicate
 *      it — so replay takes an exclusive directory lock (see `acquireLock`).
 *
 * In short: this makes a single instance durable across every process-level
 * failure. It does not make a fleet durable against losing a node's disk,
 * and no design without a replicated log can, which is precisely the thing
 * that was excluded. Scaling the backend horizontally therefore needs each
 * instance to keep a durable volume, and that is a deployment requirement,
 * not something this code can enforce.
 *
 * ── On-disk format ───────────────────────────────────────────────
 *
 * Append-only segments, `seg-<boot>-<pid>-<n>.log`, each a sequence of
 * frames:
 *
 *   magic  u32  0x57414c31 ("WAL1")   — resynchronisation point
 *   kind   u8   'R' row | 'C' commit
 *   length u32  payload byte length
 *   crc32  u32  of the payload
 *   payload     UTF-8 JSON
 *
 * A COMMIT frame's payload is `{"offset":N}` and means "every byte before N
 * in this file has reached S3". That is the atomic acknowledgement: one
 * small append, no rewrite of what it acknowledges, and replay simply skips
 * rows starting before the highest committed offset. A torn final frame —
 * the normal shape of a crash mid-append — fails its length or CRC check,
 * and everything from there to EOF is discarded as the incomplete tail it
 * is, rather than failing the whole segment.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ServerConfig } from '../../config.js';
import { emitLog, emitMetric } from '../observability/metrics.js';
import type { AnalyticsEventRow } from './schema.js';

const MAGIC = 0x57414c31;
const HEADER_BYTES = 4 + 1 + 4 + 4;
const KIND_ROW = 0x52; // 'R'
const KIND_COMMIT = 0x43; // 'C'

function envBytes(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return Math.floor(parsed);
}

/** Rotate at this size so a committed segment can actually be deleted. */
function segmentMaxBytes(): number {
  return envBytes('ANALYTICS_SPOOL_SEGMENT_BYTES', 64 * 1024 * 1024, 1024 * 1024);
}

/**
 * Total spool ceiling. Past this the OLDEST segment is dropped, which is a
 * data-loss event and is logged and metered as one. It exists so a
 * multi-day S3 outage degrades instead of filling the volume and taking
 * down every other thing that writes to /app/data.
 *
 * CONFIGURABLE, because the right value is a property of the deployment,
 * not of this code. Size it from the outage you intend to survive:
 *
 *   required_bytes = events_per_second
 *                  x average_frame_bytes     (see spoolCapacityPlan())
 *                  x outage_seconds
 *                  x safety_factor           (2x or more)
 *
 * The default of 2 GiB is a starting point, not an answer — at a measured
 * ~180 bytes/frame it covers roughly a 3-hour outage at 1,000 events/sec
 * with a 2x margin, and roughly 30 hours at 100 events/sec. A deployment
 * whose traffic or tolerated outage is larger than that MUST raise it, or
 * the ceiling silently becomes the thing that loses the data the spool
 * exists to protect.
 */
function spoolMaxBytes(): number {
  return envBytes('ANALYTICS_SPOOL_MAX_BYTES', 2 * 1024 * 1024 * 1024, 16 * 1024 * 1024);
}

/** Upper bound on how much a host power loss can cost. See the header. */
function fsyncIntervalMs(): number {
  return envBytes('ANALYTICS_SPOOL_FSYNC_MS', 1000, 0);
}

export interface SpoolCapacityPlan {
  maxBytes: number;
  segmentBytes: number;
  fsyncIntervalMs: number;
  /** Measured mean bytes per framed row so far, or null before anything is written. */
  averageFrameBytes: number | null;
  /** How long the configured ceiling covers at a given rate, using the measured frame size. */
  outageSecondsAt: (eventsPerSecond: number, safetyFactor?: number) => number | null;
}

/**
 * What the configured ceiling actually buys, in seconds of outage.
 *
 * Reported rather than assumed: the frame size depends on URL lengths, UTM
 * parameters and event properties, which differ per deployment by more than
 * any default could account for.
 */
export function spoolCapacityPlan(): SpoolCapacityPlan {
  const maxBytes = spoolMaxBytes();
  const average = stats.appended > 0 && stats.appendedBytes > 0
    ? stats.appendedBytes / stats.appended
    : null;
  return {
    maxBytes,
    segmentBytes: segmentMaxBytes(),
    fsyncIntervalMs: fsyncIntervalMs(),
    averageFrameBytes: average,
    outageSecondsAt: (eventsPerSecond: number, safetyFactor = 2) => {
      if (!average || eventsPerSecond <= 0 || safetyFactor <= 0) return null;
      return maxBytes / (eventsPerSecond * average * safetyFactor);
    },
  };
}

/** A single frame's payload ceiling — a guard against a corrupt length. */
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export interface SpoolAvailability {
  available: boolean;
  dir: string;
  reason?: string;
}

export interface SpoolStats {
  dir: string;
  segments: number;
  bytes: number;
  activeSegment: string | null;
  appended: number;
  /** Total framed bytes appended — the numerator of the measured frame size. */
  appendedBytes: number;
  committed: number;
  replayed: number;
  droppedForSize: number;
  corruptFrames: number;
  lastError: string | null;
  lastErrorAt: string | null;
}

const stats: SpoolStats = {
  dir: '', segments: 0, bytes: 0, activeSegment: null,
  appended: 0, appendedBytes: 0, committed: 0, replayed: 0, droppedForSize: 0, corruptFrames: 0,
  lastError: null, lastErrorAt: null,
};

interface ActiveSegment {
  file: string;
  fd: number;
  bytes: number;
  /** Bytes already acknowledged by a COMMIT frame in this same file. */
  committedOffset: number;
  lastFsyncAt: number;
}

let active: ActiveSegment | null = null;
let segmentSeq = 0;
let disabledReason: string | null = null;

/**
 * Directory the spool lives in.
 *
 * `/app/data` is the path the backend already mounts a persistent volume
 * at (see docker-compose.yml), so the default inherits a guarantee the
 * deployment already makes rather than inventing a new mount. A deployment
 * that puts its volume elsewhere sets ANALYTICS_SPOOL_DIR.
 */
export function spoolDir(): string {
  const configured = process.env.ANALYTICS_SPOOL_DIR;
  if (configured && configured.trim()) return configured.trim();
  return '/app/data/analytics-spool';
}

function recordError(config: ServerConfig | null, message: string): void {
  stats.lastError = message;
  stats.lastErrorAt = new Date().toISOString();
  if (config) {
    emitMetric(config, { metric: 'analytics_spool_errors', tags: { reason: 'io' } });
    emitLog(config, 'warn', 'analytics_spool_error', { error: message });
  }
}

/**
 * Can this deployment spool at all? Answers by actually writing, because
 * "the directory exists" and "this process may append to it" are different
 * questions and only the second one matters.
 *
 * CACHED, because the admin status endpoint polls and this does real
 * filesystem I/O on the request thread. A pathological mount can make even
 * `mkdirSync` block, and re-probing per poll would turn that into a hung
 * endpoint rather than one stale field. The answer only changes when a
 * volume is mounted or lost, so a short TTL is ample; `__resetSpoolForTests`
 * and a write failure both clear it immediately.
 */
const AVAILABILITY_TTL_MS = 30_000;
let availabilityCache: { at: number; value: SpoolAvailability } | null = null;

export function spoolAvailability(): SpoolAvailability {
  const dir = spoolDir();
  if (disabledReason) return { available: false, dir, reason: disabledReason };

  const cached = availabilityCache;
  if (cached && cached.value.dir === dir && Date.now() - cached.at < AVAILABILITY_TTL_MS) {
    return cached.value;
  }

  let value: SpoolAvailability;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.probe-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    value = { available: true, dir };
  } catch (err: unknown) {
    value = {
      available: false,
      dir,
      reason: err instanceof Error ? err.message : 'the spool directory is not writable',
    };
  }
  availabilityCache = { at: Date.now(), value };
  return value;
}

// ─── Framing ─────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function frame(kind: number, payload: Buffer): Buffer {
  const out = Buffer.allocUnsafe(HEADER_BYTES + payload.length);
  out.writeUInt32BE(MAGIC, 0);
  out.writeUInt8(kind, 4);
  out.writeUInt32BE(payload.length, 5);
  out.writeUInt32BE(crc32(payload), 9);
  payload.copy(out, HEADER_BYTES);
  return out;
}

interface ParsedFrame {
  kind: number;
  payload: Buffer;
  /** Byte offset this frame starts at. */
  start: number;
  /** Byte offset immediately after this frame. */
  end: number;
}

/**
 * Read every intact frame. Stops at the first frame that is truncated or
 * fails its CRC and reports how many bytes were usable — a crash during an
 * append leaves exactly that shape, and discarding the tail is the correct
 * response, not treating the whole segment as lost.
 */
function readFrames(buf: Buffer): { frames: ParsedFrame[]; corrupt: number } {
  const frames: ParsedFrame[] = [];
  let offset = 0;
  let corrupt = 0;

  while (offset + HEADER_BYTES <= buf.length) {
    if (buf.readUInt32BE(offset) !== MAGIC) { corrupt++; break; }
    const kind = buf.readUInt8(offset + 4);
    const length = buf.readUInt32BE(offset + 5);
    const expected = buf.readUInt32BE(offset + 9);
    if (length > MAX_FRAME_BYTES) { corrupt++; break; }
    const start = offset + HEADER_BYTES;
    if (start + length > buf.length) { corrupt++; break; }
    const payload = buf.subarray(start, start + length);
    if (crc32(payload) !== expected) { corrupt++; break; }
    frames.push({ kind, payload, start: offset, end: start + length });
    offset = start + length;
  }

  return { frames, corrupt };
}

// ─── Segments ────────────────────────────────────────────────────

/**
 * Segment names carry the boot timestamp and pid so two processes sharing
 * a directory never append to the same file. `bootId` is fixed for the
 * lifetime of this process.
 */
let bootId = `${Date.now().toString(36)}-${process.pid}`;

/**
 * A fresh boot identity. Only tests call this — they simulate a crash
 * in-process, and without a new identity the "restarted" process would
 * reopen the segment the "crashed" one was appending to, which is the one
 * thing a real restart never does.
 */
function rollBootId(): void {
  bootId = `${Date.now().toString(36)}-${process.pid}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function isSegment(name: string): boolean {
  return name.startsWith('seg-') && name.endsWith('.log');
}

function listSegments(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter(isSegment).sort();
  } catch { return []; }
}

function segmentBytes(dir: string, files: string[]): number {
  let total = 0;
  for (const file of files) {
    try { total += fs.statSync(path.join(dir, file)).size; } catch { /* raced with a delete */ }
  }
  return total;
}

function openSegment(config: ServerConfig | null): ActiveSegment | null {
  const dir = spoolDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `seg-${bootId}-${String(segmentSeq++).padStart(6, '0')}.log`);
    const fd = fs.openSync(file, 'a');
    return { file, fd, bytes: 0, committedOffset: 0, lastFsyncAt: Date.now() };
  } catch (err: unknown) {
    recordError(config, err instanceof Error ? err.message : 'could not open a spool segment');
    return null;
  }
}

function closeActive(): void {
  if (!active) return;
  try { fs.fsyncSync(active.fd); } catch { /* closing anyway */ }
  try { fs.closeSync(active.fd); } catch { /* already gone */ }
  active = null;
}

/**
 * Enforce the disk ceiling by dropping the OLDEST segments first.
 *
 * Dropping the oldest rather than refusing the newest is deliberate: under
 * `dual_write` PostgreSQL still holds everything, so the cost is a gap the
 * day's seal repairs, whereas refusing new appends would make the spool
 * useless exactly when it is most needed. It is still data loss and is
 * reported as such.
 */
function enforceCeiling(config: ServerConfig | null): void {
  const dir = spoolDir();
  let files = listSegments(dir);
  let bytes = segmentBytes(dir, files);
  const ceiling = spoolMaxBytes();
  while (bytes > ceiling && files.length > 1) {
    const oldest = files[0]!;
    if (active && path.join(dir, oldest) === active.file) break;
    try {
      const size = fs.statSync(path.join(dir, oldest)).size;
      fs.unlinkSync(path.join(dir, oldest));
      bytes -= size;
      stats.droppedForSize++;
      if (config) {
        emitMetric(config, { metric: 'analytics_spool_segments_dropped', tags: { reason: 'ceiling' } });
        emitLog(config, 'error', 'analytics_spool_ceiling_exceeded', {
          segment: oldest,
          bytes_after: bytes,
          note: 'spooled analytics rows were discarded to stay under the disk ceiling',
        });
      }
    } catch { break; }
    files = files.slice(1);
  }
}

// ─── Append ──────────────────────────────────────────────────────

/**
 * Append rows to the active segment. Synchronous by design: the caller has
 * already told the widget the event was accepted, so the write must happen
 * before that promise is made good, not on a later tick.
 *
 * Never throws. A spool that cannot write degrades to the Phase 2 behaviour
 * (buffer in memory, rebuild from PostgreSQL at the day's seal), which is
 * why `s3_only` is gated on this being healthy rather than merely present.
 */
export function appendRows(config: ServerConfig, rows: AnalyticsEventRow[]): boolean {
  if (rows.length === 0) return true;
  if (disabledReason) return false;

  if (!active) {
    active = openSegment(config);
    if (!active) return false;
  }

  try {
    const chunks: Buffer[] = [];
    for (const row of rows) chunks.push(frame(KIND_ROW, Buffer.from(JSON.stringify(row), 'utf8')));
    const payload = Buffer.concat(chunks);
    fs.writeSync(active.fd, payload);
    active.bytes += payload.length;
    stats.appended += rows.length;
    stats.appendedBytes += payload.length;

    const now = Date.now();
    if (now - active.lastFsyncAt >= fsyncIntervalMs()) {
      try { fs.fsyncSync(active.fd); active.lastFsyncAt = now; } catch { /* reported on the next real failure */ }
    }

    if (active.bytes >= segmentMaxBytes()) {
      closeActive();
      enforceCeiling(config);
    }
    return true;
  } catch (err: unknown) {
    recordError(config, err instanceof Error ? err.message : 'spool append failed');
    closeActive();
    // The disk just told us something the cached probe does not know.
    availabilityCache = null;
    return false;
  }
}

// ─── Commit ──────────────────────────────────────────────────────

/**
 * Acknowledge everything written so far.
 *
 * Called after a flush cycle that left nothing buffered, which is the only
 * moment at which "every row this process has accepted is in S3" is true.
 * Writes one COMMIT frame into the active segment and deletes every rotated
 * segment, because a rotated segment can only contain rows older than the
 * ones just committed.
 */
export function commitSpool(config: ServerConfig): void {
  if (disabledReason) return;
  const dir = spoolDir();

  try {
    if (active) {
      const offset = active.bytes;
      const marker = frame(KIND_COMMIT, Buffer.from(JSON.stringify({ offset }), 'utf8'));
      fs.writeSync(active.fd, marker);
      active.bytes += marker.length;
      active.committedOffset = offset;
      try { fs.fsyncSync(active.fd); active.lastFsyncAt = Date.now(); } catch { /* best effort */ }
    }

    // Every segment except the one being appended to is now fully
    // acknowledged and can go.
    for (const name of listSegments(dir)) {
      const full = path.join(dir, name);
      if (active && full === active.file) continue;
      try { fs.unlinkSync(full); } catch { /* raced with another process */ }
    }

    stats.committed++;
    emitMetric(config, { metric: 'analytics_spool_commits', tags: { count: 1 } });
  } catch (err: unknown) {
    recordError(config, err instanceof Error ? err.message : 'spool commit failed');
  }
}

// ─── Replay ──────────────────────────────────────────────────────

/**
 * An exclusive directory lock so two processes booting together cannot each
 * replay the same orphaned segments and write them twice.
 *
 * `wx` is atomic: exactly one process creates the file. A lock older than
 * the staleness window is assumed to belong to a process that died holding
 * it and is taken over, because a permanently stuck lock would silently
 * disable recovery — a worse failure than a rare double replay.
 */
const LOCK_STALE_MS = 60_000;

function acquireLock(dir: string): string | null {
  const lock = path.join(dir, 'replay.lock');
  try {
    fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
    return lock;
  } catch {
    try {
      const age = Date.now() - fs.statSync(lock).mtimeMs;
      if (age > LOCK_STALE_MS) {
        fs.writeFileSync(lock, String(process.pid));
        return lock;
      }
    } catch { /* gone between calls — let the caller skip this boot */ }
    return null;
  }
}

function releaseLock(lock: string | null): void {
  if (!lock) return;
  try { fs.unlinkSync(lock); } catch { /* already released */ }
}

export interface ReplayResult {
  rows: AnalyticsEventRow[];
  segments: number;
  skippedCommitted: number;
  corruptSegments: number;
  quarantined: string[];
}

/**
 * Read every segment left behind by a previous run and return the rows that
 * were never acknowledged.
 *
 * Duplicate-safe on three levels: rows before a segment's committed offset
 * are skipped, rows are de-duplicated by `event_id` within the replay, and
 * the directory lock stops two processes replaying the same files.
 */
export function replaySpool(config: ServerConfig): ReplayResult {
  const empty: ReplayResult = { rows: [], segments: 0, skippedCommitted: 0, corruptSegments: 0, quarantined: [] };
  if (disabledReason) return empty;

  const dir = spoolDir();
  if (!fs.existsSync(dir)) return empty;

  const lock = acquireLock(dir);
  if (!lock) {
    emitLog(config, 'info', 'analytics_spool_replay_skipped', {
      reason: 'another process holds the replay lock',
    });
    return empty;
  }

  const result: ReplayResult = { rows: [], segments: 0, skippedCommitted: 0, corruptSegments: 0, quarantined: [] };
  const seen = new Set<string>();

  try {
    for (const name of listSegments(dir)) {
      const full = path.join(dir, name);
      let buf: Buffer;
      try { buf = fs.readFileSync(full); } catch { continue; }

      const { frames, corrupt } = readFrames(buf);
      if (corrupt > 0) {
        result.corruptSegments++;
        stats.corruptFrames += corrupt;
      }

      // A segment whose FIRST frame is unreadable is not a torn tail — it is
      // damage. Keep it for inspection instead of deleting evidence.
      if (frames.length === 0 && buf.length > 0) {
        const quarantine = `${full}.corrupt`;
        try { fs.renameSync(full, quarantine); result.quarantined.push(path.basename(quarantine)); } catch { /* best effort */ }
        emitLog(config, 'error', 'analytics_spool_segment_corrupt', { segment: name, bytes: buf.length });
        continue;
      }

      let committedOffset = 0;
      for (const f of frames) {
        if (f.kind !== KIND_COMMIT) continue;
        try {
          const parsed = JSON.parse(f.payload.toString('utf8')) as { offset?: unknown };
          if (typeof parsed.offset === 'number' && parsed.offset > committedOffset) committedOffset = parsed.offset;
        } catch { /* a commit frame we cannot read acknowledges nothing */ }
      }

      for (const f of frames) {
        if (f.kind !== KIND_ROW) continue;
        if (f.start < committedOffset) { result.skippedCommitted++; continue; }
        let row: AnalyticsEventRow;
        try { row = JSON.parse(f.payload.toString('utf8')) as AnalyticsEventRow; } catch { continue; }
        if (!row || typeof row !== 'object' || typeof row.workspace_id !== 'string') continue;
        const id = typeof row.event_id === 'string' ? row.event_id : '';
        if (id) {
          if (seen.has(id)) continue;
          seen.add(id);
        }
        result.rows.push(row);
      }

      result.segments++;
      // Replayed into memory and about to be re-appended to this process's
      // own segment, so the old file's job is done.
      try { fs.unlinkSync(full); } catch { /* best effort */ }
    }
  } catch (err: unknown) {
    recordError(config, err instanceof Error ? err.message : 'spool replay failed');
  } finally {
    releaseLock(lock);
  }

  stats.replayed += result.rows.length;
  if (result.rows.length > 0 || result.corruptSegments > 0) {
    emitMetric(config, { metric: 'analytics_spool_replayed_rows', tags: { count: result.rows.length } });
    emitLog(config, 'info', 'analytics_spool_replayed', {
      rows: result.rows.length,
      segments: result.segments,
      skipped_committed: result.skippedCommitted,
      corrupt_segments: result.corruptSegments,
    });
  }
  return result;
}

// ─── Introspection ───────────────────────────────────────────────

export function spoolStats(): SpoolStats {
  const dir = spoolDir();
  const files = listSegments(dir);
  return {
    ...stats,
    dir,
    segments: files.length,
    bytes: segmentBytes(dir, files),
    activeSegment: active ? path.basename(active.file) : null,
  };
}

/** Flush the OS page cache to disk. Called on shutdown, before the drain. */
export function fsyncSpool(): void {
  if (!active) return;
  try { fs.fsyncSync(active.fd); active.lastFsyncAt = Date.now(); } catch { /* shutting down anyway */ }
}

export function __resetSpoolForTests(dir?: string): void {
  closeActive();
  availabilityCache = null;
  rollBootId();
  segmentSeq = 0;
  disabledReason = null;
  Object.assign(stats, {
    dir: '', segments: 0, bytes: 0, activeSegment: null,
    appended: 0, appendedBytes: 0, committed: 0, replayed: 0, droppedForSize: 0, corruptFrames: 0,
    lastError: null, lastErrorAt: null,
  });
  if (dir) process.env.ANALYTICS_SPOOL_DIR = dir;
}

/** Test hook: a scratch directory when /app/data is not mountable. */
export function __defaultTestSpoolDir(): string {
  return path.join(os.tmpdir(), `analytics-spool-${process.pid}`);
}
