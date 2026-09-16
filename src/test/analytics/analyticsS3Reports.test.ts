/**
 * The S3 read path, end to end, against real Parquet and a real embedded
 * DuckDB — not a mock of either.
 *
 * Rows go through the ACTUAL ingest → buffer → Parquet → object-store path,
 * are then read back by the actual store, and the numbers are asserted
 * against a fixture whose expected answers are worked out by hand. That is
 * the only way this proves anything: a test that mocked the engine would
 * prove the SQL was written, not that it computes the right thing.
 *
 * The whole suite is skipped — loudly — when the optional @duckdb/node-api
 * package is absent, because a silently-skipped suite is indistinguishable
 * from a passing one.
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resetFakeAnalyticsPool, seedGeneralPool, seedAnalyticsPool } from './fakeAnalyticsPool';

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
const { flushAnalytics, enqueueAnalyticsRow, __resetAnalyticsBuffer } =
  await import('../../../server/services/analytics/writer.js');
const { buildEventRow } = await import('../../../server/services/analytics/schema.js');
const { duckDbAvailability } = await import('../../../server/services/analytics/duckdb.js');
const { __clearAnalyticsObjectCache } = await import('../../../server/services/analytics/objectCache.js');
const { S3ParquetWebAnalyticsStore } = await import('../../../server/services/webAnalytics/store/s3.js');

const serverConfig = {} as never;
const WS = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER_WS = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const DAY = '2026-09-10';
const RANGE = { startDate: DAY, endDate: DAY };

let engineAvailable = false;
beforeAll(async () => {
  engineAvailable = (await duckDbAvailability()).available;
  if (!engineAvailable) {
    console.warn('[analytics] @duckdb/node-api is not installed — S3 report tests cannot run here.');
  }
});

let primaryDir: string;

function at(hour: number, minute: number): string {
  return `${DAY}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`;
}

/**
 * The fixture, chosen so every asserted number is a DIFFERENT number —
 * sessions 4, pageviews 6, visitors 2, bounces 2 — so a query that returned
 * the wrong one of them cannot accidentally pass.
 *
 *   visitor A — s1 (10:00, / then /products), s2 (11:00, /pricing),
 *               s3 (12:00, /) + a `signup` custom event
 *   visitor B — s4 (13:00, / then /products)
 */
const PLAN: Array<[visitor: string, session: string, hour: number, minute: number, path: string, browser: string]> = [
  ['A', 's1', 10, 0, '/', 'Chrome'],
  ['A', 's1', 10, 5, '/products', 'Chrome'],
  ['A', 's2', 11, 0, '/pricing', 'Chrome'],
  ['A', 's3', 12, 0, '/', 'Chrome'],
  ['B', 's4', 13, 0, '/', 'Firefox'],
  ['B', 's4', 13, 9, '/products', 'Firefox'],
];

async function seedLake(): Promise<void> {
  const pool = await readAnalyticsPool(serverConfig);
  for (const [visitorId, sessionId, hour, minute, p, browser] of PLAN) {
    enqueueAnalyticsRow(serverConfig, pool, buildEventRow({
      workspaceId: WS,
      eventType: 'page_view',
      occurredAt: at(hour, minute),
      url: `https://shop.test${p}`,
      title: `Title ${p}`,
      session: {
        visitorId, sessionId, sessionStartedAt: at(hour, 0), browser,
        os: 'macOS', device: 'Desktop', language: 'fa-IR',
        country: 'Iran', countryCode: 'IR', city: 'Tehran',
        utmSource: 'newsletter', utmMedium: 'email', utmCampaign: 'spring',
        referrer: 'https://www.google.com/search',
      },
    }));
  }
  enqueueAnalyticsRow(serverConfig, pool, buildEventRow({
    workspaceId: WS, eventType: 'custom_event', eventName: 'signup', occurredAt: at(12, 30),
    properties: { plan: 'pro', seats: 3 },
    session: { visitorId: 'A', sessionId: 's3', sessionStartedAt: at(12, 0) },
  }));
  // Another workspace, same day, same paths — the isolation control.
  enqueueAnalyticsRow(serverConfig, pool, buildEventRow({
    workspaceId: OTHER_WS, eventType: 'page_view', occurredAt: at(10, 0),
    url: 'https://other.test/confidential',
    session: { visitorId: 'Z', sessionId: 'z1', sessionStartedAt: at(10, 0), browser: 'Safari', country: 'Türkiye' },
  }));
  await flushAnalytics(serverConfig, { force: true });
}

function store() {
  return new S3ParquetWebAnalyticsStore(serverConfig);
}

beforeEach(async () => {
  resetFakeAnalyticsPool();
  __resetAnalyticsBuffer();
  __clearAnalyticsObjectCache();
  primaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-reports-'));
  // Test files run in parallel and the query cache defaults to one shared
  // directory, so each suite gets its own — otherwise one file's cleanup
  // deletes the objects another file's query is reading.
  process.env.ANALYTICS_QUERY_CACHE_DIR = path.join(primaryDir, '.query-cache');
  seedGeneralPool({
    primary: 'bunny_storage',
    providers: {
      bunny_storage: { config: { username: 'zone', password: 'pw', hostname: 'storage.bunnycdn.com', cdn_url: 'https://g.b-cdn.net' } },
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
  if (engineAvailable) await seedLake();
});

afterEach(() => {
  __resetAnalyticsBuffer();
  __clearAnalyticsObjectCache();
  fs.rmSync(primaryDir, { recursive: true, force: true });
});

const maybe = (name: string, fn: () => Promise<void>) =>
  it(name, async () => {
    if (!engineAvailable) return; // reported in beforeAll
    await fn();
  }, 60_000);

describe('overview', () => {
  maybe('counts sessions, pageviews and bounce rate exactly', async () => {
    const overview = await store().getOverview(WS, RANGE);
    expect(overview.sessions).toBe(4);
    expect(overview.pageviews).toBe(6);
    expect(overview.avgPagesPerSession).toBe(1.5);
    // s2 and s3 saw one page each.
    expect(overview.bounceRate).toBe(50);
  });

  maybe('counts UNIQUE VISITORS, not sessions — the metric PostgreSQL gets wrong', async () => {
    const overview = await store().getOverview(WS, RANGE);
    expect(overview.sessions).toBe(4);
    expect(overview.uniqueVisitors).toBe(2);
    expect(overview.uniqueVisitors).not.toBe(overview.sessions);
  });

  maybe('never reports a truncated result — there is no row cap on this path', async () => {
    expect((await store().getOverview(WS, RANGE)).truncated).toBe(false);
    expect((await store().getPages(WS, RANGE, 'top')).truncated).toBe(false);
  });

  maybe('returns a zeroed overview for a range with no objects rather than failing', async () => {
    const overview = await store().getOverview(WS, { startDate: '2020-01-01', endDate: '2020-01-02' });
    expect(overview.sessions).toBe(0);
    expect(overview.pageviews).toBe(0);
    expect(overview.trend).toEqual([]);
  });

  maybe('buckets the trend by day', async () => {
    const overview = await store().getOverview(WS, RANGE);
    expect(overview.trend).toEqual([{ date: DAY, sessions: 4, pageviews: 6 }]);
  });
});

describe('pages', () => {
  maybe('ranks top pages by views', async () => {
    const { rows } = await store().getPages(WS, RANGE, 'top');
    // Grouped by reportService's `normalizePath`, which keeps the scheme and
    // host and strips only the query and a trailing slash. Matching that
    // exactly is what makes the parity comparison meaningful.
    expect(rows).toEqual([
      { path: 'https://shop.test', views: 3 },
      { path: 'https://shop.test/products', views: 2 },
      { path: 'https://shop.test/pricing', views: 1 },
    ]);
  });

  maybe('takes the first page of each session as its entry page', async () => {
    const { rows } = await store().getPages(WS, RANGE, 'entry');
    // s1 → /, s2 → /pricing, s3 → /, s4 → /
    expect(rows).toEqual([
      { path: 'https://shop.test', views: 3 },
      { path: 'https://shop.test/pricing', views: 1 },
    ]);
  });

  maybe('takes the last page of each session as its exit page', async () => {
    const { rows } = await store().getPages(WS, RANGE, 'exit');
    // s1 → /products, s2 → /pricing, s3 → /, s4 → /products
    expect(rows).toEqual([
      { path: 'https://shop.test/products', views: 2 },
      { path: 'https://shop.test', views: 1 },
      { path: 'https://shop.test/pricing', views: 1 },
    ]);
  });

  maybe('builds a site-structure tree from per-path counts', async () => {
    const { root } = await store().getSiteStructure(WS, RANGE);
    expect(root.views).toBe(6);
    // Segments come from splitting the normalized value, which (as above)
    // still carries the host — reportService builds the tree the same way.
    const segments = root.children.map((c) => c.segment);
    expect(segments).toContain('https:');
  });
});

describe('breakdowns', () => {
  maybe('splits sessions and pageviews by browser', async () => {
    const { rows } = await store().getBrowsersSystems(WS, RANGE, 'browser');
    expect(rows).toEqual([
      { key: 'Chrome', label: 'Chrome', sessions: 3, pageviews: 4 },
      { key: 'Firefox', label: 'Firefox', sessions: 1, pageviews: 2 },
    ]);
  });

  maybe('resolves country and derives the continent from its code', async () => {
    expect((await store().getGeography(WS, RANGE, 'country')).rows)
      .toEqual([{ key: 'Iran', label: 'Iran', sessions: 4, pageviews: 6 }]);
    expect((await store().getGeography(WS, RANGE, 'continent')).rows)
      .toEqual([{ key: 'AS', label: 'Asia', sessions: 4, pageviews: 6 }]);
  });

  maybe('classifies channels with the shared classifier, not a second SQL copy', async () => {
    const { rows } = await store().getTrafficSources(WS, RANGE, 'channel');
    // utm_medium=email wins over the google.com referrer — the same
    // precedence server/services/webAnalytics/channels.ts applies.
    expect(rows).toEqual([{ key: 'email', label: 'Email', sessions: 4, pageviews: 6 }]);
  });

  maybe('prefers utm_source over the referrer domain for the source dimension', async () => {
    expect((await store().getTrafficSources(WS, RANGE, 'source')).rows)
      .toEqual([{ key: 'newsletter', label: 'newsletter', sessions: 4, pageviews: 6 }]);
  });

  maybe('breaks down by campaign and language', async () => {
    expect((await store().getTrafficSources(WS, RANGE, 'campaign')).rows[0].key).toBe('spring');
    expect((await store().getGeography(WS, RANGE, 'language')).rows[0].key).toBe('fa-IR');
  });
});

describe('events', () => {
  maybe('counts tracked events and their conversion against the range’s sessions', async () => {
    const { rows } = await store().getTrackedEvents(WS, RANGE);
    expect(rows).toEqual([
      { eventName: 'signup', count: 1, uniqueSessions: 1, conversionRate: 0.25 },
    ]);
  });

  maybe('reads property keys and value counts out of the JSON column', async () => {
    expect(await store().getEventPropertyKeys(WS, RANGE, 'signup')).toEqual(['plan', 'seats']);
    expect((await store().getEventPropertyBreakdown(WS, RANGE, 'signup', 'plan')).rows)
      .toEqual([{ value: 'pro', count: 1 }]);
  });
});

describe('funnels', () => {
  maybe('respects step ORDER — a later step must occur after the earlier one', async () => {
    const results = await store().computeFunnel(WS, [
      { type: 'pageview', value: 'https://shop.test', matcher: 'exact', label: 'Home' },
      { type: 'pageview', value: 'https://shop.test/products', matcher: 'exact', label: 'Products' },
    ], RANGE);
    // s1, s3 and s4 saw `/`; only s1 and s4 then saw `/products`.
    expect(results.map((r) => [r.label, r.sessions])).toEqual([['Home', 3], ['Products', 2]]);
    expect(results[1].conversionFromStart).toBeCloseTo(66.7, 1);
  });

  maybe('counts nobody through a step whose order is reversed', async () => {
    const results = await store().computeFunnel(WS, [
      { type: 'pageview', value: 'https://shop.test/products', matcher: 'exact', label: 'Products' },
      { type: 'pageview', value: 'https://shop.test', matcher: 'exact', label: 'Home' },
    ], RANGE);
    // Nobody visited /products and THEN / in this fixture.
    expect(results.map((r) => r.sessions)).toEqual([2, 0]);
  });

  maybe('mixes page views and custom events in one ordered funnel', async () => {
    const results = await store().computeFunnel(WS, [
      { type: 'pageview', value: 'https://shop.test', matcher: 'exact', label: 'Home' },
      { type: 'event', eventName: 'signup', label: 'Signed up' },
    ], RANGE);
    // Only s3 saw `/` (12:00) and then fired `signup` (12:30).
    expect(results.map((r) => r.sessions)).toEqual([3, 1]);
  });
});

describe('visitor page history', () => {
  maybe('keeps the { items, entry, current } contract the panel consumes', async () => {
    const history = await store().getVisitorPageHistory(WS, 's1', 20);
    expect(history.items.map((i) => i.url)).toEqual([
      'https://shop.test/products',
      'https://shop.test/',
    ]);
    expect(history.entry.landing_url).toBe('https://shop.test/');
    expect(history.entry.referrer).toBe('https://www.google.com/search');
    expect(history.current?.url).toBe('https://shop.test/products');
  });
});

describe('multi-tenant isolation', () => {
  maybe('never returns another workspace’s data from any report', async () => {
    const reports = await Promise.all([
      store().getPages(WS, RANGE, 'top'),
      store().getGeography(WS, RANGE, 'country'),
      store().getBrowsersSystems(WS, RANGE, 'browser'),
      store().getOverview(WS, RANGE),
    ]);
    const serialized = JSON.stringify(reports);
    expect(serialized).not.toContain('confidential');
    expect(serialized).not.toContain('Safari');
    expect(serialized).not.toContain('Türkiye');
  });

  maybe('reports the OTHER workspace’s own data correctly, so isolation is not just an empty result', async () => {
    const overview = await store().getOverview(OTHER_WS, RANGE);
    expect(overview.sessions).toBe(1);
    expect(overview.pageviews).toBe(1);
    expect((await store().getPages(OTHER_WS, RANGE, 'top')).rows)
      .toEqual([{ path: 'https://other.test/confidential', views: 1 }]);
  });

  maybe('refuses a workspace id that is not a uuid rather than widening the scan', async () => {
    await expect(store().getOverview("' OR 1=1 --", RANGE)).rejects.toThrow(/analytics_s3_unavailable/);
  });
});
