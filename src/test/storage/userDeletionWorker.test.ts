/**
 * User (account) deletion worker — server/services/userDeletion/worker.ts.
 *
 * Unlike its sibling workspaceDeletion/worker.ts, this module only exports
 * `claimNext` and `startUserDeletionWorker` — `collectWorkspaces`,
 * `checkWorkspaceDeletionsComplete`, `purgeUser` and `tick` are internal.
 * Those internals are exercised here by driving a single poll tick through
 * `startUserDeletionWorker` (its initial, immediate tick) against a claimed
 * job of the relevant status, then flushing microtasks — never by importing
 * anything the module does not export.
 *
 * Proves the collect -> await -> purge lifecycle order, that "some owned
 * workspace still exists" is treated as not-ready-yet (never counted
 * against attempt_count), the never-touch-DB-ownership-before-storage
 * guarantee (avatar cleanup happens strictly before admin_delete_user, one
 * action per tick), pagination through listForOwner, and the
 * idempotent-recovery behavior when admin_delete_user errors but the
 * profile row is already gone (a prior crashed run already committed it).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type { UserDeletionJobRow } from '../../../server/services/userDeletion/types';

const USER_A = '22222222-2222-2222-2222-222222222222';
const WS_A = '11111111-1111-1111-1111-111111111111';
const WS_B = '33333333-3333-3333-3333-333333333333';
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
const fromCalls: string[] = [];
let rpcHandlers: Record<string, (args: unknown) => { data?: unknown; error?: { message: string } | null }> = {};

function makeBuilder(table: string) {
  const rows = db[table] || (db[table] = []);
  const filters: Array<(r: Row) => boolean> = [];
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
      resolve({ data: rows.filter((r) => filters.every((f) => f(r))), error: null });
    },
  };
  return builder;
}

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      fromCalls.push(table);
      return makeBuilder(table);
    },
    rpc: async (fn: string, args: unknown) => {
      rpcCalls.push({ fn, args });
      const handler = rpcHandlers[fn];
      if (handler) return handler(args);
      return { data: null, error: null };
    },
  }),
}));

// The worker's own setInterval poll loop is irrelevant to these tests (we
// only ever need its initial, immediate tick) and would otherwise leak a
// real 5s timer per test — replace it with a no-op so nothing fires later.
vi.stubGlobal('setInterval', (() => ({ unref: () => {} })) as unknown as typeof setInterval);

function baseJob(overrides: Partial<UserDeletionJobRow> = {}): UserDeletionJobRow {
  return {
    id: JOB_1,
    user_id: USER_A,
    user_email: 'user@example.com',
    requested_by: ACTOR,
    status: 'collecting_workspaces',
    workspace_ids: [],
    avatar_cleanup_done: false,
    purge_result: null,
    attempt_count: 0,
    next_retry_at: null,
    locked_by: null,
    lease_expires_at: null,
    error_message: null,
    requested_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    completed_at: null,
    retried_by: null,
    retried_at: null,
    ...overrides,
  };
}

/** Drains the microtask queue so a tick's internal await chain (however deep) settles before we assert. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

let workerMod: typeof import('../../../server/services/userDeletion/worker');

beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(async () => {
  for (const key of Object.keys(db)) delete db[key];
  rpcCalls.length = 0;
  fromCalls.length = 0;
  rpcHandlers = {};
  listForOwnerMock.mockReset();
  deleteForOwnerMock.mockReset();
  deleteForOwnerMock.mockResolvedValue({ success: true });
  // Fresh module instance per test: the module's `started` singleton guard
  // would otherwise make every startUserDeletionWorker() call after the
  // first a silent no-op.
  vi.resetModules();
  workerMod = await import('../../../server/services/userDeletion/worker');
});

describe('claimNext', () => {
  it('returns the claimed job when the RPC reports one', async () => {
    rpcHandlers.claim_user_deletion_job = () => ({ data: { ok: true, job: baseJob() }, error: null });

    const claimed = await workerMod.claimNext({} as never);

    expect(claimed?.id).toBe(JOB_1);
    expect(claimed?.status).toBe('collecting_workspaces');
  });

  it('returns null when there is nothing claimable', async () => {
    rpcHandlers.claim_user_deletion_job = () => ({ data: { ok: true, job: null }, error: null });

    expect(await workerMod.claimNext({} as never)).toBeNull();
  });

  it('returns null when the RPC errors', async () => {
    rpcHandlers.claim_user_deletion_job = () => ({ data: null, error: { message: 'db unreachable' } });

    expect(await workerMod.claimNext({} as never)).toBeNull();
  });
});

describe('collecting_workspaces (via a single tick)', () => {
  it('enqueues one workspace deletion per owned workspace and advances with exactly those ids', async () => {
    const job = baseJob({ status: 'collecting_workspaces' });
    db.user_deletion_jobs = [job];
    db.workspaces = [
      { id: WS_A, owner_id: USER_A },
      { id: WS_B, owner_id: USER_A },
    ];
    rpcHandlers.claim_user_deletion_job = () => ({ data: { ok: true, job }, error: null });
    rpcHandlers.enqueue_workspace_deletion = () => ({ error: null });

    workerMod.startUserDeletionWorker({} as never);
    await flush();

    const enqueueCalls = rpcCalls.filter((c) => c.fn === 'enqueue_workspace_deletion');
    expect(enqueueCalls.map((c) => c.args)).toEqual([
      { _workspace_id: WS_A, _actor_user_id: ACTOR },
      { _workspace_id: WS_B, _actor_user_id: ACTOR },
    ]);
    expect(db.user_deletion_jobs[0].status).toBe('awaiting_workspace_deletions');
    expect(db.user_deletion_jobs[0].workspace_ids).toEqual([WS_A, WS_B]);
  });

  it('advances straight to awaiting_workspace_deletions with an empty list when the user owns nothing', async () => {
    const job = baseJob({ status: 'collecting_workspaces' });
    db.user_deletion_jobs = [job];
    db.workspaces = [];
    rpcHandlers.claim_user_deletion_job = () => ({ data: { ok: true, job }, error: null });

    workerMod.startUserDeletionWorker({} as never);
    await flush();

    expect(rpcCalls.filter((c) => c.fn === 'enqueue_workspace_deletion')).toHaveLength(0);
    expect(db.user_deletion_jobs[0].status).toBe('awaiting_workspace_deletions');
    expect(db.user_deletion_jobs[0].workspace_ids).toEqual([]);
  });

  it('retries with backoff (does not fail immediately or advance) when an enqueue RPC call errors', async () => {
    const job = baseJob({ status: 'collecting_workspaces', attempt_count: 0 });
    db.user_deletion_jobs = [job];
    db.workspaces = [
      { id: WS_A, owner_id: USER_A },
      { id: WS_B, owner_id: USER_A },
    ];
    rpcHandlers.claim_user_deletion_job = () => ({ data: { ok: true, job }, error: null });
    rpcHandlers.enqueue_workspace_deletion = () => ({ error: { message: 'boom' } });

    workerMod.startUserDeletionWorker({} as never);
    await flush();

    expect(db.user_deletion_jobs[0].status).toBe('collecting_workspaces');
    expect(db.user_deletion_jobs[0].attempt_count).toBe(1);
    expect(db.user_deletion_jobs[0].error_message).toMatch(/boom/);
    expect(db.user_deletion_jobs[0].next_retry_at).toBeTruthy();
    expect(db.user_deletion_jobs[0].locked_by).toBeNull();
  });
});

describe('awaiting_workspace_deletions (via a single tick)', () => {
  it('stays put without bumping attempt_count while an owned workspace still exists', async () => {
    const job = baseJob({
      status: 'awaiting_workspace_deletions',
      workspace_ids: [WS_A, WS_B],
      attempt_count: 2,
      locked_by: 'someone',
      lease_expires_at: new Date().toISOString(),
    });
    db.user_deletion_jobs = [job];
    db.workspaces = [{ id: WS_A, owner_id: USER_A }]; // WS_B done, WS_A still in flight
    rpcHandlers.claim_user_deletion_job = () => ({ data: { ok: true, job }, error: null });

    workerMod.startUserDeletionWorker({} as never);
    await flush();

    expect(db.user_deletion_jobs[0].status).toBe('awaiting_workspace_deletions');
    expect(db.user_deletion_jobs[0].attempt_count).toBe(2); // unchanged — not a failure, just not ready
    expect(db.user_deletion_jobs[0].locked_by).toBeNull();
    expect(db.user_deletion_jobs[0].lease_expires_at).toBeNull();
  });

  it('advances to purging_user once every owned workspace is gone from workspaces', async () => {
    const job = baseJob({ status: 'awaiting_workspace_deletions', workspace_ids: [WS_A, WS_B] });
    db.user_deletion_jobs = [job];
    db.workspaces = [];
    rpcHandlers.claim_user_deletion_job = () => ({ data: { ok: true, job }, error: null });

    workerMod.startUserDeletionWorker({} as never);
    await flush();

    expect(db.user_deletion_jobs[0].status).toBe('purging_user');
  });

  it('goes straight to purging_user without querying workspaces when workspace_ids is empty', async () => {
    const job = baseJob({ status: 'awaiting_workspace_deletions', workspace_ids: [] });
    db.user_deletion_jobs = [job];
    rpcHandlers.claim_user_deletion_job = () => ({ data: { ok: true, job }, error: null });

    workerMod.startUserDeletionWorker({} as never);
    await flush();

    expect(fromCalls).not.toContain('workspaces');
    expect(db.user_deletion_jobs[0].status).toBe('purging_user');
  });
});

describe('purging_user (via a single tick)', () => {
  it('first tick: cleans up global user storage, marks avatar_cleanup_done, and does not call admin_delete_user yet', async () => {
    const job = baseJob({ status: 'purging_user', avatar_cleanup_done: false });
    db.user_deletion_jobs = [job];
    rpcHandlers.claim_user_deletion_job = () => ({ data: { ok: true, job }, error: null });
    listForOwnerMock.mockResolvedValueOnce({
      success: true,
      keys: [`users/${USER_A}/avatar.png`, `users/${USER_A}/banner.png`],
      nextCursor: null,
    });

    workerMod.startUserDeletionWorker({} as never);
    await flush();

    expect(listForOwnerMock).toHaveBeenCalledWith({}, { kind: 'user', userId: USER_A });
    expect(deleteForOwnerMock).toHaveBeenCalledTimes(2);
    expect(deleteForOwnerMock).toHaveBeenCalledWith({}, { kind: 'user', userId: USER_A }, `users/${USER_A}/avatar.png`);
    expect(deleteForOwnerMock).toHaveBeenCalledWith({}, { kind: 'user', userId: USER_A }, `users/${USER_A}/banner.png`);
    expect(db.user_deletion_jobs[0].avatar_cleanup_done).toBe(true);
    expect(db.user_deletion_jobs[0].status).toBe('purging_user'); // re-claimed next tick for the DB purge
    expect(rpcCalls.filter((c) => c.fn === 'admin_delete_user')).toHaveLength(0);
  });

  it('second tick: calls admin_delete_user and marks the job completed with its returned purge_result', async () => {
    const job = baseJob({ status: 'purging_user', avatar_cleanup_done: true });
    db.user_deletion_jobs = [job];
    rpcHandlers.claim_user_deletion_job = () => ({ data: { ok: true, job }, error: null });
    rpcHandlers.admin_delete_user = () => ({ data: { purged_workspaces: 0 }, error: null });

    workerMod.startUserDeletionWorker({} as never);
    await flush();

    const call = rpcCalls.find((c) => c.fn === 'admin_delete_user');
    expect(call?.args).toEqual({ _actor_user_id: ACTOR, _user_id: USER_A });
    expect(db.user_deletion_jobs[0].status).toBe('completed');
    expect(db.user_deletion_jobs[0].purge_result).toEqual({ purged_workspaces: 0 });
    expect(db.user_deletion_jobs[0].completed_at).toBeTruthy();
    expect(listForOwnerMock).not.toHaveBeenCalled();
  });

  it('idempotent recovery: admin_delete_user errors but the profile is already gone — still completes', async () => {
    const job = baseJob({ status: 'purging_user', avatar_cleanup_done: true });
    db.user_deletion_jobs = [job];
    db.profiles = []; // already purged by a prior crashed run
    rpcHandlers.claim_user_deletion_job = () => ({ data: { ok: true, job }, error: null });
    rpcHandlers.admin_delete_user = () => ({ data: null, error: { message: 'user not found' } });

    workerMod.startUserDeletionWorker({} as never);
    await flush();

    expect(db.user_deletion_jobs[0].status).toBe('completed');
  });

  it('real failure: admin_delete_user errors and the profile still exists — retries with backoff, not a terminal failure', async () => {
    const job = baseJob({ status: 'purging_user', avatar_cleanup_done: true, attempt_count: 0 });
    db.user_deletion_jobs = [job];
    db.profiles = [{ id: USER_A }];
    rpcHandlers.claim_user_deletion_job = () => ({ data: { ok: true, job }, error: null });
    rpcHandlers.admin_delete_user = () => ({ data: null, error: { message: 'not authorized' } });

    workerMod.startUserDeletionWorker({} as never);
    await flush();

    expect(db.user_deletion_jobs[0].status).toBe('purging_user');
    expect(db.user_deletion_jobs[0].attempt_count).toBe(1);
    expect(db.user_deletion_jobs[0].error_message).toMatch(/not authorized/);
    expect(db.user_deletion_jobs[0].next_retry_at).toBeTruthy();
  });

  it('marks the job terminally failed once attempt_count is already at the retry threshold', async () => {
    const job = baseJob({ status: 'purging_user', avatar_cleanup_done: true, attempt_count: 4 });
    db.user_deletion_jobs = [job];
    db.profiles = [{ id: USER_A }];
    rpcHandlers.claim_user_deletion_job = () => ({ data: { ok: true, job }, error: null });
    rpcHandlers.admin_delete_user = () => ({ data: null, error: { message: 'not authorized' } });

    workerMod.startUserDeletionWorker({} as never);
    await flush();

    expect(db.user_deletion_jobs[0].status).toBe('failed'); // MAX_JOB_ATTEMPTS = 5
    expect(db.user_deletion_jobs[0].attempt_count).toBe(5);
  });

  it('pages through listForOwner and deletes every key from every page before setting avatar_cleanup_done', async () => {
    const job = baseJob({ status: 'purging_user', avatar_cleanup_done: false });
    db.user_deletion_jobs = [job];
    rpcHandlers.claim_user_deletion_job = () => ({ data: { ok: true, job }, error: null });
    listForOwnerMock
      .mockResolvedValueOnce({ success: true, keys: [`users/${USER_A}/a.png`], nextCursor: 'tok-1' })
      .mockResolvedValueOnce({ success: true, keys: [`users/${USER_A}/b.png`], nextCursor: null });

    workerMod.startUserDeletionWorker({} as never);
    await flush();

    expect(listForOwnerMock).toHaveBeenCalledTimes(2);
    expect(listForOwnerMock).toHaveBeenNthCalledWith(1, {}, { kind: 'user', userId: USER_A });
    expect(listForOwnerMock).toHaveBeenNthCalledWith(2, {}, { kind: 'user', userId: USER_A }, undefined, 'tok-1');
    expect(deleteForOwnerMock).toHaveBeenCalledTimes(2);
    expect(deleteForOwnerMock).toHaveBeenCalledWith({}, { kind: 'user', userId: USER_A }, `users/${USER_A}/a.png`);
    expect(deleteForOwnerMock).toHaveBeenCalledWith({}, { kind: 'user', userId: USER_A }, `users/${USER_A}/b.png`);
    expect(db.user_deletion_jobs[0].avatar_cleanup_done).toBe(true);
  });

  it('retries with backoff (does not crash) when a delete keeps failing across MAX_DELETE_ATTEMPTS_PER_KEY attempts', async () => {
    const job = baseJob({ status: 'purging_user', avatar_cleanup_done: false, attempt_count: 0 });
    db.user_deletion_jobs = [job];
    rpcHandlers.claim_user_deletion_job = () => ({ data: { ok: true, job }, error: null });
    listForOwnerMock.mockResolvedValueOnce({ success: true, keys: [`users/${USER_A}/stuck.png`], nextCursor: null });
    deleteForOwnerMock.mockResolvedValue({ success: false, error: 'permission_denied' });

    workerMod.startUserDeletionWorker({} as never);
    await flush();

    expect(deleteForOwnerMock).toHaveBeenCalledTimes(3); // MAX_DELETE_ATTEMPTS_PER_KEY
    expect(db.user_deletion_jobs[0].avatar_cleanup_done).toBe(false);
    expect(db.user_deletion_jobs[0].status).toBe('purging_user');
    expect(db.user_deletion_jobs[0].attempt_count).toBe(1);
    expect(db.user_deletion_jobs[0].next_retry_at).toBeTruthy();
  });
});
