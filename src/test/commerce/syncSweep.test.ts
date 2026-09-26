/**
 * A completed FULL sync removes products the store no longer has.
 *
 * Deletion used to be the one fact in the system with a single delivery path
 * and no repair. Every other drift — price, stock, a rename — is corrected by
 * the next sync simply because the sync rewrites whatever it finds; but
 * `runSyncJobOnce` only ever upserted, so a `product.deleted` event that never
 * arrived was permanent.
 *
 * Reproduced against a live store: a product was deleted in WooCommerce with
 * event delivery suppressed, a full manual resync ran to completion, and the
 * row stayed in the index as in_stock with a canonical URL that 404s. Store
 * 68 products, index 69.
 *
 * The dangerous half of the fix is the gate, not the sweep: an incremental
 * sync fetches only what changed, so "not seen this run" is almost the entire
 * catalogue. A sweep that fired there would empty the index — which is why
 * that case is tested here as carefully as the sweep itself.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const CONN = 'conn-1';
const WS = 'ws-1';

type Row = Record<string, unknown>;
interface FakeProduct { externalId: string; [key: string]: unknown }

/** What the fake store returns, one entry per page. */
let storePages: Array<{ products: FakeProduct[]; has_more: boolean }> = [];
/** How many rows the sweep's SQL reports removing. */
let sweptCount = 0;
let cursorRow: Row | null = null;
let connectionRow: Row | null = null;
/** Simulates a database that has not had migration 198 applied yet. */
let sweepColumnMissing = false;
/** The store answers every catalogue request with a 503. */
let storeDown = false;

const seen = {
  upserted: [] as string[],
  stampedIds: [] as string[][],
  rpcCalls: [] as Array<{ fn: string; args: Row }>,
  /** Any surviving soft-delete write — there must never be one again. */
  softDeleted: [] as string[],
  cursorWrites: [] as Row[],
  jobUpdates: [] as Row[],
  requestedPaths: [] as string[],
};

/** The slice of the supabase-js query builder that sync.ts uses. */
interface FakeQuery {
  _patch: Row | null;
  _in: string[] | null;
  _selecting: boolean;
  _cols?: string;
  select: (cols?: string) => FakeQuery;
  eq: () => FakeQuery;
  is: () => FakeQuery;
  in: (col: string, vals: string[]) => FakeQuery;
  or: () => FakeQuery;
  update: (patch: Row) => FakeQuery;
  upsert: (row: Row) => Promise<{ data: null; error: null }>;
  maybeSingle: () => Promise<{ data: Row | null; error: { code: string; message: string } | null }>;
  then: (resolve: (result: { data: unknown; error: null }) => unknown) => unknown;
}

function fakeClient() {
  const make = (table: string) => {
    const b: FakeQuery = {
      _patch: null,
      _in: null,
      _selecting: false,
      select: (cols?: string) => { b._selecting = true; b._cols = cols ?? ''; return b; },
      eq: () => b,
      is: () => b,
      in: (_col: string, vals: string[]) => { b._in = vals; return b; },
      or: () => b,
      update: (patch: Row) => { b._patch = patch; return b; },
      upsert: async (row: Row) => {
        if (table === 'commerce_sync_cursors') seen.cursorWrites.push(row);
        return { data: null, error: null };
      },
      maybeSingle: async () => {
        if (table === 'commerce_sync_cursors' && sweepColumnMissing && String(b._cols).includes('sweep_epoch')) {
          return { data: null, error: { code: '42703', message: 'column commerce_sync_cursors.sweep_epoch does not exist' } };
        }
        return {
          data: table === 'commerce_connections' ? connectionRow : table === 'commerce_sync_cursors' ? cursorRow : null,
          error: null,
        };
      },
      then: (resolve) => {
        if (table === 'commerce_products') {
          if (b._patch?.last_seen_at) seen.stampedIds.push(b._in ?? []);
          else if (b._patch?.deleted_at) seen.softDeleted.push(table);
          else if (b._selecting) return resolve({ data: [], error: null });
        }
        if (table === 'commerce_product_variants' && b._patch?.deleted_at) seen.softDeleted.push(table);
        if (table === 'commerce_sync_jobs' && b._patch) seen.jobUpdates.push(b._patch);
        return resolve({ data: null, error: null });
      },
    };
    return b;
  };
  return {
    from: (t: string) => make(t),
    rpc: async (fn: string, args: Row) => {
      seen.rpcCalls.push({ fn, args });
      return { data: fn === 'commerce_sweep_absent_products' ? sweptCount : null, error: null };
    },
  };
}

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient() }));
vi.mock('../../../server/services/commerce/credentials.js', () => ({ readInstallationSecret: async () => 'secret' }));
vi.mock('../../../server/services/commerce/signing.js', () => ({ buildSignedHeaders: () => ({}) }));
vi.mock('../../../server/services/commerce/productIndex.js', () => ({
  upsertProductInIndex: async (_c: unknown, _w: string, _conn: string, p: FakeProduct) => { seen.upserted.push(p.externalId); return p.externalId; },
}));
vi.mock('../../../server/services/commerce/connectors/woocommerce.js', () => ({
  WooCommerceConnector: class {},
  normalizeWooCommerceProduct: (raw: unknown) => raw,
}));
vi.mock('../../../server/services/commerce/httpClient.js', () => ({
  commerceHttpRequest: async ({ url }: { url: string }) => {
    seen.requestedPaths.push(url);
    const page = Number(new URL(url).searchParams.get('page') ?? '1');
    const body = storePages[page - 1] ?? { products: [], has_more: false };
    return { status: storeDown ? 503 : 200, json: body };
  },
}));

const { runSyncJobOnce, syncRetryDelayMs } = await import('../../../server/services/commerce/sync.js');

type SyncJob = Parameters<typeof runSyncJobOnce>[1];
const CONFIG = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' } as unknown as Parameters<typeof runSyncJobOnce>[0];
const product = (id: string) => ({ externalId: id, sku: `SKU-${id}`, title: `P${id}`, variants: [] });
const job = (o: Partial<SyncJob> = {}): SyncJob => ({
  id: 'job-1', workspace_id: WS, connection_id: CONN, job_type: 'manual_resync',
  status: 'running', attempts: 0, max_attempts: 5, ...o,
});

beforeEach(() => {
  storePages = [{ products: [product('1'), product('2')], has_more: false }];
  sweptCount = 0;
  cursorRow = null;
  sweepColumnMissing = false;
  storeDown = false;
  connectionRow = { id: CONN, workspace_id: WS, installation_id: 'inst-1', approved_origin: 'https://shop.example.com', revoked_at: null };
  for (const k of Object.keys(seen) as Array<keyof typeof seen>) seen[k].length = 0;
});

describe('a full sync sweeps what the store no longer has', () => {
  it('stamps every product it meets, page by page', async () => {
    storePages = [
      { products: [product('1'), product('2')], has_more: true },
      { products: [product('3')], has_more: false },
    ];
    await runSyncJobOnce(CONFIG, job());

    expect(seen.upserted).toEqual(['1', '2', '3']);
    // One stamp per page, not one per product — an unchanged product is
    // skipped by the upsert's version guard but is still very much present.
    expect(seen.stampedIds).toEqual([['1', '2'], ['3']]);
  });

  it('hands the whole removal to one statement, with this sync\u2019s epoch', async () => {
    // Read-then-write-twice could half-apply and cost a round trip per
    // batch; the matching, the delete and the gravestone now happen inside
    // commerce_sweep_absent_products (see migration
    // 20260921180000_commerce_hard_delete_products.sql).
    sweptCount = 2;
    await runSyncJobOnce(CONFIG, job());

    const sweeps = seen.rpcCalls.filter((c) => c.fn === 'commerce_sweep_absent_products');
    expect(sweeps).toHaveLength(1);
    expect(sweeps[0].args.p_connection_id).toBe(CONN);
    expect(sweeps[0].args.p_sweep_epoch).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('never soft-deletes anything', async () => {
    // A deleted product leaves the index for good: the row is gone, and what
    // stays is one line in commerce_deleted_entities. A `deleted_at` write
    // from here would mean the old, growing tombstones are back.
    sweptCount = 2;
    await runSyncJobOnce(CONFIG, job());

    expect(seen.softDeleted).toEqual([]);
  });

  it('still finishes the job when the store has everything', async () => {
    sweptCount = 0;
    await runSyncJobOnce(CONFIG, job());

    expect(seen.jobUpdates).toContainEqual({ status: 'succeeded' });
  });

  it('carries the epoch on the cursor so a re-queued run keeps sweeping the same window', async () => {
    // A catalogue larger than MAX_PAGES_PER_RUN spans several worker ticks.
    // If each tick minted a new epoch, the final one would tombstone
    // everything the earlier ticks had already stamped.
    cursorRow = { page: 2, modified_after: null, sweep_epoch: '2026-09-20T20:00:00.000Z' };
    storePages = [
      { products: [], has_more: false },
      { products: [product('9')], has_more: true },
      { products: [product('10')], has_more: false },
    ];

    await runSyncJobOnce(CONFIG, job());

    expect(seen.cursorWrites[0].sweep_epoch).toBe('2026-09-20T20:00:00.000Z');
    const sweeps = seen.rpcCalls.filter((c) => c.fn === 'commerce_sweep_absent_products');
    expect(sweeps[0].args.p_sweep_epoch).toBe('2026-09-20T20:00:00.000Z');
  });

  it('clears the epoch once the sync completes', async () => {
    await runSyncJobOnce(CONFIG, job());
    const final = seen.cursorWrites[seen.cursorWrites.length - 1];
    expect(final.sweep_epoch).toBeNull();
    expect(final.page).toBe(1);
  });
});

describe('an incremental sync must never sweep', () => {
  // It fetches only what changed since the cursor, so "not seen this run" is
  // almost the whole catalogue. This is the case that would destroy an index.
  for (const job_type of ['incremental_sync', 'reconciliation'] as const) {
    it(`${job_type} stamps nothing and tombstones nothing`, async () => {
      cursorRow = { page: 1, modified_after: '2026-09-20T18:00:00.000Z', sweep_epoch: null };
      sweptCount = 99; // if the sweep ran at all, it would take the catalogue with it

      await runSyncJobOnce(CONFIG, job({ job_type }));

      expect(seen.upserted).toEqual(['1', '2']); // it still indexes what changed
      expect(seen.stampedIds).toEqual([]);
      expect(seen.rpcCalls.filter((c) => c.fn === 'commerce_sweep_absent_products')).toEqual([]);
      expect(seen.softDeleted).toEqual([]);
    });
  }

  it('an incremental sync still asks the store for only what changed', async () => {
    cursorRow = { page: 1, modified_after: '2026-09-20T18:00:00.000Z', sweep_epoch: null };
    await runSyncJobOnce(CONFIG, job({ job_type: 'incremental_sync' }));

    expect(seen.requestedPaths[0]).toContain('modified_after=');
  });
});

describe('a database without migration 198', () => {
  // The migration workflow runs on its own trigger and skips silently when
  // DATABASE_URL is unset, so the worker can genuinely meet a database that
  // has no sweep_epoch column. That must behave exactly as it did before the
  // feature existed — not fail every sync on an unknown column.
  beforeEach(() => { sweepColumnMissing = true; });

  it('still syncs the catalogue', async () => {
    await runSyncJobOnce(CONFIG, job());

    expect(seen.upserted).toEqual(['1', '2']);
    expect(seen.jobUpdates).toContainEqual({ status: 'succeeded' });
  });

  it('never writes the column it does not have', async () => {
    await runSyncJobOnce(CONFIG, job());

    for (const write of seen.cursorWrites) expect(write).not.toHaveProperty('sweep_epoch');
  });

  it('sweeps nothing, so no row is removed by mistake', async () => {
    sweptCount = 99; // the sweep must not run at all, whatever it would report
    await runSyncJobOnce(CONFIG, job());

    expect(seen.rpcCalls.filter((c) => c.fn === 'commerce_sweep_absent_products')).toEqual([]);
    expect(seen.softDeleted).toEqual([]);
  });

  it('still resumes from the stored page', async () => {
    // The fallback select drops sweep_epoch but must keep the cursor itself,
    // or a large catalogue would restart from page 1 on every tick.
    cursorRow = { page: 2, modified_after: null };
    storePages = [{ products: [], has_more: false }, { products: [product('7')], has_more: false }];

    await runSyncJobOnce(CONFIG, job());

    expect(seen.upserted).toEqual(['7']);
  });
});

describe('incremental and reconciliation syncs resume their cursor', () => {
  // A change set larger than MAX_PAGES_PER_RUN (20 pages) spans several
  // worker ticks. These job types used to restart at page 1 on every tick,
  // so such a change set was re-queued forever and never completed.
  const WATERMARK = '2026-09-20T18:00:00.000Z';
  const pageOf = (url: string) => Number(new URL(url).searchParams.get('page'));
  const manyPages = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ products: [product(String(i + 1))], has_more: i + 1 < n }));

  afterEach(() => { vi.useRealTimers(); });

  for (const job_type of ['incremental_sync', 'reconciliation'] as const) {
    it(`${job_type} continues where the previous run stopped and then completes`, async () => {
      storePages = manyPages(25);
      cursorRow = { page: 1, modified_after: WATERMARK, sweep_epoch: null, after_cursor: null };

      await runSyncJobOnce(CONFIG, job({ job_type }));
      expect(seen.requestedPaths.map(pageOf)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
      expect(seen.jobUpdates).toContainEqual({ status: 'queued', attempts: 0 });
      const checkpoint = seen.cursorWrites[seen.cursorWrites.length - 1];
      expect(checkpoint.page).toBe(21);
      expect(checkpoint.modified_after).toBe(WATERMARK); // same watermark for the whole walk
      expect(checkpoint.after_cursor).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      // Next tick: the worker reads back what the previous one stored.
      cursorRow = { ...checkpoint };
      for (const k of Object.keys(seen) as Array<keyof typeof seen>) seen[k].length = 0;
      await runSyncJobOnce(CONFIG, job({ job_type }));

      expect(seen.requestedPaths.map(pageOf)).toEqual([21, 22, 23, 24, 25]);
      expect(seen.requestedPaths.every((u) => u.includes('modified_after='))).toBe(true);
      expect(seen.jobUpdates).toContainEqual({ status: 'succeeded' });
      const final = seen.cursorWrites[seen.cursorWrites.length - 1];
      expect(final.page).toBe(1);
      expect(final.after_cursor).toBeNull();
      // The new watermark is when the WALK began (first tick), not now.
      expect(final.modified_after).toBe(checkpoint.after_cursor);
    });
  }

  it('records the run START time as the next watermark, not the finish time', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const T0 = new Date('2026-09-25T10:00:00.000Z');
    vi.setSystemTime(T0);
    // Every page fetch takes a minute of store time: a change made while the
    // run is in flight must still be after the stored watermark.
    storePages = manyPages(3).map((p) => ({
      has_more: p.has_more,
      get products() { vi.setSystemTime(Date.now() + 60_000); return p.products; },
    }));
    cursorRow = { page: 1, modified_after: WATERMARK, sweep_epoch: null, after_cursor: null };

    await runSyncJobOnce(CONFIG, job({ job_type: 'incremental_sync' }));

    const final = seen.cursorWrites[seen.cursorWrites.length - 1];
    expect(Date.now()).toBeGreaterThan(T0.getTime());
    expect(final.modified_after).toBe(T0.toISOString());
  });

  it('a full resync never resumes an interrupted incremental walk mid-way', async () => {
    cursorRow = { page: 5, modified_after: WATERMARK, sweep_epoch: null, after_cursor: '2026-09-21T00:00:00.000Z' };
    await runSyncJobOnce(CONFIG, job({ job_type: 'manual_resync' }));

    expect(pageOf(seen.requestedPaths[0])).toBe(1);
    expect(seen.requestedPaths[0]).not.toContain('modified_after=');
  });

  it('restarts an incremental walk whose start time was never recorded', async () => {
    // A cursor written by an older build: resuming it could hand over a
    // watermark later than the pages it already walked, so start over.
    cursorRow = { page: 5, modified_after: WATERMARK, sweep_epoch: null, after_cursor: null };
    await runSyncJobOnce(CONFIG, job({ job_type: 'incremental_sync' }));

    expect(pageOf(seen.requestedPaths[0])).toBe(1);
  });
});

describe('a walk longer than one run is not a failed attempt, and a failing store is retried after a pause', () => {
  const pagesOf = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ products: [product(String(i + 1))], has_more: i + 1 < count }));
  const requestedPages = () => seen.requestedPaths.map((u) => Number(new URL(u).searchParams.get('page')));

  it('a reconciliation bigger than one run finishes on the next run instead of re-reading its first pages forever', async () => {
    // Its window is the cursor's modified_after — here null, the first
    // reconciliation of a store: a full walk of 25 pages against a budget of
    // 20 per run. It used to restart at page 1 on every run and never end.
    storePages = pagesOf(25);

    await runSyncJobOnce(CONFIG, job({ job_type: 'reconciliation', attempts: 1 }));
    expect(requestedPages()).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(seen.jobUpdates).toContainEqual({ status: 'queued', attempts: 0 });

    cursorRow = seen.cursorWrites[seen.cursorWrites.length - 1];
    seen.requestedPaths.length = 0;
    seen.jobUpdates.length = 0;

    await runSyncJobOnce(CONFIG, job({ job_type: 'reconciliation', attempts: 1 }));
    expect(requestedPages()).toEqual([21, 22, 23, 24, 25]);
    expect(seen.jobUpdates).toContainEqual({ status: 'succeeded' });
    // One walk, one epoch: the sweep uses the epoch the first run started.
    const sweeps = seen.rpcCalls.filter((c) => c.fn === 'commerce_sweep_absent_products');
    expect(sweeps).toHaveLength(1);
    expect(sweeps[0].args.p_sweep_epoch).toBe(seen.cursorWrites[0].sweep_epoch);
  });

  it('the last page writes no checkpoint of its own — completion writes the cursor', async () => {
    await runSyncJobOnce(CONFIG, job());

    expect(seen.cursorWrites).toHaveLength(1);
    expect(seen.cursorWrites[0].page).toBe(1);
  });

  it('a transient failure keeps the job leased until its retry is due instead of re-queueing it at once', async () => {
    storeDown = true;
    const before = Date.now();

    await runSyncJobOnce(CONFIG, job({ attempts: 1 }));

    expect(seen.jobUpdates).toHaveLength(1);
    const update = seen.jobUpdates[0];
    expect(update.status).toBe('running');
    expect(update.leased_by).toBeNull();
    expect(update.last_error_code).toBe('commerce_live_unavailable');
    const due = Date.parse(String(update.leased_until)) - before;
    expect(due).toBeGreaterThanOrEqual(30_000);
    expect(due).toBeLessThan(31_000);
  });

  it('the last attempt still dead-letters', async () => {
    storeDown = true;

    await runSyncJobOnce(CONFIG, job({ attempts: 5, max_attempts: 5 }));

    expect(seen.jobUpdates).toHaveLength(1);
    expect(seen.jobUpdates[0].status).toBe('dead_letter');
  });

  it('the retry delay doubles per attempt, to a ceiling', () => {
    expect([1, 2, 3, 4].map(syncRetryDelayMs)).toEqual([30_000, 60_000, 120_000, 240_000]);
    expect(syncRetryDelayMs(20)).toBe(15 * 60_000);
  });
});
