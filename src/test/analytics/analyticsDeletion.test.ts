/**
 * Workspace deletion must erase a workspace's ANALYTICS objects, from the
 * analytics primary AND from every vendor that could still hold a copy —
 * including ones no longer named as replicas.
 *
 * These suites exercise the real scope resolver and the real cleanup walker
 * against real object stores (a temp directory and a stubbed S3), so what
 * is proven is that the objects are gone, not that a function was called.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  resetFakeAnalyticsPool, seedGeneralPool, seedAnalyticsPool,
} from './fakeAnalyticsPool';

vi.mock('../../../server/supabase.js', async () => {
  const { makeFakeSupabaseClient } = await import('./fakeAnalyticsPool');
  const client = makeFakeSupabaseClient();
  return { getServiceClient: () => client };
});
vi.mock('../../../server/services/observability/metrics.js', () => ({
  emitMetric: () => undefined,
  emitLog: () => undefined,
}));

const { analyticsStorageScopes, analyticsWorkspacePrefixes, analyticsScopeName } =
  await import('../../../server/services/analytics/deletionScopes.js');
const { runScopeCleanupTick } = await import('../../../server/services/storage/scopeCleanupEngine.js');
const { uploadWithConfig, storageConfigFromRecord, listWithConfig } =
  await import('../../../server/services/storage/index.js');
const { readAnalyticsPool } = await import('../../../server/services/analytics/pool.js');

const serverConfig = {} as never;
const WS_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const WS_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const BUCKET_OF: Record<string, string> = {
  cloudflare_r2: 'r2-analytics',
  minio: 'minio-analytics',
  arvan_storage: 'arvan-general',
};

let primaryDir: string;
let buckets: Map<string, Map<string, Buffer>>;
let restoreFetch: () => void;

function installS3Stub(): () => void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const segments = url.pathname.split('/').filter(Boolean);
    const bucket = segments[0] ?? '';
    // A real S3 server decodes the percent-encoded path before it addresses an
    // object, so the stub must too — keys are signed and sent encoded.
    const key = segments.slice(1).map(decodeURIComponent).join('/');
    if (!buckets.has(bucket)) buckets.set(bucket, new Map());
    const store = buckets.get(bucket)!;

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
      const body = init?.body as ArrayBuffer | ArrayBufferView | string | undefined;
      const bytes = ArrayBuffer.isView(body)
        ? Buffer.from(body.buffer, body.byteOffset, body.byteLength)
        : body instanceof ArrayBuffer ? Buffer.from(body) : Buffer.from(String(body ?? ''));
      store.set(key, Buffer.from(bytes));
      return new Response('', { status: 200 });
    }
    if (method === 'DELETE') { store.delete(key); return new Response(null, { status: 204 }); }
    if (method === 'GET') {
      const value = store.get(key);
      return value === undefined ? new Response('', { status: 404 }) : new Response(value, { status: 200 });
    }
    return new Response('', { status: 200 });
  }) as typeof globalThis.fetch;
  return () => { globalThis.fetch = realFetch; };
}

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

function configFor(name: string) {
  const configs: Record<string, Record<string, unknown>> = {
    local: { local_path: primaryDir, public_url: 'http://localhost:9999/files' },
    cloudflare_r2: { bucket: BUCKET_OF.cloudflare_r2, account_id: 'acc', access_key_id: 'ak', secret_access_key: 'sk' },
    minio: { bucket: BUCKET_OF.minio, endpoint: 'http://objects.local:9000', access_key: 'ak', secret_key: 'sk' },
    arvan_storage: { bucket: BUCKET_OF.arvan_storage, region: 'ir-thr-at1', access_key_id: 'ak', secret_access_key: 'sk' },
    bunny_storage: { username: 'zone', password: 'pw', hostname: 'storage.bunnycdn.com', cdn_url: 'https://g.b-cdn.net' },
    gcs: { bucket: 'gcs-bucket', access_key_id: 'ak', secret_access_key: 'sk' },
  };
  return configs[name];
}

/** Put an analytics object for a workspace on one vendor, under one prefix. */
async function seedObject(vendor: string, workspaceId: string, prefix = 'analytics/web/', name = 'part-a.parquet') {
  const key = `${prefix}workspace=${workspaceId}/year=2026/month=09/day=10/${name}`;
  const result = await uploadWithConfig(storageConfigFromRecord(vendor, configFor(vendor)!), {
    fileKey: key, data: Buffer.from(`${vendor}:${workspaceId}`), contentType: 'application/vnd.apache.parquet',
  });
  expect(result.success).toBe(true);
  return key;
}

/** Drive the walker to completion over one namespace, as the deletion worker does. */
async function purge(workspaceId: string) {
  const state: Record<string, unknown> = {};
  const namespaces = await analyticsWorkspacePrefixes(serverConfig, workspaceId);
  for (const ns of namespaces) {
    const scopes = await analyticsStorageScopes(serverConfig, ns.poolPrefix);
    for (let guard = 0; guard < 200; guard++) {
      const outcome = await runScopeCleanupTick({
        scopes,
        prefix: ns.workspacePrefix,
        state: state as never,
        maxDeleteAttemptsPerKey: 2,
        heartbeat: async () => true,
        persist: async () => undefined,
      });
      if (outcome.kind === 'error') throw new Error(outcome.message);
      if (outcome.kind === 'advance') break;
    }
  }
  return state;
}

beforeEach(() => {
  resetFakeAnalyticsPool();
  primaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-deletion-'));
  buckets = new Map();
  restoreFetch = installS3Stub();
  seedGeneralPool({
    primary: 'bunny_storage',
    providers: {
      bunny_storage: { config: configFor('bunny_storage')! },
      arvan_storage: { config: configFor('arvan_storage')! },
      local: { config: configFor('local')! },
      cloudflare_r2: { config: configFor('cloudflare_r2')! },
      minio: { config: configFor('minio')! },
    },
  });
  seedAnalyticsPool({
    enabled: true, primary: 'local', replicas: ['cloudflare_r2'], replicationEnabled: true,
    prefix: 'analytics/web/', knownPrefixes: ['analytics/web/'],
    batchRows: 10_000, batchBytes: 33_554_432, flushIntervalMs: 15_000,
    format: 'parquet', compression: 'zstd', writeMode: 'dual_write', readMode: 'postgres',
    // minio was REMOVED from the replica list but still has state — and,
    // critically, may still hold objects.
    replicaState: { cloudflare_r2: {}, minio: { syncedAt: '2026-09-01T00:00:00.000Z' } },
  });
});

afterEach(() => {
  restoreFetch();
  fs.rmSync(primaryDir, { recursive: true, force: true });
});

describe('scope resolution', () => {
  it('covers the primary, the current replicas AND retired ones that may still hold data', async () => {
    const scopes = await analyticsStorageScopes(serverConfig, 'analytics/web/');
    const names = scopes.map((s) => s.name);
    expect(names).toContain(analyticsScopeName('analytics/web/', 'local'));
    expect(names).toContain(analyticsScopeName('analytics/web/', 'cloudflare_r2'));
    // Removed from `replicas`, still walked.
    expect(names).toContain(analyticsScopeName('analytics/web/', 'minio'));
  });

  it('excludes vendors that cannot be listed, so deletion can never wedge on them', async () => {
    seedGeneralPool({
      primary: 'bunny_storage',
      providers: {
        bunny_storage: { config: configFor('bunny_storage')! },
        local: { config: configFor('local')! },
        gcs: { config: configFor('gcs')! },
      },
    });
    const names = (await analyticsStorageScopes(serverConfig, 'analytics/web/')).map((s) => s.name);
    // gcs holds credentials but has no listing driver: a scope for it would
    // fail every tick and make the workspace permanently undeletable.
    expect(names.some((n) => n.includes('gcs'))).toBe(false);
    expect(names.some((n) => n.includes('local'))).toBe(true);
  });

  it('namespaces scope names by prefix so two prefixes are never confused for one', async () => {
    const a = (await analyticsStorageScopes(serverConfig, 'analytics/web/')).map((s) => s.name);
    const b = (await analyticsStorageScopes(serverConfig, 'analytics/old/')).map((s) => s.name);
    expect(a.some((name) => b.includes(name))).toBe(false);
  });

  it('keeps analytics scope names disjoint from the general pool’s', async () => {
    const names = (await analyticsStorageScopes(serverConfig, 'analytics/web/')).map((s) => s.name);
    for (const name of names) {
      expect(name.startsWith('analytics[')).toBe(true);
      expect(name.startsWith('replica:')).toBe(false);
    }
  });
});

describe('workspace prefixes', () => {
  it('always scopes to the workspace, never the whole namespace', async () => {
    const namespaces = await analyticsWorkspacePrefixes(serverConfig, WS_A);
    expect(namespaces).toHaveLength(1);
    expect(namespaces[0].workspacePrefix).toBe(`analytics/web/workspace=${WS_A}/`);
  });

  it('walks EVERY prefix the pool has ever used', async () => {
    const pool = await readAnalyticsPool(serverConfig);
    seedAnalyticsPool({ ...pool, knownPrefixes: ['analytics/old/', 'analytics/web/'] } as never);
    const namespaces = await analyticsWorkspacePrefixes(serverConfig, WS_A);
    expect(namespaces.map((n) => n.workspacePrefix)).toEqual([
      `analytics/old/workspace=${WS_A}/`,
      `analytics/web/workspace=${WS_A}/`,
    ]);
  });

  it('refuses a malformed workspace id instead of producing a broader prefix', async () => {
    await expect(analyticsWorkspacePrefixes(serverConfig, '../../')).rejects.toThrow(/invalid_workspace_id/);
    await expect(analyticsWorkspacePrefixes(serverConfig, '')).rejects.toThrow(/invalid_workspace_id/);
  });
});

describe('purge', () => {
  it('removes the workspace’s analytics objects from the primary and EVERY replica', async () => {
    const primaryKey = await seedObject('local', WS_A);
    const r2Key = await seedObject('cloudflare_r2', WS_A);
    const minioKey = await seedObject('minio', WS_A); // retired replica

    await purge(WS_A);

    expect(fs.existsSync(path.join(primaryDir, primaryKey))).toBe(false);
    expect(buckets.get(BUCKET_OF.cloudflare_r2)?.get(r2Key)).toBeUndefined();
    expect(buckets.get(BUCKET_OF.minio)?.get(minioKey)).toBeUndefined();
  });

  it('leaves OTHER workspaces completely untouched', async () => {
    await seedObject('local', WS_A);
    await seedObject('cloudflare_r2', WS_A);
    const keptLocal = await seedObject('local', WS_B);
    const keptR2 = await seedObject('cloudflare_r2', WS_B);

    await purge(WS_A);

    expect(fs.existsSync(path.join(primaryDir, keptLocal))).toBe(true);
    expect(buckets.get(BUCKET_OF.cloudflare_r2)?.get(keptR2)).toBeDefined();
    expect(localKeys().every((key) => key.includes(`workspace=${WS_B}`))).toBe(true);
  });

  it('purges every prefix the pool has used, not just the current one', async () => {
    const pool = await readAnalyticsPool(serverConfig);
    seedAnalyticsPool({ ...pool, knownPrefixes: ['analytics/old/', 'analytics/web/'] } as never);
    const oldKey = await seedObject('local', WS_A, 'analytics/old/');
    const newKey = await seedObject('local', WS_A, 'analytics/web/');

    await purge(WS_A);

    expect(fs.existsSync(path.join(primaryDir, oldKey))).toBe(false);
    expect(fs.existsSync(path.join(primaryDir, newKey))).toBe(false);
  });

  it('never touches the GENERAL storage namespace', async () => {
    const generalKey = `workspace/${WS_A}/attachments/keep.bin`;
    await uploadWithConfig(storageConfigFromRecord('local', configFor('local')!), {
      fileKey: generalKey, data: Buffer.from('general'), contentType: 'application/octet-stream',
    });
    await seedObject('local', WS_A);

    await purge(WS_A);

    // The analytics purge walks `analytics/...` only — the general objects
    // are the general walker's business and must survive this pass.
    expect(fs.existsSync(path.join(primaryDir, generalKey))).toBe(true);
  });

  it('is idempotent — a second purge over an already-empty namespace is a no-op', async () => {
    await seedObject('local', WS_A);
    await purge(WS_A);
    await expect(purge(WS_A)).resolves.toBeTruthy();
    expect(localKeys()).toHaveLength(0);
  });

  it('marks every scope verified, which is what lets the DB purge proceed', async () => {
    await seedObject('local', WS_A);
    await seedObject('cloudflare_r2', WS_A);
    const state = await purge(WS_A) as Record<string, { status: string; verified: boolean }>;
    const walked = Object.values(state).filter((s) => s.status === 'done');
    expect(walked.length).toBeGreaterThan(0);
    expect(walked.every((s) => s.verified)).toBe(true);
  });

  it('deletes a late write found during the final verification pass', async () => {
    await seedObject('local', WS_A);
    const scopes = await analyticsStorageScopes(serverConfig, 'analytics/web/');
    const prefix = `analytics/web/workspace=${WS_A}/`;
    const state: Record<string, unknown> = {};

    const tick = () => runScopeCleanupTick({
      scopes, prefix, state: state as never, maxDeleteAttemptsPerKey: 2,
      heartbeat: async () => true, persist: async () => undefined,
    });

    // Walk until the first listing pass is exhausted…
    for (let i = 0; i < 50; i++) {
      const outcome = await tick();
      if (outcome.kind === 'advance') break;
      if (outcome.kind === 'error') throw new Error(outcome.message);
      // …then slip an object in behind it, as an in-flight flush would.
      if (i === 0) await seedObject('local', WS_A, 'analytics/web/', 'part-late.parquet');
    }

    const listed = await listWithConfig(storageConfigFromRecord('local', configFor('local')!), prefix);
    expect(listed.keys ?? []).toEqual([]);
  });

  it('reports a vendor it cannot list as an error rather than as empty', async () => {
    await seedObject('cloudflare_r2', WS_A);
    const scopes = await analyticsStorageScopes(serverConfig, 'analytics/web/');
    restoreFetch();
    // Every S3 call now fails: the walker must NOT conclude "nothing there".
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('down', { status: 503 })) as typeof globalThis.fetch;

    const outcome = await runScopeCleanupTick({
      scopes: scopes.filter((s) => s.name.includes('cloudflare_r2')),
      prefix: `analytics/web/workspace=${WS_A}/`,
      state: {} as never,
      maxDeleteAttemptsPerKey: 1,
      heartbeat: async () => true,
      persist: async () => undefined,
    });

    globalThis.fetch = realFetch;
    expect(outcome.kind).toBe('error');
  });
});
