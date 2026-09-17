/**
 * BUFFER DURABILITY — what happens to an accepted event when the process
 * dies before the flush.
 *
 * The claim under test is not "the buffer survives" — it does not, and it
 * is not meant to. The claim is that losing it costs nothing, because
 * PostgreSQL holds every row and a day's SEAL rebuilds that day from it,
 * replacing whatever the speed layer managed to write.
 *
 * So these suites simulate the loss directly — drop the buffer, then seal —
 * and assert the rows are in the lake afterwards.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  resetFakeAnalyticsPool, seedGeneralPool, seedAnalyticsPool, seedTable, tableRows,
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

const { readAnalyticsPool } = await import('../../../server/services/analytics/pool.js');
const {
  flushAnalytics, enqueueAnalyticsRow, bufferedRowCount, __resetAnalyticsBuffer,
  replaySpooledRows, analyticsDurabilityReadiness,
} = await import('../../../server/services/analytics/writer.js');
const { __resetSpoolForTests, spoolStats } =
  await import('../../../server/services/analytics/spool.js');
const { buildEventRow } = await import('../../../server/services/analytics/schema.js');
const { findSealCandidates, sealWorkspaceDay, runSealCycle, unsealDays } =
  await import('../../../server/services/analytics/sealing.js');
const { backfillWorkspaceDay } = await import('../../../server/services/analytics/backfill.js');

const serverConfig = {} as never;
const WS = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const DAY = '2026-09-10';
/** Well after the day ended, so the seal grace period has elapsed. */
const NOW = new Date('2026-09-11T06:00:00.000Z').getTime();

let primaryDir: string;

function localKeys(): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const next = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), next);
      else out.push(next);
    }
  };
  walk(primaryDir, '');
  return out.sort();
}

function usePrimary(localPath: string | null) {
  seedGeneralPool({
    primary: 'bunny_storage',
    providers: {
      bunny_storage: { config: { username: 'z', password: 'p', hostname: 'storage.bunnycdn.com', cdn_url: 'https://g.b-cdn.net' } },
      local: { config: localPath === null ? {} : { local_path: localPath, public_url: 'http://localhost:9999/files' } },
    },
  });
}

/** The durable copy: what PostgreSQL holds for this workspace-day. */
function seedSource(pageViews: number, events: number, sessions: number) {
  seedTable('visitor_sessions', Array.from({ length: sessions }, (_, i) => ({
    id: `s${i}`, workspace_id: WS, visitor_id: `visitor-${i}`,
    started_at: `${DAY}T10:0${i}:00.000Z`, last_seen_at: `${DAY}T11:0${i}:00.000Z`,
    current_page: 'https://shop.test/', referrer: null, browser: 'Chrome', device: 'Desktop',
    os: 'macOS', language: 'fa-IR', country: 'Iran', city: 'Tehran',
    geo_country_code: 'IR', geo_country_name: 'Iran', geo_city: 'Tehran',
    utm_source: null, utm_medium: null, utm_campaign: null, utm_term: null, utm_content: null,
  })));
  seedTable('visitor_page_views', Array.from({ length: pageViews }, (_, i) => ({
    workspace_id: WS, visitor_session_id: `s${i % sessions}`,
    url: `https://shop.test/p${i}`, title: `P${i}`,
    viewed_at: `${DAY}T12:${String(i).padStart(2, '0')}:00.000Z`,
  })));
  seedTable('web_analytics_events', Array.from({ length: events }, (_, i) => ({
    workspace_id: WS, visitor_session_id: `s${i % sessions}`,
    event_name: 'signup', properties: { plan: 'pro' },
    page_url: 'https://shop.test/', created_at: `${DAY}T13:0${i}:00.000Z`,
  })));
  seedTable('analytics_day_seals', []);
  seedTable('workspace_deletion_jobs', []);
}

/** Rows the rebuild produces: session_start + session_end per session, plus views and events. */
function expectedRows(pageViews: number, events: number, sessions: number): number {
  return sessions * 2 + pageViews + events;
}

const PAGE_VIEWS = 5;
const EVENTS = 2;
const SESSIONS = 2;
const EXPECTED = expectedRows(PAGE_VIEWS, EVENTS, SESSIONS);

let spoolPath: string;

beforeEach(() => {
  resetFakeAnalyticsPool();
  __resetAnalyticsBuffer();
  primaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-durability-'));
  // OUTSIDE primaryDir: that directory doubles as the `local` storage
  // provider's root, and localKeys() would otherwise count spool segments
  // as stored analytics objects.
  spoolPath = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-durability-spool-'));
  __resetSpoolForTests(spoolPath);
  process.env.ANALYTICS_SPOOL_ENABLED = '1';
  usePrimary(primaryDir);
  seedAnalyticsPool({
    enabled: true, primary: 'local', replicas: [], replicationEnabled: false,
    prefix: 'analytics/web/', knownPrefixes: ['analytics/web/'],
    batchRows: 10_000, batchBytes: 33_554_432, flushIntervalMs: 15_000,
    format: 'parquet', compression: 'zstd', writeMode: 'dual_write', readMode: 'postgres',
    replicaState: {},
  });
  seedSource(PAGE_VIEWS, EVENTS, SESSIONS);
});

afterEach(() => {
  __resetAnalyticsBuffer();
  __resetSpoolForTests(spoolPath);
  delete process.env.ANALYTICS_SPOOL_ENABLED;
  delete process.env.ANALYTICS_SPOOL_DIR;
  fs.rmSync(primaryDir, { recursive: true, force: true });
  fs.rmSync(spoolPath, { recursive: true, force: true });
});

describe('the failure modes', () => {
  it('SIGTERM / crash / OOM: rows lost from the buffer are restored by the day’s seal', async () => {
    const pool = await readAnalyticsPool(serverConfig);
    for (let i = 0; i < PAGE_VIEWS; i++) {
      enqueueAnalyticsRow(serverConfig, pool, buildEventRow({
        workspaceId: WS, eventType: 'page_view', occurredAt: `${DAY}T12:0${i}:00.000Z`,
        url: `https://shop.test/p${i}`, session: { visitorId: 'visitor-0', sessionId: 's0' },
      }));
    }
    expect(bufferedRowCount()).toBe(PAGE_VIEWS);

    // The process dies. Nothing was flushed; the buffer is simply gone.
    __resetAnalyticsBuffer();
    expect(bufferedRowCount()).toBe(0);
    expect(localKeys()).toHaveLength(0);

    const outcome = await sealWorkspaceDay(serverConfig, WS, DAY);

    expect(outcome.sealed).toBe(true);
    expect(outcome.verified).toBe(true);
    // Every row PostgreSQL held is now in the lake, buffer or no buffer.
    expect(outcome.rows).toBe(EXPECTED);
    expect(localKeys().length).toBeGreaterThan(0);
  });

  it('S3 outage: a failed flush keeps the rows, and the seal covers what is still missing', async () => {
    const pool = await readAnalyticsPool(serverConfig);
    // The primary has no usable location for the duration of the flush.
    usePrimary(null);

    enqueueAnalyticsRow(serverConfig, pool, buildEventRow({
      workspaceId: WS, eventType: 'page_view', occurredAt: `${DAY}T12:00:00.000Z`,
      url: 'https://shop.test/p0', session: { visitorId: 'visitor-0', sessionId: 's0' },
    }));
    const result = await flushAnalytics(serverConfig, { force: true });
    expect(result.objects).toBe(0);

    // Storage comes back; the seal makes the day whole from PostgreSQL.
    usePrimary(primaryDir);
    const outcome = await sealWorkspaceDay(serverConfig, WS, DAY);
    expect(outcome.sealed).toBe(true);
    expect(outcome.rows).toBe(EXPECTED);
  });

  it('accounts for every buffered row on enqueue, so the ceiling can be enforced', async () => {
    const pool = { ...(await readAnalyticsPool(serverConfig)), batchRows: 10_000_000, batchBytes: 10 ** 12 };
    for (let i = 0; i < 1_200; i++) {
      enqueueAnalyticsRow(serverConfig, pool as never, buildEventRow({
        workspaceId: WS, eventType: 'page_view', occurredAt: `${DAY}T12:00:00.000Z`,
        url: 'https://shop.test/p', session: { visitorId: 'visitor-0', sessionId: 's0' },
      }));
    }
    expect(bufferedRowCount()).toBe(1_200);
  });
});

describe('sealing', () => {
  it('replaces the day’s live objects rather than adding to them — duplicates cannot survive', async () => {
    const pool = await readAnalyticsPool(serverConfig);
    enqueueAnalyticsRow(serverConfig, pool, buildEventRow({
      workspaceId: WS, eventType: 'page_view', occurredAt: `${DAY}T12:00:00.000Z`,
      url: 'https://shop.test/p0', session: { visitorId: 'visitor-0', sessionId: 's0' },
    }));
    await flushAnalytics(serverConfig, { force: true });
    expect(localKeys().some((k) => k.includes('/part-'))).toBe(true);

    const outcome = await sealWorkspaceDay(serverConfig, WS, DAY);

    expect(outcome.replaced).toBeGreaterThan(0);
    const sealedKeys = localKeys();
    // The speed layer's objects are gone; the canonical set replaced them.
    expect(sealedKeys.some((k) => k.includes('/part-'))).toBe(false);
    expect(sealedKeys.some((k) => k.includes('/backfill-'))).toBe(true);
    expect(outcome.rows).toBe(EXPECTED);
  });

  it('is idempotent — sealing twice leaves exactly one canonical set', async () => {
    await sealWorkspaceDay(serverConfig, WS, DAY);
    const first = localKeys();
    await sealWorkspaceDay(serverConfig, WS, DAY);
    expect(localKeys()).toEqual(first);
  });

  it('verifies the rebuild against the source, and reports it to the caller', async () => {
    // The verification happens, and its numbers come back in the result —
    // they are simply not written down. A seal row records that the day is
    // canonical; it is not a report on how the rebuild went.
    const outcome = await sealWorkspaceDay(serverConfig, WS, DAY);
    expect(outcome.verified).toBe(true);
    expect(outcome.rows).toBe(EXPECTED);
    expect(outcome.sourceRows).toBe(outcome.rows);
  });

  it('records the seal as ONE fact — this day is canonical — and nothing else', async () => {
    await sealWorkspaceDay(serverConfig, WS, DAY);
    const seal = (tableRows.analytics_day_seals ?? [])[0] as Record<string, unknown>;
    expect(seal.sealed_at).toBeTruthy();
    // No counters and no error history: the only column any code reads back
    // is sealed_at, so the rest stopped being written.
    for (const gone of ['attempts', 'last_error', 'row_count', 'objects_written', 'source_row_count', 'verified']) {
      expect(seal[gone]).toBeUndefined();
    }
  });

  it('leaves a day UNSEALED when the rebuild could not complete, so it is retried', async () => {
    usePrimary(null);
    const outcome = await sealWorkspaceDay(serverConfig, WS, DAY);
    expect(outcome.sealed).toBe(false);
    // A failed rebuild writes nothing at all — not a row with an error in
    // it. What matters is that the day is still offered as work.
    const rows = tableRows.analytics_day_seals ?? [];
    expect(rows.every((r) => (r as Record<string, unknown>).sealed_at == null)).toBe(true);
    expect(await findSealCandidates(serverConfig, { now: NOW })).toEqual([{ workspaceId: WS, day: DAY }]);
  });
});

describe('finding work', () => {
  it('offers a finished day that has never been sealed', async () => {
    expect(await findSealCandidates(serverConfig, { now: NOW })).toEqual([{ workspaceId: WS, day: DAY }]);
  });

  it('does not offer a day that is already sealed', async () => {
    await sealWorkspaceDay(serverConfig, WS, DAY);
    expect(await findSealCandidates(serverConfig, { now: NOW })).toEqual([]);
  });

  it('offers it again once its seal is invalidated', async () => {
    await sealWorkspaceDay(serverConfig, WS, DAY);
    expect(await unsealDays(serverConfig, WS, DAY, DAY)).toBe(1);
    expect(await findSealCandidates(serverConfig, { now: NOW })).toEqual([{ workspaceId: WS, day: DAY }]);
  });

  it('never seals a workspace whose deletion is in flight', async () => {
    seedTable('workspace_deletion_jobs', [{ workspace_id: WS, status: 'storage_cleanup' }]);
    // Sealing mid-purge would write objects back into a prefix the deletion
    // walker has already verified empty.
    expect(await findSealCandidates(serverConfig, { now: NOW })).toEqual([]);
  });

  it('does not seal a day that is still inside its grace period', async () => {
    const tooSoon = new Date(`${DAY}T00:10:00.000Z`).getTime() + 24 * 60 * 60 * 1000;
    expect(await findSealCandidates(serverConfig, { now: tooSoon })).toEqual([]);
  });
});

describe('the seal cycle', () => {
  it('seals every eligible day and reports what it did', async () => {
    const result = await runSealCycle(serverConfig, { now: NOW });
    expect(result.considered).toBe(1);
    expect(result.sealed).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.rows).toBe(EXPECTED);
  });

  it('does nothing at all while analytics storage is disabled', async () => {
    const pool = await readAnalyticsPool(serverConfig);
    seedAnalyticsPool({ ...pool, enabled: false } as never);
    expect(await runSealCycle(serverConfig, { now: NOW })).toEqual({
      considered: 0, sealed: 0, failed: 0, rows: 0, objects: 0,
    });
    expect(localKeys()).toHaveLength(0);
  });
});

describe('erasure reaches the lake', () => {
  it('unsealing rewrites the day from the anonymized source', async () => {
    await sealWorkspaceDay(serverConfig, WS, DAY);
    expect(localKeys().length).toBeGreaterThan(0);

    // A privacy subject is anonymized in PostgreSQL: the visitor id rotates.
    seedTable('visitor_sessions', (tableRows.visitor_sessions ?? []).map((row) => ({
      ...row, visitor_id: 'anon_rotated', referrer: null,
    })));
    await unsealDays(serverConfig, WS, DAY, DAY);

    const result = await runSealCycle(serverConfig, { now: NOW });
    expect(result.sealed).toBe(1);

    // The objects were rewritten, so the old identifiers are gone from the
    // lake — which is the only way an erasure can reach immutable Parquet.
    const contents = localKeys()
      .map((key) => fs.readFileSync(path.join(primaryDir, key)).toString('binary'))
      .join('');
    expect(contents).not.toContain('visitor-0');
    expect(contents).toContain('anon_rotated');
  });
});

describe('backfill still behaves as a historical import', () => {
  it('replaces only its OWN objects, never a live one, when not sealing', async () => {
    const pool = await readAnalyticsPool(serverConfig);
    enqueueAnalyticsRow(serverConfig, pool, buildEventRow({
      workspaceId: WS, eventType: 'page_view', occurredAt: `${DAY}T12:00:00.000Z`,
      url: 'https://shop.test/p0', session: { visitorId: 'visitor-0', sessionId: 's0' },
    }));
    await flushAnalytics(serverConfig, { force: true });

    const result = await backfillWorkspaceDay(serverConfig, WS, DAY);

    expect(result.ok).toBe(true);
    // The live object survives a plain backfill — only sealing supersedes it.
    expect(localKeys().some((k) => k.includes('/part-'))).toBe(true);
    expect(localKeys().some((k) => k.includes('/backfill-'))).toBe(true);
  });

  it('verifies the row count against PostgreSQL and reports the source breakdown', async () => {
    const result = await backfillWorkspaceDay(serverConfig, WS, DAY);
    expect(result.report?.verified).toBe(true);
    expect(result.report?.source).toEqual({ sessions: SESSIONS, pageViews: PAGE_VIEWS, events: EVENTS });
    expect(result.report?.rows).toBe(EXPECTED);
  });

  it('refuses a malformed day rather than guessing a range', async () => {
    expect((await backfillWorkspaceDay(serverConfig, WS, 'yesterday')).ok).toBe(false);
  });
});


/**
 * THE S3-ONLY PATH. Everything above proves a lost buffer costs nothing
 * *because PostgreSQL still has the rows*. These prove the case where it
 * does not — the spool is the only copy, and it has to be enough.
 *
 * "Crash" here means: buffer dropped, spool handles closed, process
 * identity re-rolled. The directory is left exactly as a SIGKILL would
 * leave it.
 */
describe('durable ingestion for s3_only', () => {
  function enqueue(pool: never, n: number, offset = 0) {
    for (let i = 0; i < n; i++) {
      enqueueAnalyticsRow(serverConfig, pool, buildEventRow({
        workspaceId: WS, eventType: 'page_view',
        occurredAt: `${DAY}T12:${String(offset + i).padStart(2, '0')}:00.000Z`,
        url: `https://shop.test/p${offset + i}`,
        session: { sessionId: `s${i % SESSIONS}`, visitorId: `visitor-${i % SESSIONS}`, sessionStartedAt: `${DAY}T10:00:00.000Z` },
      }));
    }
  }

  /** A hard kill: memory gone, disk intact. */
  function crash() {
    __resetAnalyticsBuffer();
    __resetSpoolForTests(spoolPath);
  }

  it('reports readiness from the real directory, not from a flag', () => {
    const readiness = analyticsDurabilityReadiness();
    expect(readiness.ready).toBe(true);
    expect(readiness.dir).toBe(spoolPath);
  });

  it('writes every accepted row to disk BEFORE it is flushed', async () => {
    const pool = await readAnalyticsPool(serverConfig);
    enqueue(pool, PAGE_VIEWS);
    expect(spoolStats().appended).toBe(PAGE_VIEWS);
    expect(spoolStats().bytes).toBeGreaterThan(0);
  });

  it('CRASH before any flush: every row comes back on replay', async () => {
    const pool = await readAnalyticsPool(serverConfig);
    enqueue(pool, PAGE_VIEWS);
    crash();
    expect(bufferedRowCount()).toBe(0);

    const replayed = replaySpooledRows(serverConfig);
    expect(replayed.rows).toBe(PAGE_VIEWS);
    expect(bufferedRowCount()).toBe(PAGE_VIEWS);
  });

  it('CRASH then replay then flush: the rows reach the lake', async () => {
    const pool = await readAnalyticsPool(serverConfig);
    enqueue(pool, PAGE_VIEWS);
    crash();
    replaySpooledRows(serverConfig);

    const result = await flushAnalytics(serverConfig, { force: true });
    expect(result.rows).toBe(PAGE_VIEWS);
    expect(localKeys().filter((k) => k.endsWith('.parquet'))).toHaveLength(1);
  });

  it('S3 OUTAGE then crash then recovery: nothing is lost across both', async () => {
    const pool = await readAnalyticsPool(serverConfig);
    enqueue(pool, PAGE_VIEWS);

    // The primary has no credentials — every flush fails.
    usePrimary(null);
    const failed = await flushAnalytics(serverConfig, { force: true });
    expect(failed.rows).toBe(0);

    crash();

    // Storage comes back, and the replayed rows flush.
    usePrimary(primaryDir);
    expect(replaySpooledRows(serverConfig).rows).toBe(PAGE_VIEWS);
    const ok = await flushAnalytics(serverConfig, { force: true });
    expect(ok.rows).toBe(PAGE_VIEWS);
  });

  it('a successful flush ACKNOWLEDGES the spool, so a later crash replays nothing', async () => {
    const pool = await readAnalyticsPool(serverConfig);
    enqueue(pool, PAGE_VIEWS);
    await flushAnalytics(serverConfig, { force: true });

    crash();
    expect(replaySpooledRows(serverConfig).rows).toBe(0);
  });

  it('a FAILED flush does not acknowledge, so the rows survive the crash', async () => {
    const pool = await readAnalyticsPool(serverConfig);
    enqueue(pool, PAGE_VIEWS);
    usePrimary(null);
    await flushAnalytics(serverConfig, { force: true });

    crash();
    expect(replaySpooledRows(serverConfig).rows).toBe(PAGE_VIEWS);
  });

  it('replay is duplicate-safe: flushing twice writes each row once', async () => {
    const pool = await readAnalyticsPool(serverConfig);
    enqueue(pool, PAGE_VIEWS);
    await flushAnalytics(serverConfig, { force: true });

    // Crash AFTER a successful flush, replay, flush again.
    crash();
    replaySpooledRows(serverConfig);
    const second = await flushAnalytics(serverConfig, { force: true });

    // Nothing to write: the commit record already covered those rows.
    expect(second.rows).toBe(0);
    expect(localKeys().filter((k) => k.endsWith('.parquet'))).toHaveLength(1);
  });

  it('re-appends replayed rows, so a SECOND crash before the flush still recovers', async () => {
    const pool = await readAnalyticsPool(serverConfig);
    enqueue(pool, PAGE_VIEWS);

    crash();
    expect(replaySpooledRows(serverConfig).rows).toBe(PAGE_VIEWS);

    // Died again before flushing. The rows must still be on disk.
    crash();
    expect(replaySpooledRows(serverConfig).rows).toBe(PAGE_VIEWS);
  });

  it('keeps rows that arrived DURING a flush, and acknowledges only the drained ones', async () => {
    const pool = await readAnalyticsPool(serverConfig);
    enqueue(pool, PAGE_VIEWS);
    await flushAnalytics(serverConfig, { force: true });

    // Arrived after the acknowledgement.
    enqueue(pool, 2, 50);
    crash();
    expect(replaySpooledRows(serverConfig).rows).toBe(2);
  });
});
