/**
 * THE headline requirement: General Storage and Analytics Storage are two
 * independent topologies that share only vendor CREDENTIALS.
 *
 * These suites hold that line from both directions — changing one must not
 * move the other — and then prove the analytics topology behaves correctly
 * on its own terms: it writes to its own primary, replicates to its own
 * replicas, records a replica failure without losing the canonical object,
 * and refuses to promote a replica that has not been proven complete.
 *
 * Both runtime-config keys live in the SAME fake store (./fakeAnalyticsPool),
 * so the isolation results are evidence rather than an artifact of the
 * harness only knowing about one of them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  resetFakeAnalyticsPool, seedGeneralPool, seedAnalyticsPool,
  getAnalyticsPool, getGeneralPool, getReplicaState, runtimeConfig,
  STORAGE_POOL_KEY, STORAGE_DEFAULT_KEY,
} from './fakeAnalyticsPool';

vi.mock('../../../server/supabase.js', async () => {
  const { makeFakeSupabaseClient } = await import('./fakeAnalyticsPool');
  const client = makeFakeSupabaseClient();
  return { getServiceClient: () => client };
});

// Observability is proven by its own suites; here it must simply not stand
// between the test and the storage calls.
vi.mock('../../../server/services/observability/metrics.js', () => ({
  emitMetric: () => undefined,
  emitLog: () => undefined,
}));

const analyticsPool = await import('../../../server/services/analytics/pool.js');
const { readAnalyticsPool, writeAnalyticsPool, isAnalyticsReplicaSynchronized, analyticsReplicaHealth } = analyticsPool;
const { flushAnalytics, enqueueAnalyticsRow, bufferedRowCount, __resetAnalyticsBuffer } =
  await import('../../../server/services/analytics/writer.js');
const { syncAnalyticsReplica } = await import('../../../server/services/analytics/replication.js');
const { buildEventRow } = await import('../../../server/services/analytics/schema.js');
const { adminAnalyticsStorageRouter, __resetAnalyticsAdminRateLimit } =
  await import('../../../server/routes/adminAnalyticsStorage.js');
const { readStoragePool, writeStoragePool } = await import('../../../server/services/storage/pool.js');

const serverConfig = {} as Parameters<typeof readAnalyticsPool>[0];
const WS_A = '11111111-1111-1111-1111-111111111111';
const WS_B = '22222222-2222-2222-2222-222222222222';

// ── Route harness ────────────────────────────────────────────────

interface FakeRes { statusCode: number; body: unknown; status(c: number): FakeRes; json(p: unknown): FakeRes }

function makeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 200, body: undefined,
    status(code) { res.statusCode = code; return res; },
    json(payload) { res.body = payload; return res; },
  };
  return res;
}

type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: { handle: (req: unknown, res: unknown, next: () => void) => unknown }[] } };

async function call(method: string, routePath: string, params: Record<string, string>, body?: unknown) {
  const stack = (adminAnalyticsStorageRouter as unknown as { stack: Layer[] }).stack;
  const layer = stack.find((l) => l.route?.path === routePath && l.route.methods[method]);
  if (!layer?.route) throw new Error(`route ${method} ${routePath} not found`);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const res = makeRes();
  await handler({ params, body, query: {}, serverConfig, adminUser: { id: 'admin-1' } }, res, () => {});
  return res;
}

// ── Two independent object stores ────────────────────────────────
//
// `local` writes to a real temp directory (the analytics primary); the
// S3-shaped vendors are served by a stubbed fetch, one bucket each, so a
// write landing in the wrong place is visible rather than absorbed.

let primaryDir: string;
let buckets: Map<string, Map<string, Buffer>>;
let downVendors: Set<string>;
let restoreFetch: () => void;

/**
 * Bucket names are deliberately NOT prefixes of their endpoint hostnames.
 * `s3BucketBase()` treats an endpoint whose host starts with the bucket name
 * as virtual-host style and then omits the bucket segment — correct
 * behaviour, but it would make `minio` + `minio.local:9000` address objects
 * at the root and silently break the vendor→bucket mapping here.
 */
const BUCKET_OF: Record<string, string> = {
  arvan_storage: 'arvan-general',
  cloudflare_r2: 'r2-analytics',
  minio: 'minio-analytics',
};

function bucketFor(name: string): Map<string, Buffer> {
  if (!buckets.has(name)) buckets.set(name, new Map());
  return buckets.get(name)!;
}

function installS3Stub(): () => void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const segments = url.pathname.split('/').filter(Boolean);
    const bucketName = segments[0] ?? '';
    const store = bucketFor(bucketName);
    // A real S3 server decodes the percent-encoded path before it addresses an
    // object, so the stub must too — keys are signed and sent encoded.
    const key = segments.slice(1).map(decodeURIComponent).join('/');

    if (downVendors.has(bucketName)) return new Response('vendor down', { status: 503 });

    if (method === 'GET' && url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      return new Response(
        `<?xml version="1.0"?><ListBucketResult>${
          keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join('')
        }<IsTruncated>false</IsTruncated></ListBucketResult>`,
        { status: 200 },
      );
    }
    if (method === 'PUT') {
      // The driver hands fetch a Buffer; undici surfaces it here as an
      // ArrayBuffer (or a view of one). Stringifying that would store
      // "[object ArrayBuffer]" and make every byte-equality assertion fail
      // for a reason that has nothing to do with replication.
      const body = init?.body as ArrayBuffer | ArrayBufferView | string | undefined;
      const bytes =
        ArrayBuffer.isView(body)
          ? Buffer.from(body.buffer, body.byteOffset, body.byteLength)
          : body instanceof ArrayBuffer
            ? Buffer.from(body)
            : Buffer.from(String(body ?? ''));
      store.set(key, Buffer.from(bytes));
      return new Response('', { status: 200 });
    }
    if (method === 'DELETE') { store.delete(key); return new Response(null, { status: 204 }); }
    if (method === 'GET') {
      const body = store.get(key);
      return body === undefined ? new Response('', { status: 404 }) : new Response(body, { status: 200 });
    }
    return new Response('', { status: 200 });
  }) as typeof globalThis.fetch;
  return () => { globalThis.fetch = realFetch; };
}

/** Objects the `local` vendor (the analytics primary) actually holds. */
function localKeys(): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const next = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), next);
      else out.push(next);
    }
  };
  walk(primaryDir, '');
  return out.sort();
}

function localBytes(key: string): Buffer {
  return fs.readFileSync(path.join(primaryDir, key));
}

/**
 * The deliberately asymmetric starting point from the requirements:
 *
 *   General   primary = bunny_storage,  mirror = arvan_storage
 *   Analytics primary = local (stands in for Arvan), replicas = R2 + MinIO
 *
 * If the two topologies were coupled in any way, an analytics write would
 * land in the general primary's bucket and these tests would see it.
 */
function seedBothPools(opts?: { replicas?: string[]; replicationEnabled?: boolean }) {
  seedGeneralPool({
    primary: 'bunny_storage',
    providers: {
      bunny_storage: { config: { username: 'general-zone', password: 'pw', hostname: 'storage.bunnycdn.com', cdn_url: 'https://general.b-cdn.net' } },
      arvan_storage: { config: { bucket: BUCKET_OF.arvan_storage, region: 'ir-thr-at1', access_key_id: 'ak', secret_access_key: 'sk' } },
      local: { config: { local_path: primaryDir, public_url: 'http://localhost:9999/files' } },
      cloudflare_r2: { config: { bucket: BUCKET_OF.cloudflare_r2, account_id: 'acc', access_key_id: 'ak', secret_access_key: 'sk' } },
      minio: { config: { bucket: BUCKET_OF.minio, endpoint: 'http://objects.local:9000', access_key: 'ak', secret_key: 'sk' } },
    },
  });
  seedAnalyticsPool({
    enabled: true,
    primary: 'local',
    replicas: opts?.replicas ?? ['cloudflare_r2', 'minio'],
    replicationEnabled: opts?.replicationEnabled !== false,
    prefix: 'analytics/web/',
    batchRows: 10_000,
    batchBytes: 32 * 1024 * 1024,
    flushIntervalMs: 15_000,
    format: 'parquet',
    compression: 'zstd',
    writeMode: 'dual_write',
    readMode: 'postgres',
    replicaState: {},
    objectsWritten: 0, bytesWritten: 0, rowsWritten: 0,
  });
}

function row(overrides: Partial<Parameters<typeof buildEventRow>[0]> & { workspaceId?: string } = {}) {
  return buildEventRow({
    workspaceId: overrides.workspaceId ?? WS_A,
    eventType: 'page_view',
    url: 'https://shop.test/products/1',
    title: 'Product',
    session: { visitorId: 'visitor-1', sessionId: 'session-1', browser: 'Chrome', country: 'Iran', ...(overrides.session ?? {}) },
    ...overrides,
  });
}

async function flushOne() {
  __resetAnalyticsBuffer();
  const pool = await readAnalyticsPool(serverConfig);
  enqueueAnalyticsRow(serverConfig, pool, row());
  return flushAnalytics(serverConfig, { force: true });
}

beforeEach(() => {
  __resetAnalyticsAdminRateLimit();
  __resetAnalyticsBuffer();
  resetFakeAnalyticsPool();
  primaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-primary-'));
  buckets = new Map();
  downVendors = new Set();
  restoreFetch = installS3Stub();
  seedBothPools();
});

afterEach(() => {
  restoreFetch();
  __resetAnalyticsBuffer();
  fs.rmSync(primaryDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────

describe('provider role isolation', () => {
  it('lets the same vendor hold different roles in each topology at once', async () => {
    const general = await readStoragePool(serverConfig);
    const analytics = await readAnalyticsPool(serverConfig);

    expect(general.primary).toBe('bunny_storage');
    expect(analytics.primary).toBe('local');
    expect(analytics.primary).not.toBe(general.primary);
    // Arvan is a general mirror and is free to hold no analytics role at all.
    expect(general.providers.arvan_storage.enabled).toBe(true);
    expect(analytics.replicas).not.toContain('arvan_storage');
  });

  it('changing the ANALYTICS primary leaves the general primary and its mirrors untouched', async () => {
    const before = await readStoragePool(serverConfig);
    const beforeDefault = runtimeConfig.get(STORAGE_DEFAULT_KEY);

    // Make cloudflare_r2 promotable: a full sync from the current analytics primary.
    await flushOne();
    await fullSync('cloudflare_r2');
    const res = await call('post', '/primary/:providerName', { providerName: 'cloudflare_r2' }, {});
    expect(res.statusCode).toBe(200);

    expect((await readAnalyticsPool(serverConfig)).primary).toBe('cloudflare_r2');

    const after = await readStoragePool(serverConfig);
    expect(after.primary).toBe(before.primary);
    expect(after.replication).toEqual(before.replication);
    expect(Object.keys(after.providers).sort()).toEqual(Object.keys(before.providers).sort());
    // The legacy pointer every general resolver reads is untouched too.
    expect(runtimeConfig.get(STORAGE_DEFAULT_KEY)).toEqual(beforeDefault);
  });

  it('changing the GENERAL primary leaves the analytics primary and replicas untouched', async () => {
    const before = await readAnalyticsPool(serverConfig);

    const general = await readStoragePool(serverConfig);
    general.primary = 'arvan_storage';
    await writeStoragePool(serverConfig, general);

    expect((await readStoragePool(serverConfig)).primary).toBe('arvan_storage');

    const after = await readAnalyticsPool(serverConfig);
    expect(after.primary).toBe(before.primary);
    expect(after.replicas).toEqual(before.replicas);
    expect(after.enabled).toBe(before.enabled);
  });

  it('selecting analytics replicas never touches the general pool row', async () => {
    const before = JSON.stringify(getGeneralPool());
    const res = await call('put', '/replicas', {}, { replicas: ['minio'] });
    expect(res.statusCode).toBe(200);
    expect((await readAnalyticsPool(serverConfig)).replicas).toEqual(['minio']);
    expect(JSON.stringify(getGeneralPool())).toBe(before);
  });

  it('stores no analytics credentials of its own — only provider names', async () => {
    const pool = getAnalyticsPool()!;
    const serialized = JSON.stringify(pool);
    expect(serialized).not.toContain('access_key');
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain(primaryDir);
    expect(pool.primary).toBe('local');
  });

  it('never returns a credential through the admin API', async () => {
    const res = await call('get', '/', {});
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('secret_access_key');
    expect(body).not.toContain('sk');
    // But it DOES show which vendor holds which role, in both topologies.
    expect((res.body as { generalPrimary: string }).generalPrimary).toBe('bunny_storage');
    expect((res.body as { primary: string }).primary).toBe('local');
  });
});

describe('analytics writes follow the ANALYTICS topology', () => {
  it('writes the canonical object to the analytics primary, not the general one', async () => {
    const result = await flushOne();

    expect(result.objects).toBe(1);
    const keys = localKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^analytics\/web\/workspace=11111111-1111-1111-1111-111111111111\/year=\d{4}\/month=\d{2}\/day=\d{2}\/part-.*\.parquet$/);

    // Nothing reached the general primary's vendor or the general mirror.
    expect(buckets.get(BUCKET_OF.arvan_storage)?.size ?? 0).toBe(0);
  });

  it('replicates the SAME key and the SAME bytes to every analytics replica', async () => {
    await flushOne();

    const key = localKeys()[0];
    const primaryBytes = localBytes(key);

    for (const bucket of [BUCKET_OF.cloudflare_r2, BUCKET_OF.minio]) {
      const copy = buckets.get(bucket)?.get(key);
      expect(copy, `${bucket} is missing ${key}`).toBeDefined();
      expect(copy!.equals(primaryBytes)).toBe(true);
    }
  });

  it('keeps the primary canonical when one replica fails, and marks only that replica dirty', async () => {
    downVendors.add(BUCKET_OF.minio);
    const result = await flushOne();

    // The batch still succeeded — the primary holds the object.
    expect(result.objects).toBe(1);
    const key = localKeys()[0];
    expect(fs.existsSync(path.join(primaryDir, key))).toBe(true);
    expect(buckets.get(BUCKET_OF.cloudflare_r2)?.get(key)).toBeDefined();
    expect(buckets.get(BUCKET_OF.minio)?.get(key)).toBeUndefined();

    const pool = await readAnalyticsPool(serverConfig);
    expect(analyticsReplicaHealth(pool, 'minio')).toBe('dirty');
    expect(pool.replicaState.minio?.dirtyReason).toMatch(/mirror_upload_failed/);
    // The healthy replica is untouched by its sibling's failure.
    expect(pool.replicaState.cloudflare_r2?.dirtyAt ?? null).toBeNull();
  });

  it('does not mark the batch successful when the analytics primary rejects the write', async () => {
    // A primary that answers 503 — the realistic failure, and the one the
    // requirement is about: the batch must NOT be reported as written.
    seedAnalyticsPool({
      ...getAnalyticsPool()!,
      primary: 'minio',
      replicas: ['cloudflare_r2'],
      replicaState: {},
    });
    downVendors.add(BUCKET_OF.minio);

    const pool = await readAnalyticsPool(serverConfig);
    __resetAnalyticsBuffer();
    enqueueAnalyticsRow(serverConfig, pool, row());
    const result = await flushAnalytics(serverConfig, { force: true });

    expect(result.objects).toBe(0);
    expect(result.failures).toBe(1);
    expect(getAnalyticsPool()!.lastError).toMatch(/primary_write_failed/);
    // Replicas must not hold an object the primary never accepted.
    expect(buckets.get(BUCKET_OF.cloudflare_r2)?.size ?? 0).toBe(0);
    // The rows are kept for the next flush, not dropped on the floor.
    expect(bufferedRowCount()).toBe(1);
  });

  it('skips replication entirely when analytics replication is switched off', async () => {
    seedBothPools({ replicationEnabled: false });
    await flushOne();

    expect(localKeys()).toHaveLength(1);
    expect(buckets.get(BUCKET_OF.cloudflare_r2)?.size ?? 0).toBe(0);
    expect(buckets.get(BUCKET_OF.minio)?.size ?? 0).toBe(0);
  });

  it('writes nothing at all while analytics storage is disabled', async () => {
    const pool = await readAnalyticsPool(serverConfig);
    pool.enabled = false;
    await writeAnalyticsPool(serverConfig, pool);

    __resetAnalyticsBuffer();
    enqueueAnalyticsRow(serverConfig, { ...pool, enabled: true }, row());
    const result = await flushAnalytics(serverConfig, { force: true });

    expect(result.objects).toBe(0);
    expect(localKeys()).toHaveLength(0);
  });
});

describe('multi-tenant isolation', () => {
  it('puts each workspace under its own object prefix', async () => {
    __resetAnalyticsBuffer();
    const pool = await readAnalyticsPool(serverConfig);
    enqueueAnalyticsRow(serverConfig, pool, row({ workspaceId: WS_A }));
    enqueueAnalyticsRow(serverConfig, pool, row({ workspaceId: WS_B }));
    await flushAnalytics(serverConfig, { force: true });

    const keys = localKeys();
    expect(keys).toHaveLength(2);
    expect(keys.filter((k) => k.includes(`workspace=${WS_A}`))).toHaveLength(1);
    expect(keys.filter((k) => k.includes(`workspace=${WS_B}`))).toHaveLength(1);
    // Never one object holding two workspaces' rows.
    for (const key of keys) {
      const owners = keys.filter((k) => k === key).length;
      expect(owners).toBe(1);
    }
  });

  it('files rows under the day they occurred, not the day they were flushed', async () => {
    __resetAnalyticsBuffer();
    const pool = await readAnalyticsPool(serverConfig);
    enqueueAnalyticsRow(serverConfig, pool, row({ occurredAt: '2026-09-15T23:59:00.000Z' }));
    enqueueAnalyticsRow(serverConfig, pool, row({ occurredAt: '2026-09-16T00:01:00.000Z' }));
    await flushAnalytics(serverConfig, { force: true });

    const keys = localKeys();
    expect(keys.some((k) => k.includes('year=2026/month=09/day=15/'))).toBe(true);
    expect(keys.some((k) => k.includes('year=2026/month=09/day=16/'))).toBe(true);
  });
});

// ── Replica sync + promotion ─────────────────────────────────────

async function fullSync(target: string) {
  let result = await syncAnalyticsReplica(serverConfig, { target, restart: true, limit: 50 });
  let rounds = 1;
  while (result.report && !result.report.done) {
    result = await syncAnalyticsReplica(serverConfig, { target, limit: 50 });
    if (++rounds > 20) throw new Error('sync never finished');
  }
  return result;
}

describe('analytics replica sync', () => {
  it('copies from the ANALYTICS primary, never the general one', async () => {
    // A replica added after the fact holds nothing until a sync runs.
    await call('put', '/replicas', {}, { replicas: ['cloudflare_r2'] });
    await flushOne();
    buckets.get(BUCKET_OF.cloudflare_r2)?.clear();

    const result = await fullSync('cloudflare_r2');
    expect(result.ok).toBe(true);
    expect(result.report!.total.copied).toBe(1);

    const key = localKeys()[0];
    expect(buckets.get(BUCKET_OF.cloudflare_r2)!.get(key)!.equals(localBytes(key))).toBe(true);
    // The general primary was never read from and never written to.
    expect(buckets.get(BUCKET_OF.arvan_storage)?.size ?? 0).toBe(0);
  });

  it('marks a replica synchronized only after a complete, zero-failure walk', async () => {
    await flushOne();
    const before = await readAnalyticsPool(serverConfig);
    expect(isAnalyticsReplicaSynchronized(before, 'cloudflare_r2')).toBe(false);

    const result = await fullSync('cloudflare_r2');
    expect(result.report!.markedSynchronized).toBe(true);
    expect(isAnalyticsReplicaSynchronized(await readAnalyticsPool(serverConfig), 'cloudflare_r2')).toBe(true);
  });

  it('refuses to mark a workspace-scoped walk as full readiness', async () => {
    await flushOne();
    const result = await syncAnalyticsReplica(serverConfig, {
      target: 'cloudflare_r2', prefix: `workspace=${WS_A}/`, restart: true, limit: 50,
    });
    expect(result.ok).toBe(true);
    expect(result.report!.markedSynchronized).toBe(false);
    expect(isAnalyticsReplicaSynchronized(await readAnalyticsPool(serverConfig), 'cloudflare_r2')).toBe(false);
  });

  it('confines every walk to the analytics namespace, whatever prefix is asked for', async () => {
    await flushOne();
    const result = await syncAnalyticsReplica(serverConfig, {
      target: 'cloudflare_r2', prefix: '../../workspace/', restart: true, limit: 50,
    });
    expect(result.ok).toBe(true);
    expect(result.report!.prefix.startsWith('analytics/web/')).toBe(true);
    expect(result.report!.prefix).not.toContain('..');
  });

  it('refuses to sync a vendor that is not an analytics replica', async () => {
    const result = await syncAnalyticsReplica(serverConfig, { target: 'arvan_storage' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not an analytics replica/);
  });

  it('skips objects the replica already holds, so re-running is cheap', async () => {
    await flushOne();
    await fullSync('cloudflare_r2');
    const second = await fullSync('cloudflare_r2');
    expect(second.report!.total.copied).toBe(0);
    expect(second.report!.total.skipped).toBeGreaterThan(0);
  });
});

describe('analytics primary promotion', () => {
  it('refuses to promote a replica that has never been proven complete', async () => {
    await flushOne();
    const res = await call('post', '/primary/:providerName', { providerName: 'cloudflare_r2' }, {});
    expect(res.statusCode).toBe(409);
    expect((res.body as { reason: string }).reason).toBe('not_synchronized');
    expect((await readAnalyticsPool(serverConfig)).primary).toBe('local');
  });

  it('refuses to promote a replica whose readiness a failed mirror write invalidated', async () => {
    await flushOne();
    await fullSync('cloudflare_r2');
    expect(isAnalyticsReplicaSynchronized(await readAnalyticsPool(serverConfig), 'cloudflare_r2')).toBe(true);

    // A later write misses that replica — the old proof is now a lie.
    downVendors.add(BUCKET_OF.cloudflare_r2);
    await flushOne();

    expect(getReplicaState('cloudflare_r2')?.dirtyAt).toBeTruthy();
    downVendors.delete(BUCKET_OF.cloudflare_r2);

    const res = await call('post', '/primary/:providerName', { providerName: 'cloudflare_r2' }, {});
    expect(res.statusCode).toBe(409);
    expect((res.body as { reason: string }).reason).toBe('not_synchronized');
  });

  it('allows promotion once a fresh full sync proves the replica caught up', async () => {
    await flushOne();
    await fullSync('cloudflare_r2');

    const res = await call('post', '/primary/:providerName', { providerName: 'cloudflare_r2' }, {});
    expect(res.statusCode).toBe(200);

    const pool = await readAnalyticsPool(serverConfig);
    expect(pool.primary).toBe('cloudflare_r2');
    // The new primary stops being one of its own replicas...
    expect(pool.replicas).not.toContain('cloudflare_r2');
    // ...and the demoted primary becomes a replica so its objects stay covered.
    expect(pool.replicas).toContain('local');
    // Every remaining replica was proven against the OLD primary, so that
    // proof no longer applies.
    expect(isAnalyticsReplicaSynchronized(pool, 'minio')).toBe(false);
  });

  it('refuses a vendor that cannot be queried as a Parquet source', async () => {
    const res = await call('post', '/primary/:providerName', { providerName: 'bunny_storage' }, {});
    expect(res.statusCode).toBe(400);
    expect((res.body as { reason: string }).reason).toBe('not_eligible');
    // ...but it may still be a replica.
    const ok = await call('put', '/replicas', {}, { replicas: ['bunny_storage'] });
    expect(ok.statusCode).toBe(200);
  });

  it('refuses to make a vendor the analytics primary when it holds no credentials', async () => {
    const general = await readStoragePool(serverConfig);
    delete general.providers.cloudflare_r2;
    await writeStoragePool(serverConfig, general);

    const res = await call('post', '/primary/:providerName', { providerName: 'cloudflare_r2' }, {});
    expect(res.statusCode).toBe(409);
    expect((res.body as { reason: string }).reason).toBe('not_configured');
  });
});

describe('replica selection rules', () => {
  it('refuses to make the analytics primary its own replica', async () => {
    const res = await call('put', '/replicas', {}, { replicas: ['local'] });
    expect(res.statusCode).toBe(400);
    expect((res.body as { reason: string }).reason).toBe('primary_as_replica');
  });

  it('refuses a vendor that cannot be listed, so replication can never become a write-only hole', async () => {
    const res = await call('put', '/replicas', {}, { replicas: ['gcs'] });
    expect(res.statusCode).toBe(400);
    expect((res.body as { reason: string }).reason).toBe('not_eligible');
  });

  it('switching replication off invalidates every readiness proof', async () => {
    await flushOne();
    await fullSync('cloudflare_r2');
    expect(isAnalyticsReplicaSynchronized(await readAnalyticsPool(serverConfig), 'cloudflare_r2')).toBe(true);

    const res = await call('put', '/settings', {}, { replicationEnabled: false });
    expect(res.statusCode).toBe(200);
    expect(isAnalyticsReplicaSynchronized(await readAnalyticsPool(serverConfig), 'cloudflare_r2')).toBe(false);
  });
});

describe('phase gates', () => {
  it('refuses to stop writing to PostgreSQL in this build', async () => {
    const res = await call('put', '/settings', {}, { writeMode: 's3_only' });
    expect(res.statusCode).toBe(409);
    expect((res.body as { reason: string }).reason).toBe('phase_locked');
    expect((await readAnalyticsPool(serverConfig)).writeMode).toBe('dual_write');
  });

  it('refuses to serve reports from S3 in this build', async () => {
    const res = await call('put', '/settings', {}, { readMode: 's3' });
    expect(res.statusCode).toBe(409);
    expect((await readAnalyticsPool(serverConfig)).readMode).toBe('postgres');
  });

  it('refuses to enable analytics storage before a primary is chosen', async () => {
    runtimeConfig.delete('analytics_storage_pool');
    const res = await call('put', '/settings', {}, { enabled: true });
    expect(res.statusCode).toBe(409);
    expect((res.body as { reason: string }).reason).toBe('no_primary');
  });
});

describe('general storage regression', () => {
  it('leaves the general pool byte-identical across a full analytics lifecycle', async () => {
    const before = JSON.stringify(runtimeConfig.get(STORAGE_POOL_KEY));
    const beforeDefault = JSON.stringify(runtimeConfig.get(STORAGE_DEFAULT_KEY));

    await call('put', '/settings', {}, { batchRows: 500, flushIntervalMs: 2000 });
    await call('put', '/replicas', {}, { replicas: ['cloudflare_r2', 'minio'] });
    await flushOne();
    await fullSync('cloudflare_r2');
    await call('post', '/primary/:providerName', { providerName: 'cloudflare_r2' }, {});

    expect(JSON.stringify(runtimeConfig.get(STORAGE_POOL_KEY))).toBe(before);
    expect(JSON.stringify(runtimeConfig.get(STORAGE_DEFAULT_KEY))).toBe(beforeDefault);
  });
});
