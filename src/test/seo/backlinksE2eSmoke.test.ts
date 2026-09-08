/**
 * SEO Backlinks — full backend/worker pipeline smoke test. Mirrors
 * src/test/seo/e2eSmoke.test.ts's shape: exercises the REAL production
 * modules end to end against a fake in-memory database (authorization, the
 * job queue, and the plan-limit resolver are all the actual shipped code).
 * Only the outbound vendor call (`fetchBacklinksForTarget`, the equivalent
 * of e2eSmoke's `seoFetch` transport fake) is faked.
 *
 *   createBacklinkScan({workspaceId, siteId}) [NO url param]
 *   -> background_jobs row enqueued
 *   -> claimNextJob() (the worker's claim)
 *   -> processBacklinkScan() [worker/seo-backlinks/processScan.ts's real
 *      orchestration, invoked from the SAME unified poller as the crawler
 *      (worker/seo-crawler/index.ts): fetchBacklinksForTarget -> normalize
 *      -> insert seo_backlinks -> mark completed -> completeJob]
 *   -> getBacklinkScan()/listBacklinks() return the completed, normalized scan.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeFakeSupabase, type FakeTables } from './testUtils/fakeSupabase.js';

const WORKER_ID = 'worker-1';

const WORKSPACE_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const WORKSPACE_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const SITE_A = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const USER_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

let tables: FakeTables;
let fakeSb: ReturnType<typeof makeFakeSupabase>;

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeSb }));
vi.mock('../../../server/middleware/featureGating.js', () => ({
  getWorkspacePlanInfo: vi.fn(async () => ({ plan: { slug: 'pro', name: 'Pro' }, limits: {} })),
}));
vi.mock('../../../server/services/seo/backlinks/index.js', () => ({
  fetchBacklinksForTarget: vi.fn(async (_config: unknown, target: string) => ({
    provider: 'dataforseo',
    result: {
      items: [
        {
          sourceUrl: 'https://ref1.example/page', sourceDomain: 'ref1.example', targetUrl: target,
          anchorText: 'link', isDofollow: true, isNew: true, isLost: false,
          pageRank: 200, domainRank: 300, spamScore: 2,
          firstSeen: '2026-01-01T00:00:00.000Z', lastSeen: '2026-02-01T00:00:00.000Z',
        },
        {
          sourceUrl: 'https://ref2.example/page', sourceDomain: 'ref2.example', targetUrl: target,
          anchorText: null, isDofollow: false, isNew: false, isLost: false,
          pageRank: 50, domainRank: 90, spamScore: 10,
          firstSeen: '2025-01-01T00:00:00.000Z', lastSeen: '2026-01-01T00:00:00.000Z',
        },
      ],
      totalCount: 2, referringDomains: 2, dofollowCount: 1, nofollowCount: 1, newCount: 1, lostCount: 0,
    },
  })),
}));

const { resolveWorkspaceSite, SiteResolutionError } = await import('../../../server/services/seo/siteResolver.js');
const {
  createBacklinkScan, getBacklinkScan, listBacklinks, BacklinkScanLimitError,
} = await import('../../../server/services/seo/backlinkService.js');
const { claimNextJob, heartbeatJob, getJob } = await import('../../../server/services/jobs/queue.js');
const { processBacklinkScan } = await import('../../../worker/seo-backlinks/processScan.js');

function seedTables(): FakeTables {
  const now = new Date().toISOString();
  return {
    workspace_domains: [
      { id: SITE_A, workspace_id: WORKSPACE_A, domain: 'example.com', verified: false, is_primary: true, created_at: now },
    ],
    background_jobs: [],
    seo_backlink_scans: [],
    seo_backlinks: [],
  };
}

const config = {} as any;

describe('SEO Backlinks end-to-end backend/worker pipeline', () => {
  beforeEach(() => {
    tables = seedTables();
    fakeSb = makeFakeSupabase(tables);
  });

  it('resolves the canonical target URL from the DB — createBacklinkScan takes NO url argument', async () => {
    const scan = await createBacklinkScan(config, { workspaceId: WORKSPACE_A, siteId: SITE_A, userId: USER_ID });
    expect(scan.target_url).toBe('https://example.com');
    expect(scan.status).toBe('queued');
    expect(scan.max_backlinks).toBe(1000); // pro-plan fallback (billing_plans.limits not overridden in this test)
  });

  it('rejects starting a scan for a site that belongs to a different workspace', async () => {
    await expect(createBacklinkScan(config, { workspaceId: WORKSPACE_B, siteId: SITE_A, userId: USER_ID }))
      .rejects.toBeInstanceOf(SiteResolutionError);
    await expect(resolveWorkspaceSite(config, WORKSPACE_B, SITE_A)).rejects.toMatchObject({ code: 'site_not_found' });
  });

  it('runs the full pipeline to a completed scan with normalized backlinks', async () => {
    const scan = await createBacklinkScan(config, { workspaceId: WORKSPACE_A, siteId: SITE_A, userId: USER_ID });

    const job = await claimNextJob(config, { jobTypes: ['seo_backlink_scan'], workerId: WORKER_ID, lockTtlSeconds: 120 });
    expect(job).toBeTruthy();
    expect(job!.locked_by).toBe(WORKER_ID);

    const secondClaim = await claimNextJob(config, { jobTypes: ['seo_backlink_scan'], workerId: 'worker-2', lockTtlSeconds: 120 });
    expect(secondClaim).toBeNull();

    const hijackAttempt = await heartbeatJob(config, { jobId: job!.id, workerId: 'attacker', lockTtlSeconds: 120, progress: 99 });
    expect(hijackAttempt.ok).toBe(false);

    const scanRow = tables.seo_backlink_scans.find((s) => s.job_id === job!.id);
    expect(scanRow).toBeTruthy();

    await processBacklinkScan(config, job!.id, scanRow, WORKER_ID, 120);

    const finalJob = await getJob(config, job!.id);
    expect(finalJob?.status).toBe('completed');

    const completed = await getBacklinkScan(config, WORKSPACE_A, scan.id);
    expect(completed?.status).toBe('completed');
    expect(completed?.total_backlinks).toBe(2);
    expect(completed?.referring_domains).toBe(2);
    expect(completed?.dofollow_count).toBe(1);
    expect(completed?.nofollow_count).toBe(1);
    expect(completed?.new_backlinks).toBe(1);

    const { backlinks, total } = await listBacklinks(config, WORKSPACE_A, scan.id);
    expect(total).toBe(2);
    expect(backlinks.map((b: any) => b.source_domain).sort()).toEqual(['ref1.example', 'ref2.example']);
  });

  it('rejects a second concurrent scan beyond the workspace plan limit', async () => {
    await createBacklinkScan(config, { workspaceId: WORKSPACE_A, siteId: SITE_A, userId: USER_ID });
    await expect(createBacklinkScan(config, { workspaceId: WORKSPACE_A, siteId: SITE_A, userId: USER_ID }))
      .rejects.toBeInstanceOf(BacklinkScanLimitError);
  });
});
