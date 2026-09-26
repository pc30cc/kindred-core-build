/**
 * The rollup ticker wakes every 10 minutes, but each SQL function only rolls
 * up the previous full hour. It now runs a function when a new bucket is due
 * (the business rollup also refreshes twice an hour for its "now" counts),
 * instead of recomputing the same bucket six times an hour on every replica.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ServerConfig } from '../../config.js';

const calls: string[] = [];
let failing = new Set<string>();
/** The previous full hour, in UTC — what a UTC database session reports. */
function utcPreviousHour(now: Date): string {
  const b = new Date(now);
  b.setUTCMinutes(0, 0, 0);
  return new Date(b.getTime() - 3_600_000).toISOString();
}
let reportBucket: (now: Date) => unknown = utcPreviousHour;

vi.mock('../../supabase.js', () => ({
  getServiceClient: () => ({
    rpc: async (fn: string) => {
      calls.push(fn);
      if (failing.has(fn)) return { data: null, error: { message: 'boom' } };
      return { data: { bucket: reportBucket(new Date()) }, error: null };
    },
  }),
}));
vi.mock('./metrics.js', () => ({ emitLog: () => undefined }));

const SLA = 'sla_reliability_rollup_and_prune';
const BIZ = 'business_metrics_rollup_and_prune';
const cfg = {} as ServerConfig;

async function tickAt(iso: string) {
  vi.setSystemTime(new Date(iso));
  const { runOnce } = await import('./reliabilityRollupTicker.js');
  await runOnce(cfg);
}

function count(fn: string) {
  return calls.filter((c) => c === fn).length;
}

beforeEach(async () => {
  vi.useFakeTimers();
  calls.length = 0;
  failing = new Set();
  reportBucket = utcPreviousHour;
  const { __stopReliabilityRollupForTests } = await import('./reliabilityRollupTicker.js');
  __stopReliabilityRollupForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('reliability rollup ticker', () => {
  it('rolls each bucket up once, and the business rollup refreshes twice an hour', async () => {
    for (const t of ['10:01', '10:11', '10:21', '10:31', '10:41', '10:51']) await tickAt(`2026-09-26T${t}:00Z`);
    expect(count(SLA)).toBe(1);
    expect(count(BIZ)).toBe(2); // 10:01 (new bucket) and 10:31 (refresh)

    await tickAt('2026-09-26T11:01:00Z'); // the 10:00 bucket is now complete
    expect(count(SLA)).toBe(2);
    expect(count(BIZ)).toBe(3);
  });

  it('a failed run is retried on the next tick', async () => {
    failing.add(SLA);
    await tickAt('2026-09-26T10:01:00Z');
    failing.clear();
    await tickAt('2026-09-26T10:11:00Z');
    expect(count(SLA)).toBe(2);
    await tickAt('2026-09-26T10:21:00Z');
    expect(count(SLA)).toBe(2);
  });

  it('follows the bucket the database reports, whatever its hour boundary', async () => {
    // A +03:30 session time zone puts the database's hours at :30 UTC.
    reportBucket = (now) => {
      const localHourStart = new Date(now.getTime() - 30 * 60_000);
      localHourStart.setUTCMinutes(0, 0, 0);
      return new Date(localHourStart.getTime() + 30 * 60_000 - 3_600_000).toISOString();
    };
    await tickAt('2026-09-26T10:01:00Z'); // rolls [08:30, 09:30)
    await tickAt('2026-09-26T10:21:00Z');
    expect(count(SLA)).toBe(1);
    await tickAt('2026-09-26T10:31:00Z'); // [09:30, 10:30) just completed
    expect(count(SLA)).toBe(2);
  });

  it('without a readable bucket it stays due every tick, as before', async () => {
    reportBucket = () => undefined;
    await tickAt('2026-09-26T10:01:00Z');
    await tickAt('2026-09-26T10:11:00Z');
    expect(count(SLA)).toBe(2);
    expect(count(BIZ)).toBe(2);
  });
});
