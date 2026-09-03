/**
 * SEO feature — full backend/worker pipeline smoke test.
 *
 * Exercises the REAL production modules end to end against a fake in-memory
 * database and a fake network layer (only `getServiceClient`, plan lookup,
 * and the outbound `seoFetch` transport are faked — everything else,
 * including authorization, the job queue, the crawler orchestrator, link-
 * graph finalization, the rules engine and the scoring model, is the actual
 * shipped code):
 *
 *   createCrawl({workspaceId, siteId}) [NO url param — proves the client
 *     cannot supply a crawl URL at the type level]
 *   -> background_jobs row enqueued
 *   -> claimNextJob() (the worker's claim)
 *   -> processCrawl() [worker/seo-crawler/index.ts's real orchestration:
 *      crawlSite -> finalizeLinkGraph -> evaluateAndPersistIssues ->
 *      computeSeoScore -> mark completed -> completeJob]
 *   -> getCrawl()/listCrawlPages()/listCrawlIssues() return the completed,
 *      normalized audit.
 *
 * Also proves, inline, several of the security/queue invariants the spec
 * requires: cross-workspace site rejection, external links recorded but
 * never fetched, a second worker cannot claim the same job, and job
 * ownership (heartbeat) cannot be hijacked by an attacker who only knows
 * the job id.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeFakeSupabase, type FakeTables } from './testUtils/fakeSupabase.js';

process.env.AI_KB_IGNORE_ROBOTS = '1'; // avoid a second, redundant robots.txt fetch through ai-agent's robots.ts
// worker/seo-crawler/index.ts derives its own WORKER_ID from this env var (falling
// back to a random value) — pin it so this test's claimNextJob() call and the
// module's internal heartbeat/claim calls inside processCrawl() use the SAME
// worker identity, exactly like a real deployed worker process would.
process.env.WORKER_ID = 'worker-1';

const WORKSPACE_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const WORKSPACE_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const SITE_A = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const USER_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

let tables: FakeTables;
let fakeSb: ReturnType<typeof makeFakeSupabase>;
const fetchedUrls: string[] = [];

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeSb }));
vi.mock('../../../server/middleware/featureGating.js', () => ({ getWorkspacePlanInfo: vi.fn(async () => null) }));

function normalizePath(url: string): string {
  const u = new URL(url);
  return `${u.origin}${u.pathname === '/' ? '/' : u.pathname}`;
}

async function fakeFetchImpl(url: string): Promise<any> {
  fetchedUrls.push(url);
  const path = normalizePath(url);
  const base = { finalUrl: url, redirectChain: [] as any[], responseTimeMs: 4, headers: {} as Record<string, string> };

  if (path === 'https://example.com/robots.txt') {
    return { ...base, ok: true, status: 200, contentType: 'text/plain', html: 'User-agent: *\nDisallow:\nSitemap: https://example.com/sitemap.xml\n' };
  }
  if (path === 'https://example.com/sitemap.xml') {
    return {
      ...base, ok: true, status: 200, contentType: 'application/xml',
      html: '<?xml version="1.0"?><urlset><url><loc>https://example.com/</loc></url><url><loc>https://example.com/about</loc></url></urlset>',
    };
  }
  if (path === 'https://example.com/') {
    return {
      ...base, ok: true, status: 200, contentType: 'text/html',
      html: '<html><head><title>Home</title></head><body>'
        + '<a href="/about">About</a> <a href="/missing">Broken</a> <a href="https://external-site.test/page">External</a>'
        + '<p>Home page body copy with enough visible words to clear the thin-content threshold used by the rules engine in this smoke test.</p>'
        + '</body></html>',
    };
  }
  if (path === 'https://example.com/about') {
    return {
      ...base, ok: true, status: 200, contentType: 'text/html',
      html: '<html><head><title>About</title></head><body>'
        + '<a href="/">Home</a>'
        + '<p>About page body copy with enough visible words to clear the thin-content threshold used by the rules engine in this smoke test.</p>'
        + '</body></html>',
    };
  }
  if (path === 'https://example.com/missing') {
    return { ...base, ok: false, status: 404, error: 'http_404' };
  }
  throw new Error(`unexpected fetch in e2e smoke test: ${url}`);
}

vi.mock('../../../server/services/seo/crawler/seoFetch.js', () => ({
  seoFetch: vi.fn((url: string) => fakeFetchImpl(url)),
}));

const { resolveWorkspaceSite, SiteResolutionError } = await import('../../../server/services/seo/siteResolver.js');
const { createCrawl, getCrawl, listCrawlPages, listCrawlIssues } = await import('../../../server/services/seo/crawlService.js');
const { claimNextJob, heartbeatJob, getJob, requestJobCancel } = await import('../../../server/services/jobs/queue.js');
const { processCrawl } = await import('../../../worker/seo-crawler/index.js');

function seedTables(): FakeTables {
  const now = new Date().toISOString();
  return {
    workspace_domains: [
      { id: SITE_A, workspace_id: WORKSPACE_A, domain: 'example.com', verified: false, is_primary: true, created_at: now },
    ],
    background_jobs: [],
    seo_crawls: [],
    seo_pages: [],
    seo_links: [],
    seo_issues: [],
    seo_issue_pages: [],
    seo_sitemaps: [],
  };
}

const config = {} as any;

describe('SEO end-to-end backend/worker pipeline', () => {
  beforeEach(() => {
    tables = seedTables();
    fakeSb = makeFakeSupabase(tables);
    fetchedUrls.length = 0;
  });

  it('resolves the canonical crawl URL from the DB — createCrawl takes NO url argument', async () => {
    // Type-level proof: this call compiles with exactly {workspaceId, siteId, userId}.
    // Adding a `url` field here would be a TS error against CreateCrawlArgs — there is
    // no code path in this feature that accepts a client-supplied URL.
    const crawl = await createCrawl(config, { workspaceId: WORKSPACE_A, siteId: SITE_A, userId: USER_ID });
    expect(crawl.canonical_url).toBe('https://example.com');
    expect(crawl.status).toBe('queued');
  });

  it('rejects starting a crawl for a site that belongs to a different workspace', async () => {
    await expect(createCrawl(config, { workspaceId: WORKSPACE_B, siteId: SITE_A, userId: USER_ID }))
      .rejects.toBeInstanceOf(SiteResolutionError);
    await expect(resolveWorkspaceSite(config, WORKSPACE_B, SITE_A)).rejects.toMatchObject({ code: 'site_not_found' });
  });

  it('runs the full pipeline to a completed, normalized, scored audit', async () => {
    const crawl = await createCrawl(config, { workspaceId: WORKSPACE_A, siteId: SITE_A, userId: USER_ID });

    // The worker's claim: a job the client never touches, keyed only by job_type.
    const job = await claimNextJob(config, { jobTypes: ['seo_crawl'], workerId: 'worker-1', lockTtlSeconds: 120 });
    expect(job).toBeTruthy();
    expect(job!.status).toBe('running');
    expect(job!.locked_by).toBe('worker-1');

    // A second worker polling concurrently must NOT be able to claim the same job.
    const secondClaim = await claimNextJob(config, { jobTypes: ['seo_crawl'], workerId: 'worker-2', lockTtlSeconds: 120 });
    expect(secondClaim).toBeNull();

    // An attacker who only knows the job id (no valid workerId) cannot hijack progress reporting.
    const hijackAttempt = await heartbeatJob(config, { jobId: job!.id, workerId: 'attacker', lockTtlSeconds: 120, progress: 99 });
    expect(hijackAttempt.ok).toBe(false);

    const crawlRow = tables.seo_crawls.find((c) => c.job_id === job!.id);
    expect(crawlRow).toBeTruthy();

    await processCrawl(config, job!.id, crawlRow);

    const finalJob = await getJob(config, job!.id);
    expect(finalJob?.status).toBe('completed');

    const completed = await getCrawl(config, WORKSPACE_A, crawl.id);
    expect(completed?.status).toBe('completed');
    expect(completed?.score).not.toBeNull();
    expect(completed?.score).toBeGreaterThanOrEqual(0);
    expect(completed?.score).toBeLessThanOrEqual(100);
    expect(completed?.score_version).toBe('v1');
    expect(completed?.pages_crawled).toBe(2); // /, /about (fetched successfully)
    expect(completed?.pages_failed).toBe(1); // /missing (404)

    const { pages } = await listCrawlPages(config, WORKSPACE_A, crawl.id, { limit: 50 });
    expect(pages.map((p: any) => p.url).sort()).toEqual([
      'https://example.com/', 'https://example.com/about', 'https://example.com/missing',
    ]);
    const missingPage = pages.find((p: any) => p.url === 'https://example.com/missing');
    expect(missingPage.http_status).toBe(404);

    const { issues } = await listCrawlIssues(config, WORKSPACE_A, crawl.id, { limit: 100 });
    expect(issues.some((i: any) => i.issue_type === 'http_4xx')).toBe(true);

    // External link recorded for reporting, but the crawler must never have fetched it.
    const externalLink = tables.seo_links.find((l) => l.target_url.includes('external-site.test'));
    expect(externalLink).toBeTruthy();
    expect(externalLink.is_external).toBe(true);
    expect(fetchedUrls.some((u) => u.includes('external-site.test'))).toBe(false);

    // Sitemap discovered and recorded.
    expect(tables.seo_sitemaps).toHaveLength(1);
    expect(tables.seo_sitemaps[0].status).toBe('valid');
    expect(tables.seo_sitemaps[0].url_count).toBe(2);
  });

  it('honors a cancellation requested mid-crawl', async () => {
    const crawl = await createCrawl(config, { workspaceId: WORKSPACE_A, siteId: SITE_A, userId: USER_ID });
    const job = await claimNextJob(config, { jobTypes: ['seo_crawl'], workerId: 'worker-1', lockTtlSeconds: 120 });
    await requestJobCancel(config, job!.id);

    const crawlRow = tables.seo_crawls.find((c) => c.job_id === job!.id);
    await processCrawl(config, job!.id, crawlRow);

    const finalJob = await getJob(config, job!.id);
    expect(finalJob?.status).toBe('cancelled');
    const cancelled = await getCrawl(config, WORKSPACE_A, crawl.id);
    expect(cancelled?.status).toBe('cancelled');
  });
});
