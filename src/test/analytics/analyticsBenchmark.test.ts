/**
 * INGESTION LOAD TEST AND QUERY BENCHMARK.
 *
 * These are MEASUREMENTS, not pass/fail gates. The goal stated for Phase 3A
 * is finding the bottleneck, not hitting a number, so the assertions here are
 * deliberately loose sanity bounds — tight thresholds would turn a benchmark
 * into a flaky test on shared CI hardware and tell nobody anything useful.
 * The numbers are printed; the report quotes them.
 *
 * What they measure honestly, and what they do not:
 *
 *   MEASURED — enqueue latency under load (the widget's request path), spool
 *     growth and the real bytes-per-frame the capacity formula needs, flush
 *     behaviour, Parquet size, and DuckDB query latency over a realistic
 *     multi-day object layout.
 *
 *   NOT MEASURED — network round-trips to a real object store. The primary
 *     here is the `local` driver writing to a temp directory, so upload time
 *     is filesystem time, not S3 time. Every figure involving a flush or a
 *     query is therefore a LOWER BOUND, and a real vendor adds its own
 *     latency on top. That is the single biggest caveat on these numbers and
 *     it is why Phase 3A also asks for a run against the real primary.
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
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

const { readAnalyticsPool } = await import('../../../server/services/analytics/pool.js');
const {
  enqueueAnalyticsRow, flushAnalytics, bufferedRowCount, __resetAnalyticsBuffer,
} = await import('../../../server/services/analytics/writer.js');
const { buildEventRow } = await import('../../../server/services/analytics/schema.js');
const { spoolStats, spoolCapacityPlan, __resetSpoolForTests } =
  await import('../../../server/services/analytics/spool.js');
const { sealWorkspaceDay } = await import('../../../server/services/analytics/sealing.js');
const { S3ParquetWebAnalyticsStore } = await import('../../../server/services/webAnalytics/store/s3.js');
const { duckDbAvailability } = await import('../../../server/services/analytics/duckdb.js');
const { __clearAnalyticsObjectCache, fetchAnalyticsObjects } =
  await import('../../../server/services/analytics/objectCache.js');

const serverConfig = {} as never;
const WS = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

let primaryDir: string;
let spoolPath: string;
let cacheDir: string;
let engine = false;

beforeAll(async () => { engine = (await duckDbAvailability()).available; });

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index]!;
}

function parquetBytes(): { objects: number; bytes: number } {
  let objects = 0;
  let bytes = 0;
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.parquet')) { objects++; bytes += fs.statSync(full).size; }
    }
  };
  walk(primaryDir);
  return { objects, bytes };
}

beforeEach(() => {
  resetFakeAnalyticsPool();
  __resetAnalyticsBuffer();
  primaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-primary-'));
  spoolPath = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-spool-'));
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-cache-'));
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
  __resetAnalyticsBuffer();
  __resetSpoolForTests(spoolPath);
  __clearAnalyticsObjectCache();
  delete process.env.ANALYTICS_QUERY_CACHE_DIR;
  delete process.env.ANALYTICS_SPOOL_ENABLED;
  delete process.env.ANALYTICS_SPOOL_DIR;
  for (const d of [primaryDir, spoolPath, cacheDir]) fs.rmSync(d, { recursive: true, force: true });
});

/** One realistic page-view event, with the field sizes real traffic has. */
function eventRow(index: number, day: string) {
  return buildEventRow({
    workspaceId: WS,
    eventType: 'page_view',
    occurredAt: `${day}T${String(index % 24).padStart(2, '0')}:00:00.000Z`,
    url: `https://shop.example.com/catalog/category-${index % 40}/product-${index % 500}?utm_source=newsletter&utm_medium=email`,
    title: `Product ${index % 500} — Shop Example`,
    session: {
      sessionId: `session-${index % 1000}`,
      visitorId: `visitor-${index % 300}`,
      sessionStartedAt: `${day}T09:00:00.000Z`,
      sessionLastSeenAt: `${day}T09:20:00.000Z`,
      referrer: index % 3 === 0 ? 'https://www.google.com/search?q=shoes' : null,
      utmSource: index % 4 === 0 ? 'newsletter' : null,
      utmMedium: index % 4 === 0 ? 'email' : null,
      utmCampaign: index % 4 === 0 ? 'spring-sale-2026' : null,
      browser: ['Chrome', 'Firefox', 'Safari'][index % 3],
      device: index % 2 ? 'Mobile' : 'Desktop',
      os: ['macOS', 'Windows', 'iOS'][index % 3],
      language: index % 2 ? 'fa-IR' : 'en-US',
      country: 'Iran', countryCode: 'IR', city: ['Tehran', 'Shiraz', 'Mashhad'][index % 3],
    },
  });
}

describe('ingestion load', () => {
  /**
   * The rates Phase 3A names. Each runs one second's worth of events through
   * the real enqueue path and reports what the widget's request handler would
   * have waited for.
   */
  for (const rate of [100, 500, 1000]) {
    it(`sustains ${rate} events/sec through the enqueue path`, async () => {
      const pool = await readAnalyticsPool(serverConfig);
      const day = '2026-08-10';
      const latencies: number[] = [];
      const before = process.memoryUsage().heapUsed;

      const started = Date.now();
      for (let i = 0; i < rate; i++) {
        const row = eventRow(i, day);
        const t0 = performance.now();
        enqueueAnalyticsRow(serverConfig, pool, row);
        latencies.push(performance.now() - t0);
      }
      const wall = Date.now() - started;

      latencies.sort((a, b) => a - b);
      const spool = spoolStats();
      const heapDelta = process.memoryUsage().heapUsed - before;

      const flushStart = Date.now();
      const flushed = await flushAnalytics(serverConfig, { force: true });
      const flushMs = Date.now() - flushStart;
      const objects = parquetBytes();

      console.log(
        `LOAD rate=${rate}/s enqueued=${rate} wallMs=${wall} `
        + `enqueue_p50=${percentile(latencies, 50).toFixed(3)}ms `
        + `p95=${percentile(latencies, 95).toFixed(3)}ms `
        + `p99=${percentile(latencies, 99).toFixed(3)}ms `
        + `max=${latencies[latencies.length - 1]!.toFixed(3)}ms `
        + `spoolBytes=${spool.bytes} bytesPerEvent=${(spool.bytes / rate).toFixed(1)} `
        + `heapDeltaKB=${Math.round(heapDelta / 1024)} `
        + `flushMs=${flushMs} flushedRows=${flushed.rows} objects=${objects.objects} `
        + `parquetBytes=${objects.bytes} parquetBytesPerRow=${(objects.bytes / rate).toFixed(1)}`,
      );

      expect(flushed.rows).toBe(rate);
      // One object per workspace-day regardless of rate — the small-files rule.
      expect(objects.objects).toBe(1);
      // A loose ceiling: catches a catastrophic per-event regression, and is
      // far enough above a real machine's numbers not to flake.
      expect(percentile(latencies, 99)).toBeLessThan(50);
    }, 180_000);
  }

  it('reports the spool capacity plan from the MEASURED frame size', async () => {
    const pool = await readAnalyticsPool(serverConfig);
    for (let i = 0; i < 2000; i++) enqueueAnalyticsRow(serverConfig, pool, eventRow(i, '2026-08-10'));

    const plan = spoolCapacityPlan();
    expect(plan.averageFrameBytes).toBeGreaterThan(0);

    const rows: string[] = [];
    for (const rate of [100, 500, 1000]) {
      const seconds = plan.outageSecondsAt(rate, 2)!;
      rows.push(`${rate}/s => ${(seconds / 3600).toFixed(2)}h`);
    }
    console.log(
      `CAPACITY avgFrameBytes=${plan.averageFrameBytes!.toFixed(1)} `
      + `maxBytes=${plan.maxBytes} segmentBytes=${plan.segmentBytes} `
      + `fsyncMs=${plan.fsyncIntervalMs} outageAt2xSafety: ${rows.join(', ')}`,
    );

    // Required bytes for a stated target, using the measured frame size.
    for (const [rate, hours] of [[100, 24], [500, 24], [1000, 24], [1000, 72]] as const) {
      const required = rate * plan.averageFrameBytes! * hours * 3600 * 2;
      console.log(
        `REQUIRED rate=${rate}/s outage=${hours}h safety=2x => ${(required / 1024 / 1024 / 1024).toFixed(2)} GiB`,
      );
    }
  }, 180_000);
});

describe('query performance', () => {
  /**
   * Builds 90 days of history the way production gets it — one sealed object
   * per workspace-day — then times the real report queries over 1, 7, 30 and
   * 90 day windows.
   */
  it('measures report latency at 1, 7, 30 and 90 days', async () => {
    if (!engine) return;

    const DAYS = 90;
    const SESSIONS_PER_DAY = 60;
    const VIEWS_PER_SESSION = 3;

    const sessions: Record<string, unknown>[] = [];
    const views: Record<string, unknown>[] = [];
    const events: Record<string, unknown>[] = [];
    const dayOf = (offset: number) =>
      new Date(Date.parse('2026-05-01T00:00:00.000Z') + offset * 86_400_000).toISOString().slice(0, 10);

    for (let d = 0; d < DAYS; d++) {
      const day = dayOf(d);
      for (let s = 0; s < SESSIONS_PER_DAY; s++) {
        const id = `d${d}s${s}`;
        sessions.push({
          id, workspace_id: WS, visitor_id: `visitor-${s % 250}`,
          started_at: `${day}T${String(8 + (s % 12)).padStart(2, '0')}:00:00.000Z`,
          last_seen_at: `${day}T${String(8 + (s % 12)).padStart(2, '0')}:18:00.000Z`,
          current_page: 'https://shop.example.com/', referrer: s % 3 === 0 ? 'https://www.google.com/search' : null,
          browser: ['Chrome', 'Firefox', 'Safari'][s % 3], device: s % 2 ? 'Mobile' : 'Desktop',
          os: ['macOS', 'Windows', 'iOS'][s % 3], language: s % 2 ? 'fa-IR' : 'en-US',
          country: 'Iran', city: ['Tehran', 'Shiraz'][s % 2],
          geo_country_code: 'IR', geo_country_name: 'Iran', geo_city: ['Tehran', 'Shiraz'][s % 2],
          utm_source: s % 4 === 0 ? 'newsletter' : null, utm_medium: s % 4 === 0 ? 'email' : null,
          utm_campaign: s % 4 === 0 ? 'spring' : null, utm_term: null, utm_content: null,
        });
        for (let v = 0; v < VIEWS_PER_SESSION; v++) {
          views.push({
            workspace_id: WS, visitor_session_id: id,
            url: `https://shop.example.com/${['', 'products', 'pricing', 'blog'][v % 4]}`,
            title: `P${v}`,
            viewed_at: `${day}T${String(8 + (s % 12)).padStart(2, '0')}:0${v}:00.000Z`,
          });
        }
      }
      for (let e = 0; e < 8; e++) {
        events.push({
          workspace_id: WS, visitor_session_id: `d${d}s${e}`, event_name: 'signup',
          properties: { plan: e % 2 ? 'pro' : 'free' }, page_url: 'https://shop.example.com/',
          created_at: `${day}T14:0${e}:00.000Z`,
        });
      }
    }

    seedTable('visitor_sessions', sessions);
    seedTable('visitor_page_views', views);
    seedTable('web_analytics_events', events);

    const sealStart = Date.now();
    for (let d = 0; d < DAYS; d++) await sealWorkspaceDay(serverConfig, WS, dayOf(d));
    const sealMs = Date.now() - sealStart;
    const stored = parquetBytes();
    console.log(
      `BACKFILL days=${DAYS} sealMs=${sealMs} objects=${stored.objects} bytes=${stored.bytes} `
      + `sourceRows=${sessions.length * 2 + views.length + events.length}`,
    );

    const store = new S3ParquetWebAnalyticsStore(serverConfig);
    const funnelSteps = [
      { type: 'pageview' as const, value: '/', matcher: 'exact' as const, label: 'Home' },
      { type: 'pageview' as const, value: '/products', matcher: 'exact' as const, label: 'Products' },
    ];

    for (const window of [1, 7, 30, 90]) {
      const endDate = dayOf(DAYS - 1);
      const startDate = dayOf(DAYS - window);
      const range = { startDate, endDate };

      // Cold: clear the local object cache so fetch cost is included.
      __clearAnalyticsObjectCache();
      const fetched = await fetchAnalyticsObjects(serverConfig, WS, range);

      const timings: Record<string, number> = {};
      const time = async (name: string, run: () => Promise<unknown>) => {
        const t0 = Date.now();
        await run();
        timings[name] = Date.now() - t0;
      };

      await time('overview', () => store.getOverview(WS, range));
      await time('topPages', () => store.getPages(WS, range, 'top'));
      await time('trafficSources', () => store.getTrafficSources(WS, range, 'source'));
      await time('geography', () => store.getGeography(WS, range, 'country'));
      await time('events', () => store.getTrackedEvents(WS, range));
      await time('funnel', () => store.computeFunnel(WS, funnelSteps, range));

      const total = Object.values(timings).reduce((a, b) => a + b, 0);
      console.log(
        `QUERY window=${window}d objectsScanned=${fetched.objectCount} bytesFetched=${fetched.bytes} `
        + Object.entries(timings).map(([k, v]) => `${k}=${v}ms`).join(' ')
        + ` totalMs=${total}`,
      );

      // Partition pruning must hold: a 1-day window may not read 90 objects.
      expect(fetched.objectCount).toBeLessThanOrEqual(window);
    }

    // Correctness at the widest window, so the timings are of real answers.
    const full = await store.getOverview(WS, { startDate: dayOf(0), endDate: dayOf(DAYS - 1) });
    expect(full.sessions).toBe(DAYS * SESSIONS_PER_DAY);
    expect(full.pageviews).toBe(DAYS * SESSIONS_PER_DAY * VIEWS_PER_SESSION);
    expect(full.truncated).toBe(false);
  }, 900_000);
});
