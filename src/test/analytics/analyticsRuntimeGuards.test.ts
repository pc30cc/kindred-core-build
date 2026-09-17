/**
 * RUNTIME GUARDS — the two capabilities analytics cannot fake, and the one
 * directory it cannot do without.
 *
 * These used to be checks on a Cutover Readiness card. The card is gone:
 * analytics keeps no history of itself, so there is nothing to build a
 * checklist out of and nowhere to store one. The underlying signals did not
 * go anywhere, though, and each is still the difference between working and
 * silently not working:
 *
 *   - ZSTD from `node:zlib` (Node 22.15+) is what compresses every Parquet
 *     file. Without it there is no write path at all.
 *   - The embedded DuckDB engine is what answers every S3 report. Without it
 *     there is no read path at all.
 *   - The spool directory is what makes ingestion survive a crash. Without a
 *     writable one, events live only in memory.
 *
 * The contract pinned here is that each of the three REPORTS its absence
 * rather than throwing. A missing capability has to surface as a value the
 * caller can act on, because the alternative — an exception at import time or
 * mid-request — takes the whole server down instead of one feature.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resetFakeAnalyticsPool } from './fakeAnalyticsPool';

vi.mock('../../../server/supabase.js', async () => {
  const { makeFakeSupabaseClient } = await import('./fakeAnalyticsPool');
  const client = makeFakeSupabaseClient();
  return { getServiceClient: () => client };
});

const { parquetRuntimeSupport, writeParquet } = await import('../../../server/services/analytics/parquet.js');
const { duckDbAvailability } = await import('../../../server/services/analytics/duckdb.js');
const { analyticsDurabilityReadiness } = await import('../../../server/services/analytics/writer.js');
const { __resetSpoolForTests } = await import('../../../server/services/analytics/spool.js');

let scratch: string;
let spoolDir: string;

beforeEach(() => {
  resetFakeAnalyticsPool();
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-guards-'));
  spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-guards-spool-'));
  __resetSpoolForTests(spoolDir);
});

afterEach(() => {
  __resetSpoolForTests(spoolDir);
  delete process.env.ANALYTICS_SPOOL_DIR;
  delete process.env.ANALYTICS_SPOOL_ENABLED;
  for (const d of [scratch, spoolDir]) fs.rmSync(d, { recursive: true, force: true });
});

describe('the Parquet runtime', () => {
  it('reports the Node runtime as supported on a runtime with ZSTD', () => {
    const support = parquetRuntimeSupport();
    expect(support.supported).toBe(true);
    expect(support.nodeVersion).toBe(process.version);
  });

  it('does NOT throw at import time — an old runtime must still boot', () => {
    // The module is already imported above. If it threw on load, this file
    // would not run at all; asserting the encoder is callable pins that the
    // check moved to the encode path rather than disappearing.
    expect(typeof writeParquet).toBe('function');
  });
});

describe('the query engine', () => {
  it('reports a MISSING engine as a reason, never as a throw', async () => {
    const engine = await duckDbAvailability();
    if (engine.available === false) expect(engine.reason).toBeTruthy();
    else expect(engine.available).toBe(true);
  });
});

describe('the durability spool', () => {
  it('is ready on a writable directory, and says which one', () => {
    const readiness = analyticsDurabilityReadiness();
    expect(readiness.ready).toBe(true);
    expect(readiness.dir).toBe(spoolDir);
  });

  it('reports — never throws — when the directory cannot be written', () => {
    // A volume that was never mounted, modelled with a file as the parent.
    const blocker = path.join(scratch, 'not-a-dir');
    fs.writeFileSync(blocker, 'x');
    __resetSpoolForTests(path.join(blocker, 'spool'));

    const readiness = analyticsDurabilityReadiness();
    expect(readiness.ready).toBe(false);
    expect(readiness.reason).toBeTruthy();
  });

  it('carries no counters — readiness is a yes/no, not a statistics page', () => {
    // The mandate: no analytics telemetry anywhere. If someone reattaches
    // rows/bytes/flush counts to this struct, that is the metrics store
    // growing back through the one function that still reports status.
    const readiness = analyticsDurabilityReadiness() as Record<string, unknown>;
    expect(Object.keys(readiness).sort()).toEqual(['dir', 'ready', 'reason'].filter((k) => k in readiness).sort());
    for (const banned of ['stats', 'appended', 'bytes', 'rows', 'written', 'queries', 'failures', 'lastWriteAt']) {
      expect(readiness[banned]).toBeUndefined();
    }
  });
});
