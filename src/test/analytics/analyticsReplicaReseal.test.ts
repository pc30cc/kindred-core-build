/**
 * REPLICA CONSISTENCY AFTER RE-SEAL.
 *
 * Sealed objects have deterministic keys, so a re-seal changes the BYTES at
 * a key a replica already holds. That is the dangerous shape: a replica that
 * merely "has the key" is not a replica that has the data, and promoting it
 * would resurrect whatever the re-seal erased.
 *
 * So three things have to hold, and each one is a test below:
 *   1. a re-seal pushes the new bytes to every replica, at the same key;
 *   2. a replica that could NOT be written goes dirty, and dirty blocks
 *      promotion;
 *   3. a manual sync REPLACES the stale copy rather than skipping a key it
 *      already has.
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  resetFakeAnalyticsPool, seedGeneralPool, seedAnalyticsPool, seedTable,
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

const { sealWorkspaceDay, unsealDays } = await import('../../../server/services/analytics/sealing.js');
const {
  readAnalyticsPool, isAnalyticsReplicaSynchronized, analyticsReplicaHealth,
} = await import('../../../server/services/analytics/pool.js');
const { syncAnalyticsReplica } = await import('../../../server/services/analytics/replication.js');
const { duckDbAvailability } = await import('../../../server/services/analytics/duckdb.js');
const { __clearAnalyticsObjectCache } = await import('../../../server/services/analytics/objectCache.js');

const serverConfig = {} as never;
const WS = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const DAY = '2026-08-10';

let primaryDir: string;
let cacheDir: string;
let engine = false;

/**
 * The replica is an S3-shaped vendor served by a stubbed fetch, one bucket
 * held in memory — the same pattern analyticsStorageIsolation.test.ts uses.
 * Two `local_path` providers are not an option: only the `local` vendor
 * reads that config key, and it is already the primary here.
 *
 * The bucket name is deliberately not a prefix of the endpoint host, or
 * s3BucketBase() would read the endpoint as virtual-host style and drop the
 * bucket segment.
 */
const REPLICA_BUCKET = 'r2-analytics';
let bucket: Map<string, Buffer>;
let replicaDown = false;
let restoreFetch: () => void;

function installS3Stub(): () => void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const segments = url.pathname.split('/').filter(Boolean);
    const key = segments.slice(1).join('/');

    if (replicaDown) return new Response('vendor down', { status: 503 });

    if (method === 'GET' && url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const keys = [...bucket.keys()].filter((k) => k.startsWith(prefix)).sort();
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
      bucket.set(key, Buffer.from(bytes));
      return new Response('', { status: 200 });
    }
    if (method === 'DELETE') { bucket.delete(key); return new Response(null, { status: 204 }); }
    if (method === 'GET') {
      const body = bucket.get(key);
      return body === undefined ? new Response('', { status: 404 }) : new Response(body, { status: 200 });
    }
    return new Response('', { status: 200 });
  }) as typeof globalThis.fetch;
  return () => { globalThis.fetch = realFetch; };
}

beforeAll(async () => { engine = (await duckDbAvailability()).available; });

const REAL_VISITOR = 'visitor-real-1234';
const ANON_VISITOR = 'anon_1f2e3d4c5b6a';

function seedSource(visitorId: string): void {
  seedTable('visitor_sessions', [{
    id: 's0', workspace_id: WS, visitor_id: visitorId,
    started_at: `${DAY}T10:00:00.000Z`, last_seen_at: `${DAY}T10:20:00.000Z`,
    current_page: 'https://shop.test/', referrer: null,
    browser: 'Chrome', device: 'Desktop', os: 'macOS', language: 'en-US',
    country: 'Iran', city: 'Tehran', geo_country_code: 'IR', geo_country_name: 'Iran', geo_city: 'Tehran',
    utm_source: null, utm_medium: null, utm_campaign: null, utm_term: null, utm_content: null,
  }]);
  seedTable('visitor_page_views', [
    { workspace_id: WS, visitor_session_id: 's0', url: 'https://shop.test/', title: 'Home', viewed_at: `${DAY}T10:00:00.000Z` },
  ]);
  seedTable('web_analytics_events', []);
  seedTable('analytics_day_seals', []);
  seedTable('workspace_deletion_jobs', []);
}

function replicaKeys(): string[] {
  return [...bucket.keys()].sort();
}

function replicaContains(needle: string): boolean {
  return [...bucket.values()].some((b) => b.includes(Buffer.from(needle, 'utf8')));
}

function filesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string, prefix: string) => {
    if (!fs.existsSync(d)) return;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const next = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(d, entry.name), next);
      else if (entry.name.endsWith('.parquet')) out.push(next);
    }
  };
  walk(root, '');
  return out.sort();
}

function containsIn(root: string, needle: string): boolean {
  const walk = (d: string): boolean => {
    if (!fs.existsSync(d)) return false;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) { if (walk(full)) return true; }
      else if (entry.name.endsWith('.parquet') && fs.readFileSync(full).includes(Buffer.from(needle, 'utf8'))) return true;
    }
    return false;
  };
  return walk(root);
}

/** @param withReplicaCredentials false models a replica whose credentials are gone. */
function configure(withReplicaCredentials: boolean): void {
  seedGeneralPool({
    primary: 'bunny_storage',
    providers: {
      bunny_storage: { config: { username: 'z', password: 'p', hostname: 'storage.bunnycdn.com', cdn_url: 'https://g.b-cdn.net' } },
      local: { config: { local_path: primaryDir, public_url: 'http://localhost:9999/files' } },
      cloudflare_r2: {
        config: withReplicaCredentials
          ? { bucket: REPLICA_BUCKET, account_id: 'acc', access_key_id: 'ak', secret_access_key: 'sk' }
          : {},
      },
    },
  });
  seedAnalyticsPool({
    enabled: true, primary: 'local', replicas: ['cloudflare_r2'], replicationEnabled: true,
    prefix: 'analytics/web/', knownPrefixes: ['analytics/web/'],
    batchRows: 10_000, batchBytes: 33_554_432, flushIntervalMs: 15_000,
    format: 'parquet', compression: 'zstd', writeMode: 'dual_write', readMode: 'postgres',
    replicaState: {
      // Starts fully synchronized against the current primary.
      cloudflare_r2: {
        syncedAt: '2026-08-09T00:00:00.000Z',
        syncedFrom: 'local',
        dirtyAt: null,
        lastError: null,
        sync: null,
      },
    },
  });
}

beforeEach(() => {
  resetFakeAnalyticsPool();
  primaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-reseal-primary-'));
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-reseal-cache-'));
  process.env.ANALYTICS_QUERY_CACHE_DIR = cacheDir;
  __clearAnalyticsObjectCache();
  bucket = new Map();
  replicaDown = false;
  restoreFetch = installS3Stub();
  configure(true);
  seedSource(REAL_VISITOR);
});

afterEach(() => {
  restoreFetch();
  __clearAnalyticsObjectCache();
  for (const d of [primaryDir, cacheDir]) fs.rmSync(d, { recursive: true, force: true });
  delete process.env.ANALYTICS_QUERY_CACHE_DIR;
});

describe('a re-seal reaches every replica', () => {
  it('mirrors the sealed objects to the replica at the same keys', async () => {
    await sealWorkspaceDay(serverConfig, WS, DAY);
    expect(filesUnder(primaryDir).length).toBeGreaterThan(0);
    expect(replicaKeys()).toEqual(filesUnder(primaryDir));
  });

  it('REPLACES the replica copy when the day is rebuilt, not just the primary', async () => {
    await sealWorkspaceDay(serverConfig, WS, DAY);
    expect(replicaContains(REAL_VISITOR)).toBe(true);

    seedSource(ANON_VISITOR);
    await unsealDays(serverConfig, WS, DAY, DAY);
    await sealWorkspaceDay(serverConfig, WS, DAY);

    // The erased value must be gone from BOTH sides. A replica still holding
    // it is one promotion away from undoing the erasure.
    expect(containsIn(primaryDir, REAL_VISITOR)).toBe(false);
    expect(replicaContains(REAL_VISITOR)).toBe(false);
    expect(replicaContains(ANON_VISITOR)).toBe(true);
  });

  it('leaves primary and replica byte-identical after a rebuild', async () => {
    await sealWorkspaceDay(serverConfig, WS, DAY);
    seedSource(ANON_VISITOR);
    await unsealDays(serverConfig, WS, DAY, DAY);
    await sealWorkspaceDay(serverConfig, WS, DAY);

    const keys = filesUnder(primaryDir);
    expect(replicaKeys()).toEqual(keys);
    for (const key of keys) {
      expect(bucket.get(key)).toEqual(fs.readFileSync(path.join(primaryDir, key)));
    }
  });
});

describe('a replica that could not be written', () => {
  it('goes DIRTY rather than being silently left behind', async () => {
    replicaDown = true;
    await sealWorkspaceDay(serverConfig, WS, DAY);

    const pool = await readAnalyticsPool(serverConfig);
    expect(analyticsReplicaHealth(pool, 'cloudflare_r2')).not.toBe('synchronized');
  });

  it('BLOCKS promotion once dirty', async () => {
    replicaDown = true;
    await sealWorkspaceDay(serverConfig, WS, DAY);

    const pool = await readAnalyticsPool(serverConfig);
    // This is the predicate the promotion route refuses on.
    expect(isAnalyticsReplicaSynchronized(pool, 'cloudflare_r2')).toBe(false);
  });

  it('goes dirty when the replica has no credentials at all', async () => {
    configure(false);
    await sealWorkspaceDay(serverConfig, WS, DAY);
    // Nothing reached it, so it must not still look promotable.
    expect(replicaKeys()).toEqual([]);
  });

  it('stays promotable while every write succeeds', async () => {
    await sealWorkspaceDay(serverConfig, WS, DAY);
    const pool = await readAnalyticsPool(serverConfig);
    expect(isAnalyticsReplicaSynchronized(pool, 'cloudflare_r2')).toBe(true);
  });
});

describe('manual sync', () => {
  it('overwrites a STALE replica copy instead of skipping the key', async () => {
    await sealWorkspaceDay(serverConfig, WS, DAY);
    const keys = filesUnder(primaryDir);
    expect(keys.length).toBeGreaterThan(0);
    const stale = bucket.get(keys[0]!)!;

    // Rebuild the primary while the replica is unreachable.
    replicaDown = true;
    seedSource(ANON_VISITOR);
    await unsealDays(serverConfig, WS, DAY, DAY);
    await sealWorkspaceDay(serverConfig, WS, DAY);

    // The replica is back, still holding the pre-erasure bytes at a key it
    // already has — the exact case a name-only skip gets wrong.
    replicaDown = false;
    bucket.set(keys[0]!, stale);
    expect(replicaContains(REAL_VISITOR)).toBe(true);

    await syncAnalyticsReplica(serverConfig, { target: 'cloudflare_r2', limit: 500 });

    expect(replicaContains(REAL_VISITOR)).toBe(false);
    expect(replicaContains(ANON_VISITOR)).toBe(true);
  });

  it('still skips live part-* keys, which are immutable once written', async () => {
    // The optimisation must survive the fix: content-unique keys are safe to
    // skip, and re-copying every object on every sync would be the
    // regression in the other direction.
    bucket.set('analytics/web/workspace=x/year=2026/month=08/day=10/part-1-abc.parquet', Buffer.from('old'));
    await sealWorkspaceDay(serverConfig, WS, DAY);
    const result = await syncAnalyticsReplica(serverConfig, { target: 'cloudflare_r2', limit: 500 });
    expect(result.ok).toBe(true);
  });

  it('leaves the replica byte-identical to the primary when it finishes', async () => {
    await sealWorkspaceDay(serverConfig, WS, DAY);
    bucket.clear();

    await syncAnalyticsReplica(serverConfig, { target: 'cloudflare_r2', limit: 500 });

    const keys = filesUnder(primaryDir);
    expect(replicaKeys()).toEqual(keys);
    for (const key of keys) {
      expect(bucket.get(key)).toEqual(fs.readFileSync(path.join(primaryDir, key)));
    }
  });
});
