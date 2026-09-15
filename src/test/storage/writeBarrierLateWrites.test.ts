/**
 * Write barrier — every owner-scoped producer must be blocked from
 * writing once its owner (workspace or user) is no longer explicitly
 * writable, including the specific races an independent review found
 * across the second AND third corrective passes:
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
 *
 * Uses the REAL production uploadForOwner/uploadWithConfigForOwner/
 * isWorkspaceWritable/isUserWritable code (not mocked away) so this is a
 * genuine regression test of the guards themselves, not just of call-site
 * wiring.
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

const { workspaceFixtures, userFixtures } = vi.hoisted(() => ({
  workspaceFixtures: new Map<string, WorkspaceFixture>(),
  userFixtures: new Map<string, UserFixture>(),
}));

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
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
