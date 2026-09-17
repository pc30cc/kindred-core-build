/**
 * SHADOW READ / PARITY — PostgreSQL answers, S3 shadows, and the two are
 * compared.
 *
 * Both sides run for real here: the PostgreSQL store reads the fake source
 * tables through the real reportService, and the S3 store queries real
 * Parquet with real embedded DuckDB. A parity test that mocked either side
 * would prove only that a comparison function was called.
 *
 * The fixture is built so the two sides SHOULD agree on everything except
 * the two metrics that are declared to diverge — which is the point: the
 * suite proves the machinery can tell an intentional difference from a
 * regression.
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  resetFakeAnalyticsPool, seedGeneralPool, seedAnalyticsPool, seedTable, runtimeConfig,
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

const { duckDbAvailability } = await import('../../../server/services/analytics/duckdb.js');
const { __clearAnalyticsObjectCache } = await import('../../../server/services/analytics/objectCache.js');
const { sealWorkspaceDay } = await import('../../../server/services/analytics/sealing.js');
const { __resetAnalyticsBuffer } = await import('../../../server/services/analytics/writer.js');
const {
  officialStore, shadowStore, runParity, shadowReadiness,
} = await import('../../../server/services/webAnalytics/store/index.js');

const serverConfig = {} as never;
const WS = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const DAY = '2026-09-10';
const RANGE = { startDate: DAY, endDate: DAY };

let engineAvailable = false;
beforeAll(async () => {
  engineAvailable = (await duckDbAvailability()).available;
  if (!engineAvailable) console.warn('[analytics] @duckdb/node-api absent — parity tests cannot run here.');
});

let primaryDir: string;

/**
 * Three sessions belonging to TWO visitors, with page views that make each
 * asserted number distinct.
 *
 *   visitor-1 → s0 (2 views), s2 (1 view)
 *   visitor-2 → s1 (2 views)
 */
function seedSource(): void {
  seedTable('visitor_sessions', [
    { id: 's0', workspace_id: WS, visitor_id: 'visitor-1', started_at: `${DAY}T10:00:00.000Z`, last_seen_at: `${DAY}T10:20:00.000Z`, current_page: 'https://shop.test/', referrer: 'https://www.google.com/search', browser: 'Chrome', device: 'Desktop', os: 'macOS', language: 'en-US', country: 'Iran', city: 'Tehran', geo_country_code: 'IR', geo_country_name: 'Iran', geo_city: 'Tehran', utm_source: null, utm_medium: null, utm_campaign: null, utm_term: null, utm_content: null },
    { id: 's1', workspace_id: WS, visitor_id: 'visitor-2', started_at: `${DAY}T11:00:00.000Z`, last_seen_at: `${DAY}T11:10:00.000Z`, current_page: 'https://shop.test/', referrer: null, browser: 'Firefox', device: 'Mobile', os: 'iOS', language: 'fa-IR', country: 'Iran', city: 'Shiraz', geo_country_code: 'IR', geo_country_name: 'Iran', geo_city: 'Shiraz', utm_source: 'newsletter', utm_medium: 'email', utm_campaign: 'spring', utm_term: null, utm_content: null },
    { id: 's2', workspace_id: WS, visitor_id: 'visitor-1', started_at: `${DAY}T12:00:00.000Z`, last_seen_at: `${DAY}T12:02:00.000Z`, current_page: 'https://shop.test/pricing', referrer: null, browser: 'Chrome', device: 'Desktop', os: 'macOS', language: 'en-US', country: 'Iran', city: 'Tehran', geo_country_code: 'IR', geo_country_name: 'Iran', geo_city: 'Tehran', utm_source: null, utm_medium: null, utm_campaign: null, utm_term: null, utm_content: null },
  ]);
  seedTable('visitor_page_views', [
    { workspace_id: WS, visitor_session_id: 's0', url: 'https://shop.test/', title: 'Home', viewed_at: `${DAY}T10:00:00.000Z` },
    { workspace_id: WS, visitor_session_id: 's0', url: 'https://shop.test/products', title: 'Products', viewed_at: `${DAY}T10:05:00.000Z` },
    { workspace_id: WS, visitor_session_id: 's1', url: 'https://shop.test/', title: 'Home', viewed_at: `${DAY}T11:00:00.000Z` },
    { workspace_id: WS, visitor_session_id: 's1', url: 'https://shop.test/products', title: 'Products', viewed_at: `${DAY}T11:06:00.000Z` },
    { workspace_id: WS, visitor_session_id: 's2', url: 'https://shop.test/pricing', title: 'Pricing', viewed_at: `${DAY}T12:00:00.000Z` },
  ]);
  seedTable('web_analytics_events', [
    { workspace_id: WS, visitor_session_id: 's1', event_name: 'signup', properties: { plan: 'pro' }, page_url: 'https://shop.test/', created_at: `${DAY}T11:08:00.000Z` },
  ]);
  seedTable('analytics_day_seals', []);
  seedTable('workspace_deletion_jobs', []);
  seedTable('seo_crawls', []);
}

beforeEach(async () => {
  resetFakeAnalyticsPool();
  __resetAnalyticsBuffer();
  __clearAnalyticsObjectCache();
  primaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-parity-'));
  // Test files run in parallel and the query cache defaults to one shared
  // directory, so each suite gets its own — otherwise one file's cleanup
  // deletes the objects another file's query is reading.
  process.env.ANALYTICS_QUERY_CACHE_DIR = path.join(primaryDir, '.query-cache');
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
  seedSource();
  // Populate the lake from the SAME source PostgreSQL will be read from, so
  // any difference is a difference in the query, not in the data.
  if (engineAvailable) await sealWorkspaceDay(serverConfig, WS, DAY);
});

afterEach(() => {
  __clearAnalyticsObjectCache();
  fs.rmSync(primaryDir, { recursive: true, force: true });
});

const maybe = (name: string, fn: () => Promise<void>) =>
  it(name, async () => {
    if (!engineAvailable) return;
    await fn();
  }, 90_000);

async function parity() {
  return runParity(serverConfig, officialStore(serverConfig), shadowStore(serverConfig), WS, RANGE);
}

describe('shadow read', () => {
  maybe('finds NO regressions between the two stores on identical data', async () => {
    const run = await parity();
    const regressions = run.reports.flatMap((r) => r.differences).filter((d) => !d.expected);
    // Any undeclared difference is printed so a failure is diagnosable.
    expect(regressions.map((d) => `${d.report}.${d.field}: pg=${d.postgres} s3=${d.s3}`)).toEqual([]);
    expect(run.regressions).toBe(0);
  });

  maybe('covers the whole report surface, not a sample', async () => {
    const run = await parity();
    const covered = run.reports.map((r) => r.report);
    for (const report of [
      'overview',
      'trafficSources.channel', 'trafficSources.source', 'trafficSources.campaign',
      'geography.country', 'geography.city', 'geography.language', 'geography.continent',
      'browsersSystems.browser', 'browsersSystems.os', 'browsersSystems.device',
      'pages.top', 'pages.entry', 'pages.exit',
      'events.tracked',
    ]) {
      expect(covered, `${report} is not covered by the parity run`).toContain(report);
    }
  });

  maybe('agrees on uniqueVisitors — the metric Phase 2 declared as divergent', async () => {
    const run = await parity();
    const overview = run.reports.find((r) => r.report === 'overview')!;

    // No difference at all any more. Phase 2 asserted pg=3 vs s3=2 here and
    // called it expected; the 3 was the session count, which is a bug.
    expect(overview.differences.find((d) => d.field === 'uniqueVisitors')).toBeUndefined();
    expect(overview.ok).toBe(true);

    // And the agreed value is the RIGHT one: visitor-1 has two sessions
    // (s0, s2), visitor-2 has one, across three sessions.
    const pg = await officialStore(serverConfig).getOverview(WS, RANGE);
    const s3 = await shadowStore(serverConfig).getOverview(WS, RANGE);
    expect(pg.sessions).toBe(3);
    expect(pg.uniqueVisitors).toBe(2);
    expect(s3.uniqueVisitors).toBe(2);
  });

  maybe('agrees on avgVisitDurationSeconds — the other Phase 2 divergence', async () => {
    const run = await parity();
    const overview = run.reports.find((r) => r.report === 'overview')!;
    expect(overview.differences.find((d) => d.field === 'avgVisitDurationSeconds')).toBeUndefined();

    // (20min + 10min + 2min) / 3 sessions = 640s. Both paths measure to the
    // session's last_seen_at; the lake reads it from session_last_seen_at.
    const pg = await officialStore(serverConfig).getOverview(WS, RANGE);
    const s3 = await shadowStore(serverConfig).getOverview(WS, RANGE);
    expect(pg.avgVisitDurationSeconds).toBe(640);
    expect(s3.avgVisitDurationSeconds).toBe(640);
  });

  maybe('counts a visitor with three sessions as ONE unique visitor', async () => {
    // The exact shape Phase 2.5 specifies: A -> 3 sessions, B -> 1.
    const at = (h: number) => `${DAY}T${String(h).padStart(2, '0')}:00:00.000Z`;
    const session = (id: string, visitor: string, hour: number) => ({
      id, workspace_id: WS, visitor_id: visitor,
      started_at: at(hour), last_seen_at: `${DAY}T${String(hour).padStart(2, '0')}:05:00.000Z`,
      current_page: 'https://shop.test/', referrer: null,
      browser: 'Chrome', device: 'Desktop', os: 'macOS', language: 'en-US',
      country: 'Iran', city: 'Tehran', geo_country_code: 'IR', geo_country_name: 'Iran', geo_city: 'Tehran',
      utm_source: null, utm_medium: null, utm_campaign: null, utm_term: null, utm_content: null,
    });
    seedTable('visitor_sessions', [
      session('a1', 'visitor-A', 9),
      session('a2', 'visitor-A', 10),
      session('a3', 'visitor-A', 11),
      session('b1', 'visitor-B', 12),
    ]);
    seedTable('visitor_page_views', [
      { workspace_id: WS, visitor_session_id: 'a1', url: 'https://shop.test/', title: 'Home', viewed_at: at(9) },
      { workspace_id: WS, visitor_session_id: 'a2', url: 'https://shop.test/', title: 'Home', viewed_at: at(10) },
      { workspace_id: WS, visitor_session_id: 'a3', url: 'https://shop.test/', title: 'Home', viewed_at: at(11) },
      { workspace_id: WS, visitor_session_id: 'b1', url: 'https://shop.test/', title: 'Home', viewed_at: at(12) },
    ]);
    seedTable('web_analytics_events', []);
    seedTable('analytics_day_seals', []);
    __clearAnalyticsObjectCache();
    await sealWorkspaceDay(serverConfig, WS, DAY);

    const pg = await officialStore(serverConfig).getOverview(WS, RANGE);
    const s3 = await shadowStore(serverConfig).getOverview(WS, RANGE);

    expect(pg.sessions).toBe(4);
    expect(pg.uniqueVisitors).toBe(2);
    expect(s3.sessions).toBe(4);
    expect(s3.uniqueVisitors).toBe(2);

    // And parity sees no difference on it.
    const run = await parity();
    const overview = run.reports.find((r) => r.report === 'overview')!;
    expect(overview.differences.filter((d) => !d.expected)).toEqual([]);
  });

  maybe('agrees exactly on every other overview count', async () => {
    const run = await parity();
    const overview = run.reports.find((r) => r.report === 'overview')!;
    const fields = overview.differences.map((d) => d.field);
    expect(fields).not.toContain('sessions');
    expect(fields).not.toContain('pageviews');
    expect(fields).not.toContain('bounceRate');
  });

  maybe('detects a REAL difference rather than tolerating it', async () => {
    // Remove a page view from PostgreSQL only: the lake still holds it, so
    // the two must now disagree — and the disagreement must be undeclared.
    seedTable('visitor_page_views', [
      { workspace_id: WS, visitor_session_id: 's0', url: 'https://shop.test/', title: 'Home', viewed_at: `${DAY}T10:00:00.000Z` },
      { workspace_id: WS, visitor_session_id: 's1', url: 'https://shop.test/', title: 'Home', viewed_at: `${DAY}T11:00:00.000Z` },
      { workspace_id: WS, visitor_session_id: 's1', url: 'https://shop.test/products', title: 'Products', viewed_at: `${DAY}T11:06:00.000Z` },
      { workspace_id: WS, visitor_session_id: 's2', url: 'https://shop.test/pricing', title: 'Pricing', viewed_at: `${DAY}T12:00:00.000Z` },
    ]);

    const run = await parity();
    expect(run.regressions).toBeGreaterThan(0);
    const overview = run.reports.find((r) => r.report === 'overview')!;
    expect(overview.differences.some((d) => d.field === 'pageviews' && !d.expected)).toBe(true);
  });

  maybe('compares funnels with the SAME steps on both sides', async () => {
    const steps = [
      { type: 'pageview' as const, value: '/', matcher: 'exact' as const, label: 'Home' },
      { type: 'pageview' as const, value: '/products', matcher: 'exact' as const, label: 'Products' },
    ];
    const run = await runParity(
      serverConfig, officialStore(serverConfig), shadowStore(serverConfig), WS, RANGE, { funnelSteps: steps },
    );
    const funnel = run.reports.find((r) => r.report === 'events.funnel');
    expect(funnel).toBeDefined();
    expect(funnel!.differences.filter((d) => !d.expected)).toEqual([]);
  });

  maybe('writes NOTHING to PostgreSQL — the result is returned, never stored', async () => {
    // Analytics keeps no history of itself. A parity run is a question asked
    // and answered in the moment; if it ever starts leaving a record behind,
    // that is the telemetry store growing back and this test fails.
    const before = new Set(runtimeConfig.keys());
    const run = await parity();
    expect(run.reports.length).toBeGreaterThan(0);

    const written = [...runtimeConfig.keys()].filter((k) => !before.has(k));
    expect(written).toEqual([]);
    expect([...runtimeConfig.keys()].some((k) => k.includes('parity'))).toBe(false);
  });

  maybe('times both sides so a slow read path is visible', async () => {
    const run = await parity();
    for (const report of run.reports) {
      expect(report.postgresMs).toBeGreaterThanOrEqual(0);
      expect(report.s3Ms).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('readiness', () => {
  it('reports "not ready" — without erroring — when analytics storage is off', async () => {
    seedAnalyticsPool({ enabled: false, primary: null, replicas: [], replicaState: {} } as never);
    const readiness = await shadowReadiness(serverConfig);
    expect(readiness.ready).toBe(false);
    expect(readiness.reason).toMatch(/disabled/);
  });

  it('reports "not ready" when no analytics primary is chosen', async () => {
    seedAnalyticsPool({ enabled: true, primary: null, replicas: [], replicaState: {} } as never);
    const readiness = await shadowReadiness(serverConfig);
    expect(readiness.ready).toBe(false);
    expect(readiness.reason).toMatch(/no analytics primary/);
  });
});
