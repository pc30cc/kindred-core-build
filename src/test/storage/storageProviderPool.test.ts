/**
 * Storage provider pool — several vendors configured at once, one primary,
 * the enabled rest mirrored (server/services/storage/pool.ts).
 *
 * The invariants that matter operationally:
 *  - the pool never disagrees with `default_storage_provider`, which is what
 *    every existing resolver reads;
 *  - a platform that has only ever used the legacy single default still sees
 *    that vendor as its primary;
 *  - mirrors are exactly "enabled and not primary";
 *  - ArvanCloud resolves to its regional S3 endpoint and signs with the same
 *    region id;
 *  - a back-fill copies what a mirror is missing and skips what it already has.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

type Row = { key: string; value: unknown };

const runtimeConfig = new Map<string, unknown>();

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      if (table !== 'app_runtime_config') throw new Error(`unexpected table ${table}`);
      let wantedKey: string | null = null;
      const builder = {
        select: () => builder,
        eq: (_col: string, value: string) => { wantedKey = value; return builder; },
        maybeSingle: async () => ({
          data: wantedKey && runtimeConfig.has(wantedKey)
            ? ({ key: wantedKey, value: runtimeConfig.get(wantedKey) } as Row)
            : null,
          error: null,
        }),
        upsert: async (row: Row) => { runtimeConfig.set(row.key, row.value); return { error: null }; },
      };
      return builder;
    },
  }),
}));

const {
  normalizePool, replicaEntries, readStoragePool, writeStoragePool,
  STORAGE_POOL_KEY, STORAGE_DEFAULT_KEY,
} = await import('../../../server/services/storage/pool.js');
const { storageConfigFromRecord, syncStorageReplica, SUPPORTED_STORAGE_PROVIDERS } =
  await import('../../../server/services/storage/index.js');

const serverConfig = {} as Parameters<typeof readStoragePool>[0];

beforeEach(() => {
  runtimeConfig.clear();
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

  it('is empty when only the primary is configured', () => {
    const pool = normalizePool({ primary: 's3', providers: { s3: { enabled: true, config: {} } } });
    expect(replicaEntries(pool)).toEqual([]);
  });
});

describe('readStoragePool', () => {
  it('projects the legacy single default into a one-entry pool', async () => {
    runtimeConfig.set(STORAGE_DEFAULT_KEY, { provider_name: 'bunny_storage', config: { storage_zone: 'z' } });

    const pool = await readStoragePool(serverConfig);

    expect(pool.primary).toBe('bunny_storage');
    expect(pool.providers.bunny_storage.enabled).toBe(true);
    expect(pool.providers.bunny_storage.config).toEqual({ storage_zone: 'z' });
  });

  it('follows the legacy pointer when it disagrees with a stale stored primary', async () => {
    runtimeConfig.set(STORAGE_POOL_KEY, {
      primary: 'minio',
      providers: { minio: { enabled: true, config: {} }, s3: { enabled: true, config: {} } },
    });
    runtimeConfig.set(STORAGE_DEFAULT_KEY, { provider_name: 's3', config: {} });

    // The running app resolves through the legacy pointer, so the screen must
    // report that vendor as primary rather than the stored one.
    expect((await readStoragePool(serverConfig)).primary).toBe('s3');
  });
});

describe('writeStoragePool', () => {
  it('keeps default_storage_provider pointing at the primary', async () => {
    await writeStoragePool(serverConfig, normalizePool({
      primary: 'arvan_storage',
      providers: {
        arvan_storage: { enabled: true, config: { bucket: 'main', region: 'ir-thr-at1' } },
        s3: { enabled: true, config: { bucket: 'copy' } },
      },
    }));

    expect(runtimeConfig.get(STORAGE_DEFAULT_KEY)).toEqual({
      provider_name: 'arvan_storage',
      config: { bucket: 'main', region: 'ir-thr-at1' },
    });
  });

  it('never stores a disabled primary — that would write to a switched-off vendor', async () => {
    await writeStoragePool(serverConfig, normalizePool({
      primary: 's3',
      providers: { s3: { enabled: false, config: {} } },
    }));

    const stored = normalizePool(runtimeConfig.get(STORAGE_POOL_KEY));
    expect(stored.providers.s3.enabled).toBe(true);
  });
});

describe('ArvanCloud object storage', () => {
  it('is a supported vendor', () => {
    expect(SUPPORTED_STORAGE_PROVIDERS).toContain('arvan_storage');
  });

  it('derives the regional endpoint and signs with the same region id', () => {
    const config = storageConfigFromRecord('arvan_storage', {
      region: 'ir-tbz-sh1',
      bucket: 'files',
      access_key_id: 'ak',
      secret_access_key: 'sk',
    });

    expect(config.endpoint).toBe('https://s3.ir-tbz-sh1.arvanstorage.ir');
    expect(config.s3Region).toBe('ir-tbz-sh1');
    expect(config.bucket).toBe('files');
  });

  it('honors an explicit endpoint for a datacenter this build does not list', () => {
    const config = storageConfigFromRecord('arvan_storage', {
      region: 'ir-thr-at1',
      endpoint: 'https://s3.ir-thr-xx9.arvanstorage.ir',
    });

    expect(config.endpoint).toBe('https://s3.ir-thr-xx9.arvanstorage.ir');
  });

  it('falls back to the default region when none was picked', () => {
    expect(storageConfigFromRecord('arvan_storage', {}).endpoint)
      .toBe('https://s3.ir-thr-at1.arvanstorage.ir');
  });
});

describe('syncStorageReplica', () => {
  beforeEach(() => {
    runtimeConfig.set(STORAGE_POOL_KEY, {
      primary: 'local',
      providers: {
        local: { enabled: true, config: { local_path: '/tmp/does-not-matter' } },
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

  it('fails cleanly when no primary is configured', async () => {
    runtimeConfig.clear();
    const result = await syncStorageReplica(serverConfig, { target: 's3' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/primary/i);
  });
});

/**
 * The copy loop, end to end: a real local primary against a stubbed
 * S3-compatible replica. `fetch` is intercepted so the test never leaves the
 * machine — an object store that answers over the network is exactly what a
 * unit test must not talk to.
 */
describe('syncStorageReplica — copying', () => {
  const WS = '22222222-2222-2222-2222-222222222222';
  let primaryDir: string;
  let replicaObjects: Map<string, string>;
  let realFetch: typeof globalThis.fetch;

  function listXml(keys: string[]): string {
    return `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>${
      keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join('')
    }<IsTruncated>false</IsTruncated></ListBucketResult>`;
  }

  beforeEach(() => {
    primaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-pool-primary-'));
    replicaObjects = new Map();
    runtimeConfig.set(STORAGE_POOL_KEY, {
      primary: 'local',
      providers: {
        local: { enabled: true, config: { local_path: primaryDir } },
        s3: { enabled: true, config: { bucket: 'copy', region: 'us-east-1', access_key_id: 'ak', secret_access_key: 'sk' } },
      },
    });

    realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.searchParams.get('list-type') === '2') {
        const prefix = url.searchParams.get('prefix') ?? '';
        const keys = [...replicaObjects.keys()].filter((k) => k.startsWith(prefix));
        return new Response(listXml(keys), { status: 200 });
      }
      const key = url.pathname.replace('/copy/', '');
      if (method === 'PUT') {
        // The S3 driver signs raw bytes and sends them as an ArrayBuffer.
        const body = init?.body;
        const text = body instanceof ArrayBuffer
          ? Buffer.from(body).toString('utf8')
          : ArrayBuffer.isView(body as ArrayBufferView)
            ? Buffer.from((body as ArrayBufferView).buffer as ArrayBuffer).toString('utf8')
            : String(body ?? '');
        replicaObjects.set(key, text);
        return new Response('', { status: 200 });
      }
      if (method === 'GET') {
        const body = replicaObjects.get(key);
        return body === undefined
          ? new Response('missing', { status: 404 })
          : new Response(body, { status: 200 });
      }
      return new Response('', { status: 200 });
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    fs.rmSync(primaryDir, { recursive: true, force: true });
  });

  function writePrimary(key: string, body: string) {
    const full = path.join(primaryDir, key);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }

  it('copies what the replica is missing and skips what it already has', async () => {
    writePrimary(`workspace/${WS}/a.txt`, 'one');
    writePrimary(`workspace/${WS}/b.txt`, 'two');
    replicaObjects.set(`workspace/${WS}/b.txt`, 'two');

    const result = await syncStorageReplica(serverConfig, { target: 's3', prefix: `workspace/${WS}` });

    expect(result.ok).toBe(true);
    expect(result.report?.scanned).toBe(2);
    expect(result.report?.copied).toBe(1);
    expect(result.report?.skipped).toBe(1);
    expect(result.report?.failed).toBe(0);
    expect(replicaObjects.get(`workspace/${WS}/a.txt`)).toBe('one');
  });

  it('is idempotent — a second run copies nothing', async () => {
    writePrimary(`workspace/${WS}/a.txt`, 'one');

    await syncStorageReplica(serverConfig, { target: 's3', prefix: `workspace/${WS}` });
    const second = await syncStorageReplica(serverConfig, { target: 's3', prefix: `workspace/${WS}` });

    expect(second.report?.copied).toBe(0);
    expect(second.report?.skipped).toBe(1);
  });

  it('reports a cursor when the primary holds more than one batch', async () => {
    for (let i = 0; i < 3; i++) writePrimary(`workspace/${WS}/f${i}.txt`, String(i));

    const result = await syncStorageReplica(serverConfig, { target: 's3', prefix: `workspace/${WS}`, limit: 2 });

    expect(result.report?.scanned).toBe(2);
    expect(result.report?.copied).toBe(2);
    expect(result.report?.nextCursor).not.toBeUndefined();
  });

  it('rejects a traversal prefix instead of listing outside the bucket root', async () => {
    const result = await syncStorageReplica(serverConfig, { target: 's3', prefix: '../etc' });
    expect(result.ok).toBe(false);
  });
});
