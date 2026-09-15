/**
 * Write barrier — every owner-scoped producer must be blocked from
 * writing once its owner (workspace or user) is no longer explicitly
 * writable, including the specific races an independent review found
 * across the second, third AND fourth corrective passes:
 *
 *   - Second pass: privacy exports (their own dedicated provider-policy
 *     resolver + uploadWithConfig) and LiveKit recordings (Egress writes
 *     directly to recording_storage) both bypassed the deletion write
 *     lock entirely.
 *   - Third pass: the write-lock check itself FAILED OPEN on a MISSING
 *     owner row — `isWorkspaceDeleting()` only rejected an explicit
 *     'deleting' status, so a producer reaching its write AFTER
 *     admin_delete_workspace()/admin_delete_user() had already
 *     hard-deleted the row would sail through ("no row -> not deleting ->
 *     allowed"), creating workspace/<alreadyDeletedId>/... or
 *     users/<alreadyDeletedId>/... AFTER deletion had fully completed —
 *     worse than a race DURING deletion. `isWorkspaceWritable()` and the
 *     new `isUserWritable()` now fail closed on every non-'active'/
 *     non-existent outcome, and there was previously no user-level
 *     barrier at all.
 *   - Fourth pass: even isWorkspaceWritable()/isUserWritable() were only a
 *     POINT-IN-TIME check — deletion could start in the gap between that
 *     check returning true and the producer's actual external write
 *     (S3 PUT, LiveKit Egress start) completing a moment later.
 *     uploadForOwner()/uploadWithConfigForOwner() now acquire a
 *     DB-backed owner_write_lease (writerLease.ts) BEFORE acting on a
 *     positive writability result and hold it for the entire write,
 *     releasing only once it has definitively completed — see the
 *     "delayed write" and "lease expiry" describe blocks below.
 *
 * Uses the REAL production uploadForOwner/uploadWithConfigForOwner/
 * isWorkspaceWritable/isUserWritable/withOwnerWriteLease/
 * hasActiveOwnerWriteLeases code (not mocked away) so this is a genuine
 * regression test of the guards themselves, not just of call-site wiring.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const WS_DELETING = '11111111-1111-1111-1111-111111111111';
const WS_ACTIVE = '22222222-2222-2222-2222-222222222222';
const WS_MISSING = '55555555-5555-5555-5555-555555555555';
const WS_ERROR = '66666666-6666-6666-6666-666666666666';
const USER_ACTIVE = '33333333-3333-3333-3333-333333333333';
const USER_DELETING = '77777777-7777-7777-7777-777777777777';
const USER_MISSING = '88888888-8888-8888-8888-888888888888';

interface WorkspaceFixture {
  status?: 'active' | 'deleting';
  missing?: boolean;
  errors?: boolean;
}
interface UserFixture {
  profileExists: boolean;
  activeDeletionJob: boolean;
}
interface LeaseRow {
  id: string;
  token: string;
  ownerKind: string;
  ownerId: string;
  expiresAtMs: number;
}

const { workspaceFixtures, userFixtures, activeLeases, rpcCallLog, renewShouldFail } = vi.hoisted(() => ({
  workspaceFixtures: new Map<string, WorkspaceFixture>(),
  userFixtures: new Map<string, UserFixture>(),
  activeLeases: [] as LeaseRow[],
  rpcCallLog: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  // Toggled by the "heartbeat renewals fail while the write is still
  // blocked" test to simulate a producer that lost DB connectivity —
  // renew_owner_write_lease then fails WITHOUT extending expiresAtMs,
  // exactly like a real transient DB error would.
  renewShouldFail: { current: false },
}));

let leaseCounter = 0;

/**
 * acquire_owner_write_lease/renew_owner_write_lease/release_owner_write_lease
 * (server/services/storage/writerLease.ts) — the fourth corrective pass's
 * RPC layer. acquire_owner_write_lease's writability check reuses the
 * SAME workspaceFixtures/userFixtures every other check in this file
 * uses, so every existing test's fixture setup keeps meaning what it
 * always meant. Real lease rows are tracked in `activeLeases` (an
 * in-memory stand-in for the owner_write_leases table) so
 * hasActiveOwnerWriteLeases()'s table read below reflects real
 * acquire/release lifecycle — this is what lets the "delayed write"
 * tests prove a lease is genuinely visible while held and gone once
 * released, using the real production functions on both sides.
 */
async function rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> {
  rpcCallLog.push({ fn, args });
  if (fn === 'acquire_owner_write_lease') {
    const ownerKind = args._owner_kind as string;
    const ownerId = args._owner_id as string;
    if (ownerKind === 'workspace') {
      const fx = workspaceFixtures.get(ownerId);
      if (!fx || fx.errors) return { data: { ok: false, error: fx?.errors ? 'workspace_lookup_failed' : 'workspace_not_found' }, error: null };
      if (fx.missing) return { data: { ok: false, error: 'workspace_not_found' }, error: null };
      if ((fx.status ?? 'active') !== 'active') return { data: { ok: false, error: 'workspace_not_writable', status: fx.status }, error: null };
    } else if (ownerKind === 'user') {
      const fx = userFixtures.get(ownerId);
      if (!fx?.profileExists) return { data: { ok: false, error: 'user_not_found' }, error: null };
      if (fx.activeDeletionJob) return { data: { ok: false, error: 'user_not_writable' }, error: null };
    } else {
      return { data: { ok: false, error: 'invalid_owner_kind' }, error: null };
    }
    leaseCounter += 1;
    const leaseSeconds = typeof args._lease_seconds === 'number' ? args._lease_seconds : 120;
    const lease: LeaseRow = { id: `lease-${leaseCounter}`, token: `token-${leaseCounter}`, ownerKind, ownerId, expiresAtMs: Date.now() + leaseSeconds * 1000 };
    activeLeases.push(lease);
    return { data: { ok: true, lease_id: lease.id, lease_token: lease.token, lease_expires_at: new Date(lease.expiresAtMs).toISOString() }, error: null };
  }
  if (fn === 'renew_owner_write_lease') {
    if (renewShouldFail.current) {
      // Simulates a transient DB failure at heartbeat time — the lease
      // row itself is untouched (no extension), exactly like a real
      // failed renew_owner_write_lease() RPC call would leave it.
      return { data: { ok: false, error: 'transient_db_failure' }, error: null };
    }
    // Fifth corrective pass, P0: mirrors 188's hardened
    // renew_owner_write_lease() — a renewal arriving after the lease's
    // OWN nominal expiry must never resurrect it.
    const lease = activeLeases.find((l) => l.id === args._lease_id && l.token === args._lease_token);
    if (!lease) return { data: { ok: false, error: 'lease_not_found' }, error: null };
    if (lease.expiresAtMs <= Date.now()) return { data: { ok: false, error: 'lease_expired' }, error: null };
    const leaseSeconds = typeof args._lease_seconds === 'number' ? args._lease_seconds : 120;
    lease.expiresAtMs = Date.now() + leaseSeconds * 1000;
    return { data: { ok: true, lease_expires_at: new Date(lease.expiresAtMs).toISOString() }, error: null };
  }
  if (fn === 'release_owner_write_lease') {
    const idx = activeLeases.findIndex((l) => l.id === args._lease_id && l.token === args._lease_token);
    if (idx >= 0) activeLeases.splice(idx, 1);
    return { data: { ok: true }, error: null };
  }
  if (fn === 'has_active_owner_write_leases') {
    // Fifth corrective pass, P0: mirrors 188's DB-time, grace-extended
    // has_active_owner_write_leases() — a lease keeps counting as active
    // until `expiresAtMs + graceSeconds`, not just `expiresAtMs`.
    const ownerKind = args._owner_kind as string;
    const ownerId = args._owner_id as string;
    const graceSeconds = typeof args._reconciliation_grace_seconds === 'number' ? args._reconciliation_grace_seconds : 600;
    const active = activeLeases.some((l) => l.ownerKind === ownerKind && l.ownerId === ownerId && l.expiresAtMs + graceSeconds * 1000 > Date.now());
    return { data: { ok: true, active }, error: null };
  }
  return { data: null, error: null };
}

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    rpc,
    from: (table: string) => {
      if (table === 'workspaces') {
        return {
          select: () => ({
            eq: (_col: string, id: string) => ({
              maybeSingle: async () => {
                const fx = workspaceFixtures.get(id);
                if (!fx || fx.errors) return { data: null, error: fx?.errors ? { message: 'db_error' } : null };
                if (fx.missing) return { data: null, error: null };
                return { data: { status: fx.status ?? 'active' }, error: null };
              },
            }),
          }),
        };
      }
      if (table === 'profiles') {
        return {
          select: () => ({
            eq: (_col: string, id: string) => ({
              maybeSingle: async () => {
                const fx = userFixtures.get(id);
                return { data: fx?.profileExists ? { id } : null, error: null };
              },
            }),
          }),
        };
      }
      if (table === 'user_deletion_jobs') {
        return {
          select: () => ({
            eq: (_col: string, id: string) => ({
              in: () => ({
                limit: () => ({
                  maybeSingle: async () => {
                    const fx = userFixtures.get(id);
                    return { data: fx?.activeDeletionJob ? { id: 'job-1' } : null, error: null };
                  },
                }),
              }),
            }),
          }),
        };
      }
      if (table === 'owner_write_leases') {
        // hasActiveOwnerWriteLeases()'s exact query shape:
        // .select('id').eq('owner_kind', k).eq('owner_id', id).gt('lease_expires_at', nowIso).limit(1).maybeSingle()
        return {
          select: () => ({
            eq: (_c1: string, ownerKind: string) => ({
              eq: (_c2: string, ownerId: string) => ({
                gt: (_c3: string, nowIso: string) => ({
                  limit: () => ({
                    maybeSingle: async () => {
                      const nowMs = new Date(nowIso).getTime();
                      const found = activeLeases.find((l) => l.ownerKind === ownerKind && l.ownerId === ownerId && l.expiresAtMs > nowMs);
                      return { data: found ? { id: found.id } : null, error: null };
                    },
                  }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === 'app_runtime_config') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { value: { provider_name: 'local', config: { local_path: '/tmp/write-barrier-test', public_url: 'http://local.test' } } },
                error: null,
              }),
            }),
          }),
        };
      }
      // Every other table (privacy_jobs updates, storage_usage_logs, etc.) —
      // harmless no-op chain so unrelated code paths don't throw.
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.update = () => chain;
      chain.insert = async () => ({ data: null, error: null });
      chain.maybeSingle = async () => ({ data: null, error: null });
      chain.then = (resolve: (v: { data: null; error: null }) => void) => resolve({ data: null, error: null });
      return chain;
    },
  }),
}));

beforeEach(() => {
  workspaceFixtures.clear();
  userFixtures.clear();
  activeLeases.length = 0;
  rpcCallLog.length = 0;
  renewShouldFail.current = false;
  workspaceFixtures.set(WS_ACTIVE, { status: 'active' });
  workspaceFixtures.set(WS_DELETING, { status: 'deleting' });
  workspaceFixtures.set(WS_MISSING, { missing: true });
  workspaceFixtures.set(WS_ERROR, { errors: true });
  userFixtures.set(USER_ACTIVE, { profileExists: true, activeDeletionJob: false });
  userFixtures.set(USER_DELETING, { profileExists: true, activeDeletionJob: true });
  userFixtures.set(USER_MISSING, { profileExists: false, activeDeletionJob: false });
});

const CFG = { provider: 'local' as const, localPath: '/tmp/write-barrier-test', publicUrl: 'http://local.test' };

describe('isWorkspaceWritable — fail-closed semantics', () => {
  it('active workspace -> writable', async () => {
    const { isWorkspaceWritable } = await import('../../../server/services/storage/index');
    expect(await isWorkspaceWritable({} as never, WS_ACTIVE)).toBe(true);
  });
  it('deleting workspace -> not writable', async () => {
    const { isWorkspaceWritable } = await import('../../../server/services/storage/index');
    expect(await isWorkspaceWritable({} as never, WS_DELETING)).toBe(false);
  });
  it('missing workspace row -> not writable (the exact bug this pass fixes — previously failed OPEN)', async () => {
    const { isWorkspaceWritable } = await import('../../../server/services/storage/index');
    expect(await isWorkspaceWritable({} as never, WS_MISSING)).toBe(false);
  });
  it('DB lookup error -> not writable', async () => {
    const { isWorkspaceWritable } = await import('../../../server/services/storage/index');
    expect(await isWorkspaceWritable({} as never, WS_ERROR)).toBe(false);
  });
});

describe('isUserWritable — fail-closed semantics', () => {
  it('active user, no deletion job -> writable', async () => {
    const { isUserWritable } = await import('../../../server/services/storage/index');
    expect(await isUserWritable({} as never, USER_ACTIVE)).toBe(true);
  });
  it('user with an active user_deletion_jobs row -> not writable', async () => {
    const { isUserWritable } = await import('../../../server/services/storage/index');
    expect(await isUserWritable({} as never, USER_DELETING)).toBe(false);
  });
  it('missing profile row -> not writable', async () => {
    const { isUserWritable } = await import('../../../server/services/storage/index');
    expect(await isUserWritable({} as never, USER_MISSING)).toBe(false);
  });
});

describe('privacy export write barrier (uploadWithConfigForOwner) — workspace-owned', () => {
  it('allows a workspace-owned privacy artifact upload when the workspace is active', async () => {
    const { uploadWithConfigForOwner } = await import('../../../server/services/storage/index');

    const result = await uploadWithConfigForOwner(
      {} as never, { kind: 'workspace', workspaceId: WS_ACTIVE }, CFG,
      { fileKey: `workspace/${WS_ACTIVE}/exports/privacy/job-1.zip`, data: Buffer.from('zip-bytes'), contentType: 'application/zip' },
    );

    expect(result.success).toBe(true);
  });

  it('rejects a workspace-owned privacy artifact upload once the workspace is deleting', async () => {
    const { uploadWithConfigForOwner } = await import('../../../server/services/storage/index');

    const result = await uploadWithConfigForOwner(
      {} as never, { kind: 'workspace', workspaceId: WS_DELETING }, CFG,
      { fileKey: `workspace/${WS_DELETING}/exports/privacy/job-2.zip`, data: Buffer.from('zip-bytes'), contentType: 'application/zip' },
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/being deleted/i);
  });

  it('MANDATORY: a privacy export that started before deletion and reaches upload AFTER the workspace row has been purged (admin_delete_workspace already ran) is rejected — no object is created', async () => {
    const { uploadWithConfigForOwner } = await import('../../../server/services/storage/index');
    // Simulates the exact race: by the time the upload call happens, the
    // workspace row is completely gone (hard-deleted by admin_delete_workspace,
    // db_cleanup's last step) — not merely 'deleting'.
    workspaceFixtures.set(WS_MISSING, { missing: true });

    const result = await uploadWithConfigForOwner(
      {} as never, { kind: 'workspace', workspaceId: WS_MISSING }, CFG,
      { fileKey: `workspace/${WS_MISSING}/exports/privacy/late-job.zip`, data: Buffer.from('zip-bytes'), contentType: 'application/zip' },
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/being deleted/i);
  });
});

describe('privacy export write barrier (uploadWithConfigForOwner) — user-owned', () => {
  it('allows a user-subject privacy export when the account is active', async () => {
    const { uploadWithConfigForOwner } = await import('../../../server/services/storage/index');

    const result = await uploadWithConfigForOwner(
      {} as never, { kind: 'user', userId: USER_ACTIVE }, CFG,
      { fileKey: `users/${USER_ACTIVE}/exports/privacy/job-3.zip`, data: Buffer.from('zip-bytes'), contentType: 'application/zip' },
    );

    expect(result.success).toBe(true);
  });

  it('rejects a user-subject privacy export once account deletion has begun (an active user_deletion_jobs row exists)', async () => {
    const { uploadWithConfigForOwner } = await import('../../../server/services/storage/index');

    const result = await uploadWithConfigForOwner(
      {} as never, { kind: 'user', userId: USER_DELETING }, CFG,
      { fileKey: `users/${USER_DELETING}/exports/privacy/job-4.zip`, data: Buffer.from('zip-bytes'), contentType: 'application/zip' },
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/being deleted/i);
  });

  it('MANDATORY: a user-subject export resumed AFTER the profile row has been purged (admin_delete_user already ran) is rejected', async () => {
    const { uploadWithConfigForOwner } = await import('../../../server/services/storage/index');
    userFixtures.set(USER_MISSING, { profileExists: false, activeDeletionJob: false });

    const result = await uploadWithConfigForOwner(
      {} as never, { kind: 'user', userId: USER_MISSING }, CFG,
      { fileKey: `users/${USER_MISSING}/exports/privacy/late-job.zip`, data: Buffer.from('zip-bytes'), contentType: 'application/zip' },
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/being deleted/i);
  });
});

describe('account avatar write barrier (uploadForOwner) — user-owned', () => {
  it('allows an avatar upload for an active user', async () => {
    const { uploadForOwner } = await import('../../../server/services/storage/index');

    const result = await uploadForOwner({} as never, {
      owner: { kind: 'user', userId: USER_ACTIVE },
      fileKey: `users/${USER_ACTIVE}/avatar/new.png`,
      data: Buffer.from('png-bytes'),
      contentType: 'image/png',
    });

    expect(result.success).toBe(true);
  });

  it('rejects an avatar upload once account deletion has begun', async () => {
    const { uploadForOwner } = await import('../../../server/services/storage/index');

    const result = await uploadForOwner({} as never, {
      owner: { kind: 'user', userId: USER_DELETING },
      fileKey: `users/${USER_DELETING}/avatar/new.png`,
      data: Buffer.from('png-bytes'),
      contentType: 'image/png',
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/being deleted/i);
  });
});

describe('processJob (server/services/privacy/worker.ts) end-to-end', () => {
  async function withProcessJobMocks<T>(fn: () => Promise<T>): Promise<T> {
    vi.doMock('../../../server/services/privacy/identity.js', () => ({
      resolveSubject: async () => ({ emails: [], names: [], ids: [] }),
    }));
    vi.doMock('../../../server/services/privacy/exporter.js', () => ({
      buildExportZip: async () => ({ buffer: Buffer.from('zip-bytes'), sha256: 'deadbeef', manifestSummary: {} }),
    }));
    vi.doMock('../../../server/services/privacy/storageResolver.js', () => ({
      resolvePrivacyStoragePolicy: async () => ({
        provider: 'local', config: CFG, source: 'platform_default' as const, allowAttachmentFallback: false,
      }),
      PrivacyStorageNotConfigured: class PrivacyStorageNotConfigured extends Error {},
    }));
    vi.doMock('../../../server/services/privacy/audit.js', () => ({ writePrivacyAudit: async () => undefined }));
    try {
      return await fn();
    } finally {
      vi.doUnmock('../../../server/services/privacy/identity.js');
      vi.doUnmock('../../../server/services/privacy/exporter.js');
      vi.doUnmock('../../../server/services/privacy/storageResolver.js');
      vi.doUnmock('../../../server/services/privacy/audit.js');
    }
  }

  it('throws end-to-end when the workspace enters deleting mid-flight', async () =>
    withProcessJobMocks(async () => {
      const { processJob } = await import('../../../server/services/privacy/worker');
      const job = {
        id: '44444444-4444-4444-4444-444444444444', workspace_id: WS_DELETING, subject_id: 'contact-1', subject_type: 'contact',
        action: 'export', status: 'running', resolved_identity: null,
      } as never;

      await expect(processJob({} as never, job)).rejects.toThrow(/being deleted/i);
    }));

  it('MANDATORY: throws end-to-end when the workspace row has been fully purged by the time the upload is reached (privacy worker resumes after admin_delete_workspace already ran)', async () =>
    withProcessJobMocks(async () => {
      const { processJob } = await import('../../../server/services/privacy/worker');
      // The workspace no longer even has a row — a stronger case than
      // 'deleting', proving isWorkspaceWritable's missing-row handling
      // (not just its explicit-status handling) reaches this call site.
      workspaceFixtures.set(WS_MISSING, { missing: true });
      const job = {
        id: '99999999-9999-9999-9999-999999999999', workspace_id: WS_MISSING, subject_id: 'contact-1', subject_type: 'contact',
        action: 'export', status: 'running', resolved_identity: null,
      } as never;

      await expect(processJob({} as never, job)).rejects.toThrow(/being deleted/i);
    }));
});

describe('LiveKit recording-start write barrier', () => {
  const { loadLiveKitConfigMock } = vi.hoisted(() => ({ loadLiveKitConfigMock: vi.fn() }));

  beforeEach(() => {
    loadLiveKitConfigMock.mockReset();
    loadLiveKitConfigMock.mockResolvedValue({
      egress_enabled: true,
      recording_storage: { bucket: 'recordings', access_key: 'AKIA', secret_key: 'secret', region: null, endpoint: null },
      egress_url: null,
    });
  });

  it('rejects starting a recording once the workspace is deleting — LiveKit Egress must never write a new object', async () => {
    vi.doMock('../../../server/services/calls/livekitConfig.js', () => ({
      loadLiveKitConfig: loadLiveKitConfigMock,
      isMinimallyConfigured: () => true,
    }));
    const { livekitProvider } = await import('../../../server/services/calls/providers/livekitProvider');

    await expect(
      livekitProvider.startRecording({} as never, 'room-1', {
        recordingType: 'composite', workspaceId: WS_DELETING, callSessionId: 'session-1',
      }),
    ).rejects.toThrow(/being deleted/i);

    vi.doUnmock('../../../server/services/calls/livekitConfig.js');
  });

  it('allows starting a recording when the workspace is active (guard is not a false positive)', async () => {
    vi.doMock('../../../server/services/calls/livekitConfig.js', () => ({
      loadLiveKitConfig: loadLiveKitConfigMock,
      isMinimallyConfigured: () => true,
    }));
    const { livekitProvider } = await import('../../../server/services/calls/providers/livekitProvider');

    // resolveLk() will still fail past the guard (no real LiveKit
    // endpoint mocked) — the point of this test is ONLY that it gets PAST
    // the deletion guard without the "being deleted" rejection; a
    // downstream config/network error is a different, unrelated failure.
    await expect(
      livekitProvider.startRecording({} as never, 'room-1', {
        recordingType: 'composite', workspaceId: WS_ACTIVE, callSessionId: 'session-1',
      }),
    ).rejects.not.toThrow(/being deleted/i);

    vi.doUnmock('../../../server/services/calls/livekitConfig.js');
  });
});

/**
 * Fourth corrective pass, P0 — closing the TOCTOU gap a point-in-time
 * isWorkspaceWritable()/isUserWritable() check leaves open:
 * uploadForOwner()/uploadWithConfigForOwner() now hold a DB-backed
 * owner_write_lease for the entire duration of a write, not just check
 * writability before it. These tests drive withOwnerWriteLease() and
 * hasActiveOwnerWriteLeases() directly — the exact reusable mechanism
 * both upload functions delegate to unmocked — with an artificially
 * blocked write, and prove:
 *   1. the lease is invisible before acquisition
 *   2. the lease is VISIBLE (hasActiveOwnerWriteLeases -> true) for the
 *      entire time the write is blocked — this is precisely what a
 *      deletion worker mid-tick would see and correctly wait on, whether
 *      the write is a workspace upload, a workspace privacy export, a
 *      user avatar upload, or a user privacy export (all four funnel
 *      through this same wrapper)
 *   3. the lease disappears (hasActiveOwnerWriteLeases -> false) only
 *      once the write actually completes and the wrapper's `finally`
 *      releases it
 * The local storage provider's write call itself is synchronous
 * (fs.writeFileSync), so there is no natural async "mid-flight" window to
 * observe through a real end-to-end uploadForOwner() call in this test
 * environment — but every provider (including a real, genuinely
 * asynchronous S3/Bunny PUT) goes through this exact wrapper identically,
 * so proving the wrapper holds the lease across an arbitrarily slow `fn`
 * proves the real race is closed for all of them.
 */
describe('delayed-write race — the lease is held for the FULL duration of the write, not just checked before it', () => {
  it('workspace-owned write (uploadForOwner\'s "upload" purpose): lease is visible while the write is blocked, gone once it completes', async () => {
    const { withOwnerWriteLease, hasActiveOwnerWriteLeases } = await import('../../../server/services/storage/writerLease');

    expect(await hasActiveOwnerWriteLeases({} as never, 'workspace', WS_ACTIVE)).toBe(false);

    let finishWrite!: () => void;
    const blockedWrite = new Promise<void>((resolve) => { finishWrite = resolve; });
    const call = withOwnerWriteLease({} as never, 'workspace', WS_ACTIVE, 'upload', async () => { await blockedWrite; return 'ok'; });

    await new Promise((r) => setImmediate(r)); // let acquisition settle
    expect(await hasActiveOwnerWriteLeases({} as never, 'workspace', WS_ACTIVE)).toBe(true);

    finishWrite();
    const result = await call;
    expect(result).toEqual({ ok: true, result: 'ok' });
    expect(await hasActiveOwnerWriteLeases({} as never, 'workspace', WS_ACTIVE)).toBe(false);
  });

  it('workspace-owned privacy export (uploadWithConfigForOwner\'s "upload_with_config" purpose): same hold-through-completion guarantee', async () => {
    const { withOwnerWriteLease, hasActiveOwnerWriteLeases } = await import('../../../server/services/storage/writerLease');

    let finishWrite!: () => void;
    const blockedWrite = new Promise<void>((resolve) => { finishWrite = resolve; });
    const call = withOwnerWriteLease({} as never, 'workspace', WS_ACTIVE, 'upload_with_config', async () => { await blockedWrite; });

    await new Promise((r) => setImmediate(r));
    expect(await hasActiveOwnerWriteLeases({} as never, 'workspace', WS_ACTIVE)).toBe(true);

    finishWrite();
    await call;
    expect(await hasActiveOwnerWriteLeases({} as never, 'workspace', WS_ACTIVE)).toBe(false);
  });

  it('user-owned write (account avatar, uploadForOwner\'s "upload" purpose): same hold-through-completion guarantee', async () => {
    const { withOwnerWriteLease, hasActiveOwnerWriteLeases } = await import('../../../server/services/storage/writerLease');

    let finishWrite!: () => void;
    const blockedWrite = new Promise<void>((resolve) => { finishWrite = resolve; });
    const call = withOwnerWriteLease({} as never, 'user', USER_ACTIVE, 'upload', async () => { await blockedWrite; });

    await new Promise((r) => setImmediate(r));
    expect(await hasActiveOwnerWriteLeases({} as never, 'user', USER_ACTIVE)).toBe(true);

    finishWrite();
    await call;
    expect(await hasActiveOwnerWriteLeases({} as never, 'user', USER_ACTIVE)).toBe(false);
  });

  it('user-owned privacy export (uploadWithConfigForOwner\'s "upload_with_config" purpose): same hold-through-completion guarantee', async () => {
    const { withOwnerWriteLease, hasActiveOwnerWriteLeases } = await import('../../../server/services/storage/writerLease');

    let finishWrite!: () => void;
    const blockedWrite = new Promise<void>((resolve) => { finishWrite = resolve; });
    const call = withOwnerWriteLease({} as never, 'user', USER_ACTIVE, 'upload_with_config', async () => { await blockedWrite; });

    await new Promise((r) => setImmediate(r));
    expect(await hasActiveOwnerWriteLeases({} as never, 'user', USER_ACTIVE)).toBe(true);

    finishWrite();
    await call;
    expect(await hasActiveOwnerWriteLeases({} as never, 'user', USER_ACTIVE)).toBe(false);
  });

  it('MANDATORY (sixth corrective pass, P0): a write that THROWS does NOT release its lease — the outcome is ambiguous (the external write may have already landed on the provider despite the client-side error/timeout), so the lease is left outstanding for natural expiry+grace rather than deleted immediately', async () => {
    const { withOwnerWriteLease, hasActiveOwnerWriteLeases } = await import('../../../server/services/storage/writerLease');

    // withOwnerWriteLease() doesn't swallow fn()'s rejection (its caller,
    // e.g. uploadForOwner's own try/catch around the provider handler,
    // is what turns that into a StorageResult) — but it must NOT release
    // the lease in that case. Sixth corrective pass: the fifth pass's
    // fix only downgraded a RESOLVED-but-lease-lost outcome; a THROWN
    // fn() (e.g. PROVIDER_UPLOAD_TIMEOUT_MS's AbortController firing) was
    // still released unconditionally in the old `finally`, destroying
    // the reconciliation evidence deletion depends on for exactly the
    // ambiguous case a client-side timeout represents.
    await expect(
      withOwnerWriteLease({} as never, 'workspace', WS_ACTIVE, 'upload', async () => { throw new Error('provider_put_failed'); }),
    ).rejects.toThrow('provider_put_failed');
    expect(await hasActiveOwnerWriteLeases({} as never, 'workspace', WS_ACTIVE)).toBe(true);
  });

  it('a write that RESOLVES successfully, with the lease provably held throughout, DOES cleanly release its lease immediately — the normal case is not made unnecessarily conservative', async () => {
    const { withOwnerWriteLease, hasActiveOwnerWriteLeases } = await import('../../../server/services/storage/writerLease');

    const outcome = await withOwnerWriteLease({} as never, 'workspace', WS_ACTIVE, 'upload', async () => 'ok');

    expect(outcome).toEqual({ ok: true, result: 'ok' });
    expect(await hasActiveOwnerWriteLeases({} as never, 'workspace', WS_ACTIVE)).toBe(false);
  });

  it('MANDATORY: heartbeat DB calls begin failing while the external write is still blocked/running and the lease\'s nominal expiration passes — deletion (hasActiveOwnerWriteLeases) MUST NOT report clear at any point, and the write is reported as unsafe once it finally resolves', async () => {
    const { withOwnerWriteLease, hasActiveOwnerWriteLeases } = await import('../../../server/services/storage/writerLease');

    vi.useFakeTimers();
    try {
      let finishWrite!: () => void;
      const blockedWrite = new Promise<void>((resolve) => { finishWrite = resolve; });
      const call = withOwnerWriteLease({} as never, 'workspace', WS_ACTIVE, 'upload', async () => { await blockedWrite; return 'landed'; });
      await vi.advanceTimersByTimeAsync(0); // let acquisition settle

      // Deletion would find this lease outstanding right now.
      expect(await hasActiveOwnerWriteLeases({} as never, 'workspace', WS_ACTIVE)).toBe(true);

      // DB connectivity is lost — every heartbeat renewal from here on
      // fails, but the external provider PUT (the still-blocked `fn`
      // above) keeps running regardless; it has no idea the lease is in
      // trouble.
      renewShouldFail.current = true;

      // Advance well past the lease's nominal 120s TTL (four missed
      // 30s heartbeats) — the write is STILL running the whole time.
      await vi.advanceTimersByTimeAsync(130_000);

      // The lease is now past its nominal expiry with zero successful
      // renewals — but deletion must STILL see it as blocking, because
      // 130s is nowhere near the 600s reconciliation grace period.
      expect(await hasActiveOwnerWriteLeases({} as never, 'workspace', WS_ACTIVE)).toBe(true);

      // The write finally completes.
      finishWrite();
      const result = await call;

      // A producer that lost its lease mid-write must never report
      // success, even though `fn` itself resolved normally — it cannot
      // prove the write was safe to trust.
      expect(result).toEqual(expect.objectContaining({ ok: false, error: 'lease_lost_during_write' }));

      // Sixth corrective pass, P0: the fifth pass's test stopped here —
      // it never proved deletion stays blocked AFTER withOwnerWriteLease()
      // returns. The old `finally` released (deleted) the lease row
      // unconditionally, which would make this assertion fail: deletion
      // would see zero active leases the instant the function returned,
      // even though the write's outcome was never provably safe.
      expect(await hasActiveOwnerWriteLeases({} as never, 'workspace', WS_ACTIVE)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('MANDATORY (sixth corrective pass, P0): full composed scenario — lease acquired, heartbeat fails, external write stays unresolved past nominal TTL, the write finally THROWS ambiguously, withOwnerWriteLease() exits, DB connectivity recovers — the stale reconciliation intent MUST still exist and hasActiveOwnerWriteLeases() MUST remain true for the full grace window, only clearing once nominal expiry + RECONCILIATION_GRACE_SECONDS has genuinely elapsed. Proven for BOTH workspace and user owner kinds.', async () => {
    const { withOwnerWriteLease, hasActiveOwnerWriteLeases } = await import('../../../server/services/storage/writerLease');

    for (const ownerKind of ['workspace', 'user'] as const) {
      const ownerId = ownerKind === 'workspace' ? WS_ACTIVE : USER_ACTIVE;
      activeLeases.length = 0; // isolate each owner kind's pass
      renewShouldFail.current = false;

      vi.useFakeTimers();
      try {
        // 1. lease acquired; 2. "deletion starts" (modeled by polling
        // hasActiveOwnerWriteLeases throughout, exactly as a deletion
        // worker's tick loop would).
        let finishWrite!: (() => void) | ((err: Error) => void);
        const blockedWrite = new Promise<void>((_resolve, reject) => { finishWrite = reject; });
        const call = withOwnerWriteLease({} as never, ownerKind, ownerId, 'upload', async () => { await blockedWrite; });
        await vi.advanceTimersByTimeAsync(0);
        expect(await hasActiveOwnerWriteLeases({} as never, ownerKind, ownerId)).toBe(true);

        // 3. heartbeat DB calls begin failing.
        renewShouldFail.current = true;

        // 4. external write remains unresolved; 5. nominal TTL (120s)
        // passes with zero successful renewals.
        await vi.advanceTimersByTimeAsync(130_000);
        expect(await hasActiveOwnerWriteLeases({} as never, ownerKind, ownerId)).toBe(true);

        // 6. the write finally settles AMBIGUOUSLY — a throw, not a
        // clean resolve (e.g. the provider call's own hard timeout
        // firing without proof the remote side never received it).
        (finishWrite as (err: Error) => void)(new Error('provider_call_timed_out'));
        // 7. withOwnerWriteLease() exits.
        await expect(call).rejects.toThrow('provider_call_timed_out');

        // 8. DB connectivity is healthy again from this point on.
        renewShouldFail.current = false;

        // 9/10. the stale reconciliation intent MUST still exist —
        // hasActiveOwnerWriteLeases() MUST remain true — immediately
        // after exit, and MUST keep remaining true throughout the
        // reconciliation grace window (600s past nominal expiry), even
        // though DB connectivity has recovered and nothing is renewing
        // it further (it was never released, so nothing needs to).
        expect(await hasActiveOwnerWriteLeases({} as never, ownerKind, ownerId)).toBe(true);
        await vi.advanceTimersByTimeAsync(500_000); // well within the 600s grace, past the 130s already elapsed
        // 11. deletion cannot verify/purge during that window.
        expect(await hasActiveOwnerWriteLeases({} as never, ownerKind, ownerId)).toBe(true);

        // 12. only once nominal expiry + the full grace period has
        // genuinely elapsed does the stale intent stop blocking — at
        // that point a fresh storage listing is guaranteed to reflect
        // reality (PROVIDER_UPLOAD_TIMEOUT_MS bounds how long the
        // ambiguous write could still have been in flight; the grace
        // period is provably longer — see writerLease.ts's own doc
        // comment), so a subsequent full cleanup pass is safe to trust.
        await vi.advanceTimersByTimeAsync(200_000); // total elapsed: 130s + 500s + 200s = 830s > 120s TTL + 600s grace
        // 13. only then would purge be safe to run.
        expect(await hasActiveOwnerWriteLeases({} as never, ownerKind, ownerId)).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    }
  });
});

describe('lease expiry — a crashed producer never wedges deletion forever, but an expired lease is not IMMEDIATELY proof-of-safety either', () => {
  it('MANDATORY: a lease that JUST passed its nominal expiry (crashed producer, heartbeat stopped) still counts as active — an expired-but-recent lease must not be treated as proof the external write has stopped', async () => {
    const { hasActiveOwnerWriteLeases } = await import('../../../server/services/storage/writerLease');

    // Simulate a process that acquired a lease and then lost DB
    // connectivity (heartbeat renewals stopped) or crashed before its
    // `finally` ever ran — the row is never released, and its nominal
    // expiry has JUST passed. The external S3/Bunny PUT it was covering
    // is entirely independent of this lease's DB bookkeeping and could
    // still be landing bytes right now — fifth corrective pass, P0.
    activeLeases.push({ id: 'crashed-lease', token: 'tok', ownerKind: 'workspace', ownerId: WS_ACTIVE, expiresAtMs: Date.now() - 1_000 });

    // A deletion worker checking now must STILL wait — nominal expiry
    // alone proves nothing about whether the write actually stopped.
    expect(await hasActiveOwnerWriteLeases({} as never, 'workspace', WS_ACTIVE)).toBe(true);
  });

  it('a lease expired well beyond the reconciliation grace period (600s) — long enough that the write it covered is GUARANTEED to have completed or been aborted by its own hard timeout — finally stops counting as active', async () => {
    const { hasActiveOwnerWriteLeases } = await import('../../../server/services/storage/writerLease');

    activeLeases.push({ id: 'long-dead-lease', token: 'tok', ownerKind: 'workspace', ownerId: WS_ACTIVE, expiresAtMs: Date.now() - 700_000 });

    expect(await hasActiveOwnerWriteLeases({} as never, 'workspace', WS_ACTIVE)).toBe(false);
  });

  it('an unexpired lease still counts as active even if it will never be renewed again (no assumption about future renewal)', async () => {
    const { hasActiveOwnerWriteLeases } = await import('../../../server/services/storage/writerLease');

    activeLeases.push({ id: 'about-to-expire', token: 'tok', ownerKind: 'user', ownerId: USER_ACTIVE, expiresAtMs: Date.now() + 5_000 });

    expect(await hasActiveOwnerWriteLeases({} as never, 'user', USER_ACTIVE)).toBe(true);
  });

  it('MANDATORY: a delayed renewal call arriving AFTER the lease has already expired cannot resurrect it', async () => {
    const { renewOwnerWriteLease } = await import('../../../server/services/storage/writerLease');

    activeLeases.push({ id: 'delayed-renew', token: 'tok', ownerKind: 'workspace', ownerId: WS_ACTIVE, expiresAtMs: Date.now() - 500 });

    const renewed = await renewOwnerWriteLease({} as never, 'delayed-renew', 'tok', 120);

    expect(renewed).toBe(false);
    // Not just a false return — the row itself must still show the
    // ORIGINAL (past) expiry, never a fresh extension.
    const row = activeLeases.find((l) => l.id === 'delayed-renew')!;
    expect(row.expiresAtMs).toBeLessThan(Date.now());
  });

  it('MANDATORY: the active-lease safety decision is made entirely by the DB — the client never sends an app-computed timestamp for has_active_owner_write_leases to compare against', async () => {
    const { hasActiveOwnerWriteLeases } = await import('../../../server/services/storage/writerLease');

    await hasActiveOwnerWriteLeases({} as never, 'workspace', WS_ACTIVE);

    const call = rpcCallLog.find((c) => c.fn === 'has_active_owner_write_leases');
    expect(call).toBeTruthy();
    // Only owner identity and a plain, pre-agreed grace-period NUMBER
    // (not a "now" timestamp) ever leave the app server for this
    // decision — an app-server/Postgres clock skew (however large) has
    // nothing to act on, because the app never asserts what time it is;
    // 188_owner_write_lease_hardening.sql's has_active_owner_write_leases()
    // computes `now()` entirely inside Postgres.
    expect(Object.keys(call!.args).sort()).toEqual(['_owner_id', '_owner_kind', '_reconciliation_grace_seconds']);
    expect(typeof call!.args._reconciliation_grace_seconds).toBe('number');
  });

  it('an application clock skewed 5 minutes ahead of (or behind) real time cannot change the lease-safety result — Date.now() on the app server is faked, but the RPC args sent (and therefore the DB-side result) are provably unaffected', async () => {
    activeLeases.push({ id: 'skew-test', token: 'tok', ownerKind: 'workspace', ownerId: WS_ACTIVE, expiresAtMs: Date.now() - 700_000 });
    const { hasActiveOwnerWriteLeases } = await import('../../../server/services/storage/writerLease');

    // Faking the app server's clock must not change what's sent to the
    // DB (still just owner identity + a fixed grace-second count, per the
    // test above) — proving the app-side result can only diverge from
    // the DB's real answer if the MOCK itself is buggy enough to also
    // evaluate Date.now() at call time (this in-process mock does, purely
    // as a stand-in for Postgres's `now()` — a real Postgres backend has
    // its own independent clock entirely, already exercised live for
    // 188_owner_write_lease_hardening.sql in this pass).
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 5 * 60_000);
      await hasActiveOwnerWriteLeases({} as never, 'workspace', WS_ACTIVE);
      vi.setSystemTime(Date.now() - 10 * 60_000);
      await hasActiveOwnerWriteLeases({} as never, 'workspace', WS_ACTIVE);
    } finally {
      vi.useRealTimers();
    }
    const calls = rpcCallLog.filter((c) => c.fn === 'has_active_owner_write_leases');
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(Object.keys(c.args).sort()).toEqual(['_owner_id', '_owner_kind', '_reconciliation_grace_seconds']);
    }
  });
});

/**
 * Fourth corrective pass, P0 — livekitProvider.ts's startRecording() must
 * hold its workspace write lease through BOTH the StartRoomCompositeEgress
 * call AND the caller's durable persistence (`onStarted`), releasing only
 * after — never the instant the Egress call itself returns. A deletion
 * worker checking mid-flight must see the lease is still outstanding.
 */
describe('LiveKit recording-start write lease (fourth corrective pass, P0 — TOCTOU close)', () => {
  const { leaseLoadLiveKitConfigMock, leaseTwirpMock } = vi.hoisted(() => ({
    leaseLoadLiveKitConfigMock: vi.fn(),
    leaseTwirpMock: vi.fn(),
  }));

  beforeEach(() => {
    leaseLoadLiveKitConfigMock.mockReset();
    leaseLoadLiveKitConfigMock.mockResolvedValue({
      egress_enabled: true,
      recording_storage: { bucket: 'recordings', access_key: 'AKIA', secret_key: 'secret', region: null, endpoint: null },
      egress_url: null,
      rtc_url: 'https://lk.example.test',
      api_key: 'key',
      api_secret: 'secret',
    });
    leaseTwirpMock.mockReset();
  });

  async function withLivekitMocks<T>(fn: () => Promise<T>): Promise<T> {
    // The earlier 'LiveKit recording-start write barrier' describe block
    // above already dynamically imported livekitProvider.ts against ITS
    // OWN doMock of livekitConfig.js. Vitest's module registry caches that
    // evaluated instance, so a later vi.doMock() of the same specifier in
    // THIS describe block would silently be ignored without a hard reset
    // — resetModules() forces livekitProvider.ts (and everything it
    // imports) to be re-evaluated fresh against the mocks registered here.
    vi.resetModules();
    vi.doMock('../../../server/services/calls/livekitConfig.js', () => ({
      loadLiveKitConfig: leaseLoadLiveKitConfigMock,
      isMinimallyConfigured: () => true,
    }));
    vi.doMock('../../../server/services/calls/livekitTwirp.js', () => ({
      twirp: leaseTwirpMock,
      mintParticipantToken: vi.fn(),
      LiveKitTwirpError: class LiveKitTwirpError extends Error {
        code: string;
        constructor(code: string, message: string) { super(message); this.code = code; }
      },
    }));
    try {
      return await fn();
    } finally {
      vi.doUnmock('../../../server/services/calls/livekitConfig.js');
      vi.doUnmock('../../../server/services/calls/livekitTwirp.js');
    }
  }

  it('holds the write lease through StartRoomCompositeEgress AND onStarted persistence — a check mid-flight sees the outstanding lease, releases only after persistence completes', async () =>
    withLivekitMocks(async () => {
      const { livekitProvider } = await import('../../../server/services/calls/providers/livekitProvider');
      const { hasActiveOwnerWriteLeases } = await import('../../../server/services/storage/writerLease');
      leaseTwirpMock.mockResolvedValueOnce({ egress_id: 'egr-1', status: 'EGRESS_ACTIVE' });

      let releasePersist!: () => void;
      const persistBlocked = new Promise<void>((resolve) => { releasePersist = resolve; });
      const startPromise = livekitProvider.startRecording({} as never, 'room-1', {
        recordingType: 'composite', workspaceId: WS_ACTIVE, callSessionId: '99999999-aaaa-bbbb-cccc-dddddddddddd',
        onStarted: async () => { await persistBlocked; },
      });

      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r)); // twirp + onStarted invocation are both microtask hops
      expect(await hasActiveOwnerWriteLeases({} as never, 'workspace', WS_ACTIVE)).toBe(true);

      releasePersist();
      const handle = await startPromise;
      expect(handle.recordingId).toBe('egr-1');
      expect(await hasActiveOwnerWriteLeases({} as never, 'workspace', WS_ACTIVE)).toBe(false);
    }));

  it('compensates with a StopEgress call when onStarted (durable persistence) throws, then releases the lease once compensation succeeds', async () =>
    withLivekitMocks(async () => {
      const { livekitProvider } = await import('../../../server/services/calls/providers/livekitProvider');
      const { hasActiveOwnerWriteLeases } = await import('../../../server/services/storage/writerLease');
      leaseTwirpMock.mockResolvedValueOnce({ egress_id: 'egr-2', status: 'EGRESS_ACTIVE' }); // StartRoomCompositeEgress
      leaseTwirpMock.mockResolvedValueOnce({}); // StopEgress

      await expect(livekitProvider.startRecording({} as never, 'room-1', {
        recordingType: 'composite', workspaceId: WS_ACTIVE, callSessionId: '99999999-aaaa-bbbb-cccc-dddddddddddd',
        onStarted: async () => { throw new Error('db_write_failed'); },
      })).rejects.toThrow(/could not be durably recorded/);

      expect(leaseTwirpMock).toHaveBeenCalledTimes(2); // Start, then the compensating Stop
      expect(await hasActiveOwnerWriteLeases({} as never, 'workspace', WS_ACTIVE)).toBe(false);
    }));

  it('retains the write lease (never releases it) when BOTH persistence AND the compensating stop fail — deletion keeps waiting rather than ever trust storage', async () =>
    withLivekitMocks(async () => {
      const { livekitProvider } = await import('../../../server/services/calls/providers/livekitProvider');
      const { hasActiveOwnerWriteLeases } = await import('../../../server/services/storage/writerLease');
      leaseTwirpMock.mockResolvedValueOnce({ egress_id: 'egr-3', status: 'EGRESS_ACTIVE' }); // Start
      leaseTwirpMock.mockRejectedValueOnce(new Error('stop_network_error')); // Stop fails

      await expect(livekitProvider.startRecording({} as never, 'room-1', {
        recordingType: 'composite', workspaceId: WS_ACTIVE, callSessionId: '99999999-aaaa-bbbb-cccc-dddddddddddd',
        onStarted: async () => { throw new Error('db_write_failed'); },
      })).rejects.toThrow(/write lease held until expiry/);

      // Still held — never released on a failed compensation. It will
      // only stop counting once it naturally expires (see the "lease
      // expiry" describe block above).
      expect(await hasActiveOwnerWriteLeases({} as never, 'workspace', WS_ACTIVE)).toBe(true);
    }));
});
