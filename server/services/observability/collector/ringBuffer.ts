/**
 * Self-rolling ring-buffer primitives shared by realtimeCollector.ts and
 * perfCollector.ts.
 *
 * Each ring is a fixed-length array of buckets, one per minute or hour
 * slot, indexed by `epoch % size`. A bucket carries its own `epoch` stamp;
 * writing into a bucket whose stamp doesn't match the current epoch means
 * the slot belongs to a previous cycle (e.g. the same minute-of-hour from
 * an hour ago) and is lazily zeroed in place before use. This is what
 * replaces the old SQL rollup+prune job entirely — aging-out happens for
 * free on every write, there is no separate ticker or cron job.
 */
import { BUCKET_EDGES_MS } from './constants.js';

export interface RealtimeBucket {
  epoch: number; // -1 = never written
  total: number;
  byDriver: Record<string, number>;
  bySource: Record<string, number>;
}

export interface PerfBucket {
  epoch: number;
  count: number;
  errorCount: number;
  sumMs: number;
  maxMs: number;
  histogram: Record<string, number>;
  statusGroups: Record<string, number>;
}

export function makeRealtimeBucket(): RealtimeBucket {
  return { epoch: -1, total: 0, byDriver: {}, bySource: {} };
}

export function makePerfBucket(): PerfBucket {
  return { epoch: -1, count: 0, errorCount: 0, sumMs: 0, maxMs: 0, histogram: {}, statusGroups: {} };
}

function slotIndex(epoch: number, size: number): number {
  return ((epoch % size) + size) % size;
}

/** Returns the live bucket for `nowMs`, lazily resetting it if stale. */
export function advanceRealtime(ring: RealtimeBucket[], nowMs: number, slotMs: number): RealtimeBucket {
  const epoch = Math.floor(nowMs / slotMs);
  const bucket = ring[slotIndex(epoch, ring.length)];
  if (bucket.epoch !== epoch) {
    bucket.epoch = epoch;
    bucket.total = 0;
    bucket.byDriver = {};
    bucket.bySource = {};
  }
  return bucket;
}

export function advancePerf(ring: PerfBucket[], nowMs: number, slotMs: number): PerfBucket {
  const epoch = Math.floor(nowMs / slotMs);
  const bucket = ring[slotIndex(epoch, ring.length)];
  if (bucket.epoch !== epoch) {
    bucket.epoch = epoch;
    bucket.count = 0;
    bucket.errorCount = 0;
    bucket.sumMs = 0;
    bucket.maxMs = 0;
    bucket.histogram = {};
    bucket.statusGroups = {};
  }
  return bucket;
}

export interface RealtimeWindowAgg {
  total: number;
  byDriver: Record<string, number>;
  bySource: Record<string, number>;
}

/** Sums the trailing `windowSlots` slots ending at `nowMs`, treating stale/never-written slots as zero. Read-only — never mutates the ring. */
export function sumRealtimeWindow(
  ring: RealtimeBucket[],
  nowMs: number,
  slotMs: number,
  windowSlots: number,
): RealtimeWindowAgg {
  const size = ring.length;
  const nowEpoch = Math.floor(nowMs / slotMs);
  const n = Math.min(windowSlots, size);
  const out: RealtimeWindowAgg = { total: 0, byDriver: {}, bySource: {} };
  for (let i = 0; i < n; i++) {
    const epoch = nowEpoch - i;
    const bucket = ring[slotIndex(epoch, size)];
    if (bucket.epoch !== epoch) continue;
    out.total += bucket.total;
    for (const [k, v] of Object.entries(bucket.byDriver)) out.byDriver[k] = (out.byDriver[k] || 0) + v;
    for (const [k, v] of Object.entries(bucket.bySource)) out.bySource[k] = (out.bySource[k] || 0) + v;
  }
  return out;
}

export interface PerfWindowAgg {
  count: number;
  errorCount: number;
  sumMs: number;
  maxMs: number;
  histogram: Record<string, number>;
  statusGroups: Record<string, number>;
}

export function sumPerfWindow(
  ring: PerfBucket[],
  nowMs: number,
  slotMs: number,
  windowSlots: number,
): PerfWindowAgg {
  const size = ring.length;
  const nowEpoch = Math.floor(nowMs / slotMs);
  const n = Math.min(windowSlots, size);
  const out: PerfWindowAgg = { count: 0, errorCount: 0, sumMs: 0, maxMs: 0, histogram: {}, statusGroups: {} };
  for (let i = 0; i < n; i++) {
    const epoch = nowEpoch - i;
    const bucket = ring[slotIndex(epoch, size)];
    if (bucket.epoch !== epoch) continue;
    out.count += bucket.count;
    out.errorCount += bucket.errorCount;
    out.sumMs += bucket.sumMs;
    if (bucket.maxMs > out.maxMs) out.maxMs = bucket.maxMs;
    for (const [k, v] of Object.entries(bucket.histogram)) out.histogram[k] = (out.histogram[k] || 0) + v;
    for (const [k, v] of Object.entries(bucket.statusGroups)) out.statusGroups[k] = (out.statusGroups[k] || 0) + v;
  }
  return out;
}

/** Moved verbatim from the pre-migration server/routes/adminPerf.ts. */
export function percentileFromHistogram(hist: Record<string, number>, total: number, p: number): number {
  if (total <= 0) return 0;
  const target = (p / 100) * total;
  let cum = 0;
  let prevUpper = 0;
  for (const { key, upper } of BUCKET_EDGES_MS) {
    const c = Number(hist[key] || 0);
    if (cum + c >= target) {
      const need = target - cum;
      const frac = c > 0 ? need / c : 0;
      return Math.round(prevUpper + (upper - prevUpper) * frac);
    }
    cum += c;
    prevUpper = upper;
  }
  return prevUpper;
}

export function bucketKeyForDuration(ms: number): string {
  for (const { key, upper } of BUCKET_EDGES_MS) {
    if (ms <= upper) return key;
  }
  return 'inf';
}
