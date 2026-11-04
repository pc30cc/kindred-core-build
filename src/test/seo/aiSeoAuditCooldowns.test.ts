/**
 * The plans' SEO and Brand Radar cooldowns are enforced (audit ai-3,
 * 2026-11-04). They were configured, shown and documented, and their
 * "most recent run" helpers existed, but no create path called them:
 *   - an audit (crawl), a backlink scan, a keyword lookup and a performance
 *     audit started inside the plan's cooldown are refused with
 *     `frequency_limit` and retryAfterSeconds, before any job is queued;
 *   - a manual rank check (a synchronous paid SERP call) is throttled to one
 *     per keyword per hour;
 *   - both Brand Radar "run checks now" triggers honour
 *     `brand_radar_check_frequency_hours` and never run twice at once.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

const WS = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222222';
const CRAWL = '33333333-3333-4333-8333-333333333333';
const KEYWORD = '44444444-4444-4444-8444-444444444444';

const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

type Row = Record<string, unknown>;
let TABLES: Record<string, Row[]> = {};

function fakeClient() {
  return {
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      let ordered = false;
      const rows = () => {
        const out = (TABLES[table] || []).filter((r) => filters.every((f) => f(r)));
        return ordered ? [...out].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))) : out;
      };
      const q = {
        select: () => q,
        order: () => { ordered = true; return q; },
        limit: () => q,
        range: () => q,
        insert: () => q,
        update: () => q,
        eq: (col: string, val: unknown) => {
          filters.push((r) => r[col] === val);
          return q;
        },
        in: (col: string, vals: unknown[]) => {
          filters.push((r) => vals.includes(r[col]));
          return q;
        },
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        single: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (resolve: (v: { data: Row[]; error: null; count: number }) => unknown) =>
          resolve({ data: rows(), error: null, count: rows().length }),
      };
      return q;
    },
  };
}

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient() }));

const enqueued: string[] = [];
vi.mock('../../../server/services/jobs/queue.js', () => ({
  enqueueJob: async (_c: unknown, args: { jobType: string }) => {
    enqueued.push(args.jobType);
    throw new Error('ENQUEUED');
  },
  requestJobCancel: async () => {},
  cancelQueuedJob: async () => {},
  getJob: async () => null,
}));

vi.mock('../../../server/services/seo/siteResolver.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/seo/siteResolver.js')>()),
  resolveWorkspaceSite: async () => ({ id: SITE, canonicalUrl: 'https://shop.example/', domain: 'shop.example' }),
}));

let LIMITS: Record<string, number> = {};
const limitsOf = () => ({ limits: { ...LIMITS }, planSlug: 'pro', planName: 'Pro' });
vi.mock('../../../server/services/seo/limits.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/seo/limits.js')>()),
  resolveSeoLimits: async () => limitsOf(),
  countActiveWorkspaceCrawls: async () => 0,
  countActiveSiteCrawls: async () => 0,
}));
vi.mock('../../../server/services/seo/backlinksLimits.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/seo/backlinksLimits.js')>()),
  resolveBacklinksLimits: async () => limitsOf(),
  countActiveWorkspaceBacklinkScans: async () => 0,
}));
vi.mock('../../../server/services/seo/keywordsLimits.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/seo/keywordsLimits.js')>()),
  resolveKeywordsLimits: async () => limitsOf(),
  countActiveWorkspaceKeywordRuns: async () => 0,
}));
vi.mock('../../../server/services/seo/performanceLimits.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/seo/performanceLimits.js')>()),
  resolvePerformanceLimits: async () => limitsOf(),
}));
vi.mock('../../../server/services/seo/canonicalRepository.js', () => ({
  getCrawlPages: async () => [],
  getCrawlLinks: async () => [],
}));

const rankChecks: string[] = [];
let releaseRankCheck: (() => void) | null = null;
vi.mock('../../../server/services/seo/rankTrackingTicker.js', () => ({
  checkOneKeyword: async (_c: unknown, row: { id: string }) => {
    rankChecks.push(row.id);
    if (releaseRankCheck === null) return;
    await new Promise<void>((resolve) => { releaseRankCheck = resolve; });
  },
}));

// Brand Radar route: everything but the throttle is mocked.
vi.mock('../../../server/lib/workspaceAuth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/lib/workspaceAuth.js')>()),
  authorizeWorkspaceAccess: async () => ({ userId: 'owner', isAdmin: false, role: 'owner' }),
}));
vi.mock('../../../server/middleware/featureGating.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/middleware/featureGating.js')>()),
  requireModule: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../../server/services/brandRadar/limits.js', () => ({
  resolveBrandRadarLimits: async () => limitsOf(),
}));
vi.mock('../../../server/services/brandRadar/settingsService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/brandRadar/settingsService.js')>()),
  getSettings: async () => ({ brandName: 'Shop', competitorNames: ['Rival'], siteId: SITE }),
  listTopics: async () => [{ id: 't1', topic: 'shoes' }],
}));
const radarRuns: string[] = [];
let holdRadar: Promise<void> | null = null;
vi.mock('../../../server/services/brandRadar/aiVisibilityService.js', () => ({
  runAllTopicsAiVisibility: async () => {
    radarRuns.push('ai');
    if (holdRadar) await holdRadar;
    return { results: [], errors: [] };
  },
  getLatestAiChecksByTopic: async () => [],
  getAiCheckHistory: async () => [],
}));
vi.mock('../../../server/services/brandRadar/webVisibilityService.js', () => ({
  runAllTermsWebVisibility: async () => {
    radarRuns.push('web');
    return { results: [], errors: [] };
  },
  getLatestWebChecks: async () => [],
  getWebCheckHistory: async () => [],
  isWebVisibilityAvailable: async () => true,
}));

const { cooldownRetryAfterSeconds } = await import('../../../server/services/seo/cooldown.js');
const { createCrawl, CrawlLimitError } = await import('../../../server/services/seo/crawlService.js');
const { createBacklinkScan } = await import('../../../server/services/seo/backlinkService.js');
const { createKeywordResearchRun } = await import('../../../server/services/seo/keywordResearchService.js');
const { createPerformanceAudit } = await import('../../../server/services/seo/performanceAuditService.js');
const { checkTrackedKeywordNow } = await import('../../../server/services/seo/rankTrackingService.js');
const { brandRadarRouter } = await import('../../../server/routes/brandRadar.js');

const CONFIG = { supabaseUrl: 'https://example.supabase.co', supabaseServiceRoleKey: 'k' } as never;

beforeEach(() => {
  enqueued.length = 0;
  rankChecks.length = 0;
  radarRuns.length = 0;
  releaseRankCheck = null;
  holdRadar = null;
  LIMITS = {
    seo_workspace_concurrent_jobs: 5,
    seo_site_concurrent_jobs: 5,
    seo_crawl_frequency_hours: 24,
    seo_backlinks_max_per_scan: 100,
    seo_backlinks_workspace_concurrent_scans: 5,
    seo_backlinks_scan_frequency_hours: 168,
    seo_keywords_max_per_lookup: 10,
    seo_keywords_workspace_concurrent_runs: 5,
    seo_keywords_lookup_frequency_hours: 24,
    seo_performance_max_pages_per_audit: 5,
    seo_performance_audit_frequency_hours: 168,
    brand_radar_check_frequency_hours: 12,
  };
  TABLES = {
    seo_crawls: [{ id: CRAWL, workspace_id: WS, website_id: SITE, created_at: ago(2 * HOUR) }],
    seo_backlink_scans: [{ id: 'b1', workspace_id: WS, website_id: SITE, created_at: ago(2 * HOUR) }],
    seo_keyword_research_runs: [{ id: 'k1', workspace_id: WS, website_id: SITE, created_at: ago(2 * HOUR) }],
    seo_performance_audits: [{ id: 'p1', workspace_id: WS, crawl_id: CRAWL, created_at: ago(2 * HOUR) }],
    seo_tracked_keywords: [{
      id: KEYWORD, workspace_id: WS, website_id: SITE, keyword: 'shoes', device: 'desktop',
      location_code: null, last_checked_at: ago(10 * 60_000),
    }],
    brand_radar_ai_checks: [{ id: 'a1', workspace_id: WS, created_at: ago(2 * HOUR) }],
    brand_radar_web_checks: [{ id: 'w1', workspace_id: WS, created_at: ago(2 * HOUR) }],
    workspace_domains: [{ id: SITE, domain: 'shop.example' }],
  };
});

describe('cooldownRetryAfterSeconds', () => {
  const now = Date.parse('2026-11-04T12:00:00Z');
  it('waits out the rest of the cooldown', () => {
    expect(cooldownRetryAfterSeconds('2026-11-04T11:00:00Z', 24, now)).toBe(23 * 3600);
  });
  it('lets a run start once the cooldown has passed', () => {
    expect(cooldownRetryAfterSeconds('2026-11-03T11:00:00Z', 24, now)).toBe(0);
  });
  it('waits for nothing without an earlier run, or with no cooldown (0 or -1)', () => {
    expect(cooldownRetryAfterSeconds(null, 24, now)).toBe(0);
    expect(cooldownRetryAfterSeconds('2026-11-04T11:59:00Z', 0, now)).toBe(0);
    expect(cooldownRetryAfterSeconds('2026-11-04T11:59:00Z', -1, now)).toBe(0);
  });
  it('never answers 0 while a wait remains, and ignores a broken date', () => {
    expect(cooldownRetryAfterSeconds('2026-11-04T11:59:59.900Z', 1, now)).toBeGreaterThan(0);
    expect(cooldownRetryAfterSeconds('not a date', 24, now)).toBe(0);
  });
});

describe('the SEO runs honour their plan cooldowns', () => {
  const cases: Array<[string, () => Promise<unknown>, string, number]> = [
    ['an audit (crawl)', () => createCrawl(CONFIG, { workspaceId: WS, siteId: SITE, userId: 'u' }), 'seo_crawl_frequency_hours', 24],
    ['a backlink scan', () => createBacklinkScan(CONFIG, { workspaceId: WS, siteId: SITE, userId: 'u' }), 'seo_backlinks_scan_frequency_hours', 168],
    ['a keyword lookup', () => createKeywordResearchRun(CONFIG, { workspaceId: WS, siteId: SITE, userId: 'u', seedKeywords: ['shoes'] }), 'seo_keywords_lookup_frequency_hours', 24],
    ['a performance audit', () => createPerformanceAudit(CONFIG, { workspaceId: WS, crawlId: CRAWL, userId: 'u' }), 'seo_performance_audit_frequency_hours', 168],
  ];

  it.each(cases)('%s inside the cooldown is refused before a job is queued', async (_label, run, _key, hours) => {
    const err = await run().then(() => null, (e: unknown) => e as { reason?: string; retryAfterSeconds?: number; message?: string });
    expect(err?.reason).toBe('frequency_limit');
    expect(err?.retryAfterSeconds).toBeGreaterThan((hours - 2) * 3600 - 60);
    expect(err?.retryAfterSeconds).toBeLessThanOrEqual((hours - 2) * 3600 + 60);
    expect(enqueued).toEqual([]);
  });

  it.each(cases)('%s with no cooldown on the plan (-1) goes ahead', async (_label, run, key) => {
    LIMITS[key] = -1;
    await expect(run()).rejects.toThrow('ENQUEUED');
    expect(enqueued).toHaveLength(1);
  });

  it('the crawl error is the one the route answers 429 for', async () => {
    await expect(createCrawl(CONFIG, { workspaceId: WS, siteId: SITE, userId: 'u' })).rejects.toBeInstanceOf(CrawlLimitError);
  });
});

describe('a manual rank check is throttled', () => {
  it('refuses a keyword checked within the hour, with the wait', async () => {
    await expect(checkTrackedKeywordNow(CONFIG, WS, KEYWORD)).rejects.toMatchObject({ reason: 'frequency_limit' });
    expect(rankChecks).toEqual([]);
  });

  it('checks a keyword last checked over an hour ago, once at a time', async () => {
    TABLES.seo_tracked_keywords[0].last_checked_at = ago(2 * HOUR);
    releaseRankCheck = () => {};
    const first = checkTrackedKeywordNow(CONFIG, WS, KEYWORD);
    await vi.waitFor(() => expect(rankChecks).toHaveLength(1));
    await expect(checkTrackedKeywordNow(CONFIG, WS, KEYWORD)).rejects.toMatchObject({ reason: 'frequency_limit' });
    releaseRankCheck!();
    await first;
    expect(rankChecks).toEqual([KEYWORD]);
  });

  it('an unknown keyword is not found, not a duplicate', async () => {
    await expect(checkTrackedKeywordNow(CONFIG, WS, '55555555-5555-4555-8555-555555555555'))
      .rejects.toMatchObject({ reason: 'keyword_not_found' });
  });
});

describe('Brand Radar "run checks now" honours brand_radar_check_frequency_hours', () => {
  const app = express();
  app.use((req, _res, next) => {
    (req as express.Request & { serverConfig?: unknown }).serverConfig = CONFIG;
    next();
  });
  app.use(express.json());
  app.use('/api/brand-radar', brandRadarRouter);
  const server = http.createServer(app).listen(0);
  afterAll(() => {
    server.close();
  });

  function post(path: string) {
    const port = (server.address() as AddressInfo).port;
    return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path, method: 'POST' }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode || 0, body: d ? JSON.parse(d) : {} }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  it.each(['ai', 'web'])('the %s run inside the cooldown is refused with the wait', async (kind) => {
    const r = await post(`/api/brand-radar/${WS}/${kind}-visibility/run`);
    expect(r.status).toBe(429);
    expect(r.body.error).toBe('frequency_limit');
    expect(r.body.retryAfterHours).toBe(10);
    expect(radarRuns).toEqual([]);
  });

  it.each(['ai', 'web'])('the %s run goes ahead once the cooldown has passed', async (kind) => {
    LIMITS.brand_radar_check_frequency_hours = 1;
    const r = await post(`/api/brand-radar/${WS}/${kind}-visibility/run`);
    expect(r.status).toBe(200);
    expect(radarRuns).toEqual([kind]);
  });

  it('never runs twice at once, even with no cooldown on the plan', async () => {
    LIMITS.brand_radar_check_frequency_hours = -1;
    let release!: () => void;
    holdRadar = new Promise<void>((resolve) => { release = resolve; });
    const first = post(`/api/brand-radar/${WS}/ai-visibility/run`);
    await vi.waitFor(() => expect(radarRuns).toEqual(['ai']));
    const second = await post(`/api/brand-radar/${WS}/ai-visibility/run`);
    expect(second.status).toBe(429);
    release();
    expect((await first).status).toBe(200);
    const third = await post(`/api/brand-radar/${WS}/ai-visibility/run`);
    expect(third.status).toBe(200);
    expect(radarRuns).toEqual(['ai', 'ai']);
  });
});
