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

type Row = Record<string, any>;

/** What the fake store returns, one entry per page. */
let storePages: Array<{ products: any[]; has_more: boolean }> = [];
/** How many rows the sweep's SQL reports removing. */
let sweptCount = 0;
let cursorRow: Row | null = null;
let connectionRow: Row | null = null;
/** Simulates a database that has not had migration 198 applied yet. */
let sweepColumnMissing = false;

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

function fakeClient() {
  const make = (table: string) => {
    const b: any = {
      _patch: null as Row | null,
      _in: null as string[] | null,
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
      then: (resolve: any) => {
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
  upsertProductInIndex: async (_c: any, _w: string, _conn: string, p: any) => { seen.upserted.push(p.externalId); return p.externalId; },
}));
vi.mock('../../../server/services/commerce/connectors/woocommerce.js', () => ({
  WooCommerceConnector: class {},
  normalizeWooCommerceProduct: (raw: any) => raw,
}));
vi.mock('../../../server/services/commerce/httpClient.js', () => ({
  commerceHttpRequest: async ({ url }: { url: string }) => {
    seen.requestedPaths.push(url);
    const page = Number(new URL(url).searchParams.get('page') ?? '1');
    const body = storePages[page - 1] ?? { products: [], has_more: false };
    return { status: 200, json: body };
  },
}));

const { runSyncJobOnce } = await import('../../../server/services/commerce/sync.js');

const CONFIG: any = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' };
const product = (id: string) => ({ externalId: id, sku: `SKU-${id}`, title: `P${id}`, variants: [] });
const job = (o: Partial<Row> = {}): any => ({
  id: 'job-1', workspace_id: WS, connection_id: CONN, job_type: 'manual_resync',
  status: 'running', attempts: 0, max_attempts: 5, ...o,
});

beforeEach(() => {
  storePages = [{ products: [product('1'), product('2')], has_more: false }];
  sweptCount = 0;
  cursorRow = null;
  sweepColumnMissing = false;
  connectionRow = { id: CONN, workspace_id: WS, installation_id: 'inst-1', approved_origin: 'https://shop.example.com', revoked_at: null };
  for (const k of Object.keys(seen)) (seen as any)[k].length = 0;
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
    storePages = [{ products: [], has_more: false }, { products: [product('9')], has_more: false }];

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
      expect(seen.jobUpdates).toContainEqual({ status: 'queued' });
      const checkpoint = seen.cursorWrites[seen.cursorWrites.length - 1];
      expect(checkpoint.page).toBe(21);
      expect(checkpoint.modified_after).toBe(WATERMARK); // same watermark for the whole walk
      expect(checkpoint.after_cursor).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      // Next tick: the worker reads back what the previous one stored.
      cursorRow = { ...checkpoint };
      for (const k of Object.keys(seen)) (seen as any)[k].length = 0;
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

