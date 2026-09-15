/**
 * Workspace deletion worker — server/services/workspaceDeletion/worker.ts.
 *
 * Covers the redesigned multi-scope storage cleanup (every physical
 * provider a workspace can have objects in — attachment / privacy_export /
 * livekit_recording — server/services/storage/workspaceScopes.ts), not
 * just a single owner-derived one:
 *   - each scope is walked independently, one listing page per tick, and
 *     `db_cleanup` is never reached until every scope is 'done' or
 *     'skipped_not_configured'
 *   - two scopes resolving to the same physical StorageConfig
 *     (storageConfigFingerprint match) are only ever listed/deleted once —
 *     the second is marked 'done' via dedup_of, copying the first's counts
 *   - an unconfigured scope is skipped immediately and never blocks
 *     siblings; a scope that WAS configured and stops being so mid-cleanup
 *     is never silently marked done
 *   - resumability from a persisted per-scope cursor
 *   - the retry/backoff path (attempt_count/next_retry_at) versus terminal
 *     'failed' only once MAX_JOB_ATTEMPTS is exhausted
 *   - the never-touch-users/platform guarantee (only ever
 *     workspace/<id>/...)
 *   - runDbCleanup's idempotent-recovery when admin_delete_workspace errors
 *     but the workspace row is already gone (a prior crashed run already
 *     committed it)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { claimNext, runStorageCleanup, runDbCleanup } from '../../../server/services/workspaceDeletion/worker';
import type { WorkspaceDeletionJobRow, StorageScopesState } from '../../../server/services/workspaceDeletion/types';
import type { StorageConfig, StorageResult, ListResult } from '../../../server/services/storage/index';
import type { WorkspaceStorageScope, ScopeResolution } from '../../../server/services/storage/workspaceScopes';

const WS_A = '11111111-1111-1111-1111-111111111111';
const JOB_1 = '77777777-7777-7777-7777-777777777771';
const ACTOR = '99999999-9999-9999-9999-999999999999';

const { listWithConfigMock, deleteWithConfigMock, workspaceStorageScopesMock } = vi.hoisted(() => ({
  listWithConfigMock: vi.fn<(config: unknown, prefix: string, cursor?: string) => Promise<ListResult>>(),
  deleteWithConfigMock: vi.fn<(config: unknown, key: string) => Promise<StorageResult>>(async () => ({ success: true })),
  workspaceStorageScopesMock: vi.fn(),
}));

vi.mock('../../../server/services/storage/index.js', () => ({
  listWithConfig: listWithConfigMock,
  deleteWithConfig: deleteWithConfigMock,
}));

// workspaceScopePrefix / storageConfigFingerprint are re-implemented here
// verbatim (matching server/services/storage/workspaceScopes.ts exactly)
// rather than pulled in via importOriginal, so this mock never drags in
// the real privacy-export / LiveKit resolver modules that the real
// workspaceStorageScopes() (which we replace entirely) depends on.
vi.mock('../../../server/services/storage/workspaceScopes.js', () => ({
  workspaceStorageScopes: workspaceStorageScopesMock,
  workspaceScopePrefix: (workspaceId: string) => `workspace/${workspaceId}/`,
  storageConfigFingerprint: (cfg: StorageConfig) =>
    JSON.stringify([cfg.provider, cfg.bucket ?? null, cfg.storageZone ?? null, cfg.endpoint ?? null, cfg.s3Region ?? null, cfg.localPath ?? null]),
}));

type Row = Record<string, unknown>;
// Typed as unknown[] per table (rather than Row[]) so seeding a table with a
// concrete named type (e.g. `db.workspace_deletion_jobs = [baseJob()]`) type
// checks without a cast — WorkspaceDeletionJobRow has no index signature, so
// TS refuses to assign it directly into a Row[]-typed slot even though it is
// structurally a Row at runtime.
const db: Record<string, unknown[]> = {};
const rpcCalls: Array<{ fn: string; args: unknown }> = [];
let rpcResponse: { data: unknown; error: { message: string } | null } = { data: null, error: null };

function makeBuilder(table: string) {
  const rows = (db[table] || (db[table] = [])) as Row[];
  return {
    select: (_cols?: string) => {
      const filters: Array<(r: Row) => boolean> = [];
      const chain = {
        eq: (col: string, val: unknown) => {
          filters.push((r) => r[col] === val);
          return chain;
        },
        maybeSingle: async () => {
          const matched = rows.filter((r) => filters.every((f) => f(r)));
          return { data: matched[0] ?? null, error: null };
        },
      };
      return chain;
    },
    update: (patch: Row) => ({
      eq: async (col: string, val: unknown) => {
        for (const r of rows) {
          if (r[col] === val) Object.assign(r, patch);
        }
        return { data: null, error: null };
      },
    }),
  };
}

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: (table: string) => makeBuilder(table),
    rpc: async (fn: string, args: unknown) => {
      rpcCalls.push({ fn, args });
      return rpcResponse;
    },
  }),
}));

function baseJob(overrides: Partial<WorkspaceDeletionJobRow> = {}): WorkspaceDeletionJobRow {
  return {
    id: JOB_1,
    workspace_id: WS_A,
    workspace_slug: 'acme',
    workspace_name: 'Acme',
    requested_by: ACTOR,
    status: 'storage_cleanup',
    storage_scopes: {},
    attempt_count: 0,
    next_retry_at: null,
    locked_by: null,
    lease_expires_at: null,
    db_cleanup_completed_at: null,
    error_message: null,
    requested_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    completed_at: null,
    retried_by: null,
    retried_at: null,
    storage_objects_found: null,
    storage_objects_deleted: 0,
    storage_cursor: null,
    storage_cleanup_error: null,
    ...overrides,
  };
}

function configuredConfig(bucket: string): StorageConfig {
  return { provider: 's3', bucket, s3Region: 'us-east-1' };
}

function currentJobRow(): Row {
  return db.workspace_deletion_jobs[0] as Row;
}

beforeEach(() => {
  for (const key of Object.keys(db)) delete db[key];
  listWithConfigMock.mockReset();
  deleteWithConfigMock.mockReset();
  deleteWithConfigMock.mockResolvedValue({ success: true });
  workspaceStorageScopesMock.mockReset();
  rpcCalls.length = 0;
  rpcResponse = { data: { ok: true, job: null }, error: null };
});

describe('claimNext', () => {
  it('returns the claimed job when the RPC reports ok with a job', async () => {
    const job = baseJob({ status: 'storage_cleanup' });
    rpcResponse = { data: { ok: true, job }, error: null };

    const claimed = await claimNext({} as never);

    expect(claimed).toEqual(job);
    expect(rpcCalls[0].fn).toBe('claim_workspace_deletion_job');
    expect(rpcCalls[0].args).toMatchObject({ _lease_seconds: 60 });
  });

  it('returns null when the RPC reports ok with nothing claimable', async () => {
    rpcResponse = { data: { ok: true, job: null }, error: null };

    expect(await claimNext({} as never)).toBeNull();
  });

  it('returns null when the RPC itself errors', async () => {
    rpcResponse = { data: null, error: { message: 'boom' } };

    expect(await claimNext({} as never)).toBeNull();
  });

  it('returns null when data.ok is false', async () => {
    rpcResponse = { data: { ok: false, job: null }, error: null };

    expect(await claimNext({} as never)).toBeNull();
  });
});

describe('runStorageCleanup', () => {
  it('walks 3 configured scopes with different physical configs independently, one per tick, and only advances to db_cleanup once every scope is done', async () => {
    const attachmentResolve = vi.fn(async (): Promise<ScopeResolution> => ({ configured: true, config: configuredConfig('attach-bucket') }));
    const privacyResolve = vi.fn(async (): Promise<ScopeResolution> => ({ configured: true, config: configuredConfig('privacy-bucket') }));
    const livekitResolve = vi.fn(async (): Promise<ScopeResolution> => ({ configured: true, config: configuredConfig('livekit-bucket') }));
    workspaceStorageScopesMock.mockReturnValue([
      { name: 'attachment', resolve: attachmentResolve },
      { name: 'privacy_export', resolve: privacyResolve },
      { name: 'livekit_recording', resolve: livekitResolve },
    ] satisfies WorkspaceStorageScope[]);
    listWithConfigMock.mockImplementation(async (config: StorageConfig) => ({
      success: true,
      keys: [`workspace/${WS_A}/${config.bucket}/a.pdf`],
      nextCursor: null,
    }));
    db.workspace_deletion_jobs = [baseJob()];

    // Tick 1: only the attachment scope is touched.
    await runStorageCleanup({} as never, baseJob());
    expect(privacyResolve).not.toHaveBeenCalled();
    expect(livekitResolve).not.toHaveBeenCalled();
    let row = currentJobRow();
    let state = row.storage_scopes as StorageScopesState;
    expect(state.attachment?.status).toBe('done');
    expect(state.privacy_export).toBeUndefined();
    expect(row.status).toBe('storage_cleanup');

    // Tick 2: attachment is skipped (already done), privacy_export is worked.
    await runStorageCleanup({} as never, baseJob({ storage_scopes: state }));
    expect(attachmentResolve).toHaveBeenCalledTimes(1); // never re-resolved
    expect(livekitResolve).not.toHaveBeenCalled();
    row = currentJobRow();
    state = row.storage_scopes as StorageScopesState;
    expect(state.privacy_export?.status).toBe('done');
    expect(row.status).toBe('storage_cleanup');

    // Tick 3: livekit_recording is worked.
    await runStorageCleanup({} as never, baseJob({ storage_scopes: state }));
    row = currentJobRow();
    state = row.storage_scopes as StorageScopesState;
    expect(state.livekit_recording?.status).toBe('done');
    expect(row.status).toBe('storage_cleanup'); // one more tick needed to notice completion

    // Tick 4: every scope is done -> advances.
    await runStorageCleanup({} as never, baseJob({ storage_scopes: state }));
    row = currentJobRow();
    expect(row.status).toBe('db_cleanup');

    expect(listWithConfigMock).toHaveBeenCalledTimes(3);
    expect(listWithConfigMock).toHaveBeenNthCalledWith(1, configuredConfig('attach-bucket'), `workspace/${WS_A}/`, undefined);
    expect(listWithConfigMock).toHaveBeenNthCalledWith(2, configuredConfig('privacy-bucket'), `workspace/${WS_A}/`, undefined);
    expect(listWithConfigMock).toHaveBeenNthCalledWith(3, configuredConfig('livekit-bucket'), `workspace/${WS_A}/`, undefined);
    expect(deleteWithConfigMock).toHaveBeenCalledTimes(3);
  });

  it('dedups two scopes resolving to the identical physical StorageConfig — the second is marked done via dedup_of without ever being listed', async () => {
    const sharedConfig = configuredConfig('shared-bucket');
    const attachmentResolve = vi.fn(async (): Promise<ScopeResolution> => ({ configured: true, config: sharedConfig }));
    const privacyResolve = vi.fn(async (): Promise<ScopeResolution> => ({ configured: true, config: sharedConfig }));
    workspaceStorageScopesMock.mockReturnValue([
      { name: 'attachment', resolve: attachmentResolve },
      { name: 'privacy_export', resolve: privacyResolve },
    ] satisfies WorkspaceStorageScope[]);
    listWithConfigMock.mockResolvedValueOnce({
      success: true,
      keys: [`workspace/${WS_A}/a.pdf`, `workspace/${WS_A}/b.pdf`],
      nextCursor: null,
    });
    db.workspace_deletion_jobs = [baseJob()];

    // Tick 1: attachment claims and fully drains the shared bucket.
    await runStorageCleanup({} as never, baseJob());
    let row = currentJobRow();
    const state1 = row.storage_scopes as StorageScopesState;
    expect(state1.attachment).toMatchObject({ status: 'done', objects_found: 2, objects_deleted: 2 });
    expect(row.status).toBe('storage_cleanup');
    expect(listWithConfigMock).toHaveBeenCalledTimes(1);

    // Tick 2: privacy_export resolves to the same config and dedups — no re-listing.
    await runStorageCleanup({} as never, baseJob({ storage_scopes: state1 }));
    row = currentJobRow();
    const state2 = row.storage_scopes as StorageScopesState;
    expect(privacyResolve).toHaveBeenCalledTimes(1);
    expect(state2.privacy_export).toMatchObject({
      status: 'done',
      dedup_of: 'attachment',
      objects_found: 2,
      objects_deleted: 2,
    });
    expect(listWithConfigMock).toHaveBeenCalledTimes(1); // still just the one call from tick 1
    expect(deleteWithConfigMock).toHaveBeenCalledTimes(2); // still just the two deletes from tick 1
    // Dedup doesn't stop the loop (unlike real work, which returns after
    // one page) — with no scopes left to process, the same tick notices
    // every scope is terminal and advances.
    expect(row.status).toBe('db_cleanup');
  });

  it('marks an unconfigured scope skipped_not_configured immediately, never retries it, and never blocks a sibling scope', async () => {
    const attachmentResolve = vi.fn(async (): Promise<ScopeResolution> => ({ configured: false, reason: 'No storage provider configured' }));
    const privacyResolve = vi.fn(async (): Promise<ScopeResolution> => ({ configured: true, config: configuredConfig('privacy-bucket') }));
    workspaceStorageScopesMock.mockReturnValue([
      { name: 'attachment', resolve: attachmentResolve },
      { name: 'privacy_export', resolve: privacyResolve },
    ] satisfies WorkspaceStorageScope[]);
    listWithConfigMock.mockResolvedValueOnce({ success: true, keys: [], nextCursor: null });
    db.workspace_deletion_jobs = [baseJob()];

    await runStorageCleanup({} as never, baseJob());

    let row = currentJobRow();
    let state = row.storage_scopes as StorageScopesState;
    expect(state.attachment).toMatchObject({ status: 'skipped_not_configured', objects_found: 0, objects_deleted: 0 });
    expect(state.privacy_export?.status).toBe('done'); // not blocked by the skipped sibling, same tick
    expect(listWithConfigMock).toHaveBeenCalledTimes(1); // only ever for privacy_export
    expect(row.status).toBe('storage_cleanup');

    await runStorageCleanup({} as never, baseJob({ storage_scopes: state }));

    row = currentJobRow();
    state = row.storage_scopes as StorageScopesState;
    expect(row.status).toBe('db_cleanup');
    expect(attachmentResolve).toHaveBeenCalledTimes(1); // never retried once skipped
  });

  it('sends the job to retry/backoff (never marks anything done) when a scope resolve() throws', async () => {
    const attachmentResolve = vi.fn(async (): Promise<ScopeResolution> => {
      throw new Error('provider secrets fetch failed');
    });
    workspaceStorageScopesMock.mockReturnValue([{ name: 'attachment', resolve: attachmentResolve }] satisfies WorkspaceStorageScope[]);
    db.workspace_deletion_jobs = [baseJob({ attempt_count: 0 })];

    await runStorageCleanup({} as never, baseJob({ attempt_count: 0 }));

    const row = currentJobRow();
    expect(row.status).toBe('storage_cleanup'); // retry path never sets status
    expect(row.attempt_count).toBe(1);
    expect(row.next_retry_at).toBeTruthy();
    expect(row.error_message).toMatch(/provider secrets fetch failed/);
    expect(row.storage_scopes).toEqual({});
    expect(listWithConfigMock).not.toHaveBeenCalled();
  });

  it('sends the job to retry/backoff (never marks it done) when a scope that was configured earlier stops being configured mid-cleanup', async () => {
    const attachmentResolve = vi.fn(async (): Promise<ScopeResolution> => ({ configured: false, reason: 'integration disabled' }));
    workspaceStorageScopesMock.mockReturnValue([{ name: 'attachment', resolve: attachmentResolve }] satisfies WorkspaceStorageScope[]);
    const midState: StorageScopesState = {
      attachment: { status: 'in_progress', cursor: 'tok-9', objects_found: 5, objects_deleted: 5, error: null, fingerprint: 'fp-a', dedup_of: null },
    };
    db.workspace_deletion_jobs = [baseJob({ storage_scopes: midState, attempt_count: 1 })];

    await runStorageCleanup({} as never, baseJob({ storage_scopes: midState, attempt_count: 1 }));

    const row = currentJobRow();
    expect(row.attempt_count).toBe(2);
    expect(row.next_retry_at).toBeTruthy();
    const state = row.storage_scopes as StorageScopesState;
    expect(state.attachment?.status).toBe('in_progress'); // untouched — never silently flipped to done
    expect(listWithConfigMock).not.toHaveBeenCalled();
  });

  it('resumes an in_progress scope from its persisted cursor and never re-touches an already-done scope', async () => {
    const attachmentResolve = vi.fn();
    const privacyResolve = vi.fn(async (): Promise<ScopeResolution> => ({ configured: true, config: configuredConfig('privacy-bucket') }));
    workspaceStorageScopesMock.mockReturnValue([
      { name: 'attachment', resolve: attachmentResolve },
      { name: 'privacy_export', resolve: privacyResolve },
    ] satisfies WorkspaceStorageScope[]);
    listWithConfigMock.mockResolvedValueOnce({ success: true, keys: [`workspace/${WS_A}/c.pdf`], nextCursor: null });

    const state: StorageScopesState = {
      attachment: { status: 'done', cursor: null, objects_found: 1, objects_deleted: 1, error: null, fingerprint: 'fp-attach', dedup_of: null },
      privacy_export: {
        status: 'in_progress',
        cursor: 'tok-1',
        objects_found: 3,
        objects_deleted: 3,
        error: null,
        fingerprint: JSON.stringify(['s3', 'privacy-bucket', null, null, 'us-east-1', null]),
        dedup_of: null,
      },
    };
    db.workspace_deletion_jobs = [baseJob({ storage_scopes: state })];

    await runStorageCleanup({} as never, baseJob({ storage_scopes: state }));

    expect(attachmentResolve).not.toHaveBeenCalled();
    expect(privacyResolve).toHaveBeenCalledTimes(1);
    expect(listWithConfigMock).toHaveBeenCalledWith(configuredConfig('privacy-bucket'), `workspace/${WS_A}/`, 'tok-1');
    const row = currentJobRow();
    const newState = row.storage_scopes as StorageScopesState;
    expect(newState.privacy_export).toMatchObject({ status: 'done', objects_found: 4, objects_deleted: 4 });
    expect(newState.attachment).toEqual(state.attachment); // byte-for-byte unchanged
  });

  it('retries with backoff (does not fail immediately) when a delete keeps failing across the per-key attempt cap', async () => {
    const attachmentResolve = vi.fn(async (): Promise<ScopeResolution> => ({ configured: true, config: configuredConfig('attach-bucket') }));
    workspaceStorageScopesMock.mockReturnValue([{ name: 'attachment', resolve: attachmentResolve }] satisfies WorkspaceStorageScope[]);
    listWithConfigMock.mockResolvedValueOnce({ success: true, keys: [`workspace/${WS_A}/a.pdf`], nextCursor: null });
    deleteWithConfigMock.mockResolvedValue({ success: false, error: 'permission_denied' });
    db.workspace_deletion_jobs = [baseJob({ attempt_count: 2 })];

    await runStorageCleanup({} as never, baseJob({ attempt_count: 2 }));

    expect(deleteWithConfigMock).toHaveBeenCalledTimes(3); // MAX_DELETE_ATTEMPTS_PER_KEY
    const row = currentJobRow();
    expect(row.status).toBe('storage_cleanup'); // not failed yet
    expect(row.attempt_count).toBe(3);
    expect(row.next_retry_at).toBeTruthy();
  });

  it('terminally fails the job once a persistent delete failure pushes attempt_count to MAX_JOB_ATTEMPTS', async () => {
    const attachmentResolve = vi.fn(async (): Promise<ScopeResolution> => ({ configured: true, config: configuredConfig('attach-bucket') }));
    workspaceStorageScopesMock.mockReturnValue([{ name: 'attachment', resolve: attachmentResolve }] satisfies WorkspaceStorageScope[]);
    listWithConfigMock.mockResolvedValueOnce({ success: true, keys: [`workspace/${WS_A}/a.pdf`], nextCursor: null });
    deleteWithConfigMock.mockResolvedValue({ success: false, error: 'permission_denied' });
    db.workspace_deletion_jobs = [baseJob({ attempt_count: 4 })];

    await runStorageCleanup({} as never, baseJob({ attempt_count: 4 }));

    const row = currentJobRow();
    expect(row.status).toBe('failed');
    expect(row.attempt_count).toBe(5);
    expect(row.error_message).toMatch(/permission_denied/);
  });

  it('only ever lists/deletes under workspace/<id>/ — never users/ or platform/', async () => {
    const attachmentResolve = vi.fn(async (): Promise<ScopeResolution> => ({ configured: true, config: configuredConfig('attach-bucket') }));
    workspaceStorageScopesMock.mockReturnValue([{ name: 'attachment', resolve: attachmentResolve }] satisfies WorkspaceStorageScope[]);
    listWithConfigMock.mockResolvedValueOnce({ success: true, keys: [`workspace/${WS_A}/a.pdf`], nextCursor: null });
    db.workspace_deletion_jobs = [baseJob()];

    await runStorageCleanup({} as never, baseJob());

    expect(listWithConfigMock).toHaveBeenCalledWith(configuredConfig('attach-bucket'), `workspace/${WS_A}/`, undefined);
    expect(deleteWithConfigMock).toHaveBeenCalledWith(configuredConfig('attach-bucket'), `workspace/${WS_A}/a.pdf`);
    const prefixArg = listWithConfigMock.mock.calls[0][1] as string;
    expect(prefixArg.startsWith('users/')).toBe(false);
    expect(prefixArg.startsWith('platform/')).toBe(false);
    expect(prefixArg).toBe(`workspace/${WS_A}/`);
  });
});

describe('runDbCleanup', () => {
  it('calls admin_delete_workspace with the actor and workspace id, then marks the job completed', async () => {
    db.workspace_deletion_jobs = [baseJob({ status: 'db_cleanup' })];

    await runDbCleanup({} as never, baseJob({ status: 'db_cleanup' }));

    expect(rpcCalls[0]).toEqual({ fn: 'admin_delete_workspace', args: { _actor_user_id: ACTOR, _workspace_id: WS_A } });
    const row = currentJobRow();
    expect(row.status).toBe('completed');
    expect(row.db_cleanup_completed_at).toBeTruthy();
    expect(row.completed_at).toBeTruthy();
  });

  it('retries with backoff (does not fail immediately) when the RPC errors and the workspace row still exists', async () => {
    rpcResponse = { data: null, error: { message: 'not authorized' } };
    db.workspace_deletion_jobs = [baseJob({ status: 'db_cleanup', attempt_count: 1 })];
    db.workspaces = [{ id: WS_A }];

    await runDbCleanup({} as never, baseJob({ status: 'db_cleanup', attempt_count: 1 }));

    const row = currentJobRow();
    expect(row.status).toBe('db_cleanup'); // retry path never sets status
    expect(row.attempt_count).toBe(2);
    expect(row.next_retry_at).toBeTruthy();
    expect(row.error_message).toMatch(/not authorized/);
  });

  it('terminally fails when the RPC errors, the workspace row still exists, and attempt_count is already exhausted', async () => {
    rpcResponse = { data: null, error: { message: 'not authorized' } };
    db.workspace_deletion_jobs = [baseJob({ status: 'db_cleanup', attempt_count: 4 })];
    db.workspaces = [{ id: WS_A }];

    await runDbCleanup({} as never, baseJob({ status: 'db_cleanup', attempt_count: 4 }));

    const row = currentJobRow();
    expect(row.status).toBe('failed');
    expect(row.attempt_count).toBe(5);
  });

  it('treats an RPC error as an already-completed idempotent resume when the workspace row is already gone', async () => {
    rpcResponse = { data: null, error: { message: 'Workspace not found' } };
    db.workspace_deletion_jobs = [baseJob({ status: 'db_cleanup' })];
    db.workspaces = []; // already purged by a prior crashed run

    await runDbCleanup({} as never, baseJob({ status: 'db_cleanup' }));

    const row = currentJobRow();
    expect(row.status).toBe('completed');
  });
});
