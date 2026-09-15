/**
 * Workspace deletion worker — server/services/workspaceDeletion/worker.ts.
 *
 * Proves the storage-cleanup-before-DB-cleanup ordering, resumability
 * (storage_cursor persisted across ticks), the never-touch-users/platform
 * guarantee (only ever lists/deletes under workspace/<id>/), and the
 * idempotent-recovery behavior when the DB purge RPC errors but the
 * workspace row is already gone (a prior crashed run already committed
 * it).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { claimNext, runStorageCleanup, runDbCleanup } from '../../../server/services/workspaceDeletion/worker';
import type { WorkspaceDeletionJobRow } from '../../../server/services/workspaceDeletion/types';

const WS_A = '11111111-1111-1111-1111-111111111111';
const JOB_1 = '77777777-7777-7777-7777-777777777771';
const ACTOR = '99999999-9999-9999-9999-999999999999';

const { listForOwnerMock, deleteForOwnerMock } = vi.hoisted(() => ({
  listForOwnerMock: vi.fn(),
  deleteForOwnerMock: vi.fn(async () => ({ success: true })),
}));

vi.mock('../../../server/services/storage/index.js', () => ({
  listForOwner: listForOwnerMock,
  deleteForOwner: deleteForOwnerMock,
}));

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
const rpcCalls: Array<{ fn: string; args: unknown }> = [];
let rpcResponse: { error: { message: string } | null } = { error: null };

function makeBuilder(table: string) {
  const rows = db[table] || (db[table] = []);
  const filters: Array<(r: Row) => boolean> = [];
  let limitN = Infinity;
  const builder = {
    select: () => builder,
    in: (col: string, vals: unknown[]) => {
      filters.push((r) => vals.includes(r[col]));
      return builder;
    },
    eq: (col: string, val: unknown) => {
      filters.push((r) => r[col] === val);
      return builder;
    },
    order: () => builder,
    limit: (n: number) => {
      limitN = n;
      return builder;
    },
    maybeSingle: async () => {
      const matched = rows.filter((r) => filters.every((f) => f(r)));
      return { data: matched[0] ?? null, error: null };
    },
    update: (patch: Row) => {
      const scoped: Array<(r: Row) => boolean> = [...filters];
      function applyAndBuildResult() {
        const matched = rows.filter((r) => scoped.every((f) => f(r)));
        for (const r of matched) Object.assign(r, patch);
        return matched;
      }
      const chain = {
        eq: (col: string, val: unknown) => {
          scoped.push((r) => r[col] === val);
          return {
            ...chain,
            select: () => ({
              maybeSingle: async () => {
                const matched = applyAndBuildResult();
                return { data: matched[0] ?? null, error: matched.length ? null : { message: 'no match' } };
              },
            }),
            then: (resolve: (v: { error: null }) => void) => {
              applyAndBuildResult();
              resolve({ error: null });
            },
          };
        },
      };
      return chain;
    },
    then(resolve: (v: { data: Row[]; error: null }) => void) {
      resolve({ data: rows.filter((r) => filters.every((f) => f(r))).slice(0, limitN), error: null });
    },
  };
  return builder;
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
    storage_objects_found: null,
    storage_objects_deleted: 0,
    storage_cursor: null,
    storage_cleanup_error: null,
    db_cleanup_completed_at: null,
    error_message: null,
    requested_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    completed_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  for (const key of Object.keys(db)) delete db[key];
  listForOwnerMock.mockReset();
  deleteForOwnerMock.mockReset();
  deleteForOwnerMock.mockResolvedValue({ success: true });
  rpcCalls.length = 0;
  rpcResponse = { error: null };
});

describe('claimNext', () => {
  it('claims a pending job, flips it to storage_cleanup, and stamps started_at', async () => {
    db.workspace_deletion_jobs = [baseJob({ status: 'pending', started_at: null })];

    const claimed = await claimNext({} as never);

    expect(claimed?.status).toBe('storage_cleanup');
    expect(claimed?.started_at).toBeTruthy();
  });

  it('resumes a job already mid-flight (storage_cleanup or db_cleanup) without re-claiming', async () => {
    db.workspace_deletion_jobs = [baseJob({ status: 'db_cleanup' })];

    const claimed = await claimNext({} as never);

    expect(claimed?.status).toBe('db_cleanup');
  });

  it('never claims a completed or failed job', async () => {
    db.workspace_deletion_jobs = [baseJob({ status: 'completed' })];

    expect(await claimNext({} as never)).toBeNull();
  });
});

describe('runStorageCleanup', () => {
  it('only ever lists/deletes under the workspace owner — never users/ or platform/', async () => {
    listForOwnerMock.mockResolvedValueOnce({ success: true, keys: [`workspace/${WS_A}/attachments/a.pdf`], nextCursor: null });
    db.workspace_deletion_jobs = [baseJob()];

    await runStorageCleanup({} as never, baseJob());

    expect(listForOwnerMock).toHaveBeenCalledWith({}, { kind: 'workspace', workspaceId: WS_A }, undefined, undefined);
    expect(deleteForOwnerMock).toHaveBeenCalledWith({}, { kind: 'workspace', workspaceId: WS_A }, `workspace/${WS_A}/attachments/a.pdf`);
  });

  it('deletes every object then advances the job to db_cleanup', async () => {
    listForOwnerMock.mockResolvedValueOnce({
      success: true,
      keys: [`workspace/${WS_A}/a.pdf`, `workspace/${WS_A}/b.pdf`],
      nextCursor: null,
    });
    db.workspace_deletion_jobs = [baseJob()];

    await runStorageCleanup({} as never, baseJob());

    expect(deleteForOwnerMock).toHaveBeenCalledTimes(2);
    expect(db.workspace_deletion_jobs[0].status).toBe('db_cleanup');
    expect(db.workspace_deletion_jobs[0].storage_objects_deleted).toBe(2);
  });

  it('persists the provider cursor and does not advance to db_cleanup when the listing is truncated', async () => {
    listForOwnerMock.mockResolvedValueOnce({ success: true, keys: [`workspace/${WS_A}/a.pdf`], nextCursor: 'tok-1' });
    db.workspace_deletion_jobs = [baseJob()];

    await runStorageCleanup({} as never, baseJob());

    expect(db.workspace_deletion_jobs[0].storage_cursor).toBe('tok-1');
    expect(db.workspace_deletion_jobs[0].status).toBe('storage_cleanup');
  });

  it('resumes from a persisted cursor on a subsequent call', async () => {
    listForOwnerMock.mockResolvedValueOnce({ success: true, keys: [`workspace/${WS_A}/b.pdf`], nextCursor: null });
    const job = baseJob({ storage_cursor: 'tok-1', storage_objects_deleted: 1 });
    db.workspace_deletion_jobs = [job];

    await runStorageCleanup({} as never, job);

    expect(listForOwnerMock).toHaveBeenCalledWith({}, { kind: 'workspace', workspaceId: WS_A }, undefined, 'tok-1');
    expect(db.workspace_deletion_jobs[0].storage_objects_deleted).toBe(2);
  });

  it('fails closed on a listing error — never advances to db_cleanup with unknown storage state', async () => {
    listForOwnerMock.mockResolvedValueOnce({ success: false, error: 'provider_unreachable' });
    db.workspace_deletion_jobs = [baseJob()];

    await runStorageCleanup({} as never, baseJob());

    expect(db.workspace_deletion_jobs[0].status).toBe('failed');
    expect(deleteForOwnerMock).not.toHaveBeenCalled();
  });

  it('fails the job (does not advance) when a delete keeps failing after retries', async () => {
    listForOwnerMock.mockResolvedValueOnce({ success: true, keys: [`workspace/${WS_A}/a.pdf`], nextCursor: null });
    deleteForOwnerMock.mockResolvedValue({ success: false, error: 'permission_denied' });
    db.workspace_deletion_jobs = [baseJob()];

    await runStorageCleanup({} as never, baseJob());

    expect(db.workspace_deletion_jobs[0].status).toBe('failed');
    expect(deleteForOwnerMock).toHaveBeenCalledTimes(3); // MAX_DELETE_ATTEMPTS_PER_KEY
  });
});

describe('runDbCleanup', () => {
  it('calls admin_delete_workspace with the actor and workspace id, then marks the job completed', async () => {
    db.workspace_deletion_jobs = [baseJob({ status: 'db_cleanup' })];

    await runDbCleanup({} as never, baseJob({ status: 'db_cleanup' }));

    expect(rpcCalls[0]).toEqual({ fn: 'admin_delete_workspace', args: { _actor_user_id: ACTOR, _workspace_id: WS_A } });
    expect(db.workspace_deletion_jobs[0].status).toBe('completed');
    expect(db.workspace_deletion_jobs[0].db_cleanup_completed_at).toBeTruthy();
  });

  it('marks the job failed when the RPC errors and the workspace row still exists', async () => {
    rpcResponse = { error: { message: 'not authorized' } };
    db.workspace_deletion_jobs = [baseJob({ status: 'db_cleanup' })];
    db.workspaces = [{ id: WS_A }];

    await runDbCleanup({} as never, baseJob({ status: 'db_cleanup' }));

    expect(db.workspace_deletion_jobs[0].status).toBe('failed');
    expect(db.workspace_deletion_jobs[0].error_message).toMatch(/not authorized/);
  });

  it('treats an RPC error as an already-completed idempotent resume when the workspace row is already gone', async () => {
    rpcResponse = { error: { message: 'Workspace not found' } };
    db.workspace_deletion_jobs = [baseJob({ status: 'db_cleanup' })];
    db.workspaces = []; // already purged by a prior crashed run

    await runDbCleanup({} as never, baseJob({ status: 'db_cleanup' }));

    expect(db.workspace_deletion_jobs[0].status).toBe('completed');
  });
});
