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
import { describe, it, expect, beforeEach, vi } from 'vitest';

const CONN = 'conn-1';
const WS = 'ws-1';

type Row = Record<string, any>;

/** What the fake store returns, one entry per page. */
let storePages: Array<{ products: any[]; has_more: boolean }> = [];
/** Rows the sweep query finds (live and not seen since the epoch). */
let staleRows: Row[] = [];
let cursorRow: Row | null = null;
let connectionRow: Row | null = null;
/** Simulates a database that has not had migration 198 applied yet. */
let sweepColumnMissing = false;

const seen = {
  upserted: [] as string[],
  stampedIds: [] as string[][],
  sweepFilters: [] as string[],
  productsTombstoned: [] as string[][],
  variantsTombstoned: [] as string[][],
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
      or: (expr: string) => { seen.sweepFilters.push(expr); return b; },
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
          else if (b._patch?.deleted_at) seen.productsTombstoned.push(b._in ?? []);
          else if (b._selecting) return resolve({ data: staleRows, error: null });
        }
        if (table === 'commerce_product_variants' && b._patch) seen.variantsTombstoned.push(b._in ?? []);
        if (table === 'commerce_sync_jobs' && b._patch) seen.jobUpdates.push(b._patch);
        return resolve({ data: null, error: null });
      },
    };
    return b;
  };
  return { from: (t: string) => make(t), rpc: async () => ({ data: null, error: null }) };
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
  staleRows = [];
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

  it('tombstones the rows it never met, and their variants', async () => {
    staleRows = [{ id: 'gone-a' }, { id: 'gone-b' }];
    await runSyncJobOnce(CONFIG, job());

    expect(seen.productsTombstoned).toEqual([['gone-a', 'gone-b']]);
    expect(seen.variantsTombstoned).toEqual([['gone-a', 'gone-b']]);
  });

  it('matches rows never stamped as well as rows stamped before this sync', async () => {
    // "never stamped" carries the first sweep after deploy, when no row has a
    // last_seen_at yet; without it that sweep would find nothing at all.
    await runSyncJobOnce(CONFIG, job());

    expect(seen.sweepFilters).toHaveLength(1);
    expect(seen.sweepFilters[0]).toMatch(/^last_seen_at\.is\.null,last_seen_at\.lt\.\d{4}-\d{2}-\d{2}T/);
  });

  it('does nothing when the store still has everything', async () => {
    staleRows = [];
    await runSyncJobOnce(CONFIG, job());

    expect(seen.productsTombstoned).toEqual([]);
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
    expect(seen.sweepFilters[0]).toContain('last_seen_at.lt.2026-09-20T20:00:00.000Z');
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
      staleRows = [{ id: 'would-have-been-wiped' }];

      await runSyncJobOnce(CONFIG, job({ job_type }));

      expect(seen.upserted).toEqual(['1', '2']); // it still indexes what changed
      expect(seen.stampedIds).toEqual([]);
      expect(seen.sweepFilters).toEqual([]);
      expect(seen.productsTombstoned).toEqual([]);
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

  it('sweeps nothing, so no row is tombstoned by mistake', async () => {
    staleRows = [{ id: 'must-not-be-touched' }];
    await runSyncJobOnce(CONFIG, job());

    expect(seen.sweepFilters).toEqual([]);
    expect(seen.productsTombstoned).toEqual([]);
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

