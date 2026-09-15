/**
 * Storage provider pool — several vendors configured at once, one primary,
 * the enabled rest mirrored (server/services/storage/pool.ts).
 *
 * What these tests pin down:
 *  - reads FAIL CLOSED: a PostgREST `{error}` must never look like "no pool
 *    configured", or an admin mutation would overwrite a multi-provider pool
 *    with a one-entry one;
 *  - the pool and the legacy `default_storage_provider` pointer are written
 *    by ONE transactional RPC — never one without the other;
 *  - a back-fill walks EVERY object deterministically: a provider page can
 *    hold far more keys than one sync batch copies, and a provider may have
 *    no continuation token at all;
 *  - promotion readiness is earned by a completed whole-namespace walk that
 *    the server recorded itself.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

type Row = { key: string; value: unknown };

/** The fake DB. `rpcError` makes set_storage_provider_pool fail like a real one would. */
const runtimeConfig = new Map<string, unknown>();
const dbState: { readError: { message: string } | null; rpcError: { message: string } | null; rpcCalls: number } = {
  readError: null, rpcError: null, rpcCalls: 0,
};

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      let wantedKey: string | null = null;
      const builder = {
        select: () => builder,
        eq: (col: string, value: string) => { if (col === 'key') wantedKey = value; return builder; },
        order: () => builder,
        limit: () => builder,
        single: async () => ({ data: null, error: null }),
        maybeSingle: async () => {
          if (table !== 'app_runtime_config') return { data: null, error: null };
          if (dbState.readError) return { data: null, error: dbState.readError };
          return {
            data: wantedKey && runtimeConfig.has(wantedKey)
              ? ({ key: wantedKey, value: runtimeConfig.get(wantedKey) } as Row)
              : null,
            error: null,
          };
        },
      };
      return builder;
    },
    // Mirrors migration 189: both keys move together, or neither does.
    rpc: async (fn: string, args: { _pool: unknown; _default: unknown }) => {
      if (fn !== 'set_storage_provider_pool') throw new Error(`unexpected rpc ${fn}`);
      dbState.rpcCalls++;
      if (dbState.rpcError) return { data: null, error: dbState.rpcError };
      runtimeConfig.set('storage_provider_pool', args._pool);
      if (args._default === null) runtimeConfig.delete('default_storage_provider');
      else runtimeConfig.set('default_storage_provider', args._default);
      return { data: null, error: null };
    },
  }),
}));

const {
  normalizePool, replicaEntries, readStoragePool, writeStoragePool, isReplicaSynchronized,
  STORAGE_POOL_KEY, STORAGE_DEFAULT_KEY,
} = await import('../../../server/services/storage/pool.js');
const { storageConfigFromRecord, syncStorageReplica, SUPPORTED_STORAGE_PROVIDERS } =
  await import('../../../server/services/storage/index.js');

const serverConfig = {} as Parameters<typeof readStoragePool>[0];

beforeEach(() => {
  runtimeConfig.clear();
  dbState.readError = null;
  dbState.rpcError = null;
  dbState.rpcCalls = 0;
});

describe('normalizePool', () => {
  it('fills in defaults for an empty value', () => {
    const pool = normalizePool(undefined);
    expect(pool.primary).toBeNull();
    expect(pool.providers).toEqual({});
    expect(pool.replication).toEqual({ enabled: true, mirrorDeletes: false });
  });

  it('drops a primary that is not one of the configured providers', () => {
    const pool = normalizePool({ primary: 'ghost', providers: { s3: { enabled: true, config: {} } } });
    expect(pool.primary).toBeNull();
  });

  it('treats a provider without an explicit flag as enabled', () => {
    const pool = normalizePool({ providers: { s3: { config: { bucket: 'b' } } } });
    expect(pool.providers.s3.enabled).toBe(true);
    expect(pool.providers.s3.config).toEqual({ bucket: 'b' });
  });
});

describe('replicaEntries', () => {
  it('is every enabled vendor except the primary', () => {
    const pool = normalizePool({
      primary: 's3',
      providers: {
        s3: { enabled: true, config: {} },
        arvan_storage: { enabled: true, config: { bucket: 'copy' } },
        minio: { enabled: false, config: {} },
      },
    });
    expect(replicaEntries(pool).map((r) => r.name)).toEqual(['arvan_storage']);
  });
});

describe('readStoragePool — fail closed', () => {
  it('throws on a PostgREST error instead of reporting an empty pool', async () => {
    runtimeConfig.set(STORAGE_POOL_KEY, {
      primary: 's3',
      providers: { s3: { enabled: true, config: {} }, minio: { enabled: true, config: {} } },
    });
    dbState.readError = { message: 'connection reset by peer' };

    await expect(readStoragePool(serverConfig)).rejects.toThrow(/connection reset/);
  });

  it('a failed read can never be mistaken for the legacy one-provider state', async () => {
    dbState.readError = { message: 'statement timeout' };
    await expect(readStoragePool(serverConfig)).rejects.toThrow(/statement timeout/);
  });

  it('projects the legacy single default into a one-entry pool', async () => {
    runtimeConfig.set(STORAGE_DEFAULT_KEY, { provider_name: 'bunny_storage', config: { storage_zone: 'z' } });

    const pool = await readStoragePool(serverConfig);

    expect(pool.primary).toBe('bunny_storage');
    expect(pool.providers.bunny_storage.config).toEqual({ storage_zone: 'z' });
  });

  it('follows the legacy pointer when it disagrees with a stale stored primary', async () => {
    runtimeConfig.set(STORAGE_POOL_KEY, {
      primary: 'minio',
      providers: { minio: { enabled: true, config: {} }, s3: { enabled: true, config: {} } },
    });
    runtimeConfig.set(STORAGE_DEFAULT_KEY, { provider_name: 's3', config: {} });

    expect((await readStoragePool(serverConfig)).primary).toBe('s3');
  });
});

describe('writeStoragePool — atomic with the legacy pointer', () => {
  it('writes both keys through one transactional RPC', async () => {
    await writeStoragePool(serverConfig, normalizePool({
      primary: 'arvan_storage',
      providers: {
        arvan_storage: { enabled: true, config: { bucket: 'main', region: 'ir-thr-at1' } },
        s3: { enabled: true, config: { bucket: 'copy' } },
      },
    }));

    expect(dbState.rpcCalls).toBe(1);
    expect(runtimeConfig.get(STORAGE_DEFAULT_KEY)).toEqual({
      provider_name: 'arvan_storage',
      config: { bucket: 'main', region: 'ir-thr-at1' },
    });
    expect(runtimeConfig.has(STORAGE_POOL_KEY)).toBe(true);
  });

  it('commits neither half when the transaction fails', async () => {
    // A pool that is already live — the failed write must not disturb it.
    runtimeConfig.set(STORAGE_POOL_KEY, { primary: 'local', providers: { local: { enabled: true, config: {} } } });
    runtimeConfig.set(STORAGE_DEFAULT_KEY, { provider_name: 'local', config: {} });
    dbState.rpcError = { message: 'deadlock detected' };

    await expect(writeStoragePool(serverConfig, normalizePool({
      primary: 's3',
      providers: { s3: { enabled: true, config: { bucket: 'new' } } },
    }))).rejects.toThrow(/deadlock detected/);

    expect(runtimeConfig.get(STORAGE_DEFAULT_KEY)).toEqual({ provider_name: 'local', config: {} });
    expect(normalizePool(runtimeConfig.get(STORAGE_POOL_KEY)).primary).toBe('local');
  });

  it('removes the legacy pointer when the pool has no primary left', async () => {
    runtimeConfig.set(STORAGE_DEFAULT_KEY, { provider_name: 'local', config: {} });

    await writeStoragePool(serverConfig, normalizePool({ primary: null, providers: {} }));

    expect(runtimeConfig.has(STORAGE_DEFAULT_KEY)).toBe(false);
  });

  it('never stores a disabled primary — that would write to a switched-off vendor', async () => {
    await writeStoragePool(serverConfig, normalizePool({
      primary: 's3',
      providers: { s3: { enabled: false, config: {} } },
    }));

    expect(normalizePool(runtimeConfig.get(STORAGE_POOL_KEY)).providers.s3.enabled).toBe(true);
  });
});

describe('ArvanCloud object storage', () => {
  it('is a supported vendor', () => {
    expect(SUPPORTED_STORAGE_PROVIDERS).toContain('arvan_storage');
  });

  it('derives the regional endpoint and signs with the same region id', () => {
    const config = storageConfigFromRecord('arvan_storage', {
      region: 'ir-tbz-sh1', bucket: 'files', access_key_id: 'ak', secret_access_key: 'sk',
    });
    expect(config.endpoint).toBe('https://s3.ir-tbz-sh1.arvanstorage.ir');
    expect(config.s3Region).toBe('ir-tbz-sh1');
  });

  it('honors an explicit endpoint for a datacenter this build does not list', () => {
    expect(storageConfigFromRecord('arvan_storage', {
      region: 'ir-thr-at1', endpoint: 'https://s3.ir-thr-xx9.arvanstorage.ir',
    }).endpoint).toBe('https://s3.ir-thr-xx9.arvanstorage.ir');
  });

  it('falls back to the default region when none was picked', () => {
    expect(storageConfigFromRecord('arvan_storage', {}).endpoint)
      .toBe('https://s3.ir-thr-at1.arvanstorage.ir');
  });
});

describe('syncStorageReplica — guards', () => {
  beforeEach(() => {
    runtimeConfig.set(STORAGE_POOL_KEY, {
      primary: 'local',
      providers: {
        local: { enabled: true, config: { local_path: '/tmp/unused' } },
        s3: { enabled: true, config: { bucket: 'copy' } },
      },
    });
  });

  it('refuses to sync the primary onto itself', async () => {
    const result = await syncStorageReplica(serverConfig, { target: 'local' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/itself/i);
  });

  it('refuses a vendor that is not in the pool', async () => {
    const result = await syncStorageReplica(serverConfig, { target: 'wasabi' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not configured/i);
  });

  it('rejects a traversal prefix instead of listing outside the root', async () => {
    expect((await syncStorageReplica(serverConfig, { target: 's3', prefix: '../etc' })).ok).toBe(false);
  });

  it('fails cleanly when no primary is configured', async () => {
    runtimeConfig.clear();
    const result = await syncStorageReplica(serverConfig, { target: 's3' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/primary/i);
  });
});

// ── Stubbed S3-compatible endpoint ───────────────────────────────
//
// Bucket-addressed so several vendors can be simulated at once, with a
// REAL continuation token so a provider page can hold more keys than one
// sync batch copies. Nothing here leaves the machine.

interface S3Stub {
  buckets: Map<string, Map<string, string>>;
  /** Keys per ListObjectsV2 response. */
  pageSize: number;
  /** Every PUT, in order — proves no object is copied twice. */
  puts: string[];
}

function installS3Stub(stub: S3Stub): () => void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const [, bucket, ...rest] = url.pathname.split('/');
    const objects = stub.buckets.get(bucket) ?? new Map<string, string>();
    stub.buckets.set(bucket, objects);

    if (method === 'GET' && url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const all = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const after = url.searchParams.get('continuation-token');
      const start = after ? all.indexOf(after) + 1 : 0;
      const page = all.slice(start, start + stub.pageSize);
      const last = page[page.length - 1];
      const truncated = start + page.length < all.length;
      return new Response(
        `<?xml version="1.0"?><ListBucketResult>${
          page.map((k) => `<Contents><Key>${k}</Key></Contents>`).join('')
        }<IsTruncated>${truncated}</IsTruncated>${
          truncated ? `<NextContinuationToken>${last}</NextContinuationToken>` : ''
        }</ListBucketResult>`,
        { status: 200 },
      );
    }

    const key = rest.join('/');
    if (method === 'PUT') {
      const body = init?.body;
      const text = body instanceof ArrayBuffer
        ? Buffer.from(body).toString('utf8')
        : ArrayBuffer.isView(body as ArrayBufferView)
          ? Buffer.from((body as ArrayBufferView).buffer as ArrayBuffer).toString('utf8')
          : String(body ?? '');
      objects.set(key, text);
      stub.puts.push(`${bucket}/${key}`);
      return new Response('', { status: 200 });
    }
    if (method === 'DELETE') {
      objects.delete(key);
      return new Response('', { status: 204 });
    }
    if (method === 'GET') {
      const body = objects.get(key);
      return body === undefined
        ? new Response('missing', { status: 404 })
        : new Response(body, { status: 200 });
    }
    return new Response('', { status: 200 });
  }) as typeof globalThis.fetch;
  return () => { globalThis.fetch = realFetch; };
}

describe('syncStorageReplica — walking a provider that paginates', () => {
  const WS = '33333333-3333-3333-3333-333333333333';
  const OBJECT_COUNT = 23;
  const BATCH = 5;
  let stub: S3Stub;
  let restoreFetch: () => void;
  let targetDir: string;

  beforeEach(() => {
    // Primary pages 10 keys at a time; a sync batch copies 5. The two sizes
    // deliberately do not divide each other.
    stub = { buckets: new Map(), pageSize: 10, puts: [] };
    const source = new Map<string, string>();
    for (let i = 0; i < OBJECT_COUNT; i++) {
      source.set(`workspace/${WS}/f${String(i).padStart(3, '0')}.txt`, `body-${i}`);
    }
    stub.buckets.set('source', source);
    restoreFetch = installS3Stub(stub);

    targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-target-'));
    runtimeConfig.set(STORAGE_POOL_KEY, {
      primary: 's3',
      providers: {
        s3: { enabled: true, config: { bucket: 'source', region: 'us-east-1', access_key_id: 'ak', secret_access_key: 'sk' } },
        local: { enabled: true, config: { local_path: targetDir, public_url: 'http://localhost:9999/files' } },
      },
    });
  });

  afterEach(() => {
    restoreFetch();
    fs.rmSync(targetDir, { recursive: true, force: true });
  });

  it('returns a continuation after the first batch, then never repeats it', async () => {
    const first = await syncStorageReplica(serverConfig, { target: 'local', limit: BATCH, restart: true });
    expect(first.ok).toBe(true);
    expect(first.report?.batch.copied).toBe(BATCH);
    expect(first.report?.done).toBe(false);
    expect(first.report?.nextCursor).toBeTruthy();

    const copiedAfterFirst = fs.readdirSync(path.join(targetDir, 'workspace', WS)).sort();

    const second = await syncStorageReplica(serverConfig, { target: 'local', limit: BATCH });
    expect(second.report?.batch.copied).toBe(BATCH);
    // Nothing from batch one was copied again…
    expect(second.report?.batch.skipped).toBe(0);
    // …and the target grew by exactly one batch.
    const copiedAfterSecond = fs.readdirSync(path.join(targetDir, 'workspace', WS)).sort();
    expect(copiedAfterSecond.length).toBe(copiedAfterFirst.length + BATCH);
    expect(copiedAfterSecond.slice(0, BATCH)).toEqual(copiedAfterFirst);
    expect(second.report?.total.copied).toBe(BATCH * 2);
  });

  it('eventually copies every object, and only reports done when it truly is', async () => {
    let result = await syncStorageReplica(serverConfig, { target: 'local', limit: BATCH, restart: true });
    let rounds = 1;
    while (result.report && !result.report.done) {
      expect(result.report.nextCursor).toBeTruthy();
      result = await syncStorageReplica(serverConfig, { target: 'local', limit: BATCH });
      rounds++;
      expect(rounds).toBeLessThan(20); // guards against a cursor that never advances
    }

    expect(result.report?.nextCursor).toBeNull();
    expect(result.report?.total.copied).toBe(OBJECT_COUNT);
    expect(result.report?.total.failed).toBe(0);

    const copied = fs.readdirSync(path.join(targetDir, 'workspace', WS));
    expect(copied.length).toBe(OBJECT_COUNT);
  });

  it('never reports done while keys of the current provider page are unprocessed', async () => {
    // One batch smaller than the provider page — the page is partly consumed,
    // so the cursor must address a position INSIDE it, not the next page.
    const first = await syncStorageReplica(serverConfig, { target: 'local', limit: 3, restart: true });
    expect(first.report?.done).toBe(false);
    const second = await syncStorageReplica(serverConfig, { target: 'local', limit: 3 });
    expect(second.report?.batch.skipped).toBe(0);
    expect(second.report?.total.copied).toBe(6);
  });

  it('marks the vendor synchronized only after a whole-namespace walk with no failures', async () => {
    let result = await syncStorageReplica(serverConfig, { target: 'local', limit: BATCH, restart: true });
    while (result.report && !result.report.done) {
      expect(result.report.markedSynchronized).toBe(false);
      result = await syncStorageReplica(serverConfig, { target: 'local', limit: BATCH });
    }

    expect(result.report?.markedSynchronized).toBe(true);
    expect(isReplicaSynchronized(await readStoragePool(serverConfig), 'local')).toBe(true);
  });

  it('a prefix-scoped walk completes without granting promotion readiness', async () => {
    let result = await syncStorageReplica(serverConfig, {
      target: 'local', prefix: `workspace/${WS}/f00`, limit: BATCH, restart: true,
    });
    while (result.report && !result.report.done) {
      result = await syncStorageReplica(serverConfig, { target: 'local', limit: BATCH });
    }

    expect(result.report?.done).toBe(true);
    expect(result.report?.markedSynchronized).toBe(false);
    expect(isReplicaSynchronized(await readStoragePool(serverConfig), 'local')).toBe(false);
  });
});

describe('syncStorageReplica — walking a provider with no continuation token', () => {
  const WS = '44444444-4444-4444-4444-444444444444';
  const OBJECT_COUNT = 7;
  let stub: S3Stub;
  let restoreFetch: () => void;
  let primaryDir: string;

  beforeEach(() => {
    // local returns its ENTIRE recursive listing in one page, nextCursor
    // null — the offset in the cursor is the only thing that can carry the
    // walk forward.
    primaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-primary-'));
    for (let i = 0; i < OBJECT_COUNT; i++) {
      const full = path.join(primaryDir, `workspace/${WS}/f${i}.txt`);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, `body-${i}`);
    }
    stub = { buckets: new Map([['mirror', new Map<string, string>()]]), pageSize: 1000, puts: [] };
    restoreFetch = installS3Stub(stub);

    runtimeConfig.set(STORAGE_POOL_KEY, {
      primary: 'local',
      providers: {
        local: { enabled: true, config: { local_path: primaryDir, public_url: 'http://localhost:9999/files' } },
        s3: { enabled: true, config: { bucket: 'mirror', region: 'us-east-1', access_key_id: 'ak', secret_access_key: 'sk' } },
      },
    });
  });

  afterEach(() => {
    restoreFetch();
    fs.rmSync(primaryDir, { recursive: true, force: true });
  });

  it('walks the whole listing in batches without repeating or skipping an object', async () => {
    let result = await syncStorageReplica(serverConfig, { target: 's3', limit: 2, restart: true });
    let rounds = 1;
    while (result.report && !result.report.done) {
      expect(result.report.nextCursor).toBeTruthy();
      result = await syncStorageReplica(serverConfig, { target: 's3', limit: 2 });
      rounds++;
      expect(rounds).toBeLessThan(15);
    }

    expect(result.report?.nextCursor).toBeNull();
    expect(result.report?.total.copied).toBe(OBJECT_COUNT);
    // Exactly one PUT per object: no batch redid another batch's work.
    expect(stub.puts.length).toBe(OBJECT_COUNT);
    expect(new Set(stub.puts).size).toBe(OBJECT_COUNT);
    expect(stub.buckets.get('mirror')!.size).toBe(OBJECT_COUNT);
  });

  it('is idempotent — re-running a finished walk copies nothing again', async () => {
    let result = await syncStorageReplica(serverConfig, { target: 's3', limit: 3, restart: true });
    while (result.report && !result.report.done) {
      result = await syncStorageReplica(serverConfig, { target: 's3', limit: 3 });
    }
    const putsAfterFirstWalk = stub.puts.length;

    let again = await syncStorageReplica(serverConfig, { target: 's3', limit: 3, restart: true });
    while (again.report && !again.report.done) {
      again = await syncStorageReplica(serverConfig, { target: 's3', limit: 3 });
    }

    expect(again.report?.total.copied).toBe(0);
    expect(again.report?.total.skipped).toBe(OBJECT_COUNT);
    expect(stub.puts.length).toBe(putsAfterFirstWalk);
  });
});
