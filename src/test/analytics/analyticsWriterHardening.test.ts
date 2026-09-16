/**
 * The write path's failure behaviour, as opposed to its happy path.
 *
 * Each of these guards a defect that an adversarial audit of Phase 1
 * surfaced — every one of them silently destroyed accepted events or took
 * the process down, and none of them would show up in a test that only
 * exercised a successful flush.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resetFakeAnalyticsPool, seedGeneralPool, seedAnalyticsPool } from './fakeAnalyticsPool';

vi.mock('../../../server/supabase.js', async () => {
  const { makeFakeSupabaseClient } = await import('./fakeAnalyticsPool');
  const client = makeFakeSupabaseClient();
  return { getServiceClient: () => client };
});
vi.mock('../../../server/services/observability/metrics.js', () => ({
  emitMetric: () => undefined,
  emitLog: () => undefined,
}));

const { readAnalyticsPool } = await import('../../../server/services/analytics/pool.js');
const { flushAnalytics, enqueueAnalyticsRow, bufferedRowCount, __resetAnalyticsBuffer } =
  await import('../../../server/services/analytics/writer.js');
const { buildEventRow } = await import('../../../server/services/analytics/schema.js');

const serverConfig = {} as never;
const WS = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BUCKET = 'r2-analytics';

let primaryDir: string;
let restoreFetch: (() => void) | null = null;

function row(url = 'https://shop.test/') {
  return buildEventRow({
    workspaceId: WS, eventType: 'page_view', occurredAt: '2026-09-10T12:00:00.000Z',
    url, session: { visitorId: 'visitor-0', sessionId: 's0' },
  });
}

function useS3Primary() {
  seedGeneralPool({
    primary: 'bunny_storage',
    providers: {
      bunny_storage: { config: { username: 'z', password: 'p', hostname: 'storage.bunnycdn.com' } },
      cloudflare_r2: { config: { bucket: BUCKET, account_id: 'acc', access_key_id: 'ak', secret_access_key: 'sk' } },
    },
  });
  seedAnalyticsPool({
    enabled: true, primary: 'cloudflare_r2', replicas: [], replicationEnabled: false,
    prefix: 'analytics/web/', knownPrefixes: ['analytics/web/'],
    batchRows: 10_000, batchBytes: 33_554_432, flushIntervalMs: 15_000,
    format: 'parquet', compression: 'zstd', writeMode: 'dual_write', readMode: 'postgres',
    replicaState: {},
  });
}

beforeEach(() => {
  resetFakeAnalyticsPool();
  __resetAnalyticsBuffer();
  primaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-hardening-'));
  seedGeneralPool({
    primary: 'bunny_storage',
    providers: {
      bunny_storage: { config: { username: 'z', password: 'p', hostname: 'storage.bunnycdn.com' } },
      local: { config: { local_path: primaryDir, public_url: 'http://localhost:9999/files' } },
    },
  });
  seedAnalyticsPool({
    enabled: true, primary: 'local', replicas: [], replicationEnabled: false,
    prefix: 'analytics/web/', knownPrefixes: ['analytics/web/'],
    batchRows: 10_000, batchBytes: 33_554_432, flushIntervalMs: 15_000,
    format: 'parquet', compression: 'zstd', writeMode: 'dual_write', readMode: 'postgres',
    replicaState: {},
  });
});

afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
  __resetAnalyticsBuffer();
  fs.rmSync(primaryDir, { recursive: true, force: true });
});

describe('a network-level failure must not destroy the batch', () => {
  it('requeues rows when the driver THROWS rather than returning a failure', async () => {
    useS3Primary();
    const pool = await readAnalyticsPool(serverConfig);
    enqueueAnalyticsRow(serverConfig, pool, row());
    expect(bufferedRowCount()).toBe(1);

    // fetchWithTimeout throws on a network error; the batch is already
    // detached from the buffer by then, so an escaping exception would
    // destroy the rows instead of putting them back.
    const realFetch = globalThis.fetch;
    restoreFetch = () => { globalThis.fetch = realFetch; };
    globalThis.fetch = (async () => { throw new Error('ECONNRESET'); }) as typeof globalThis.fetch;

    const result = await flushAnalytics(serverConfig, { force: true });

    expect(result.objects).toBe(0);
    expect(result.failures).toBe(1);
    // The rows survived: the next flush retries them.
    expect(bufferedRowCount()).toBe(1);
  });

  it('writes them successfully once the network recovers', async () => {
    useS3Primary();
    const pool = await readAnalyticsPool(serverConfig);
    enqueueAnalyticsRow(serverConfig, pool, row());

    const realFetch = globalThis.fetch;
    restoreFetch = () => { globalThis.fetch = realFetch; };
    globalThis.fetch = (async () => { throw new Error('ECONNRESET'); }) as typeof globalThis.fetch;
    await flushAnalytics(serverConfig, { force: true });

    const stored = new Map<string, Buffer>();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const key = url.pathname.split('/').filter(Boolean).slice(1).join('/');
      if ((init?.method ?? 'GET') === 'PUT') {
        const body = init?.body as ArrayBuffer | ArrayBufferView | undefined;
        stored.set(key, ArrayBuffer.isView(body)
          ? Buffer.from(body.buffer, body.byteOffset, body.byteLength)
          : Buffer.from((body as ArrayBuffer) ?? new ArrayBuffer(0)));
        return new Response('', { status: 200 });
      }
      return new Response('', { status: 200 });
    }) as typeof globalThis.fetch;

    const result = await flushAnalytics(serverConfig, { force: true });

    expect(result.objects).toBe(1);
    expect(bufferedRowCount()).toBe(0);
    expect(stored.size).toBe(1);
  });
});

describe('a malformed row must not throw out of enqueue', () => {
  it('accepts a row with an unusable timestamp instead of throwing on the request path', async () => {
    const pool = await readAnalyticsPool(serverConfig);
    const malformed = { ...row(), occurred_at: Number.NaN as unknown as number };

    // enqueue is called from a widget request handler; a throw here would
    // escape into whatever call site forgot to wrap it.
    expect(() => enqueueAnalyticsRow(serverConfig, pool, malformed as never)).not.toThrow();
    expect(bufferedRowCount()).toBe(1);
  });

  it('drains the buffer rather than retrying an unwritable batch forever', async () => {
    const pool = await readAnalyticsPool(serverConfig);
    enqueueAnalyticsRow(serverConfig, pool, { ...row(), occurred_at: Number.NaN as unknown as number } as never);
    enqueueAnalyticsRow(serverConfig, pool, row());

    await flushAnalytics(serverConfig, { force: true });
    await flushAnalytics(serverConfig, { force: true });

    // A permanently failing batch that is requeued grows without bound and
    // is re-encoded on every tick forever; the buffer must end up empty.
    expect(bufferedRowCount()).toBe(0);
  });
});

describe('a threshold-triggered flush must not be able to kill the process', () => {
  it('does not surface an unhandled rejection when the flush throws', async () => {
    useS3Primary();
    const pool = { ...(await readAnalyticsPool(serverConfig)), batchRows: 1 };

    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);

    const realFetch = globalThis.fetch;
    restoreFetch = () => {
      globalThis.fetch = realFetch;
      process.off('unhandledRejection', onRejection);
    };
    globalThis.fetch = (async () => { throw new Error('ECONNRESET'); }) as typeof globalThis.fetch;

    // batchRows = 1 makes this enqueue fire a flush immediately.
    enqueueAnalyticsRow(serverConfig, pool as never, row());
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(rejections).toEqual([]);
  });
});

describe('the Parquet writer refuses an unsupported runtime', () => {
  it('states the Node version requirement rather than failing cryptically', async () => {
    // The guard runs at module load; this asserts the contract it enforces,
    // which is what makes a Node 20 deployment fail legibly instead of
    // throwing "zstdCompressSync is not a function" on every flush.
    const zlib = await import('node:zlib');
    expect(typeof zlib.zstdCompressSync).toBe('function');
    const source = fs.readFileSync('server/services/analytics/parquet.ts', 'utf8');
    expect(source).toContain('analytics_parquet_unsupported_runtime');
    expect(source).toContain('22.15');
  });

  it('is matched by the Node version the server and worker images run', () => {
    for (const dockerfile of ['Dockerfile.server', 'Dockerfile.worker']) {
      const contents = fs.readFileSync(dockerfile, 'utf8');
      const version = /FROM node:(\d+)/.exec(contents)?.[1];
      expect(Number(version), `${dockerfile} runs a Node too old for node:zlib's ZSTD`).toBeGreaterThanOrEqual(22);
    }
  });
});
