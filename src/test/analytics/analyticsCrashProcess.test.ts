/**
 * CROSS-PROCESS CRASH TESTS — a real process, really killed.
 *
 * Every other durability test in this suite simulates a crash by dropping
 * in-process state. That proves the frame format, the commit watermark and
 * the replay logic, and it cannot prove the claim the whole design rests on:
 *
 *   bytes handed to fs.writeSync before a SIGKILL are still on disk
 *   afterwards, because the page cache belongs to the kernel, not to the
 *   process that died.
 *
 * So these spawn `scripts/analytics-spool-child.mjs` as a genuine OS process,
 * wait for it to report its rows are written, kill it for real, and then do
 * the recovery in this process: replay the spool, flush to the analytics
 * primary, and query the resulting Parquet with DuckDB.
 *
 * The assertion that matters is EXACTLY ONCE — not "at least once". A design
 * that replayed too eagerly would double-count page views, which is a subtler
 * and more damaging failure than losing them.
 *
 * Not covered here, and why: a true OOM kill and a container restart. Both
 * deliver SIGKILL to the process from outside, which is exactly what
 * `kill -9` does here — the kernel does not distinguish the page cache's fate
 * by who sent the signal. What a container restart adds beyond SIGKILL is the
 * VOLUME question (does /app/data come back?), which is a deployment property
 * no in-container test can settle and which is reported instead by the
 * multi-instance readiness check.
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  resetFakeAnalyticsPool, seedGeneralPool, seedAnalyticsPool, seedTable,
} from './fakeAnalyticsPool';

vi.mock('../../../server/supabase.js', async () => {
  const { makeFakeSupabaseClient } = await import('./fakeAnalyticsPool');
  const client = makeFakeSupabaseClient();
  return { getServiceClient: () => client };
});
vi.mock('../../../server/services/observability/metrics.js', () => ({
  emitMetric: () => undefined,
  emitLog: () => undefined,
}));

const { flushAnalytics, replaySpooledRows, bufferedRowCount, __resetAnalyticsBuffer } =
  await import('../../../server/services/analytics/writer.js');
const { __resetSpoolForTests } = await import('../../../server/services/analytics/spool.js');
const { S3ParquetWebAnalyticsStore } = await import('../../../server/services/webAnalytics/store/s3.js');
const { duckDbAvailability } = await import('../../../server/services/analytics/duckdb.js');
const { __clearAnalyticsObjectCache } = await import('../../../server/services/analytics/objectCache.js');

const serverConfig = {} as never;
const WS = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const RANGE = { startDate: '2026-08-10', endDate: '2026-08-10' };
const CHILD = path.resolve(process.cwd(), 'scripts/analytics-spool-child.mjs');

let primaryDir: string;
let spoolPath: string;
let cacheDir: string;
let engine = false;
const children: ChildProcess[] = [];

beforeAll(async () => { engine = (await duckDbAvailability()).available; });

/**
 * Spawn the child and resolve once it reports its rows are on disk. Run
 * through tsx so it can import the real TypeScript spool module.
 */
function spawnChild(rows: number, mode: 'wait' | 'sigterm' | 'commit'): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', CHILD, spoolPath, String(rows), mode],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } },
    );
    children.push(child);

    let out = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error(`child never became ready: ${out}`)); }
    }, 60_000);

    child.stdout!.on('data', (chunk) => {
      out += String(chunk);
      if (!settled && out.includes('READY')) {
        settled = true;
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr!.on('data', (chunk) => { out += String(chunk); });
    child.on('exit', (code) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`child exited ${code}: ${out}`)); }
    });
  });
}

function died(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
}

function segments(): string[] {
  if (!fs.existsSync(spoolPath)) return [];
  return fs.readdirSync(spoolPath).filter((f) => f.startsWith('seg-') && f.endsWith('.log'));
}

function parquetObjects(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.parquet')) out.push(full);
    }
  };
  walk(primaryDir);
  return out;
}

/** The recovery a restarted backend performs: replay, then flush. */
async function recover(): Promise<{ replayed: number; flushed: number }> {
  const replayed = replaySpooledRows(serverConfig);
  const result = await flushAnalytics(serverConfig, { force: true });
  return { replayed: replayed.rows, flushed: result.rows };
}

beforeEach(() => {
  resetFakeAnalyticsPool();
  __resetAnalyticsBuffer();
  primaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-primary-'));
  spoolPath = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-spool-'));
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-cache-'));
  process.env.ANALYTICS_QUERY_CACHE_DIR = cacheDir;
  process.env.ANALYTICS_SPOOL_ENABLED = '1';
  __resetSpoolForTests(spoolPath);
  __clearAnalyticsObjectCache();

  seedGeneralPool({
    primary: 'bunny_storage',
    providers: {
      bunny_storage: { config: { username: 'z', password: 'p', hostname: 'storage.bunnycdn.com', cdn_url: 'https://g.b-cdn.net' } },
      local: { config: { local_path: primaryDir, public_url: 'http://localhost:9999/files' } },
    },
  });
  seedAnalyticsPool({
    enabled: true, primary: 'local', replicas: [], replicationEnabled: false,
    prefix: 'analytics/web/', knownPrefixes: ['analytics/web/'],
    batchRows: 10_000, batchBytes: 33_554_432, flushIntervalMs: 15_000,
    format: 'parquet', compression: 'zstd', writeMode: 'dual_write', readMode: 'postgres',
    replicaState: {},
  });
  seedTable('analytics_day_seals', []);
  seedTable('workspace_deletion_jobs', []);
});

afterEach(() => {
  for (const child of children.splice(0)) {
    try { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); } catch { /* gone */ }
  }
  __resetAnalyticsBuffer();
  __resetSpoolForTests(spoolPath);
  delete process.env.ANALYTICS_QUERY_CACHE_DIR;
  delete process.env.ANALYTICS_SPOOL_ENABLED;
  delete process.env.ANALYTICS_SPOOL_DIR;
  for (const d of [primaryDir, spoolPath, cacheDir]) fs.rmSync(d, { recursive: true, force: true });
});

describe('SIGKILL — the process is destroyed without warning', () => {
  it('leaves every accepted row on disk, and recovery writes it exactly once', async () => {
    const ROWS = 40;
    const child = await spawnChild(ROWS, 'wait');

    // The rows exist on disk while the process that wrote them is still alive.
    expect(segments().length).toBeGreaterThan(0);

    child.kill('SIGKILL');
    const exit = await died(child);
    // Proof it really was killed, not a graceful exit that ran cleanup.
    expect(exit.signal).toBe('SIGKILL');

    // Nothing was flushed before the kill.
    expect(parquetObjects()).toHaveLength(0);

    const { replayed, flushed } = await recover();
    expect(replayed).toBe(ROWS);
    expect(flushed).toBe(ROWS);
    expect(parquetObjects().length).toBeGreaterThan(0);
  }, 180_000);

  it('the recovered rows are queryable, and each event appears ONCE', async () => {
    if (!engine) return;
    const ROWS = 40;
    const child = await spawnChild(ROWS, 'wait');
    child.kill('SIGKILL');
    await died(child);

    await recover();

    const store = new S3ParquetWebAnalyticsStore(serverConfig);
    const overview = await store.getOverview(WS, RANGE);
    // Exactly once: a replay that double-wrote would show 80 here.
    expect(overview.pageviews).toBe(ROWS);
    expect(overview.uniqueVisitors).toBe(3);
  }, 180_000);

  it('a SECOND crash before the flush still loses nothing', async () => {
    const ROWS = 20;
    const first = await spawnChild(ROWS, 'wait');
    first.kill('SIGKILL');
    await died(first);

    // Restarted, replayed... and killed again before it could flush.
    const replayed = replaySpooledRows(serverConfig);
    expect(replayed.rows).toBe(ROWS);
    __resetAnalyticsBuffer();
    __resetSpoolForTests(spoolPath);

    const { flushed } = await recover();
    expect(flushed).toBe(ROWS);
  }, 180_000);

  it('replays NOTHING when the rows were already acknowledged', async () => {
    // `commit` models a flush that reached S3 before the crash.
    const child = await spawnChild(25, 'commit');
    child.kill('SIGKILL');
    await died(child);

    const { replayed, flushed } = await recover();
    expect(replayed).toBe(0);
    expect(flushed).toBe(0);
    expect(parquetObjects()).toHaveLength(0);
  }, 180_000);
});

describe('SIGTERM — a deploy', () => {
  it('drains and fsyncs, and the rows still replay', async () => {
    const ROWS = 30;
    const child = await spawnChild(ROWS, 'sigterm');

    child.kill('SIGTERM');
    const exit = await died(child);
    // Exited on its own after draining, rather than being killed.
    expect(exit.code).toBe(0);

    const { replayed, flushed } = await recover();
    expect(replayed).toBe(ROWS);
    expect(flushed).toBe(ROWS);
  }, 180_000);
});

describe('storage outage across a crash', () => {
  it('survives an outage that outlasts the process', async () => {
    const ROWS = 30;
    const child = await spawnChild(ROWS, 'wait');
    child.kill('SIGKILL');
    await died(child);

    // The primary has no credentials — recovery flushes fail.
    seedGeneralPool({
      primary: 'bunny_storage',
      providers: {
        bunny_storage: { config: { username: 'z', password: 'p', hostname: 'storage.bunnycdn.com', cdn_url: 'https://g.b-cdn.net' } },
        local: { config: {} },
      },
    });
    const duringOutage = await recover();
    expect(duringOutage.replayed).toBe(ROWS);
    expect(duringOutage.flushed).toBe(0);

    // Crash AGAIN, mid-outage, with the rows still unflushed.
    __resetAnalyticsBuffer();
    __resetSpoolForTests(spoolPath);

    // Storage comes back.
    seedGeneralPool({
      primary: 'bunny_storage',
      providers: {
        bunny_storage: { config: { username: 'z', password: 'p', hostname: 'storage.bunnycdn.com', cdn_url: 'https://g.b-cdn.net' } },
        local: { config: { local_path: primaryDir, public_url: 'http://localhost:9999/files' } },
      },
    });
    const afterRecovery = await recover();
    expect(afterRecovery.replayed).toBe(ROWS);
    expect(afterRecovery.flushed).toBe(ROWS);
  }, 180_000);
});

describe('two processes sharing one spool directory', () => {
  it('never append to the same segment, and both replay', async () => {
    const a = await spawnChild(10, 'wait');
    const b = await spawnChild(10, 'wait');

    // Distinct segment files: each process owns its own by name.
    expect(segments().length).toBe(2);

    a.kill('SIGKILL');
    b.kill('SIGKILL');
    await Promise.all([died(a), died(b)]);

    const { replayed } = await recover();
    // Both processes' rows, each exactly once — the ids are deterministic
    // and identical across children, so de-duplication by event_id collapses
    // them to one set rather than 20.
    expect(replayed).toBe(10);
    expect(bufferedRowCount()).toBe(0);
  }, 180_000);
});
