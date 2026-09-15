/**
 * Privacy export expiry sweep — symmetric delete-side quota logging.
 *
 * server/services/privacy/worker.ts logs a storage_usage_logs 'upload' row
 * for workspace-owned export jobs (server/services/storage/categoryPolicy.ts's
 * 'privacy_export' entry). If the matching delete-side log were missing,
 * workspace_usage_counters.storage_bytes would only ever increase for
 * exports and never decrease — a permanent quota leak. This proves
 * purgeOne() (the TTL sweep's per-job purge, also reused by the
 * auto-purge-on-download path in server/routes/privacy.ts) logs the
 * matching 'delete' row, using privacy_jobs.artifact_size_bytes as the
 * freed-bytes figure, and only for workspace-owned jobs.
 */
import { describe, it, expect, vi } from 'vitest';
import { purgeOne, type ExpiredJobRow } from '../../../server/services/privacy/expirySweep';

const WS_A = '11111111-1111-1111-1111-111111111111';
const JOB_ID = '44444444-4444-4444-4444-444444444444';

const { resolvePrivacyStoragePolicyMock, deleteWithConfigMock } = vi.hoisted(() => ({
  resolvePrivacyStoragePolicyMock: vi.fn(async () => ({
    provider: 'local',
    config: { provider: 'local', localPath: '/tmp/storage', publicUrl: 'http://local.test' },
    source: 'platform_default' as const,
    allowAttachmentFallback: false,
  })),
  deleteWithConfigMock: vi.fn(async () => ({ success: true })),
}));

vi.mock('../../../server/services/privacy/storageResolver.js', () => ({
  resolvePrivacyStoragePolicy: resolvePrivacyStoragePolicyMock,
  PrivacyStorageNotConfigured: class PrivacyStorageNotConfigured extends Error {},
}));
vi.mock('../../../server/services/storage/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../../server/services/storage/index')>(
    '../../../server/services/storage/index',
  );
  return { ...actual, deleteWithConfig: deleteWithConfigMock };
});
vi.mock('../../../server/services/privacy/artifactStore.js', () => ({
  deleteLegacyArtifact: vi.fn(),
  legacyArtifactExists: vi.fn(() => false),
}));

const insertCalls: Array<{ table: string; row: Record<string, unknown> }> = [];
vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => {
        insertCalls.push({ table, row });
        return { data: null, error: null };
      },
    }),
  }),
}));

function baseJob(overrides: Partial<ExpiredJobRow>): ExpiredJobRow {
  return {
    id: JOB_ID,
    workspace_id: WS_A,
    actor_user_id: 'actor-1',
    artifact_storage_provider: 'local',
    artifact_storage_key: `workspace/${WS_A}/exports/privacy/${JOB_ID}.zip`,
    artifact_path: `workspace/${WS_A}/exports/privacy/${JOB_ID}.zip`,
    artifact_size_bytes: 12345,
    expires_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('purgeOne — symmetric delete-side storage_usage_logs write', () => {
  it('logs a delete row for a workspace-owned job using artifact_size_bytes as freed bytes', async () => {
    insertCalls.length = 0;
    const job = baseJob({});

    const result = await purgeOne({} as never, job);

    expect(result.ok).toBe(true);
    const usageInserts = insertCalls.filter((c) => c.table === 'storage_usage_logs');
    expect(usageInserts).toHaveLength(1);
    expect(usageInserts[0].row).toMatchObject({
      workspace_id: WS_A,
      operation: 'delete',
      file_key: job.artifact_storage_key,
      file_size: 12345,
      success: true,
    });
  });

  it('never logs for a user-owned job (workspace_id null) — nothing to attribute it to', async () => {
    insertCalls.length = 0;
    const job = baseJob({ workspace_id: null });

    const result = await purgeOne({} as never, job);

    expect(result.ok).toBe(true);
    expect(insertCalls.filter((c) => c.table === 'storage_usage_logs')).toHaveLength(0);
  });

  it('does not log when the underlying delete fails', async () => {
    insertCalls.length = 0;
    deleteWithConfigMock.mockResolvedValueOnce({ success: false, error: 'boom' } as unknown as { success: boolean });
    const job = baseJob({});

    const result = await purgeOne({} as never, job);

    expect(result.ok).toBe(false);
    expect(insertCalls.filter((c) => c.table === 'storage_usage_logs')).toHaveLength(0);
  });
});
