/**
 * P1 — promoting a mirror to primary is a data-availability decision.
 *
 * Every read resolves through the primary, so an object the mirror never
 * received stops being downloadable the moment it is promoted. These tests
 * drive the real admin route and pin the gate down:
 *
 *   - readiness comes from state the SERVER recorded (a completed
 *     whole-namespace back-fill from the current primary), never a flag the
 *     browser sends;
 *   - a vendor that is off, unreachable, or not proven synchronized is
 *     refused;
 *   - `force` is the one way past it, for recovering from a primary that is
 *     already gone;
 *   - changing a vendor's credentials invalidates the readiness it had.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Router } from 'express';

import { runtimeConfig, resetFakeStoragePool, getEntry } from './fakeStoragePool';

vi.mock('../../../server/supabase.js', async () => {
  const { makeFakeSupabaseClient } = await import('./fakeStoragePool');
  return { getServiceClient: () => makeFakeSupabaseClient() };
});

const { adminStorageProvidersRouter, __resetStorageAdminRateLimit } =
  await import('../../../server/routes/adminStorageProviders.js');
const { syncStorageReplica } = await import('../../../server/services/storage/index.js');

// ── Minimal express harness ──────────────────────────────────────

interface FakeRes {
  statusCode: number;
  body: unknown;
  status(code: number): FakeRes;
  json(payload: unknown): FakeRes;
}

function makeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 200,
    body: undefined,
    status(code) { res.statusCode = code; return res; },
    json(payload) { res.body = payload; return res; },
  };
  return res;
}

type Layer = {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: { handle: (req: unknown, res: unknown, next: () => void) => unknown }[];
  };
};

async function call(method: string, routePath: string, params: Record<string, string>, body: unknown) {
  const stack = (adminStorageProvidersRouter as unknown as { stack: Layer[] }).stack;
  const layer = stack.find((l) => l.route?.path === routePath && l.route.methods[method]);
  if (!layer?.route) throw new Error(`route ${method} ${routePath} not found`);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const res = makeRes();
  await handler({ params, body, serverConfig: {}, adminUser: { id: 'admin-1' } }, res, () => {});
  return res;
}

const routerFor = (): Router => adminStorageProvidersRouter;

// ── Two hermetic vendors: a local primary and a stubbed S3 mirror ──

let primaryDir: string;
let mirrorObjects: Map<string, string>;
let mirrorReachable: boolean;
let restoreFetch: () => void;

function installS3Stub(): () => void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!mirrorReachable) return new Response('nope', { status: 503 });
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const [, , ...rest] = url.pathname.split('/');

    if (method === 'GET' && url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const keys = [...mirrorObjects.keys()].filter((k) => k.startsWith(prefix)).sort();
      return new Response(
        `<?xml version="1.0"?><ListBucketResult>${
          keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join('')
        }<IsTruncated>false</IsTruncated></ListBucketResult>`,
        { status: 200 },
      );
    }
    const key = rest.join('/');
    if (method === 'PUT') { mirrorObjects.set(key, 'x'); return new Response('', { status: 200 }); }
    if (method === 'DELETE') { mirrorObjects.delete(key); return new Response(null, { status: 204 }); }
    if (method === 'GET') {
      const body = mirrorObjects.get(key);
      return body === undefined ? new Response('', { status: 404 }) : new Response(body, { status: 200 });
    }
    return new Response('', { status: 200 });
  }) as typeof globalThis.fetch;
  return () => { globalThis.fetch = realFetch; };
}

function seedPool(overrides?: { mirrorEnabled?: boolean }) {
  runtimeConfig.set('storage_provider_pool', {
    primary: 'local',
    replication: { enabled: true, mirrorDeletes: false },
    providers: {
      local: { enabled: true, config: { local_path: primaryDir, public_url: 'http://localhost:9999/files' } },
      s3: {
        enabled: overrides?.mirrorEnabled ?? true,
        config: { bucket: 'mirror', region: 'us-east-1', access_key_id: 'ak', secret_access_key: 'sk' },
      },
    },
  });
  runtimeConfig.set('default_storage_provider', {
    provider_name: 'local',
    config: { local_path: primaryDir, public_url: 'http://localhost:9999/files' },
  });
}

function seedPrimaryObject(key: string) {
  const full = path.join(primaryDir, key);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, 'x');
}

/** Run the back-fill to completion, the way the UI's batch loop does. */
async function fullSync(target: string) {
  let result = await syncStorageReplica({} as never, { target, restart: true, limit: 50 });
  let rounds = 1;
  while (result.report && !result.report.done) {
    result = await syncStorageReplica({} as never, { target, limit: 50 });
    if (++rounds > 20) throw new Error('sync never finished');
  }
  return result;
}

beforeEach(() => {
  __resetStorageAdminRateLimit();
  resetFakeStoragePool();
  primaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-primary-'));
  mirrorObjects = new Map();
  mirrorReachable = true;
  restoreFetch = installS3Stub();
  seedPool();
});

afterEach(() => {
  restoreFetch();
  fs.rmSync(primaryDir, { recursive: true, force: true });
});

describe('POST /:providerName/primary — promotion gate', () => {
  it('exposes the route', () => {
    expect(routerFor()).toBeTruthy();
  });

  it('refuses a mirror that has never been synced', async () => {
    seedPrimaryObject('workspace/ws/a.txt');

    const res = await call('post', '/:providerName/primary', { providerName: 's3' }, {});

    expect(res.statusCode).toBe(409);
    expect((res.body as { reason?: string }).reason).toBe('not_synchronized');
    // The pointer every upload resolves through is untouched.
    expect((runtimeConfig.get('default_storage_provider') as { provider_name: string }).provider_name).toBe('local');
  });

  it('refuses a vendor that is switched off', async () => {
    seedPool({ mirrorEnabled: false });

    const res = await call('post', '/:providerName/primary', { providerName: 's3' }, {});

    expect(res.statusCode).toBe(409);
    expect((res.body as { reason?: string }).reason).toBe('disabled');
  });

  it('refuses a vendor whose credentials do not answer', async () => {
    mirrorReachable = false;

    const res = await call('post', '/:providerName/primary', { providerName: 's3' }, {});

    expect(res.statusCode).toBe(409);
    expect((res.body as { reason?: string }).reason).toBe('unreachable');
  });

  it('promotes once a completed whole-namespace sync proved the mirror matches', async () => {
    seedPrimaryObject('workspace/ws/a.txt');
    seedPrimaryObject('users/u/b.txt');
    const synced = await fullSync('s3');
    expect(synced.report?.markedSynchronized).toBe(true);

    const res = await call('post', '/:providerName/primary', { providerName: 's3' }, {});

    expect(res.statusCode).toBe(200);
    expect((runtimeConfig.get('default_storage_provider') as { provider_name: string }).provider_name).toBe('s3');
  });

  it('a prefix-scoped sync does not unlock promotion', async () => {
    seedPrimaryObject('workspace/ws/a.txt');
    seedPrimaryObject('users/u/b.txt');
    let result = await syncStorageReplica({} as never, { target: 's3', prefix: 'workspace/', restart: true, limit: 50 });
    while (result.report && !result.report.done) {
      result = await syncStorageReplica({} as never, { target: 's3', limit: 50 });
    }
    expect(result.report?.done).toBe(true);

    const res = await call('post', '/:providerName/primary', { providerName: 's3' }, {});

    expect(res.statusCode).toBe(409);
    expect((res.body as { reason?: string }).reason).toBe('not_synchronized');
  });

  it('force promotes an unsynchronized mirror, and says so', async () => {
    seedPrimaryObject('workspace/ws/a.txt');

    const res = await call('post', '/:providerName/primary', { providerName: 's3' }, { force: true });

    expect(res.statusCode).toBe(200);
    expect((res.body as { forced?: boolean }).forced).toBe(true);
    expect((runtimeConfig.get('default_storage_provider') as { provider_name: string }).provider_name).toBe('s3');
  });

  it('repointing at a different location is refused while the old one holds managed data', async () => {
    seedPrimaryObject('workspace/ws/a.txt');
    await fullSync('s3');

    // A different bucket is a different physical location. The pool knows one
    // location per vendor, so accepting this would drop the old bucket out of
    // every future lifecycle cleanup while it still holds that object.
    const saved = await call('put', '/:providerName', { providerName: 's3' }, {
      config: { bucket: 'somewhere-else', region: 'us-east-1' },
    });

    expect(saved.statusCode).toBe(409);
    expect((saved.body as { reason?: string }).reason).toBe('old_location_not_empty');
    expect(getEntry('s3')!.config).toMatchObject({ bucket: 'mirror' });
  });

  it('repointing is allowed once the old location is verifiably empty, and readiness is dropped', async () => {
    seedPrimaryObject('workspace/ws/a.txt');
    await fullSync('s3');
    mirrorObjects.clear();   // the old bucket was emptied by the operator

    const saved = await call('put', '/:providerName', { providerName: 's3' }, {
      config: { bucket: 'somewhere-else', region: 'us-east-1' },
    });
    expect(saved.statusCode).toBe(200);

    // A new physical location is a new storage identity — nothing the earlier
    // walk proved applies to it.
    const res = await call('post', '/:providerName/primary', { providerName: 's3' }, {});
    expect(res.statusCode).toBe(409);
    expect((res.body as { reason?: string }).reason).toBe('not_synchronized');
  });

  it('rotating a secret at the SAME location keeps readiness', async () => {
    seedPrimaryObject('workspace/ws/a.txt');
    await fullSync('s3');

    // Same bucket, new key: the bytes did not move, so the proof still holds.
    const saved = await call('put', '/:providerName', { providerName: 's3' }, {
      config: { bucket: 'mirror', region: 'us-east-1', secret_access_key: 'rotated' },
    });
    expect(saved.statusCode).toBe(200);

    const res = await call('post', '/:providerName/primary', { providerName: 's3' }, {});
    expect(res.statusCode).toBe(200);
  });

  it('re-saving identical settings keeps readiness', async () => {
    seedPrimaryObject('workspace/ws/a.txt');
    await fullSync('s3');

    const saved = await call('put', '/:providerName', { providerName: 's3' }, {
      config: { bucket: 'mirror', region: 'us-east-1' },
    });
    expect(saved.statusCode).toBe(200);

    const res = await call('post', '/:providerName/primary', { providerName: 's3' }, {});
    expect(res.statusCode).toBe(200);
  });

  it('never returns a stored credential', async () => {
    const res = await call('get', '/', {}, undefined);
    const providers = (res.body as { providers: { name: string; config: Record<string, unknown>; secretKeys: string[] }[] }).providers;
    const mirror = providers.find((p) => p.name === 's3')!;

    expect(mirror.config.access_key_id).toBeUndefined();
    expect(mirror.config.secret_access_key).toBeUndefined();
    expect(mirror.secretKeys).toContain('access_key_id');
    expect(JSON.stringify(res.body)).not.toContain('sk');
  });
});
