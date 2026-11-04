/**
 * server/services/commerce/sync.ts — a sync run renews its claim's lease and
 * writes the job row only while it still holds that lease.
 *
 * The claim (commerce_claim_sync_job) leases a job for SYNC_LEASE_SECONDS and
 * reclaims a running job once that lapses. A run used to keep the claim's
 * lease unrenewed and finish with `update … where id = $job`, so a run that
 * outlasted the lease was handed to the next worker as well (a redeploy's new
 * container), and the first one's finish then marked the other's run
 * succeeded, re-queued or dead-lettered it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type Row = Record<string, unknown>;
interface Write { table: string; patch: Row; filters: Array<[string, unknown]> }

let writes: Write[] = [];
/** What a lease renewal finds: the row (still ours) or nothing (reclaimed). */
let renewalMatches = true;
let storePages: Array<{ products: unknown[]; has_more: boolean }> = [];
let onFetch: (() => Promise<void>) | null = null;

function fakeClient() {
  const make = (table: string) => {
    let patch: Row | null = null;
    const filters: Array<[string, unknown]> = [];
    const record = () => { if (patch) writes.push({ table, patch, filters: [...filters] }); };
    const b: Record<string, unknown> = {};
    Object.assign(b, {
      select: () => b,
      eq: (col: string, val: unknown) => { filters.push([col, val]); return b; },
      is: () => b,
      in: () => b,
      update: (p: Row) => { patch = p; return b; },
      upsert: async () => ({ data: null, error: null }),
      maybeSingle: async () => {
        record();
        if (table === 'commerce_connections') {
          return { data: { id: 'conn-1', workspace_id: 'ws-1', installation_id: 'inst-1', approved_origin: 'https://shop.example.com', revoked_at: null }, error: null };
        }
        if (table === 'commerce_sync_jobs' && patch && 'leased_until' in patch) {
          return { data: renewalMatches ? { id: 'job-1' } : null, error: null };
        }
        return { data: null, error: null };
      },
      then: (resolve: (r: { data: null; error: null }) => unknown) => { record(); return resolve({ data: null, error: null }); },
    });
    return b;
  };
  return { from: (t: string) => make(t), rpc: async () => ({ data: 0, error: null }) };
}

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient() }));
vi.mock('../../../server/services/commerce/credentials.js', () => ({ readInstallationSecret: async () => 'secret' }));
vi.mock('../../../server/services/commerce/signing.js', () => ({ buildSignedHeaders: () => ({}) }));
vi.mock('../../../server/services/commerce/productIndex.js', () => ({ upsertProductInIndex: async () => 'x' }));
vi.mock('../../../server/services/commerce/connectors/woocommerce.js', () => ({
  WooCommerceConnector: class {},
  normalizeWooCommerceProduct: (raw: unknown) => raw,
}));
vi.mock('../../../server/services/commerce/httpClient.js', () => ({
  commerceHttpRequest: async ({ url }: { url: string }) => {
    if (onFetch) await onFetch();
    const page = Number(new URL(url).searchParams.get('page') ?? '1');
    return { status: 200, json: storePages[page - 1] ?? { products: [], has_more: false } };
  },
}));

const { runSyncJobOnce, holdSyncLease, SYNC_LEASE_RENEW_MS, SYNC_LEASE_SECONDS } = await import('../../../server/services/commerce/sync.js');
type SyncJob = Parameters<typeof runSyncJobOnce>[1];
const CONFIG = {} as Parameters<typeof runSyncJobOnce>[0];
const job = (o: Partial<SyncJob> = {}): SyncJob => ({
  id: 'job-1', workspace_id: 'ws-1', connection_id: 'conn-1', job_type: 'manual_resync',
  status: 'running', attempts: 1, max_attempts: 5, leased_by: 'worker-a', ...o,
});
const jobWrites = () => writes.filter((w) => w.table === 'commerce_sync_jobs');

beforeEach(() => {
  writes = [];
  renewalMatches = true;
  storePages = [{ products: [{ externalId: '1' }], has_more: false }];
  onFetch = null;
});
afterEach(() => { vi.useRealTimers(); });

describe('commerce sync lease', () => {
  it('renews well inside the lease', () => {
    expect(SYNC_LEASE_RENEW_MS).toBeLessThan((SYNC_LEASE_SECONDS * 1000) / 2);
  });

  it('scopes the final write to the worker holding the lease', async () => {
    await runSyncJobOnce(CONFIG, job());
    const done = jobWrites().find((w) => w.patch.status === 'succeeded');
    expect(done?.filters).toEqual(expect.arrayContaining([['id', 'job-1'], ['status', 'running'], ['leased_by', 'worker-a']]));
  });

  it('scopes a failure (dead letter) to the lease too', async () => {
    onFetch = async () => { throw new Error('store unreachable'); };
    await runSyncJobOnce(CONFIG, job({ attempts: 5, max_attempts: 5 }));
    const dead = jobWrites().find((w) => w.patch.status === 'dead_letter');
    expect(dead?.filters).toEqual(expect.arrayContaining([['leased_by', 'worker-a']]));
  });

  it('renews the lease while a run lasts, scoped to its holder', async () => {
    vi.useFakeTimers();
    const lease = holdSyncLease(CONFIG, job(), 1000);
    await vi.advanceTimersByTimeAsync(1000);
    const renewal = jobWrites().find((w) => 'leased_until' in w.patch);
    expect(renewal?.filters).toEqual(expect.arrayContaining([['id', 'job-1'], ['status', 'running'], ['leased_by', 'worker-a']]));
    expect(lease.lost).toBe(false);
    lease.stop();
  });

  it('a run whose lease was reclaimed stops and writes nothing to the job', async () => {
    vi.useFakeTimers();
    renewalMatches = false;
    storePages = [
      { products: [{ externalId: '1' }], has_more: true },
      { products: [{ externalId: '2' }], has_more: false },
    ];
    // The first page takes longer than a renewal period.
    let first = true;
    onFetch = async () => {
      if (!first) return;
      first = false;
      await new Promise((r) => setTimeout(r, SYNC_LEASE_RENEW_MS + 10));
    };
    const run = runSyncJobOnce(CONFIG, job());
    await vi.advanceTimersByTimeAsync(SYNC_LEASE_RENEW_MS + 20);
    await run;
    const statusWrites = jobWrites().filter((w) => 'status' in w.patch);
    expect(statusWrites).toEqual([]);
  });

  it('a job without a recorded holder keeps the old unscoped writes', async () => {
    await runSyncJobOnce(CONFIG, job({ leased_by: undefined }));
    const done = jobWrites().find((w) => w.patch.status === 'succeeded');
    expect(done?.filters).toEqual([['id', 'job-1']]);
  });
});
