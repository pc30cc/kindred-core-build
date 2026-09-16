/**
 * SCALE — a realistic historical backfill, then a query over the whole range.
 *
 * The other suites prove correctness on a handful of rows. This one proves
 * the shape of the thing at a size where the design decisions matter: that a
 * multi-day backfill produces ONE object per workspace-day rather than a
 * pile of small ones, that every source row is accounted for, and that
 * querying the full range aggregates inside the engine instead of dragging
 * rows into Node.
 *
 * It is also the closest thing here to a regression guard on compression: if
 * ZSTD ever silently stopped being applied, bytes-per-row would jump by an
 * order of magnitude and the assertion below would catch it.
 */
import { it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resetFakeAnalyticsPool, seedGeneralPool, seedAnalyticsPool, seedTable } from './fakeAnalyticsPool';

vi.mock('../../../server/supabase.js', async () => {
  const { makeFakeSupabaseClient } = await import('./fakeAnalyticsPool');
  const client = makeFakeSupabaseClient();
  return { getServiceClient: () => client };
});
vi.mock('../../../server/services/observability/metrics.js', () => ({ emitMetric: () => undefined, emitLog: () => undefined }));

const { runSealCycle } = await import('../../../server/services/analytics/sealing.js');
const { S3ParquetWebAnalyticsStore } = await import('../../../server/services/webAnalytics/store/s3.js');
const { duckDbAvailability } = await import('../../../server/services/analytics/duckdb.js');
const { __clearAnalyticsObjectCache } = await import('../../../server/services/analytics/objectCache.js');

const WS = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
let dir: string;
let engine = false;
beforeAll(async () => { engine = (await duckDbAvailability()).available; });

beforeEach(() => {
  resetFakeAnalyticsPool();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-demo-'));
  process.env.ANALYTICS_QUERY_CACHE_DIR = path.join(dir, '.qc');
  __clearAnalyticsObjectCache();
  seedGeneralPool({ primary: 'bunny_storage', providers: {
    bunny_storage: { config: { username: 'z', password: 'p', hostname: 'storage.bunnycdn.com', cdn_url: 'https://g.b-cdn.net' } },
    local: { config: { local_path: dir, public_url: 'http://localhost:9999/files' } },
  }});
  seedAnalyticsPool({ enabled: true, primary: 'local', replicas: [], replicationEnabled: false,
    prefix: 'analytics/web/', knownPrefixes: ['analytics/web/'], batchRows: 10_000, batchBytes: 33_554_432,
    flushIntervalMs: 15_000, format: 'parquet', compression: 'zstd', writeMode: 'dual_write',
    readMode: 'postgres', replicaState: {} });
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

it('backfills two weeks of history into one object per day, and queries it whole', async () => {
  if (!engine) return;

  // 14 days of history: 40 sessions/day over 12 visitors, ~3 page views each,
  // plus custom events.
  const DAYS = 14, SESSIONS_PER_DAY = 40, VIEWS_PER_SESSION = 3, EVENTS_PER_DAY = 10;
  const sessions: Record<string, unknown>[] = [];
  const views: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];

  for (let d = 0; d < DAYS; d++) {
    const day = `2026-08-${String(10 + d).padStart(2, '0')}`;
    for (let s = 0; s < SESSIONS_PER_DAY; s++) {
      const id = `d${d}s${s}`;
      sessions.push({
        id, workspace_id: WS, visitor_id: `visitor-${s % 12}`,
        started_at: `${day}T${String(8 + (s % 12)).padStart(2, '0')}:00:00.000Z`,
        last_seen_at: `${day}T${String(8 + (s % 12)).padStart(2, '0')}:20:00.000Z`,
        current_page: 'https://shop.test/', referrer: s % 3 === 0 ? 'https://www.google.com/search' : null,
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
          url: `https://shop.test/${['', 'products', 'pricing', 'blog'][v % 4]}`,
          title: `P${v}`,
          viewed_at: `${day}T${String(8 + (s % 12)).padStart(2, '0')}:0${v}:00.000Z`,
        });
      }
    }
    for (let e = 0; e < EVENTS_PER_DAY; e++) {
      events.push({
        workspace_id: WS, visitor_session_id: `d${d}s${e}`, event_name: 'signup',
        properties: { plan: e % 2 ? 'pro' : 'free' }, page_url: 'https://shop.test/',
        created_at: `${day}T14:0${e}:00.000Z`,
      });
    }
  }

  seedTable('visitor_sessions', sessions);
  seedTable('visitor_page_views', views);
  seedTable('web_analytics_events', events);
  seedTable('analytics_day_seals', []);
  seedTable('workspace_deletion_jobs', []);

  const started = Date.now();
  const result = await runSealCycle({} as never, { now: new Date('2026-09-15T00:00:00Z').getTime(), limit: 30 });
  const elapsed = Date.now() - started;

  const objects: string[] = [];
  let bytes = 0;
  const walk = (d: string, p: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const next = p ? `${p}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(d, entry.name), next);
      else if (next.endsWith('.parquet')) { objects.push(next); bytes += fs.statSync(path.join(d, entry.name)).size; }
    }
  };
  walk(dir, '');

  const sourceRows = sessions.length * 2 + views.length + events.length;

  expect(result.sealed).toBe(DAYS);
  expect(result.failed).toBe(0);
  // Every row PostgreSQL held is accounted for, exactly.
  expect(result.rows).toBe(sourceRows);

  // ONE object per workspace-day — the small-files rule, at scale.
  expect(objects).toHaveLength(DAYS);

  // Parquet + ZSTD over 28 mostly-low-cardinality columns. A regression that
  // dropped compression would blow straight past this.
  expect(bytes / result.rows).toBeLessThan(120);
  expect(elapsed).toBeLessThan(120_000);

  // Now query the whole backfilled range through DuckDB.
  const store = new S3ParquetWebAnalyticsStore({} as never);
  const overview = await store.getOverview(WS, { startDate: '2026-08-10', endDate: '2026-08-23' });

  expect(overview.sessions).toBe(DAYS * SESSIONS_PER_DAY);
  expect(overview.pageviews).toBe(DAYS * SESSIONS_PER_DAY * VIEWS_PER_SESSION);
  // 12 distinct visitors across 560 sessions — the metric the PostgreSQL
  // path reports as 560.
  expect(overview.uniqueVisitors).toBe(12);
  // No row cap anywhere on this path, whatever the range.
  expect(overview.truncated).toBe(false);
}, 180_000);
