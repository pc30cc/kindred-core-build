/**
 * The AI knowledge crawler, its job queue and the AI Runtime client after
 * the 2026-11-04 audit:
 *   - ai-4: a re-sync that fails (the site down, a bot challenge, a billing
 *     denial) never deletes the website's knowledge, and one page that
 *     fails to load keeps its own; a page answering 404/410 is dropped;
 *   - ai-5: a crawl attempts a bounded number of URLs and queues a bounded
 *     number of links, and a refused answer's body is cancelled (its socket
 *     released);
 *   - ai-6: a claimed job's lease is renewed while it runs, only its worker
 *     finishes it, and two workers cannot both re-claim an expired one;
 *   - ai-7: the AI Runtime client's deadline covers the response body;
 *   - frontend-3 (server side): the AI prompt's URL line carries only an
 *     http(s) page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
let TABLES: Record<string, Row[]> = {};
const updates: Array<{ table: string; patch: Row; filters: string[] }> = [];

function fakeClient() {
  return {
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      const described: string[] = [];
      let patch: Row | null = null;
      let window: [number, number] | null = null;
      let orderBy: string | null = null;
      let cap: number | null = null;
      const rows = () => (TABLES[table] || []).filter((r) => filters.every((f) => f(r)));
      const apply = () => {
        const hit = rows();
        if (patch) {
          updates.push({ table, patch, filters: described });
          for (const r of hit) Object.assign(r, patch);
        }
        return hit;
      };
      const q = {
        select: () => q,
        order: (col: string) => { orderBy = col; return q; },
        limit: (n: number) => { cap = n; return q; },
        gt: (col: string, val: unknown) => {
          filters.push((r) => String(r[col]) > String(val));
          return q;
        },
        range: (from: number, to: number) => { window = [from, to]; return q; },
        or: () => q,
        upsert: async (row: Row) => {
          (TABLES[table] ||= []).push(row);
          return { data: null, error: null };
        },
        update: (p: Row) => { patch = p; return q; },
        insert: () => q,
        neq: (col: string, val: unknown) => {
          described.push(`${col}!=${String(val)}`);
          filters.push((r) => r[col] !== val);
          return q;
        },
        like: (col: string, pattern: string) => {
          described.push(`${col}~${pattern}`);
          const prefix = pattern.replace(/%$/, '');
          filters.push((r) => String(r[col]).startsWith(prefix));
          return q;
        },
        not: () => q,
        eq: (col: string, val: unknown) => {
          described.push(`${col}=${String(val)}`);
          filters.push((r) => r[col] === val);
          return q;
        },
        in: (col: string, vals: unknown[]) => {
          described.push(`${col} in ${vals.join(',')}`);
          filters.push((r) => vals.includes(r[col]));
          return q;
        },
        maybeSingle: async () => ({ data: apply()[0] ?? null, error: null }),
        single: async () => ({ data: apply()[0] ?? null, error: null }),
        then: (resolve: (v: { data: Row[]; error: null; count: number }) => unknown) => {
          let all = apply();
          if (orderBy) {
            const col = orderBy;
            all = [...all].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0));
          }
          let hit = window ? all.slice(window[0], window[1] + 1) : all;
          if (cap !== null) hit = hit.slice(0, cap);
          return resolve({ data: hit, error: null, count: all.length });
        },
      };
      return q;
    },
  };
}

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient() }));

// The site, as the crawler's transport sees it.
let SITE: Record<string, { status: number; html?: string }> = {};
const fetched: string[] = [];
vi.mock('../../../server/services/ai-agent/crawler/safeCrawlFetch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/ai-agent/crawler/safeCrawlFetch.js')>()),
  safeCrawlFetch: async (url: string) => {
    fetched.push(url);
    const page = SITE[url];
    if (!page) return { ok: false, error: 'timeout', finalUrl: url };
    if (page.status >= 400) return { ok: false, status: page.status, error: `http_${page.status}`, finalUrl: url };
    return { ok: true, status: 200, html: page.html, finalUrl: url };
  },
}));
vi.mock('../../../server/services/ai-agent/crawler/robots.js', () => ({
  getRobotsRules: async () => ({ allow: [], disallow: [] }),
  isPathAllowedByRobots: () => true,
}));
let billingDenied = false;
vi.mock('../../../server/services/ai-agent/knowledgeIndex/indexer.js', () => ({
  getEmbedderForWorkspace: async () => null,
  indexSource: async () => {
    if (billingDenied) throw new Error('ai_allowance_exhausted');
    return { chunksCreated: 1, chunksUpdated: 0, embeddingsGenerated: 0 };
  },
}));

const { crawlWebsiteSource, crawlAttemptCap, crawlQueueCap, shouldSkipPrune } =
  await import('../../../server/services/ai-agent/crawler/crawlWebsiteSource.js');
const { urlHash } = await import('../../../server/services/ai-agent/crawler/urlRules.js');
const { safeCrawlFetch: realSafeCrawlFetch } =
  await vi.importActual<typeof import('../../../server/services/ai-agent/crawler/safeCrawlFetch.js')>(
    '../../../server/services/ai-agent/crawler/safeCrawlFetch.js',
  );
const { claimNextSourceSyncJob, completeSourceSyncJob, failSourceSyncJob, renewSourceSyncJobLease } =
  await import('../../../server/services/ai-agent/sourceJobs.js');
const { startLeaseHeartbeat } = await import('../../../server/services/ai-agent/sourceWorker.js');
const { buildUserPrompt } = await import('../../../server/services/ai-agent/prompt.js');

const CONFIG = {} as never;
const WS = 'ws-1';
const SOURCE = 'src-1';
const ROOT = 'https://shop.example/';
const PAGE_A = 'https://shop.example/a';
const PAGE_B = 'https://shop.example/b';
const LONG_TEXT = 'Shipping and returns. '.repeat(40);
const html = (links: string[]) =>
  `<html><head><title>t</title></head><body><p>${LONG_TEXT}</p>${links.map((l) => `<a href="${l}">x</a>`).join('')}</body></html>`;

const chunkId = (url: string) => `${SOURCE}:${urlHash(url)}`;

function knownChunks(urls: string[]): Row[] {
  return urls.map((u, i) => ({ id: `chunk-${i}`, workspace_id: WS, source_type: 'web_page', source_id: chunkId(u), status: 'active' }));
}

function crawl(maxPages = 10) {
  return crawlWebsiteSource(CONFIG, {
    workspaceId: WS, sourceId: SOURCE, baseUrl: ROOT, rootHost: 'shop.example',
    include: [], exclude: [], maxPages, maxDepth: 3, workerId: 'w', jobId: 'j',
  });
}

const deleted = () => TABLES.ai_knowledge_chunks.filter((c) => c.status === 'deleted').map((c) => c.source_id);

beforeEach(() => {
  TABLES = { ai_knowledge_chunks: knownChunks([ROOT, PAGE_A, PAGE_B]), ai_source_pages: [] };
  updates.length = 0;
  fetched.length = 0;
  billingDenied = false;
  SITE = {
    [ROOT]: { status: 200, html: html([PAGE_A, PAGE_B]) },
    [PAGE_A]: { status: 200, html: html([]) },
    [PAGE_B]: { status: 200, html: html([]) },
  };
});

describe('ai-4: a failed re-sync keeps the website’s knowledge', () => {
  it('the site down (every page 5xx) deletes nothing', async () => {
    SITE = { [ROOT]: { status: 503 } };
    const summary = await crawl();
    expect(summary.pages_fetched).toBe(0);
    expect(deleted()).toEqual([]);
    expect(summary.warnings).toContain('prune_skipped_nothing_fetched');
  });

  it('a timeout on the first page deletes nothing', async () => {
    SITE = {};
    await crawl();
    expect(deleted()).toEqual([]);
  });

  it('one page that fails to load keeps its knowledge', async () => {
    SITE[PAGE_A] = { status: 502 };
    await crawl();
    expect(deleted()).toEqual([]);
  });

  it('a page that answers 404 or 410 is dropped', async () => {
    SITE[PAGE_A] = { status: 404 };
    SITE[PAGE_B] = { status: 410 };
    await crawl();
    expect(deleted().sort()).toEqual([chunkId(PAGE_A), chunkId(PAGE_B)].sort());
  });

  it('a page no longer linked is dropped, as before', async () => {
    SITE[ROOT] = { status: 200, html: html([PAGE_A]) };
    await crawl();
    expect(deleted()).toEqual([chunkId(PAGE_B)]);
  });

  it('a billing denial mid-crawl deletes nothing', async () => {
    billingDenied = true;
    const summary = await crawl();
    expect(deleted()).toEqual([]);
    expect(summary.warnings).toContain('prune_skipped_billing_denied');
  });

  it('shouldSkipPrune: only a run that read the site as far as its page cap prunes', () => {
    expect(shouldSkipPrune({ pages_fetched: 3 }, { billingDenied: false, incomplete: null })).toBeNull();
    expect(shouldSkipPrune({ pages_fetched: 0 }, { billingDenied: false, incomplete: null })).toBe('nothing_fetched');
    expect(shouldSkipPrune({ pages_fetched: 3 }, { billingDenied: true, incomplete: null })).toBe('billing_denied');
    expect(shouldSkipPrune({ pages_fetched: 3 }, { billingDenied: false, incomplete: 'crawl_attempt_limit' })).toBe('incomplete');
  });
});

describe('ai-5: a crawl’s work is bounded', () => {
  it('stops after its attempt cap when pages keep failing, and prunes nothing', async () => {
    // The root links many pages that all fail: none counts toward maxPages.
    const many = Array.from({ length: 400 }, (_, i) => `https://shop.example/p${i}`);
    SITE = { [ROOT]: { status: 200, html: html(many) } };
    const summary = await crawl(5);
    expect(fetched.length).toBe(crawlAttemptCap(5));
    expect(summary.truncated).toBe(true);
    expect(summary.warnings).toContain('crawl_attempt_limit');
    expect(deleted()).toEqual([]);
  });

  it('queues at most its queue cap of links', async () => {
    const many = Array.from({ length: crawlQueueCap(1) + 200 }, (_, i) => `https://shop.example/q${i}`);
    SITE = { [ROOT]: { status: 200, html: html(many) } };
    for (const u of many) SITE[u] = { status: 200, html: html([]) };
    const summary = await crawl(1);
    expect(summary.pages_fetched).toBe(1);
    expect(summary.truncated).toBe(true);
    expect(summary.warnings).toContain('crawl_queue_limit');
  });

  it('the caps grow with the plan and keep a floor', () => {
    expect(crawlAttemptCap(100)).toBeGreaterThan(100);
    expect(crawlQueueCap(1)).toBeGreaterThanOrEqual(500);
    expect(crawlQueueCap(1000)).toBeGreaterThanOrEqual(1000);
  });

  it.each([
    ['a 5xx', 503, 'text/html', undefined],
    ['a wrong type', 200, 'application/pdf', undefined],
    ['an oversized content-length', 200, 'text/html', '99999999'],
  ])('safeCrawlFetch cancels the body of %s', async (_label, status, type, length) => {
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array([0x61])); },
      cancel() { cancelled = true; },
    });
    const headers: Record<string, string> = { 'content-type': type };
    if (length) headers['content-length'] = length;
    const res = await realSafeCrawlFetch('https://example.com/x', {
      userAgent: 'test-bot',
      timeoutMs: 2000,
      maxBytes: 1024,
      isUrlAllowed: () => true,
      lookupImpl: (async () => [{ address: '93.184.216.34', family: 4 }]) as never,
      fetchImpl: (async () => new Response(body, { status, headers })) as never,
    });
    expect(res.ok).toBe(false);
    expect(cancelled).toBe(true);
  });
});

describe('ai-6: a job’s lease is kept while it runs, and only its worker ends it', () => {
  const job = (over: Row = {}): Row => ({
    id: 'job-1', status: 'running', locked_by: 'worker-a', attempts: 1, max_attempts: 3,
    lock_expires_at: new Date(Date.now() + 60_000).toISOString(), ...over,
  });

  it('renews the lease only for the worker holding it', async () => {
    TABLES.ai_source_sync_jobs = [job()];
    expect(await renewSourceSyncJobLease(CONFIG, { jobId: 'job-1', workerId: 'worker-a', lockTtlSeconds: 180 })).toBe(true);
    expect(Date.parse(String(TABLES.ai_source_sync_jobs[0].lock_expires_at))).toBeGreaterThan(Date.now() + 170_000);
    expect(await renewSourceSyncJobLease(CONFIG, { jobId: 'job-1', workerId: 'worker-b', lockTtlSeconds: 180 })).toBe(false);
  });

  it('complete and fail with a worker id touch only that worker’s job', async () => {
    TABLES.ai_source_sync_jobs = [job({ locked_by: 'worker-b' })];
    expect((await completeSourceSyncJob(CONFIG, { jobId: 'job-1', workerId: 'worker-a' })).updated).toBe(false);
    expect((await failSourceSyncJob(CONFIG, { jobId: 'job-1', error: 'x', retryable: true, workerId: 'worker-a' })).updated).toBe(false);
    expect(TABLES.ai_source_sync_jobs[0].status).toBe('running');
    expect((await completeSourceSyncJob(CONFIG, { jobId: 'job-1', workerId: 'worker-b' })).updated).toBe(true);
    expect(TABLES.ai_source_sync_jobs[0].status).toBe('completed');
  });

  it('a re-claim is conditional on the attempts it read', async () => {
    TABLES.ai_source_sync_jobs = [job({ lock_expires_at: new Date(Date.now() - 1000).toISOString() })];
    const claimed = await claimNextSourceSyncJob(CONFIG, { workerId: 'worker-b', lockTtlSeconds: 180 });
    expect(claimed?.locked_by).toBe('worker-b');
    const claim = updates.find((u) => u.table === 'ai_source_sync_jobs' && u.patch.locked_by === 'worker-b');
    expect(claim?.filters).toContain('attempts=1');
  });

  describe('the heartbeat', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('renews every third of the lease until stopped', async () => {
      TABLES.ai_source_sync_jobs = [job()];
      const stop = startLeaseHeartbeat(CONFIG, 'job-1', { workerId: 'worker-a', lockTtlSeconds: 30 });
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(10_000);
      const renewals = () => updates.filter((u) => u.table === 'ai_source_sync_jobs' && 'lock_expires_at' in u.patch).length;
      expect(renewals()).toBe(2);
      stop();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(renewals()).toBe(2);
    });
  });
});

describe('ai-7: the AI Runtime client’s deadline covers the body', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.AI_RUNTIME_TIMEOUT_MS;
  });

  it('a runtime that sends headers and then stalls times out', async () => {
    process.env.AI_RUNTIME_TIMEOUT_MS = '1000';
    vi.resetModules();
    const { runtimeComplete } = await import('../../../server/services/ai/runtimeClient.js');
    vi.spyOn(globalThis, 'fetch' as never).mockImplementation((async (_url: unknown, init: { signal: AbortSignal }) => {
      const body = new ReadableStream({
        start(controller) {
          init.signal.addEventListener('abort', () =>
            controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    }) as never);
    const start = Date.now();
    await expect(
      runtimeComplete(
        { aiRuntimeBaseUrl: 'https://ai-runtime.example.com', aiRuntimeInternalSecret: 's' } as never,
        { provider: 'openai', apiKey: 'k', model: 'm' } as never,
        { workspaceId: 'w', prompt: 'hi' } as never,
      ),
    ).rejects.toMatchObject({ code: 'runtime_unreachable' });
    expect(Date.now() - start).toBeLessThan(5000);
  }, 10_000);
});

describe('frontend-3: the prompt carries only an http(s) visitor page', () => {
  it.each(['javascript://x/%0aalert(1)', 'data:text/html,hi', 'not a url'])('drops %s', (url) => {
    const prompt = buildUserPrompt('Where is my order?', [], undefined, { pageContext: { currentPageUrl: url } });
    expect(prompt).not.toContain('URL:');
    expect(prompt).not.toContain(url);
  });

  it('keeps an http(s) page, without credentials', () => {
    const prompt = buildUserPrompt('Where is my order?', [], undefined, {
      pageContext: { currentPageUrl: 'https://user:pw@shop.example/orders' },
    });
    expect(prompt).toContain('URL: https://shop.example/orders');
    expect(prompt).not.toContain('pw@');
  });
});
