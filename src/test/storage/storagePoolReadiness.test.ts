/**
 * P0 — promotion readiness must reflect the PRESENT, not a moment in the past.
 *
 * A completed whole-namespace back-fill proves a mirror matched the primary
 * when the walk finished. Every later primary upload can break that: the
 * primary write succeeds, the mirrored write fails, and the mirror is now
 * missing an object while `syncedAt` still says "synchronized". Promoting on
 * that stale proof makes the missing objects unreachable.
 *
 * So a failed mirror write — or a failure to resolve replication at all —
 * must invalidate readiness DURABLY, server-side, from the upload path. The
 * browser is not part of this decision and never reports it.
 *
 * P1 — and a long-running sync must not write its stale pool snapshot back
 * over newer credentials, a newer primary or a newer enabled flag.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runtimeConfig, resetFakeStoragePool, getEntry, POOL_KEY } from './fakeStoragePool';

vi.mock('../../../server/supabase.js', async () => {
  const { makeFakeSupabaseClient } = await import('./fakeStoragePool');
  return { getServiceClient: () => makeFakeSupabaseClient() };
});

// The owner-write lease and the usage meter are proven by their own suites;
// here they must simply not stand between the test and the provider calls.
vi.mock('../../../server/services/storage/writerLease.js', () => ({
  withOwnerWriteLease: async (
    _c: unknown, _k: unknown, _id: unknown, _p: unknown,
    run: () => Promise<unknown>,
  ) => ({ ok: true, result: await run() }),
}));

const { readStoragePool, isReplicaSynchronized, writeStoragePool, normalizePool, StoragePoolConflictError } =
  await import('../../../server/services/storage/pool.js');
const { syncStorageReplica, uploadForOwner } =
  await import('../../../server/services/storage/index.js');
const { adminStorageProvidersRouter, __resetStorageAdminRateLimit } =
  await import('../../../server/routes/adminStorageProviders.js');

const serverConfig = {} as Parameters<typeof readStoragePool>[0];
const WS = '55555555-5555-5555-5555-555555555555';

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

async function call(method: string, routePath: string, params: Record<string, string>, body: unknown) {
  const stack = (adminStorageProvidersRouter as unknown as { stack: Layer[] }).stack;
  const layer = stack.find((l) => l.route?.path === routePath && l.route.methods[method]);
  if (!layer?.route) throw new Error(`route ${method} ${routePath} not found`);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const res = makeRes();
  await handler({ params, body, serverConfig: {}, adminUser: { id: 'admin-1' } }, res, () => {});
  return res;
}

// ── A local primary and a stubbed S3 mirror that can be made to fail ──

let primaryDir: string;
let mirrorObjects: Map<string, string>;
let mirrorWritable: boolean;
let restoreFetch: () => void;
/**
 * Holds every mirror PUT until released, so a sync can be parked mid-flight
 * while an admin request commits. That is the only way to reproduce the race
 * this section is about: the read, the provider I/O and the write are three
 * separate moments, and something else can land between them.
 */
let heldWrites: (() => void)[];
let holdMirrorWrites: boolean;

async function waitForHeldWrite() {
  for (let i = 0; i < 200 && heldWrites.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  if (heldWrites.length === 0) throw new Error('sync never reached a mirror write');
}

function releaseHeldWrites() {
  holdMirrorWrites = false;
  for (const release of heldWrites.splice(0)) release();
}

function installS3Stub(): () => void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
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
    if (method === 'PUT') {
      if (holdMirrorWrites) {
        await new Promise<void>((resolve) => { heldWrites.push(resolve); });
      }
      if (!mirrorWritable) return new Response('mirror down', { status: 503 });
      mirrorObjects.set(key, 'x');
      return new Response('', { status: 200 });
    }
    if (method === 'DELETE') { mirrorObjects.delete(key); return new Response(null, { status: 204 }); }
    if (method === 'GET') {
      const body = mirrorObjects.get(key);
      return body === undefined ? new Response('', { status: 404 }) : new Response(body, { status: 200 });
    }
    return new Response('', { status: 200 });
  }) as typeof globalThis.fetch;
  return () => { globalThis.fetch = realFetch; };
}

function seedPool() {
  runtimeConfig.set(POOL_KEY, {
    primary: 'local',
    replication: { enabled: true, mirrorDeletes: false },
    revision: 1,
    providers: {
      local: { enabled: true, config: { local_path: primaryDir, public_url: 'http://localhost:9999/files' } },
      s3: { enabled: true, config: { bucket: 'mirror', region: 'us-east-1', access_key_id: 'ak', secret_access_key: 'sk' } },
    },
  });
  runtimeConfig.set('default_storage_provider', {
    provider_name: 'local',
    config: { local_path: primaryDir, public_url: 'http://localhost:9999/files' },
  });
}

async function fullSync(target: string) {
  let result = await syncStorageReplica(serverConfig, { target, restart: true, limit: 50 });
  let rounds = 1;
  while (result.report && !result.report.done) {
    result = await syncStorageReplica(serverConfig, { target, limit: 50 });
    if (++rounds > 20) throw new Error('sync never finished');
  }
  return result;
}

async function uploadToOwner(name: string) {
  return uploadForOwner(serverConfig, {
    owner: { kind: 'workspace', workspaceId: WS },
    fileKey: `workspace/${WS}/attachments/${name}`,
    data: Buffer.from('payload'),
    contentType: 'text/plain',
  });
}

beforeEach(() => {
  __resetStorageAdminRateLimit();
  resetFakeStoragePool();
  primaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'readiness-primary-'));
  mirrorObjects = new Map();
  mirrorWritable = true;
  heldWrites = [];
  holdMirrorWrites = false;
  restoreFetch = installS3Stub();
  seedPool();
});

afterEach(() => {
  releaseHeldWrites();
  restoreFetch();
  fs.rmSync(primaryDir, { recursive: true, force: true });
});

describe('a failed mirrored write invalidates promotion readiness', () => {
  it('walks the full lifecycle: synced → mirror fails → not synced → promotion refused → re-synced', async () => {
    // 1. a completed whole-namespace walk earns readiness
    fs.mkdirSync(path.join(primaryDir, `workspace/${WS}/attachments`), { recursive: true });
    fs.writeFileSync(path.join(primaryDir, `workspace/${WS}/attachments/old.txt`), 'x');
    expect((await fullSync('s3')).report?.markedSynchronized).toBe(true);
    expect(isReplicaSynchronized(await readStoragePool(serverConfig), 's3')).toBe(true);

    // 2. a later primary upload succeeds while the mirror rejects it
    mirrorWritable = false;
    const uploaded = await uploadToOwner('new.txt');
    expect(uploaded.success).toBe(true);           // the primary write still stands
    expect(uploaded.mirrors?.[0].success).toBe(false);

    // 3. readiness is gone — and durably, not just in that response
    const afterFailure = await readStoragePool(serverConfig);
    expect(isReplicaSynchronized(afterFailure, 's3')).toBe(false);
    expect(afterFailure.providers.s3.dirtyAt).toBeTruthy();
    expect(afterFailure.providers.s3.dirtyReason).toMatch(/mirror_upload_failed/);

    // 4. the ordinary promotion path refuses — and specifically because the
    //    mirror is no longer proven complete, not merely because it is down.
    mirrorWritable = true;
    const refused = await call('post', '/:providerName/primary', { providerName: 's3' }, {});
    expect(refused.statusCode).toBe(409);
    expect((refused.body as { reason?: string }).reason).toBe('not_synchronized');

    // 5. a fresh successful whole-namespace walk restores it
    expect((await fullSync('s3')).report?.markedSynchronized).toBe(true);
    expect(isReplicaSynchronized(await readStoragePool(serverConfig), 's3')).toBe(true);
    const promoted = await call('post', '/:providerName/primary', { providerName: 's3' }, {});
    expect(promoted.statusCode).toBe(200);
  });

  it('a gap recorded DURING a walk stops that walk from claiming readiness', async () => {
    fs.mkdirSync(path.join(primaryDir, `workspace/${WS}/attachments`), { recursive: true });
    for (let i = 0; i < 4; i++) {
      fs.writeFileSync(path.join(primaryDir, `workspace/${WS}/attachments/f${i}.txt`), 'x');
    }

    // Start a walk, then let a mirrored write fail while it is still running.
    const first = await syncStorageReplica(serverConfig, { target: 's3', restart: true, limit: 1 });
    expect(first.report?.done).toBe(false);

    mirrorWritable = false;
    await uploadToOwner('late.txt');
    mirrorWritable = true;

    let result = await syncStorageReplica(serverConfig, { target: 's3', limit: 50 });
    while (result.ok && result.report && !result.report.done) {
      result = await syncStorageReplica(serverConfig, { target: 's3', limit: 50 });
    }

    // The walk cannot vouch for an object that went missing after it began.
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/mirrored write failed/i);
    expect(isReplicaSynchronized(await readStoragePool(serverConfig), 's3')).toBe(false);
  });

  it('replication that cannot even be resolved marks every replica dirty', async () => {
    fs.mkdirSync(path.join(primaryDir, `workspace/${WS}/attachments`), { recursive: true });
    fs.writeFileSync(path.join(primaryDir, `workspace/${WS}/attachments/old.txt`), 'x');
    await fullSync('s3');
    expect(isReplicaSynchronized(await readStoragePool(serverConfig), 's3')).toBe(true);

    // The pool read inside the upload path fails: the object landed on the
    // primary, and NO replica was reached. None of them may still claim to
    // be complete.
    const { dbState } = await import('./fakeStoragePool');
    dbState.readError = { message: 'connection reset by peer' };
    dbState.readErrorKeys = ['storage_provider_pool'];
    const uploaded = await uploadToOwner('unreplicated.txt');
    dbState.readError = null;
    dbState.readErrorKeys = null;

    expect(uploaded.success).toBe(true);
    const pool = await readStoragePool(serverConfig);
    expect(isReplicaSynchronized(pool, 's3')).toBe(false);
    expect(pool.providers.s3.dirtyReason).toMatch(/replication_unresolved/);
  });
});

describe('stale whole-pool writes are rejected (compare-and-set)', () => {
  it('a sync that started under credentials A cannot restore them, nor bless credentials B', async () => {
    fs.mkdirSync(path.join(primaryDir, `workspace/${WS}/attachments`), { recursive: true });
    fs.writeFileSync(path.join(primaryDir, `workspace/${WS}/attachments/f0.txt`), 'x');

    // A whole-namespace walk begins against bucket "mirror" (credentials A)
    // and is parked inside its first mirror write.
    holdMirrorWrites = true;
    const inFlight = syncStorageReplica(serverConfig, { target: 's3', restart: true, limit: 50 });
    await waitForHeldWrite();

    // Meanwhile an admin repoints the vendor at a different bucket (B).
    const saved = await call('put', '/:providerName', { providerName: 's3' }, {
      config: { bucket: 'somewhere-else', region: 'us-east-1' },
    });
    expect(saved.statusCode).toBe(200);
    expect(getEntry('s3')!.config).toMatchObject({ bucket: 'somewhere-else' });

    // The parked walk now finishes and tries to persist its snapshot.
    releaseHeldWrites();
    const late = await inFlight;

    expect(late.ok).toBe(false);
    expect(late.error).toMatch(/settings changed/i);
    // Credentials A are NOT restored…
    expect(getEntry('s3')!.config).toMatchObject({ bucket: 'somewhere-else' });
    // …and bucket B is not blessed by a walk that never looked at it.
    expect(isReplicaSynchronized(await readStoragePool(serverConfig), 's3')).toBe(false);
  });

  it('a walk cannot mark readiness after the primary changed underneath it', async () => {
    // A third vendor exists so the primary can move to something OTHER than
    // the walk's own target.
    const pool = runtimeConfig.get(POOL_KEY) as { providers: Record<string, unknown> };
    pool.providers.minio = {
      enabled: true,
      config: { bucket: 'third', region: 'us-east-1', access_key_id: 'ak', secret_access_key: 'sk' },
    };

    fs.mkdirSync(path.join(primaryDir, `workspace/${WS}/attachments`), { recursive: true });
    fs.writeFileSync(path.join(primaryDir, `workspace/${WS}/attachments/f0.txt`), 'x');

    holdMirrorWrites = true;
    const inFlight = syncStorageReplica(serverConfig, { target: 's3', restart: true, limit: 50 });
    await waitForHeldWrite();

    // The primary moves while the walk is parked: it has been copying FROM a
    // provider that is no longer the source of truth.
    const promoted = await call('post', '/:providerName/primary', { providerName: 'minio' }, { force: true });
    expect(promoted.statusCode).toBe(200);

    releaseHeldWrites();
    const late = await inFlight;

    expect(late.ok).toBe(false);
    expect(late.error).toMatch(/primary changed/i);
    expect(isReplicaSynchronized(await readStoragePool(serverConfig), 's3')).toBe(false);
  });

  it('an enable/disable change is not lost when a stale whole-pool write lands later', async () => {
    const stale = await readStoragePool(serverConfig);   // revision N

    // Another admin retires the mirror — revision N+1.
    const patched = await call('patch', '/:providerName', { providerName: 's3' }, { enabled: false });
    expect(patched.statusCode).toBe(200);
    expect(getEntry('s3')!.enabled).toBe(false);

    // The stale snapshot (which still has it enabled) must be refused.
    stale.replication.mirrorDeletes = true;
    await expect(writeStoragePool(serverConfig, stale)).rejects.toBeInstanceOf(StoragePoolConflictError);
    expect(getEntry('s3')!.enabled).toBe(false);
  });

  it('a rejected compare-and-set surfaces as 409, not as a silent overwrite', async () => {
    const stale = await readStoragePool(serverConfig);
    await call('patch', '/:providerName', { providerName: 's3' }, { enabled: false });

    let conflict: unknown;
    try {
      await writeStoragePool(serverConfig, normalizePool({ ...stale, revision: stale.revision }));
    } catch (err) { conflict = err; }

    expect(conflict).toBeInstanceOf(StoragePoolConflictError);
  });
});

describe('removing a vendor cannot silently forget owner data', () => {
  it('refuses while the vendor still holds workspace objects', async () => {
    mirrorObjects.set(`workspace/${WS}/attachments/a.txt`, 'x');

    const res = await call('delete', '/:providerName', { providerName: 's3' }, {});

    expect(res.statusCode).toBe(409);
    expect((res.body as { reason?: string }).reason).toBe('managed_data_present');
    // Still configured — so still a deletion scope for every future owner purge.
    expect(getEntry('s3')).toBeTruthy();
  });

  it('refuses while the vendor still holds user objects', async () => {
    mirrorObjects.set('users/abc/avatar.png', 'x');

    const res = await call('delete', '/:providerName', { providerName: 's3' }, {});

    expect(res.statusCode).toBe(409);
    expect(getEntry('s3')).toBeTruthy();
  });

  it('refuses when it cannot even verify — unverifiable is not empty', async () => {
    mirrorWritable = true;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('boom', { status: 500 })) as typeof globalThis.fetch;

    const res = await call('delete', '/:providerName', { providerName: 's3' }, {});
    globalThis.fetch = realFetch;

    expect(res.statusCode).toBe(409);
    expect((res.body as { error: string }).error).toMatch(/could not list/i);
    expect(getEntry('s3')).toBeTruthy();
  });

  it('allows removal once the vendor is verifiably free of managed data', async () => {
    const res = await call('delete', '/:providerName', { providerName: 's3' }, {});

    expect(res.statusCode).toBe(200);
    expect(getEntry('s3')).toBeUndefined();
  });

  it('force is the named destructive escape hatch, and says it was used', async () => {
    mirrorObjects.set(`workspace/${WS}/attachments/a.txt`, 'x');

    const res = await call('delete', '/:providerName', { providerName: 's3' }, { force: true });

    expect(res.statusCode).toBe(200);
    expect((res.body as { forced?: boolean }).forced).toBe(true);
    expect(getEntry('s3')).toBeUndefined();
  });

  it('retiring keeps the vendor as a deletion scope instead of forgetting it', async () => {
    mirrorObjects.set(`workspace/${WS}/attachments/a.txt`, 'x');

    const res = await call('patch', '/:providerName', { providerName: 's3' }, { enabled: false });

    expect(res.statusCode).toBe(200);
    const listed = (res.body as { providers: { name: string; retired: boolean }[] }).providers;
    expect(listed.find((p) => p.name === 's3')!.retired).toBe(true);
    expect(getEntry('s3')).toBeTruthy();
  });
});
