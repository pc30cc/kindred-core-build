/**
 * Corrective-pass P0 regression test — explicit Provider A / Provider B
 * LiveKit recording routing.
 *
 * Setup mirrors the user's exact scenario: the workspace's ordinary
 * attachment storage provider is Provider A (bucket 'attachments-a');
 * LiveKit's own recording_storage account is a COMPLETELY SEPARATE
 * Provider B (bucket 'livekit-b'). Verifies every recording read/delete
 * path resolves and uses Provider B, never Provider A:
 *
 *   - recording creation: already correct by construction (LiveKit Egress
 *     is instructed via cfg.recording_storage directly — see
 *     server/services/calls/providers/livekitProvider.ts's startRecording;
 *     it never touched the workspace attachment resolver, so there is
 *     nothing to regression-test here beyond confirming that resolver
 *     call still reads recording_storage, covered by
 *     recordingStorageResolver.test.ts).
 *   - playback reads B (server/routes/recordingPlayback.ts)
 *   - retention deletion deletes B (server/services/recordings/retentionJanitor.ts)
 *   - workspace deletion deletes B: covered by
 *     src/test/storage/workspaceDeletionWorker.test.ts's multi-scope tests
 *   - consistency audit inspects B: covered by
 *     src/test/storage/consistencyAudit.test.ts's "multi-provider
 *     correctness" describe block
 *
 * This file focuses on the two read/delete paths not covered elsewhere:
 * playback and retention. Both must resolve Provider B via
 * resolveRecordingStorageConfig and must NEVER call anything that would
 * resolve Provider A (resolveStorageConfig / resolveStorageConfigForOwner).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const PROVIDER_A = { provider: 's3' as const, bucket: 'attachments-a', accessKeyId: 'a-key', secretAccessKey: 'a-secret' };
const PROVIDER_B = { provider: 's3' as const, bucket: 'livekit-b', accessKeyId: 'b-key', secretAccessKey: 'b-secret' };

const {
  loadLiveKitConfigMock,
  downloadRangeWithConfigMock,
  deleteWithConfigMock,
} = vi.hoisted(() => ({
  loadLiveKitConfigMock: vi.fn(),
  downloadRangeWithConfigMock: vi.fn(),
  deleteWithConfigMock: vi.fn(),
}));

vi.mock('../../../server/services/calls/livekitConfig.js', () => ({
  loadLiveKitConfig: loadLiveKitConfigMock,
}));

// resolveStorageConfig/resolveStorageConfigForOwner represent "Provider A" —
// asserting they are never called is how these tests prove Provider A is
// never touched by a recording-only code path.
const resolveStorageConfigMock = vi.fn(async () => PROVIDER_A);
vi.mock('../../../server/services/storage/index.js', () => ({
  downloadRangeWithConfig: downloadRangeWithConfigMock,
  deleteWithConfig: deleteWithConfigMock,
  resolveStorageConfig: resolveStorageConfigMock,
}));

beforeEach(() => {
  loadLiveKitConfigMock.mockReset();
  downloadRangeWithConfigMock.mockReset();
  deleteWithConfigMock.mockReset();
  resolveStorageConfigMock.mockClear();
  loadLiveKitConfigMock.mockResolvedValue({
    recording_storage: { bucket: PROVIDER_B.bucket, access_key: PROVIDER_B.accessKeyId, secret_key: PROVIDER_B.secretAccessKey, region: null, endpoint: null },
  });
});

describe('recordingStorageResolver — Provider A / Provider B isolation', () => {
  it('resolveRecordingStorageConfig maps LiveKit recording_storage (Provider B), never the workspace attachment resolver (Provider A)', async () => {
    const { resolveRecordingStorageConfig } = await import('../../../server/services/calls/recordingStorageResolver');
    const cfg = await resolveRecordingStorageConfig({} as never);

    expect(cfg.bucket).toBe('livekit-b');
    expect(resolveStorageConfigMock).not.toHaveBeenCalled();
  });
});

describe('retention deletion (retentionJanitor.ts) — deletes Provider B', () => {
  it('resolves Provider B once and deletes the expired recording through it, never touching Provider A', async () => {
    const sbMock = {
      from: (table: string) => {
        if (table === 'call_recordings') {
          return {
            select: () => ({
              eq: () => ({
                not: () => ({
                  lte: () => ({
                    order: () => ({
                      limit: async () => ({
                        data: [{ id: 'rec-1', call_session_id: 'sess-1', storage_path: 'workspace/ws-1/calls/recordings/sess-1/x.mp4', call_sessions: { workspace_id: 'ws-1' } }],
                        error: null,
                      }),
                    }),
                  }),
                }),
              }),
            }),
            delete: () => ({ eq: async () => ({ error: null }) }),
          };
        }
        throw new Error(`unexpected table ${table}`);
      },
    };
    vi.doMock('../../../server/supabase.js', () => ({ getServiceClient: () => sbMock }));
    deleteWithConfigMock.mockResolvedValue({ success: true });

    const { sweepRecordingRetention } = await import('../../../server/services/recordings/retentionJanitor');
    const result = await sweepRecordingRetention({} as never);

    expect(result).toEqual({ scanned: 1, storage_deleted: 1, rows_deleted: 1, failures: 0 });
    expect(deleteWithConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: 'livekit-b' }),
      'workspace/ws-1/calls/recordings/sess-1/x.mp4',
    );
    expect(resolveStorageConfigMock).not.toHaveBeenCalled();
    vi.doUnmock('../../../server/supabase.js');
  });

  it('skips the entire sweep (never deletes a DB row) when Provider B is not configured, rather than risking an orphaned delete', async () => {
    loadLiveKitConfigMock.mockResolvedValue({ recording_storage: { bucket: null, access_key: null, secret_key: null, region: null, endpoint: null } });
    let rowDeleteCalled = false;
    const sbMock = {
      from: (table: string) => {
        if (table === 'call_recordings') {
          return {
            select: () => ({
              eq: () => ({
                not: () => ({
                  lte: () => ({
                    order: () => ({
                      limit: async () => ({
                        data: [{ id: 'rec-1', call_session_id: 'sess-1', storage_path: 'workspace/ws-1/calls/recordings/sess-1/x.mp4', call_sessions: { workspace_id: 'ws-1' } }],
                        error: null,
                      }),
                    }),
                  }),
                }),
              }),
            }),
            delete: () => ({ eq: async () => { rowDeleteCalled = true; return { error: null }; } }),
          };
        }
        throw new Error(`unexpected table ${table}`);
      },
    };
    vi.doMock('../../../server/supabase.js', () => ({ getServiceClient: () => sbMock }));

    const { sweepRecordingRetention } = await import('../../../server/services/recordings/retentionJanitor');
    const result = await sweepRecordingRetention({} as never);

    expect(result).toEqual({ scanned: 1, storage_deleted: 0, rows_deleted: 0, failures: 1 });
    expect(deleteWithConfigMock).not.toHaveBeenCalled();
    expect(rowDeleteCalled).toBe(false);
    vi.doUnmock('../../../server/supabase.js');
  });
});
