/**
 * Privacy export storage ownership — server/services/privacy/worker.ts.
 *
 * Proves the migration described in docs/STORAGE_ARCHITECTURE_AUDIT.md
 * §10: export artifacts are written under the canonical
 * workspace/<id>/exports/privacy/<jobId>.zip for workspace-scoped jobs
 * (contact/visitor) or users/<id>/exports/privacy/<jobId>.zip for
 * user-subject jobs (which never carry a workspace_id) — never the old
 * privacy-exports/<id|_self>/<jobId>.zip root, and never with a fake
 * sentinel workspaceId passed to the storage layer. The dedicated
 * privacy-export provider policy (workspace override → platform default →
 * optional attachment fallback) is untouched.
 */
import { describe, it, expect, vi } from 'vitest';
import { ownerForJob, processJob } from '../../../server/services/privacy/worker';
import type { PrivacyJobRow } from '../../../server/services/privacy/types';

const WS_A = '11111111-1111-1111-1111-111111111111';
const USER_A = '33333333-3333-3333-3333-333333333333';
const JOB_ID = '44444444-4444-4444-4444-444444444444';

describe('ownerForJob', () => {
  it('returns a workspace owner for contact/visitor jobs (workspace_id present)', () => {
    expect(ownerForJob({ workspace_id: WS_A, subject_id: 'contact-1' })).toEqual({
      kind: 'workspace',
      workspaceId: WS_A,
    });
  });

  it('returns a user owner (by subject_id, the person the job concerns) when workspace_id is null', () => {
    expect(ownerForJob({ workspace_id: null, subject_id: USER_A })).toEqual({
      kind: 'user',
      userId: USER_A,
    });
  });
});

const { resolveSubjectMock, buildExportZipMock, resolvePrivacyStoragePolicyMock, uploadWithConfigMock, writePrivacyAuditMock } = vi.hoisted(() => ({
  resolveSubjectMock: vi.fn(async () => ({ contact_ids: [], visitor_ids: [], emails: [] })),
  buildExportZipMock: vi.fn(async () => ({
    buffer: Buffer.from('zip-bytes'),
    sha256: 'deadbeef',
    manifestSummary: {},
  })),
  resolvePrivacyStoragePolicyMock: vi.fn(async () => ({
    provider: 'local',
    config: { provider: 'local', localPath: '/tmp/storage', publicUrl: 'http://local.test' },
    source: 'platform_default' as const,
    allowAttachmentFallback: false,
  })),
  uploadWithConfigMock: vi.fn(async (_config: unknown, _owner: unknown, _storageConfig: unknown, req: { fileKey: string }) => ({
    success: true,
    url: `http://local.test/${req.fileKey}`,
    fileKey: req.fileKey,
  })),
  writePrivacyAuditMock: vi.fn(async () => undefined),
}));

vi.mock('../../../server/services/privacy/identity.js', () => ({ resolveSubject: resolveSubjectMock }));
vi.mock('../../../server/services/privacy/exporter.js', () => ({ buildExportZip: buildExportZipMock }));
vi.mock('../../../server/services/privacy/storageResolver.js', () => ({
  resolvePrivacyStoragePolicy: resolvePrivacyStoragePolicyMock,
  PrivacyStorageNotConfigured: class PrivacyStorageNotConfigured extends Error {},
}));
vi.mock('../../../server/services/privacy/audit.js', () => ({ writePrivacyAudit: writePrivacyAuditMock }));
vi.mock('../../../server/services/privacy/anonymizer.js', () => ({ runAnonymize: vi.fn(async () => ({})) }));
vi.mock('../../../server/services/storage/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../../server/services/storage/index')>(
    '../../../server/services/storage/index',
  );
  // processJob calls uploadWithConfigForOwner (not the bare uploadWithConfig)
  // since the second corrective pass's workspace-deletion write barrier —
  // mock that call site directly rather than the lower-level function it
  // wraps, since an ESM module's own internal call from one export to
  // another (uploadWithConfigForOwner -> uploadWithConfig, both declared in
  // the same source file) resolves to the real local binding regardless of
  // what an outside vi.mock() does to the module's exports.
  return { ...actual, uploadWithConfigForOwner: uploadWithConfigMock };
});

interface JobUpdateCall {
  patch: Record<string, unknown>;
  filters: Array<[string, unknown]>;
}

function makeSupabaseStub() {
  const updateCalls: JobUpdateCall[] = [];
  const insertCalls: Array<{ table: string; row: Record<string, unknown> }> = [];
  const client = {
    from: (table: string) => ({
      update: (patch: Record<string, unknown>) => {
        const filters: Array<[string, unknown]> = [];
        const chain = {
          eq: (col: string, val: unknown) => {
            filters.push([col, val]);
            updateCalls.push({ patch, filters: [...filters] });
            return chain;
          },
        };
        return chain;
      },
      insert: async (row: Record<string, unknown>) => {
        insertCalls.push({ table, row });
        return { data: null, error: null };
      },
    }),
  };
  return { client, updateCalls, insertCalls };
}

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => currentStub.client,
}));

let currentStub = makeSupabaseStub();

function baseJob(overrides: Partial<PrivacyJobRow>): PrivacyJobRow {
  return {
    id: JOB_ID,
    workspace_id: null,
    actor_user_id: USER_A,
    subject_type: 'user',
    subject_id: USER_A,
    subject_email_hash: null,
    resolved_identity: { contact_ids: [], visitor_ids: [], emails: [] },
    action: 'export',
    status: 'running',
    scope: {},
    artifact_path: null,
    artifact_hash: null,
    artifact_size_bytes: null,
    download_count: 0,
    download_token_hash: null,
    expires_at: null,
    error_message: null,
    requested_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    completed_at: null,
    cancelled_at: null,
    ...overrides,
  };
}

describe('processJob (export action) — canonical key + no fake workspaceId', () => {
  it('a user-subject job (no workspace_id) writes to users/<subjectId>/exports/privacy/<jobId>.zip', async () => {
    currentStub = makeSupabaseStub();
    uploadWithConfigMock.mockClear();
    const job = baseJob({ workspace_id: null, subject_type: 'user', subject_id: USER_A });

    await processJob({} as never, job);

    expect(uploadWithConfigMock).toHaveBeenCalledTimes(1);
    const [, , , req] = uploadWithConfigMock.mock.calls[0];
    expect(req.fileKey).toBe(`users/${USER_A}/exports/privacy/${JOB_ID}.zip`);
    // No fake/sentinel workspaceId passed to the storage layer.
    expect(req).not.toHaveProperty('workspaceId');

    const artifactUpdate = currentStub.updateCalls.find((c) => 'artifact_storage_key' in c.patch);
    expect(artifactUpdate?.patch.artifact_storage_key).toBe(`users/${USER_A}/exports/privacy/${JOB_ID}.zip`);
  });

  it('a contact/visitor job (workspace_id present) writes to workspace/<id>/exports/privacy/<jobId>.zip', async () => {
    currentStub = makeSupabaseStub();
    uploadWithConfigMock.mockClear();
    const job = baseJob({ workspace_id: WS_A, subject_type: 'contact', subject_id: 'contact-1' });

    await processJob({} as never, job);

    expect(uploadWithConfigMock).toHaveBeenCalledTimes(1);
    const [, , , req] = uploadWithConfigMock.mock.calls[0];
    expect(req.fileKey).toBe(`workspace/${WS_A}/exports/privacy/${JOB_ID}.zip`);
    expect(req).not.toHaveProperty('workspaceId');
  });

  it('never produces the old privacy-exports/ root', async () => {
    currentStub = makeSupabaseStub();
    uploadWithConfigMock.mockClear();
    const job = baseJob({ workspace_id: WS_A });

    await processJob({} as never, job);

    const [, , , req] = uploadWithConfigMock.mock.calls[0];
    expect(req.fileKey.startsWith('privacy-exports/')).toBe(false);
  });
});

describe('processJob (export action) — storage_usage_logs quota participation', () => {
  it('a workspace-owned job (contact/visitor) writes a storage_usage_logs upload row for that workspace', async () => {
    currentStub = makeSupabaseStub();
    uploadWithConfigMock.mockClear();
    const job = baseJob({ workspace_id: WS_A, subject_type: 'contact', subject_id: 'contact-1' });

    await processJob({} as never, job);

    const usageInserts = currentStub.insertCalls.filter((c) => c.table === 'storage_usage_logs');
    expect(usageInserts).toHaveLength(1);
    expect(usageInserts[0].row).toMatchObject({
      workspace_id: WS_A,
      operation: 'upload',
      file_key: `workspace/${WS_A}/exports/privacy/${JOB_ID}.zip`,
      file_size: Buffer.from('zip-bytes').length,
      success: true,
    });
  });

  it('a user-subject job (no workspace_id) never writes to storage_usage_logs — no workspace to attribute it to', async () => {
    currentStub = makeSupabaseStub();
    uploadWithConfigMock.mockClear();
    const job = baseJob({ workspace_id: null, subject_type: 'user', subject_id: USER_A });

    await processJob({} as never, job);

    const usageInserts = currentStub.insertCalls.filter((c) => c.table === 'storage_usage_logs');
    expect(usageInserts).toHaveLength(0);
  });
});
