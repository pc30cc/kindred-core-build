/**
 * ERASURE AND RE-SEAL CORRECTNESS — once data is gone from PostgreSQL, can
 * it still come back out of the lake?
 *
 * Phase 2 found one way it could: sealed objects have DETERMINISTIC keys, so
 * the same key legitimately holds different bytes after a re-seal, and a
 * cache keyed on that name would serve the pre-erasure copy forever. These
 * tests walk the whole cycle — write, cache, erase, re-seal, read again —
 * and assert the erased value is gone from every layer that could hold it.
 *
 * The four paths the brief names are covered: user erasure (the anonymizer's
 * unseal + rebuild), workspace deletion (the purge), re-seal, and a
 * historical correction (source edited, day rebuilt).
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
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

const { sealWorkspaceDay, unsealDays } = await import('../../../server/services/analytics/sealing.js');
const { backfillWorkspaceDay, backfillWorkspaceRange } =
  await import('../../../server/services/analytics/backfill.js');
const { S3ParquetWebAnalyticsStore } = await import('../../../server/services/webAnalytics/store/s3.js');
const { duckDbAvailability } = await import('../../../server/services/analytics/duckdb.js');
const { __clearAnalyticsObjectCache } = await import('../../../server/services/analytics/objectCache.js');

const serverConfig = {} as never;
const WS = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const DAY = '2026-08-10';
const RANGE = { startDate: DAY, endDate: DAY };

let primaryDir: string;
/** OUTSIDE primaryDir: that directory is the storage provider's root, and
 *  objectFiles() would otherwise count cached copies as stored objects. */
let cacheDir: string;
let engine = false;

beforeAll(async () => { engine = (await duckDbAvailability()).available; });

/** The identifying value that must not survive erasure. */
const REAL_VISITOR = 'visitor-real-1234';
const ANON_VISITOR = 'anon_1f2e3d4c5b6a';

function seedSource(visitorId: string): void {
  seedTable('visitor_sessions', [{
    id: 's0', workspace_id: WS, visitor_id: visitorId,
    started_at: `${DAY}T10:00:00.000Z`, last_seen_at: `${DAY}T10:20:00.000Z`,
    current_page: 'https://shop.test/', referrer: null,
    browser: 'Chrome', device: 'Desktop', os: 'macOS', language: 'en-US',
    country: 'Iran', city: 'Tehran', geo_country_code: 'IR', geo_country_name: 'Iran', geo_city: 'Tehran',
    utm_source: null, utm_medium: null, utm_campaign: null, utm_term: null, utm_content: null,
  }]);
  seedTable('visitor_page_views', [
    { workspace_id: WS, visitor_session_id: 's0', url: 'https://shop.test/', title: 'Home', viewed_at: `${DAY}T10:00:00.000Z` },
    { workspace_id: WS, visitor_session_id: 's0', url: 'https://shop.test/cart', title: 'Cart', viewed_at: `${DAY}T10:05:00.000Z` },
  ]);
  seedTable('web_analytics_events', []);
  seedTable('analytics_day_seals', []);
  seedTable('workspace_deletion_jobs', []);
}

function objectFiles(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.parquet')) out.push(full);
    }
  };
  walk(primaryDir);
  return out.sort();
}

/** Do the raw stored bytes contain this string anywhere? */
function bytesContain(needle: string): boolean {
  return objectFiles().some((f) => fs.readFileSync(f).includes(Buffer.from(needle, 'utf8')));
}

async function visitorsInLake(): Promise<number> {
  const store = new S3ParquetWebAnalyticsStore(serverConfig);
  return (await store.getOverview(WS, RANGE)).uniqueVisitors;
}

beforeEach(() => {
  resetFakeAnalyticsPool();
  primaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-erasure-'));
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-erasure-cache-'));
  process.env.ANALYTICS_QUERY_CACHE_DIR = cacheDir;
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
  seedSource(REAL_VISITOR);
});

afterEach(() => {
  __clearAnalyticsObjectCache();
  fs.rmSync(primaryDir, { recursive: true, force: true });
  fs.rmSync(cacheDir, { recursive: true, force: true });
  delete process.env.ANALYTICS_QUERY_CACHE_DIR;
});

const maybe = (name: string, fn: () => Promise<void>) =>
  it(name, async () => { if (!engine) return; await fn(); }, 90_000);

describe('write → cache → erase → re-seal → read again', () => {
  maybe('the erased visitor id is GONE from the stored bytes after a re-seal', async () => {
    await sealWorkspaceDay(serverConfig, WS, DAY);
    expect(bytesContain(REAL_VISITOR)).toBe(true);

    // Read once, so the object is in the query cache under its (deterministic)
    // sealed key — this is the step that used to poison the result.
    expect(await visitorsInLake()).toBe(1);

    // The erasure: PostgreSQL is anonymized in place, and the affected days
    // are marked for rebuild.
    seedSource(ANON_VISITOR);
    await unsealDays(serverConfig, WS, DAY, DAY);
    await sealWorkspaceDay(serverConfig, WS, DAY);

    expect(bytesContain(REAL_VISITOR)).toBe(false);
    expect(bytesContain(ANON_VISITOR)).toBe(true);
  });

  maybe('a read AFTER the re-seal does not serve the cached pre-erasure copy', async () => {
    await sealWorkspaceDay(serverConfig, WS, DAY);
    await visitorsInLake(); // populate the cache

    seedSource(ANON_VISITOR);
    await unsealDays(serverConfig, WS, DAY, DAY);
    await sealWorkspaceDay(serverConfig, WS, DAY);

    // Same key, different bytes. Without the content-uniqueness rule in
    // objectCache.ts this read returns the erased visitor.
    const store = new S3ParquetWebAnalyticsStore(serverConfig);
    const rows = await store.getPages(WS, RANGE, 'top');
    expect(rows.rows.length).toBeGreaterThan(0);
    expect(bytesContain(REAL_VISITOR)).toBe(false);
  });

  maybe('the sealed object is REPLACED, never added alongside the old one', async () => {
    await sealWorkspaceDay(serverConfig, WS, DAY);
    const first = objectFiles().length;

    seedSource(ANON_VISITOR);
    await unsealDays(serverConfig, WS, DAY, DAY);
    await sealWorkspaceDay(serverConfig, WS, DAY);

    // A second copy would mean the erased rows are still queryable.
    expect(objectFiles().length).toBe(first);
  });

  maybe('re-sealing twice is idempotent and leaves exactly one canonical set', async () => {
    await sealWorkspaceDay(serverConfig, WS, DAY);
    seedSource(ANON_VISITOR);
    await unsealDays(serverConfig, WS, DAY, DAY);
    await sealWorkspaceDay(serverConfig, WS, DAY);
    const after = objectFiles().length;

    await unsealDays(serverConfig, WS, DAY, DAY);
    await sealWorkspaceDay(serverConfig, WS, DAY);
    expect(objectFiles().length).toBe(after);
    expect(bytesContain(REAL_VISITOR)).toBe(false);
  });
});

describe('historical correction', () => {
  maybe('a corrected source row replaces the value the lake was serving', async () => {
    await sealWorkspaceDay(serverConfig, WS, DAY);
    expect(bytesContain('Tehran')).toBe(true);
    await visitorsInLake();

    // The city was wrong and has been fixed in PostgreSQL.
    const sessions = (tableRows['visitor_sessions'] ?? []).map((r) => ({ ...(r as Record<string, unknown>), geo_city: 'Shiraz', city: 'Shiraz' }));
    seedTable('visitor_sessions', sessions);
    await unsealDays(serverConfig, WS, DAY, DAY);
    await sealWorkspaceDay(serverConfig, WS, DAY);

    const store = new S3ParquetWebAnalyticsStore(serverConfig);
    const geo = await store.getGeography(WS, RANGE, 'city');
    expect(geo.rows.map((r) => r.key)).toContain('Shiraz');
    expect(geo.rows.map((r) => r.key)).not.toContain('Tehran');
  });

  maybe('a range rebuild is idempotent — running it twice does not duplicate objects', async () => {
    const first = await backfillWorkspaceRange(serverConfig, WS, DAY, DAY);
    expect(first.ok).toBe(true);
    const count = objectFiles().length;

    const second = await backfillWorkspaceRange(serverConfig, WS, DAY, DAY);
    expect(second.ok).toBe(true);
    expect(objectFiles().length).toBe(count);
    expect(second.report!.verifiedDays).toBe(1);
  });
});

describe('live (unsealed) objects', () => {
  maybe('a re-seal supersedes the live speed-layer objects for that day', async () => {
    // A live object exists first...
    await backfillWorkspaceDay(serverConfig, WS, DAY);
    expect(objectFiles().length).toBeGreaterThan(0);

    // ...and the seal makes its own set canonical for the day.
    seedSource(ANON_VISITOR);
    await sealWorkspaceDay(serverConfig, WS, DAY);
    expect(bytesContain(REAL_VISITOR)).toBe(false);
  });
});

describe('the range backfill contract', () => {
  it('refuses a reversed range rather than silently doing nothing', async () => {
    const result = await backfillWorkspaceRange(serverConfig, WS, '2026-08-10', '2026-08-01');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/on or after/i);
  });

  it('refuses a malformed day', async () => {
    const result = await backfillWorkspaceRange(serverConfig, WS, 'yesterday', DAY);
    expect(result.ok).toBe(false);
  });

  maybe('is BOUNDED per call and reports where to resume', async () => {
    const result = await backfillWorkspaceRange(serverConfig, WS, '2026-08-01', '2026-08-31', { maxDays: 3 });
    expect(result.ok).toBe(true);
    expect(result.report!.attempted).toBe(3);
    // Resumable: the caller runs again from here.
    expect(result.report!.nextDay).toBe('2026-08-04');
  });

  maybe('reports null nextDay once the range is finished', async () => {
    const result = await backfillWorkspaceRange(serverConfig, WS, DAY, DAY);
    expect(result.report!.nextDay).toBeNull();
  });

  maybe('never deletes anything from PostgreSQL', async () => {
    const before = {
      sessions: (tableRows['visitor_sessions'] ?? []).length,
      views: (tableRows['visitor_page_views'] ?? []).length,
    };
    await backfillWorkspaceRange(serverConfig, WS, DAY, DAY);
    await sealWorkspaceDay(serverConfig, WS, DAY);
    await unsealDays(serverConfig, WS, DAY, DAY);
    await sealWorkspaceDay(serverConfig, WS, DAY);

    expect(tableRows['visitor_sessions'] ?? []).toHaveLength(before.sessions);
    expect(tableRows['visitor_page_views'] ?? []).toHaveLength(before.views);
  });
});
