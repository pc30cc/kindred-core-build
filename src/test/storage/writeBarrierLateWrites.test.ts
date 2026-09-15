/**
 * Second corrective pass, P0 — the workspace-deletion write barrier must
 * cover EVERY workspace-owned producer, not just uploadForOwner(). Two
 * producers bypassed it entirely before this pass: privacy exports (their
 * own dedicated provider-policy resolver + uploadWithConfig, never
 * enforceOwnerScope or the deletion write lock) and LiveKit recordings
 * (Egress writes directly to recording_storage, never through this
 * module's upload handlers at all). Proves both are now blocked once a
 * workspace enters 'deleting', using the REAL
 * uploadWithConfigForOwner/isWorkspaceDeleting production code (not
 * mocked away) so this is a genuine regression test of the guard itself,
 * not just of call-site wiring.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const WS_DELETING = '11111111-1111-1111-1111-111111111111';
const WS_ACTIVE = '22222222-2222-2222-2222-222222222222';

const { workspaceStatusMock } = vi.hoisted(() => ({
  workspaceStatusMock: { current: 'active' as string },
}));

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      if (table === 'workspaces') {
        return {
          select: () => ({
            eq: (_col: string, _id: string) => ({
              maybeSingle: async () => ({ data: { status: workspaceStatusMock.current }, error: null }),
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
  workspaceStatusMock.current = 'active';
});

describe('privacy export write barrier (uploadWithConfigForOwner)', () => {
  it('allows a workspace-owned privacy artifact upload when the workspace is active', async () => {
    const { uploadWithConfigForOwner } = await import('../../../server/services/storage/index');
    workspaceStatusMock.current = 'active';

    const result = await uploadWithConfigForOwner(
      {} as never,
      { kind: 'workspace', workspaceId: WS_ACTIVE },
      { provider: 'local', localPath: '/tmp/write-barrier-test', publicUrl: 'http://local.test' },
      { fileKey: `workspace/${WS_ACTIVE}/exports/privacy/job-1.zip`, data: Buffer.from('zip-bytes'), contentType: 'application/zip' },
    );

    expect(result.success).toBe(true);
  });

  it('rejects a workspace-owned privacy artifact upload once the workspace is deleting — a late-arriving export can never orphan a new object after cleanup', async () => {
    const { uploadWithConfigForOwner } = await import('../../../server/services/storage/index');
    workspaceStatusMock.current = 'deleting';

    const result = await uploadWithConfigForOwner(
      {} as never,
      { kind: 'workspace', workspaceId: WS_DELETING },
      { provider: 'local', localPath: '/tmp/write-barrier-test', publicUrl: 'http://local.test' },
      { fileKey: `workspace/${WS_DELETING}/exports/privacy/job-2.zip`, data: Buffer.from('zip-bytes'), contentType: 'application/zip' },
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/being deleted/i);
  });

  it('never applies the workspace-deletion write lock to a user-owned (user-subject) privacy export — not workspace storage', async () => {
    const { uploadWithConfigForOwner } = await import('../../../server/services/storage/index');
    workspaceStatusMock.current = 'deleting'; // irrelevant to a user-owned export

    const result = await uploadWithConfigForOwner(
      {} as never,
      { kind: 'user', userId: '33333333-3333-3333-3333-333333333333' },
      { provider: 'local', localPath: '/tmp/write-barrier-test', publicUrl: 'http://local.test' },
      { fileKey: `users/33333333-3333-3333-3333-333333333333/exports/privacy/job-3.zip`, data: Buffer.from('zip-bytes'), contentType: 'application/zip' },
    );

    expect(result.success).toBe(true);
  });

  it('privacy/worker.ts processJob throws (job fails) end-to-end when the workspace enters deleting mid-flight', async () => {
    vi.doMock('../../../server/services/privacy/identity.js', () => ({
      resolveSubject: async () => ({ emails: [], names: [], ids: [] }),
    }));
    vi.doMock('../../../server/services/privacy/exporter.js', () => ({
      buildExportZip: async () => ({ buffer: Buffer.from('zip-bytes'), sha256: 'deadbeef', manifestSummary: {} }),
    }));
    vi.doMock('../../../server/services/privacy/storageResolver.js', () => ({
      resolvePrivacyStoragePolicy: async () => ({
        provider: 'local',
        config: { provider: 'local', localPath: '/tmp/write-barrier-test', publicUrl: 'http://local.test' },
        source: 'platform_default' as const,
        allowAttachmentFallback: false,
      }),
      PrivacyStorageNotConfigured: class PrivacyStorageNotConfigured extends Error {},
    }));
    vi.doMock('../../../server/services/privacy/audit.js', () => ({ writePrivacyAudit: async () => undefined }));

    workspaceStatusMock.current = 'deleting';
    const { processJob } = await import('../../../server/services/privacy/worker');

    const job = {
      id: '44444444-4444-4444-4444-444444444444', workspace_id: WS_DELETING, subject_id: 'contact-1', subject_type: 'contact',
      action: 'export', status: 'running', resolved_identity: null,
    } as never;

    await expect(processJob({} as never, job)).rejects.toThrow(/being deleted/i);

    vi.doUnmock('../../../server/services/privacy/identity.js');
    vi.doUnmock('../../../server/services/privacy/exporter.js');
    vi.doUnmock('../../../server/services/privacy/storageResolver.js');
    vi.doUnmock('../../../server/services/privacy/audit.js');
  });
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
    workspaceStatusMock.current = 'deleting';
    const { livekitProvider } = await import('../../../server/services/calls/providers/livekitProvider');

    await expect(
      livekitProvider.startRecording({} as never, 'room-1', {
        recordingType: 'composite', workspaceId: WS_DELETING, callSessionId: 'session-1',
      }),
    ).rejects.toThrow(/being deleted/i);

    // The guard must fire BEFORE ever reaching LiveKit config / Egress —
    // loadLiveKitConfig is called by the write-barrier check's caller path
    // is irrelevant here; the important assertion is that this never got
    // far enough to construct/send an Egress start request, which a
    // network mock absence already enforces (a fetch attempt would throw
    // ECONNREFUSED/undici errors, not the "being deleted" message above).
    vi.doUnmock('../../../server/services/calls/livekitConfig.js');
  });

  it('allows starting a recording when the workspace is active (guard is not a false positive)', async () => {
    vi.doMock('../../../server/services/calls/livekitConfig.js', () => ({
      loadLiveKitConfig: loadLiveKitConfigMock,
      isMinimallyConfigured: () => true,
    }));
    workspaceStatusMock.current = 'active';
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
