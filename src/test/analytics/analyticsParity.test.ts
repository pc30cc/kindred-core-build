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
  officialStore, shadowStore, runParity, readParityState, shadowReadiness, PARITY_STATE_KEY,
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

  maybe('reports the two DECLARED divergences as expected, never as regressions', async () => {
    const run = await parity();
    const overview = run.reports.find((r) => r.report === 'overview')!;
    const unique = overview.differences.find((d) => d.field === 'uniqueVisitors');

    // PostgreSQL counts 3 sessions; the lake counts 2 real visitors.
    expect(unique).toBeDefined();
    expect(unique!.expected).toBe(true);
    expect(unique!.postgres).toBe('3');
    expect(unique!.s3).toBe('2');
    // A declared difference must not make the report "not ok".
    expect(overview.ok).toBe(true);
  });

  maybe('agrees exactly on the counts that are NOT declared to diverge', async () => {
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

  maybe('persists the run so the admin panel can show it', async () => {
    await parity();
    const state = await readParityState(serverConfig);
    expect(state).toBeTruthy();
    expect(state!.workspaceId).toBe(WS);
    expect(runtimeConfig.has(PARITY_STATE_KEY)).toBe(true);
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
