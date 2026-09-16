/**
 * Ingestion: the row shape the tracking routes produce, the buffering rules
 * that keep one event from becoming one object, and the unique-visitor
 * semantics the PostgreSQL report path gets wrong today.
 *
 * These are pure-module tests — no storage, no database — so they say
 * exactly what the schema and buffer do, independent of any vendor.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../server/supabase.js', async () => {
  const { makeFakeSupabaseClient } = await import('./fakeAnalyticsPool');
  const client = makeFakeSupabaseClient();
  return { getServiceClient: () => client };
});
vi.mock('../../../server/services/observability/metrics.js', () => ({
  emitMetric: () => undefined,
  emitLog: () => undefined,
}));

const {
  buildEventRow, sanitizeUrl, urlPath, referrerHost,
  analyticsDayPrefix, analyticsObjectKey, analyticsWorkspacePrefix,
  ANALYTICS_COLUMNS,
} = await import('../../../server/services/analytics/schema.js');
const { analyticsSessionFrom } = await import('../../../server/services/analytics/ingest.js');
const { enqueueAnalyticsRow, bufferedRowCount, __resetAnalyticsBuffer } =
  await import('../../../server/services/analytics/writer.js');
const { normalizeAnalyticsPool, normalizeAnalyticsPrefix, ANALYTICS_DEFAULTS } =
  await import('../../../server/services/analytics/pool.js');

const serverConfig = {} as never;
const WS = '11111111-1111-1111-1111-111111111111';

beforeEach(() => { __resetAnalyticsBuffer(); });

describe('event row shape', () => {
  it('carries visitor_id on every row, which is what makes unique visitors computable', () => {
    const row = buildEventRow({
      workspaceId: WS,
      eventType: 'page_view',
      url: 'https://shop.test/a',
      session: { visitorId: 'visitor-7', sessionId: 'session-3' },
    });
    expect(row.visitor_id).toBe('visitor-7');
    expect(row.session_id).toBe('session-3');
    expect(ANALYTICS_COLUMNS.map((c) => c.name)).toContain('visitor_id');
  });

  it('counts one visitor across many sessions — the bug the PostgreSQL path has today', () => {
    // Visitor A has three sessions, visitor B has one: 4 sessions, 2 visitors.
    const rows = [
      ['A', 's1'], ['A', 's2'], ['A', 's3'], ['B', 's4'],
    ].map(([visitorId, sessionId]) =>
      buildEventRow({
        workspaceId: WS, eventType: 'page_view', url: 'https://shop.test/',
        session: { visitorId, sessionId },
      }));

    expect(new Set(rows.map((r) => r.session_id)).size).toBe(4);
    expect(new Set(rows.map((r) => r.visitor_id)).size).toBe(2);
  });

  it('denormalizes session dimensions onto the row so reports need no join', () => {
    const row = buildEventRow({
      workspaceId: WS,
      eventType: 'page_view',
      url: 'https://shop.test/pricing',
      session: {
        visitorId: 'v', sessionId: 's',
        referrer: 'https://www.google.com/search',
        utmSource: 'newsletter', utmMedium: 'email', utmCampaign: 'spring',
        browser: 'Firefox', device: 'Mobile', os: 'iOS', language: 'fa-IR',
        country: 'Iran', countryCode: 'IR', city: 'Tehran',
      },
    });
    expect(row.referrer_domain).toBe('google.com');
    expect(row.utm_source).toBe('newsletter');
    expect(row.browser).toBe('Firefox');
    expect(row.country_code).toBe('IR');
    expect(row.city).toBe('Tehran');
  });

  it('stamps a schema version so a later column addition stays readable', () => {
    const row = buildEventRow({ workspaceId: WS, eventType: 'session_start', session: {} });
    expect(row.schema_version).toBeGreaterThanOrEqual(1);
  });

  it('gives every row a distinct id, even within the same millisecond', () => {
    const ids = Array.from({ length: 500 }, () =>
      buildEventRow({ workspaceId: WS, eventType: 'page_view', session: {} }).event_id);
    expect(new Set(ids).size).toBe(500);
  });

  it('serializes custom-event properties as JSON text', () => {
    const row = buildEventRow({
      workspaceId: WS, eventType: 'custom_event', eventName: 'signup_completed',
      properties: { plan: 'pro', seats: 3 }, session: {},
    });
    expect(row.event_name).toBe('signup_completed');
    expect(JSON.parse(row.properties!)).toEqual({ plan: 'pro', seats: 3 });
  });

  it('leaves properties null rather than writing an empty object on every page view', () => {
    const row = buildEventRow({ workspaceId: WS, eventType: 'page_view', properties: {}, session: {} });
    expect(row.properties).toBeNull();
  });
});

describe('privacy', () => {
  it('drops the query string and fragment from stored URLs', () => {
    expect(sanitizeUrl('https://shop.test/reset?token=abc123&email=a@b.test#section'))
      .toBe('https://shop.test/reset');
  });

  it('drops the query string from stored referrers too', () => {
    const row = buildEventRow({
      workspaceId: WS, eventType: 'page_view',
      session: { referrer: 'https://mail.test/inbox?session=secret' },
    });
    expect(row.referrer).toBe('https://mail.test/inbox');
    expect(row.referrer).not.toContain('secret');
  });

  it('carries no IP field at all — neither raw nor hashed', () => {
    const row = buildEventRow({
      workspaceId: WS, eventType: 'page_view', session: { visitorId: 'v', sessionId: 's' },
    });
    expect(Object.keys(row)).not.toContain('ip_hash');
    expect(Object.keys(row)).not.toContain('ip_raw');
    expect(ANALYTICS_COLUMNS.map((c) => c.name).some((n) => n.includes('ip'))).toBe(false);
  });

  it('never carries an IP even when the session row it maps from has one', () => {
    const dimensions = analyticsSessionFrom('s1', 'v1', {
      ip_hash: 'deadbeef', ip_raw: '203.0.113.9', browser: 'Chrome', started_at: '2026-09-16T10:00:00Z',
    });
    expect(JSON.stringify(dimensions)).not.toContain('203.0.113.9');
    expect(JSON.stringify(dimensions)).not.toContain('deadbeef');
    expect(dimensions.browser).toBe('Chrome');
  });
});

describe('session dimension mapping', () => {
  it('prefers MaxMind-resolved geo over the original tracker columns, as the reports do', () => {
    const dimensions = analyticsSessionFrom('s1', 'v1', {
      country: 'IR', city: 'tehran',
      geo_country_name: 'Iran', geo_country_code: 'IR', geo_city: 'Tehran',
    });
    expect(dimensions.country).toBe('Iran');
    expect(dimensions.city).toBe('Tehran');
    expect(dimensions.countryCode).toBe('IR');
  });

  it('lets the current request override a stale stored value', () => {
    const dimensions = analyticsSessionFrom('s1', 'v1', { browser: 'Safari' }, { browser: 'Chrome' });
    expect(dimensions.browser).toBe('Chrome');
  });

  it('survives a missing session row without inventing values', () => {
    const dimensions = analyticsSessionFrom('s1', 'v1', null);
    expect(dimensions.sessionId).toBe('s1');
    expect(dimensions.visitorId).toBe('v1');
    expect(dimensions.browser).toBeNull();
    expect(dimensions.country).toBeNull();
  });
});

describe('path normalization', () => {
  it('matches the grouping the existing reports already use', () => {
    expect(urlPath(sanitizeUrl('https://shop.test/products/'))).toBe('/products');
    expect(urlPath(sanitizeUrl('https://shop.test/'))).toBe('/');
    expect(urlPath(sanitizeUrl('https://shop.test'))).toBe('/');
    expect(urlPath(sanitizeUrl('https://shop.test/a/b?x=1'))).toBe('/a/b');
  });

  it('strips www from a referrer host and returns null for a direct visit', () => {
    expect(referrerHost('https://www.google.com/search?q=x')).toBe('google.com');
    expect(referrerHost(null)).toBeNull();
    expect(referrerHost('not a url')).toBeNull();
  });
});

describe('object layout', () => {
  const when = new Date('2026-09-16T20:31:00.000Z');

  it('partitions by workspace first, then date, in hive-style segments', () => {
    expect(analyticsDayPrefix('analytics/web/', WS, when))
      .toBe(`analytics/web/workspace=${WS}/year=2026/month=09/day=16/`);
  });

  it('gives every workspace a single listable, purgeable prefix', () => {
    expect(analyticsWorkspacePrefix('analytics/web/', WS)).toBe(`analytics/web/workspace=${WS}/`);
  });

  it('keeps analytics objects out of the general storage roots', () => {
    const key = analyticsObjectKey('analytics/web/', WS, when);
    expect(key.startsWith('analytics/')).toBe(true);
    for (const root of ['workspace/', 'users/', 'platform/']) {
      expect(key.startsWith(root)).toBe(false);
    }
    expect(key.endsWith('.parquet')).toBe(true);
  });

  it('never produces the same object key twice', () => {
    const keys = new Set(Array.from({ length: 200 }, () => analyticsObjectKey('analytics/web/', WS, when)));
    expect(keys.size).toBe(200);
  });
});

describe('prefix normalization', () => {
  it('canonicalizes whatever an operator types into one safe shape', () => {
    expect(normalizeAnalyticsPrefix('/analytics/web')).toBe('analytics/web/');
    expect(normalizeAnalyticsPrefix('analytics/web///')).toBe('analytics/web/');
    expect(normalizeAnalyticsPrefix('   ')).toBe(ANALYTICS_DEFAULTS.prefix);
  });

  it('strips traversal so an operator-supplied prefix can never escape', () => {
    expect(normalizeAnalyticsPrefix('../../workspace')).not.toContain('..');
    expect(normalizeAnalyticsPrefix('a\\b')).not.toContain('\\');
  });
});

describe('buffering — one event is never one object', () => {
  const pool = normalizeAnalyticsPool({
    enabled: true, primary: 'local', replicas: [], prefix: 'analytics/web/',
    batchRows: 1000, batchBytes: 32 * 1024 * 1024, flushIntervalMs: 15_000,
  });

  const row = (workspaceId = WS, occurredAt?: string) =>
    buildEventRow({
      workspaceId, eventType: 'page_view', occurredAt: occurredAt ?? null,
      url: 'https://shop.test/a', session: { visitorId: 'v', sessionId: 's' },
    });

  it('accumulates rows instead of writing each one', () => {
    for (let i = 0; i < 50; i++) enqueueAnalyticsRow(serverConfig, pool, row());
    expect(bufferedRowCount()).toBe(50);
  });

  it('keeps separate buffers per workspace and per day, so one object never straddles a partition', () => {
    enqueueAnalyticsRow(serverConfig, pool, row(WS, '2026-09-15T10:00:00.000Z'));
    enqueueAnalyticsRow(serverConfig, pool, row(WS, '2026-09-16T10:00:00.000Z'));
    enqueueAnalyticsRow(serverConfig, pool, row('22222222-2222-2222-2222-222222222222', '2026-09-16T10:00:00.000Z'));
    expect(bufferedRowCount()).toBe(3);
  });
});

describe('pool normalization', () => {
  it('starts disabled, so a deploy alone never begins writing objects', () => {
    const pool = normalizeAnalyticsPool(undefined);
    expect(pool.enabled).toBe(false);
    expect(pool.primary).toBeNull();
    expect(pool.writeMode).toBe('dual_write');
    expect(pool.readMode).toBe('postgres');
  });

  it('drops a primary that is not eligible rather than trusting a stored value', () => {
    expect(normalizeAnalyticsPool({ primary: 'bunny_storage' }).primary).toBeNull();
    expect(normalizeAnalyticsPool({ primary: 'arvan_storage' }).primary).toBe('arvan_storage');
  });

  it('never lets the primary appear in its own replica list', () => {
    const pool = normalizeAnalyticsPool({ primary: 'minio', replicas: ['minio', 'cloudflare_r2'] });
    expect(pool.replicas).toEqual(['cloudflare_r2']);
  });

  it('clamps batch settings into a workable range', () => {
    const tiny = normalizeAnalyticsPool({ batchRows: 1, batchBytes: 1, flushIntervalMs: 1 });
    expect(tiny.batchRows).toBeGreaterThanOrEqual(100);
    expect(tiny.flushIntervalMs).toBeGreaterThanOrEqual(1000);

    const huge = normalizeAnalyticsPool({ batchRows: 10_000_000, flushIntervalMs: 10 ** 9 });
    expect(huge.batchRows).toBeLessThanOrEqual(500_000);
    expect(huge.flushIntervalMs).toBeLessThanOrEqual(300_000);
  });

  it('pins the canonical format', () => {
    const pool = normalizeAnalyticsPool({ format: 'json', compression: 'gzip' });
    expect(pool.format).toBe('parquet');
    expect(pool.compression).toBe('zstd');
  });
});
