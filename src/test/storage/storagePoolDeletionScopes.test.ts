/**
 * P0 — owner lifecycle deletion must erase EVERY physical copy.
 *
 * The storage pool mirrors each primary write to the enabled replicas, so
 * `workspace/<id>/...` and `users/<id>/...` objects exist in more than one
 * bucket. Workspace/account deletion purges the database; if it walked only
 * the ordinary attachment/default provider, the mirrored copies would
 * survive the owner forever.
 *
 * `replication.mirrorDeletes` is deliberately irrelevant here: it governs
 * ORDINARY object deletion (keeping a backup copy of one deleted
 * attachment). Lifecycle deletion has the opposite contract — leave nothing
 * anywhere — so these tests keep it OFF throughout and still require every
 * replica to be emptied and verified before the walker may advance.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const WS_A = '11111111-1111-1111-1111-111111111111';
const WS_B = '22222222-2222-2222-2222-222222222222';
const USER_A = '33333333-3333-3333-3333-333333333333';
const USER_B = '44444444-4444-4444-4444-444444444444';

import { runtimeConfig, dbState, resetFakeStoragePool } from './fakeStoragePool';

vi.mock('../../../server/supabase.js', async () => {
  const { makeFakeSupabaseClient } = await import('./fakeStoragePool');
  return { getServiceClient: () => makeFakeSupabaseClient() };
});

// The privacy-export and LiveKit-recording scopes have their own resolvers
// and their own tests; here they are deliberately unconfigured so the
// assertions are about the pool replicas only.
vi.mock('../../../server/services/privacy/storageResolver.js', () => {
  class PrivacyStorageNotConfigured extends Error {}
  return {
    PrivacyStorageNotConfigured,
    resolvePrivacyStoragePolicy: async () => { throw new PrivacyStorageNotConfigured('privacy storage not configured'); },
  };
});
vi.mock('../../../server/services/calls/recordingStorageResolver.js', () => {
  class RecordingStorageNotConfigured extends Error {}
  return {
    RecordingStorageNotConfigured,
    resolveRecordingStorageConfig: async () => { throw new RecordingStorageNotConfigured('recording storage not configured'); },
  };
});

const { workspaceStorageScopes, workspaceScopePrefix } =
  await import('../../../server/services/storage/workspaceScopes.js');
const { userStorageScopes, userScopePrefix } =
  await import('../../../server/services/storage/userScopes.js');
import type { ScopeCleanupState } from '../../../server/services/storage/scopeCleanupEngine.js';
const { runScopeCleanupTick } =
  await import('../../../server/services/storage/scopeCleanupEngine.js');

const serverConfig = {} as Parameters<typeof workspaceStorageScopes>[0];

// ── Three physical providers, all hermetic ───────────────────────
// primary: `local` on a real temp dir; mirrors: two S3-compatible vendors
// (different buckets) served by a stubbed endpoint.

interface Buckets { [bucket: string]: Map<string, string> }

let primaryDir: string;
let buckets: Buckets;
let restoreFetch: () => void;
/** Buckets whose DELETE is rejected — stands in for a mirror that cannot be emptied. */
let undeletableBuckets: Set<string>;

function installS3Stub(): () => void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    // Decoded, as a real S3 server does — keys are sent percent-encoded.
    const [, bucket, ...rest] = url.pathname.split('/').map((s, i) => (i > 1 ? decodeURIComponent(s) : s));
    const objects = buckets[bucket] ?? (buckets[bucket] = new Map());

    if (method === 'GET' && url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      return new Response(
        `<?xml version="1.0"?><ListBucketResult>${
          keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join('')
        }<IsTruncated>false</IsTruncated></ListBucketResult>`,
        { status: 200 },
      );
    }
    const key = rest.join('/');
    if (method === 'DELETE') {
      if (undeletableBuckets.has(bucket)) return new Response('denied', { status: 500 });
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    if (method === 'PUT') { objects.set(key, 'x'); return new Response('', { status: 200 }); }
    if (method === 'GET') {
      const body = objects.get(key);
      return body === undefined ? new Response('', { status: 404 }) : new Response(body, { status: 200 });
    }
    return new Response('', { status: 200 });
  }) as typeof globalThis.fetch;
  return () => { globalThis.fetch = realFetch; };
}

function seedPrimary(key: string) {
  const full = path.join(primaryDir, key);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, 'x');
}

function primaryHas(key: string): boolean {
  return fs.existsSync(path.join(primaryDir, key));
}

/** Switch a vendor off the way the admin PATCH does. */
function retire(name: string) {
  const pool = runtimeConfig.get('storage_provider_pool') as { providers: Record<string, { enabled: boolean }> };
  pool.providers[name].enabled = false;
}

/** Drives the walker to completion the way a worker's ticks would. Takes either owner's scope list. */
async function drain(
  scopes: Parameters<typeof runScopeCleanupTick>[0]['scopes'],
  prefix: string,
) {
  const state: ScopeCleanupState = {};
  for (let tick = 0; tick < 60; tick++) {
    const outcome = await runScopeCleanupTick({
      scopes,
      prefix,
      state,
      maxDeleteAttemptsPerKey: 2,
      heartbeat: async () => true,
      persist: async () => {},
    });
    if (outcome.kind === 'error') return { outcome, state, ticks: tick + 1 };
    if (outcome.kind === 'advance') return { outcome, state, ticks: tick + 1 };
  }
  throw new Error('walker never settled');
}

beforeEach(() => {
  resetFakeStoragePool();
  primaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deletion-primary-'));
  buckets = { mirror_one: new Map(), mirror_two: new Map() };
  undeletableBuckets = new Set();
  restoreFetch = installS3Stub();

  runtimeConfig.set('storage_provider_pool', {
    primary: 'local',
    // The flag that must NOT weaken lifecycle deletion.
    replication: { enabled: true, mirrorDeletes: false },
    providers: {
      local: { enabled: true, config: { local_path: primaryDir, public_url: 'http://localhost:9999/files' } },
      s3: { enabled: true, config: { bucket: 'mirror_one', region: 'us-east-1', access_key_id: 'ak', secret_access_key: 'sk' } },
      minio: { enabled: true, config: { bucket: 'mirror_two', region: 'us-east-1', access_key_id: 'ak', secret_access_key: 'sk' } },
    },
  });
  runtimeConfig.set('default_storage_provider', {
    provider_name: 'local',
    config: { local_path: primaryDir, public_url: 'http://localhost:9999/files' },
  });
});

afterEach(() => {
  restoreFetch();
  fs.rmSync(primaryDir, { recursive: true, force: true });
});

describe('workspace deletion — every configured pool vendor is a scope', () => {
  it('lists one replica scope per configured vendor, on top of the static scopes', async () => {
    const scopes = await workspaceStorageScopes(serverConfig, WS_A);
    const names = scopes.map((s) => s.name);

    expect(names).toContain('attachment');
    expect(names).toContain('privacy_export');
    expect(names).toContain('livekit_recording');
    expect(names).toContain('replica:local');
    expect(names).toContain('replica:s3');
    expect(names).toContain('replica:minio');
  });

  it('KEEPS a vendor the operator switched off — it still holds what it received', async () => {
    // Retiring a mirror stops new writes; it does not empty the bucket. A
    // retired vendor that dropped out of the scope list would keep this
    // owner's objects forever, which is the whole failure this guards.
    retire('minio');

    const names = (await workspaceStorageScopes(serverConfig, WS_A)).map((s) => s.name);
    expect(names).toContain('replica:s3');
    expect(names).toContain('replica:minio');
  });

  it('throws rather than dropping replica scopes when the pool cannot be read', async () => {
    // A failed read must never look like "this platform has no replicas" —
    // that is precisely how deletion would advance to the DB purge while
    // mirrored copies survive.
    dbState.readError = { message: 'connection reset by peer' };
    await expect(workspaceStorageScopes(serverConfig, WS_A)).rejects.toThrow(/connection reset/);
    await expect(userStorageScopes(serverConfig, USER_A)).rejects.toThrow(/connection reset/);
    dbState.readError = null;
  });

  it('deletes and verifies the object on the primary AND both mirrors, with mirrorDeletes off', async () => {
    const key = `workspace/${WS_A}/attachments/a.txt`;
    seedPrimary(key);
    buckets.mirror_one.set(key, 'x');
    buckets.mirror_two.set(key, 'x');

    const scopes = await workspaceStorageScopes(serverConfig, WS_A);
    const { outcome, state } = await drain(scopes, workspaceScopePrefix(WS_A));

    expect(outcome.kind).toBe('advance');
    expect(primaryHas(key)).toBe(false);
    expect(buckets.mirror_one.has(key)).toBe(false);
    expect(buckets.mirror_two.has(key)).toBe(false);

    // Every replica scope is settled AND verified — the walker only returns
    // 'advance' (which is what lets a worker move on to the DB purge) once
    // a from-scratch re-listing found each location empty.
    for (const name of ['replica:s3', 'replica:minio']) {
      expect(state[name].status).toBe('done');
      expect(state[name].verified).toBe(true);
    }
  });

  it('never advances to the DB purge while a mirror still holds an object', async () => {
    const key = `workspace/${WS_A}/attachments/a.txt`;
    seedPrimary(key);
    buckets.mirror_one.set(key, 'x');

    // A mirror that cannot be emptied must stop the whole job: the walker
    // reports an error and never returns 'advance', which is the only thing
    // that would let a worker move on to the irreversible DB purge.
    undeletableBuckets.add('mirror_one');

    const scopes = await workspaceStorageScopes(serverConfig, WS_A);
    const { outcome } = await drain(scopes, workspaceScopePrefix(WS_A));

    expect(outcome.kind).toBe('error');
    expect(outcome.kind === 'error' && outcome.message).toMatch(/replica:s3/);
    expect(buckets.mirror_one.has(key)).toBe(true);
  });

  it('deduplicates a vendor that is the same physical location as the attachment scope', async () => {
    const key = `workspace/${WS_A}/attachments/a.txt`;
    seedPrimary(key);

    const scopes = await workspaceStorageScopes(serverConfig, WS_A);
    const { state } = await drain(scopes, workspaceScopePrefix(WS_A));

    // 'attachment' resolves to the same local dir as 'replica:local'.
    expect(state['replica:local'].dedup_of).toBe('attachment');
    expect(state['replica:local'].status).toBe('done');
  });

  it('cleans and verifies a RETIRED mirror, with mirrorDeletes off', async () => {
    const key = `workspace/${WS_A}/attachments/a.txt`;
    seedPrimary(key);
    buckets.mirror_one.set(key, 'x');
    buckets.mirror_two.set(key, 'x');
    // Received the object while enabled, then switched off.
    retire('minio');

    const scopes = await workspaceStorageScopes(serverConfig, WS_A);
    const { outcome, state } = await drain(scopes, workspaceScopePrefix(WS_A));

    expect(outcome.kind).toBe('advance');
    expect(buckets.mirror_two.has(key)).toBe(false);
    expect(state['replica:minio'].status).toBe('done');
    expect(state['replica:minio'].verified).toBe(true);
  });

  it('stays blocked when a retired mirror cannot be emptied, rather than reporting success', async () => {
    const key = `workspace/${WS_A}/attachments/a.txt`;
    seedPrimary(key);
    buckets.mirror_two.set(key, 'x');
    retire('minio');
    undeletableBuckets.add('mirror_two');

    const scopes = await workspaceStorageScopes(serverConfig, WS_A);
    const { outcome } = await drain(scopes, workspaceScopePrefix(WS_A));

    expect(outcome.kind).toBe('error');
    expect(buckets.mirror_two.has(key)).toBe(true);
  });

  it('never touches another workspace, on any provider', async () => {
    const mine = `workspace/${WS_A}/attachments/a.txt`;
    const theirs = `workspace/${WS_B}/attachments/b.txt`;
    seedPrimary(mine);
    seedPrimary(theirs);
    for (const bucket of [buckets.mirror_one, buckets.mirror_two]) {
      bucket.set(mine, 'x');
      bucket.set(theirs, 'x');
    }

    const scopes = await workspaceStorageScopes(serverConfig, WS_A);
    await drain(scopes, workspaceScopePrefix(WS_A));

    expect(primaryHas(theirs)).toBe(true);
    expect(buckets.mirror_one.has(theirs)).toBe(true);
    expect(buckets.mirror_two.has(theirs)).toBe(true);
  });
});

describe('user deletion — every configured pool vendor is a scope', () => {
  it('lists one replica scope per enabled vendor', async () => {
    const names = (await userStorageScopes(serverConfig, USER_A)).map((s) => s.name);
    expect(names).toContain('default');
    expect(names).toContain('privacy_export');
    expect(names).toContain('replica:s3');
    expect(names).toContain('replica:minio');
  });

  it('deletes and verifies users/<id>/... on the primary and both mirrors', async () => {
    const key = `users/${USER_A}/avatar/a.png`;
    seedPrimary(key);
    buckets.mirror_one.set(key, 'x');
    buckets.mirror_two.set(key, 'x');

    const scopes = await userStorageScopes(serverConfig, USER_A);
    const { outcome, state } = await drain(scopes, userScopePrefix(USER_A));

    expect(outcome.kind).toBe('advance');
    expect(primaryHas(key)).toBe(false);
    expect(buckets.mirror_one.has(key)).toBe(false);
    expect(buckets.mirror_two.has(key)).toBe(false);
    for (const name of ['replica:s3', 'replica:minio']) {
      expect(state[name].verified).toBe(true);
    }
  });

  it('cleans and verifies a RETIRED mirror for users/<id>/… too', async () => {
    const key = `users/${USER_A}/avatar/a.png`;
    seedPrimary(key);
    buckets.mirror_two.set(key, 'x');
    retire('minio');

    const scopes = await userStorageScopes(serverConfig, USER_A);
    const { outcome, state } = await drain(scopes, userScopePrefix(USER_A));

    expect(outcome.kind).toBe('advance');
    expect(buckets.mirror_two.has(key)).toBe(false);
    expect(state['replica:minio'].verified).toBe(true);
  });

  it('never touches another account, on any provider', async () => {
    const mine = `users/${USER_A}/avatar/a.png`;
    const theirs = `users/${USER_B}/avatar/b.png`;
    seedPrimary(mine);
    seedPrimary(theirs);
    for (const bucket of [buckets.mirror_one, buckets.mirror_two]) {
      bucket.set(mine, 'x');
      bucket.set(theirs, 'x');
    }

    const scopes = await userStorageScopes(serverConfig, USER_A);
    await drain(scopes, userScopePrefix(USER_A));

    expect(primaryHas(theirs)).toBe(true);
    expect(buckets.mirror_one.has(theirs)).toBe(true);
    expect(buckets.mirror_two.has(theirs)).toBe(true);
  });
});
