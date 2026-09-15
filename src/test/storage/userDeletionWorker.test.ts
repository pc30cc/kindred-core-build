/**
 * User (account) deletion worker — server/services/userDeletion/worker.ts,
 * rewritten to match the second corrective pass:
 *   - real lease fencing (lease_token / persistFenced / LeaseFencedError),
 *     mirroring workspaceDeletion/worker.ts exactly
 *   - MULTI-PROVIDER user storage cleanup ('default' + 'privacy_export'
 *     scopes, server/services/storage/userScopes.ts) via the shared
 *     scopeCleanupEngine.ts walker, not a single-scope best-effort sweep
 *   - collectWorkspaces inspects enqueue_workspace_deletion's BUSINESS
 *     result ({ok:false, error:...}), not just a transport error —
 *     'workspace_stuck_no_active_job' is a real failure,
 *     'workspace_not_found' is a benign race, not a failure
 *   - checkWorkspaceDeletionsComplete inspects an owned workspace's own
 *     latest deletion job status (not just whether the workspace row still
 *     exists) — a terminally 'failed' child job propagates as a failure
 *     here too, instead of polling forever
 *
 * Only `claimNext`, `startUserDeletionWorker` and `LeaseFencedError` are
 * exported — `collectWorkspaces`, `checkWorkspaceDeletionsComplete`,
 * `purgeUser` and `tick` are internal. Those internals are exercised here
 * by driving a single poll tick through `startUserDeletionWorker` (its
 * initial, immediate tick, with the periodic setInterval stubbed to a
 * no-op so nothing fires later) against a claimed job of the relevant
 * status, then flushing microtasks — same technique the old version of
 * this file used for the same constraint.
 *
 * `runScopeCleanupTick` (the shared engine `purgeUser` delegates to) is
 * mocked directly as a controllable outcome — it already has full
 * dedicated coverage in scopeCleanupEngine.test.ts; this file tests only
 * userDeletion/worker.ts's own responsibilities around it (wiring the
 * right scopes/prefix, persisting state, deciding retry/advance/complete).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type { UserDeletionJobRow } from '../../../server/services/userDeletion/types';

const USER_A = '22222222-2222-2222-2222-222222222222';
const WS_A = '11111111-1111-1111-1111-111111111111';
const WS_B = '33333333-3333-3333-3333-333333333333';
const JOB_1 = '77777777-7777-7777-7777-777777777771';
const ACTOR = '99999999-9999-9999-9999-999999999999';

const { runScopeCleanupTickMock, userStorageScopesMock } = vi.hoisted(() => ({
  runScopeCleanupTickMock: vi.fn(),
  userStorageScopesMock: vi.fn(),
}));

// runScopeCleanupTick already has full dedicated coverage
// (src/test/storage/scopeCleanupEngine.test.ts) — mock its outcome
// directly rather than driving real listing/deletion through it.
vi.mock('../../../server/services/storage/scopeCleanupEngine.js', () => ({
  runScopeCleanupTick: runScopeCleanupTickMock,
}));

// userScopes.ts's own resolution logic (resolveStorageConfigForOwner /
// resolvePrivacyStoragePolicy) is a separate, simple module — a light
// existence check that worker.ts wires it in correctly is enough here.
vi.mock('../../../server/services/storage/userScopes.js', () => ({
  userStorageScopes: userStorageScopesMock,
  userScopePrefix: (userId: string) => `users/${userId}/`,
}));

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
const rpcCalls: Array<{ fn: string; args: unknown }> = [];
const fromCalls: string[] = [];
let rpcHandlers: Record<string, (args: unknown) => { data?: unknown; error?: { message: string } | null }> = {};

/**
 * Generic chainable query-builder mock. Every filter/shape method mutates
 * internal state and returns the same builder, so any of the real code's
 * call shapes work without a bespoke builder per call site:
 *   .select().eq()                              -> awaited directly
 *   .select().in()                               -> awaited directly
 *   .select().in().order()                       -> awaited directly
 *   .select().eq().maybeSingle()                 -> awaited, {data: row|null}
 *   .update(patch).eq().eq().select('id')        -> awaited, {data: matched rows or []}
 * The builder implements `.then()` itself so `await` at any point in the
 * chain resolves — matching how the real Supabase client's query builder
 * (a thenable, not a Promise) behaves.
 */
function makeBuilder(table: string) {
  const rows = db[table] || (db[table] = []);
  const filters: Array<(r: Row) => boolean> = [];
  let updatePatch: Row | null = null;
  let orderBy: { col: string; ascending: boolean } | null = null;
  let single = false;

  const builder = {
    select: (_cols?: string) => builder,
    eq: (col: string, val: unknown) => {
      filters.push((r) => r[col] === val);
      return builder;
    },
    in: (col: string, vals: unknown[]) => {
      filters.push((r) => vals.includes(r[col]));
      return builder;
    },
    gt: (col: string, val: unknown) => {
      filters.push((r) => String(r[col]) > String(val));
      return builder;
    },
    limit: (_n: number) => builder,
    order: (col: string, opts?: { ascending?: boolean }) => {
      orderBy = { col, ascending: opts?.ascending !== false };
      return builder;
    },
    update: (patch: Row) => {
      updatePatch = patch;
      return builder;
    },
    maybeSingle: () => {
      single = true;
      return builder;
    },
    then(resolve: (v: { data: unknown; error: null }) => void) {
      let matched = rows.filter((r) => filters.every((f) => f(r)));
      if (updatePatch) {
        for (const r of matched) Object.assign(r, updatePatch);
        resolve({ data: matched.map((r) => ({ id: r.id })), error: null });
        return;
      }
      if (orderBy) {
        const { col, ascending } = orderBy;
        matched = [...matched].sort((a, b) => {
          const av = String(a[col]);
          const bv = String(b[col]);
          if (av < bv) return ascending ? -1 : 1;
          if (av > bv) return ascending ? 1 : -1;
          return 0;
        });
      }
      if (single) {
        resolve({ data: matched[0] ?? null, error: null });
        return;
      }
      resolve({ data: matched, error: null });
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
    storage_scopes: {},
    avatar_cleanup_done: false,
    purge_result: null,
    attempt_count: 0,
    next_retry_at: null,
    locked_by: null,
    lease_token: 'lease-token-1',
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

function currentJobRow(): Row {
  return db.user_deletion_jobs[0];
}

let workerMod: typeof import('../../../server/services/userDeletion/worker');

beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
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
  // Fifth corrective pass, P0 #1: hasActiveOwnerWriteLeases() now calls the
  // has_active_owner_write_leases RPC (DB-time-authoritative, grace-extended
  // — see migration 188) instead of querying owner_write_leases directly.
  // Mirror that RPC's logic here as the default handler so every test that
  // doesn't care about lease-drain gating gets a real "no active leases"
  // answer instead of silently fail-open-to-blocking on the generic
  // {data:null,error:null} fallback (which would make hasActiveOwnerWriteLeases
  // permanently report "leases outstanding" per its fail-toward-"wait" rule).
  const RECONCILIATION_GRACE_SECONDS = 600;
  rpcHandlers.has_active_owner_write_leases = (args) => {
    const { _owner_kind, _owner_id, _reconciliation_grace_seconds } = args as {
      _owner_kind: string; _owner_id: string; _reconciliation_grace_seconds?: number;
    };
    const grace = _reconciliation_grace_seconds ?? RECONCILIATION_GRACE_SECONDS;
    const leases = (db.owner_write_leases ?? []) as Row[];
    const now = Date.now();
    const active = leases.some((l) =>
      l.owner_kind === _owner_kind &&
      l.owner_id === _owner_id &&
      new Date(l.lease_expires_at as string).getTime() + grace * 1000 > now,
    );
    return { data: { ok: true, active }, error: null };
  };
  runScopeCleanupTickMock.mockReset();
  runScopeCleanupTickMock.mockResolvedValue({ kind: 'advance' });
  userStorageScopesMock.mockReset();
  userStorageScopesMock.mockReturnValue([
    { name: 'default', resolve: async () => ({ configured: false, reason: 'not configured in this test' }) },
    { name: 'privacy_export', resolve: async () => ({ configured: false, reason: 'not configured in this test' }) },
  ]);
  vi.mocked(console.warn).mockClear();
  // Fresh module instance per test: the module's `started` singleton guard
  // would otherwise make every startUserDeletionWorker() call after the
  // first a silent no-op.
  vi.resetModules();
  workerMod = await import('../../../server/services/userDeletion/worker');
});

describe('claimNext', () => {
  it('returns the claimed job (including its lease_token) when the RPC reports one', async () => {
    rpcHandlers.claim_user_deletion_job = () => ({ data: { ok: true, job: baseJob({ lease_token: 'fresh-token' }) }, error: null });

    const claimed = await workerMod.claimNext({} as never);

    expect(claimed?.id).toBe(JOB_1);
    expect(claimed?.status).toBe('collecting_workspaces');
    expect(claimed?.lease_token).toBe('fresh-token');
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
    db.user_deletion_jobs = [job as unknown as Row];
    db.workspaces = [
      { id: WS_A, owner_id: USER_A },
      { id: WS_B, owner_id: USER_A },
    ];
    rpcHandlers.claim_user_deletion_job = () => ({ data: { ok: true, job }, error: null });
    rpcHandlers.enqueue_workspace_deletion = () => ({ data: { ok: true, started: true, job: {} }, error: null });

    workerMod.startUserDeletionWorker({} as never);
    await flush();

    const enqueueCalls = rpcCalls.filter((c) => c.fn === 'enqueue_workspace_deletion');
    expect(enqueueCalls.map((c) => c.args)).toEqual([
      { _workspace_id: WS_A, _actor_user_id: ACTOR },
      { _workspace_id: WS_B, _actor_user_id: ACTOR },
    ]);
    expect(currentJobRow().status).toBe('awaiting_workspace_deletions');
    expect(currentJobRow().workspace_ids).toEqual([WS_A, WS_B]);
  });

  it('advances straight to awaiting_workspace_deletions with an empty list when the user owns nothing', async () => {
    const job = baseJob({ status: 'collecting_workspaces' });
    db.user_deletion_jobs = [job as unknown as Row];
    db.workspaces = [];
    rpcHandlers.claim_user_deletion_job = () => ({ data: { ok: true, job }, error: null });

    workerMod.startUserDeletionWorker({} as never);
    await flush();

    expect(rpcCalls.filter((c) => c.fn === 'enqueue_workspace_deletion')).toHaveLength(0);
    expect(currentJobRow().status).toBe('awaiting_workspace_deletions');
    expect(currentJobRow().workspace_ids).toEqual([]);
  });

  it('treats a SQL-successful enqueue that reports {ok:false, error:"workspace_stuck_no_active_job"} as a real failure — retries, never advances', async () => {
    const job = baseJob({ status: 'collecting_workspaces', attempt_count: 0 });
    db.user_deletion_jobs = [job as unknown as Row];
    db.workspaces = [{ id: WS_A, owner_id: USER_A }];
    rpcHandlers.claim_user_deletion_job = () => ({ data: { ok: true, job }, error: null });
    rpcHandlers.enqueue_workspace_deletion = () => ({ data: { ok: false, error: 'workspace_stuck_no_active_job' }, error: null });

    workerMod.startUserDeletionWorker({} as never);
    await flush();

    // No RPC transport error at all — the RPC call itself succeeded; the
    // worker must inspect the BUSINESS result, not just `error`.
    expect(currentJobRow().status).toBe('collecting_workspaces'); // never advanced
    expect(currentJobRow().attempt_count).toBe(1);
    expect(currentJobRow().error_message).toMatch(/workspace_stuck_no_active_job/);
    expect(currentJobRow().next_retry_at).toBeTruthy();
    expect(currentJobRow().locked_by).toBeNull();
  });

  it('treats {ok:false, error:"workspace_not_found"} as a benign race, not a failure — continues the loop and advances normally', async () => {
    const job = baseJob({ status: 'collecting_workspaces' });
    db.user_deletion_jobs = [job as unknown as Row];
    db.workspaces = [
      { id: WS_A, owner_id: USER_A },
      { id: WS_B, owner_id: USER_A },
    ];
    rpcHandlers.claim_user_deletion_job = () => ({ data: { ok: true, job }, error: null });
    rpcHandlers.enqueue_workspace_deletion = (args) => {
      const { _workspace_id } = args as { _workspace_id: string };
      if (_workspace_id === WS_A) return { data: { ok: false, error: 'workspace_not_found' }, error: null };
      return { data: { ok: true, started: true, job: {} }, error: null };
    };

    workerMod.startUserDeletionWorker({} as never);
    await flush();

    const enqueueCalls = rpcCalls.filter((c) => c.fn === 'enqueue_workspace_deletion');
    expect(enqueueCalls).toHaveLength(2); // both workspaces were attempted — the race didn't stop the loop
    expect(currentJobRow().status).toBe('awaiting_workspace_deletions'); // advanced normally, not treated as a failure
    expect(currentJobRow().workspace_ids).toEqual([WS_A, WS_B]);
    expect(currentJobRow().attempt_count).toBe(0); // never bumped
  });

  it('retries with backoff (does not fail immediately or advance) when an enqueue RPC call has a genuine transport error', async () => {
    const job = baseJob({ status: 'collecting_workspaces', attempt_count: 0 });
    db.user_deletion_jobs = [job as unknown as Row];
    db.workspaces = [
      { id: WS_A, owner_id: USER_A },
      { id: WS_B, owner_id: USER_A },
    ];
    rpcHandlers.claim_user_deletion_job = () => ({ data: { ok: true, job }, error: null });
    rpcHandlers.enqueue_workspace_deletion = () => ({ data: null, error: { message: 'boom' } });

    workerMod.startUserDeletionWorker({} as never);
    await flush();

    expect(currentJobRow().status).toBe('collecting_workspaces');
    expect(currentJobRow().attempt_count).toBe(1);
    expect(currentJobRow().error_message).toMatch(/boom/);
    expect(currentJobRow().next_retry_at).toBeTruthy();
    expect(currentJobRow().locked_by).toBeNull();
  });
});

describe('awaiting_workspace_deletions (via a single tick)', () => {
  it('advances to purging_user once every owned workspace is gone from workspaces', async () => {
    const job = baseJob({ status: 'awaiting_workspace_deletions', workspace_ids: [WS_A, WS_B] });
    db.user_deletion_jobs = [job as unknown as Row];
    db.workspaces = [];
    rpcHandlers.claim_user_deletion_job = () => ({ data: { ok: true, job }, error: null });

    workerMod.startUserDeletionWorker({} as never);
    await flush();

    expect(currentJobRow().status).toBe('purging_user');
  });

  it('stays put without bumping attempt_count while an owned workspace still exists and its latest deletion job is not terminally failed', async () => {
    const job = baseJob({
      status: 'awaiting_workspace_deletions',
      workspace_ids: [WS_A, WS_B],
      attempt_count: 2,
      locked_by: 'someone',
      lease_expires_at: new Date().toISOString(),
    });
    db.user_deletion_jobs = [job as unknown as Row];
    db.workspaces = [{ id: WS_A, owner_id: USER_A }]; // WS_B done, WS_A still in flight
    db.workspace_deletion_jobs = [{ workspace_id: WS_A, status: 'storage_cleanup', requested_at: new Date().toISOString() }];
    rpcHandlers.claim_user_deletion_job = () => ({ data: { ok: true, job }, error: null });

    workerMod.startUserDeletionWorker({} as never);
    await flush();

    expect(currentJobRow().status).toBe('awaiting_workspace_deletions');
    expect(currentJobRow().attempt_count).toBe(2); // unchanged — not a failure, just not ready
    expect(currentJobRow().locked_by).toBeNull();
    expect(currentJobRow().lease_expires_at).toBeNull();
  });

  it('treats a remaining workspace whose LATEST deletion job is terminally failed as a failure/retry condition for the user-deletion job', async () => {
    const job = baseJob({
      status: 'awaiting_workspace_deletions',
      workspace_ids: [WS_A, WS_B],
      attempt_count: 1,
    });
    db.user_deletion_jobs = [job as unknown as Row];
    db.workspaces = [{ id: WS_A, owner_id: USER_A }]; // WS_B already gone
    // Two jobs for WS_A — only the LATEST (by requested_at desc) should count.
    db.workspace_deletion_jobs = [
      { workspace_id: WS_A, status: 'storage_cleanup', requested_at: '2026-01-01T00:00:00.000Z' },
      { workspace_id: WS_A, status: 'failed', requested_at: '2026-01-02T00:00:00.000Z' },
    ];
    rpcHandlers.claim_user_deletion_job = () => ({ data: { ok: true, job }, error: null });

    workerMod.startUserDeletionWorker({} as never);
    await flush();

    expect(currentJobRow().status).toBe('awaiting_workspace_deletions'); // retry path never changes status
    expect(currentJobRow().attempt_count).toBe(2); // bumped — this is a failure, not "still in flight"
    expect(currentJobRow().error_message).toMatch(new RegExp(`${WS_A}|failed|retry`, 'i'));
    expect(currentJobRow().next_retry_at).toBeTruthy();
  });

  it('pushes the user-deletion job to terminal failed once attempt_count is already at the exhaustion threshold and a remaining workspace deletion has failed', async () => {
    const job = baseJob({
      status: 'awaiting_workspace_deletions',
      workspace_ids: [WS_A],
      attempt_count: 4, // MAX_JOB_ATTEMPTS = 5 -> next attempt (5) is terminal
    });
    db.user_deletion_jobs = [job as unknown as Row];
    db.workspaces = [{ id: WS_A, owner_id: USER_A }];
    db.workspace_deletion_jobs = [{ workspace_id: WS_A, status: 'failed', requested_at: new Date().toISOString() }];
    rpcHandlers.claim_user_deletion_job = () => ({ data: { ok: true, job }, error: null });

    workerMod.startUserDeletionWorker({} as never);
    await flush();

    expect(currentJobRow().status).toBe('failed');
    expect(currentJobRow().attempt_count).toBe(5);
  });

  it('goes straight to purging_user without ever querying workspaces when workspace_ids is empty', async () => {
    const job = baseJob({ status: 'awaiting_workspace_deletions', workspace_ids: [] });
    db.user_deletion_jobs = [job as unknown as Row];
    rpcHandlers.claim_user_deletion_job = () => ({ data: { ok: true, job }, error: null });

    workerMod.startUserDeletionWorker({} as never);
    await flush();

    expect(fromCalls).not.toContain('workspaces');
    expect(currentJobRow().status).toBe('purging_user');
  });
});

describe('purging_user (via a single tick) — multi-provider storage_scopes cleanup', () => {
  it('calls runScopeCleanupTick with the scopes from userStorageScopes(config, job.user_id) and the correct prefix/constants', async () => {
    const job = baseJob({ status: 'purging_user', lease_token: 'lease-token-1' });
    db.user_deletion_jobs = [job as unknown as Row];
    const fakeScopes = [
      { name: 'default', resolve: vi.fn() },
      { name: 'privacy_export', resolve: vi.fn() },
    ];
    userStorageScopesMock.mockReturnValue(fakeScopes);
    rpcHandlers.claim_user_deletion_job = () => ({ data: { ok: true, job }, error: null });
    rpcHandlers.admin_delete_user = () => ({ data: { ok: true }, error: null });
    runScopeCleanupTickMock.mockResolvedValueOnce({ kind: 'advance' });

    workerMod.startUserDeletionWorker({} as never);
    await flush();

    expect(userStorageScopesMock).toHaveBeenCalledWith({}, USER_A);
    expect(runScopeCleanupTickMock).toHaveBeenCalledTimes(1);
    const ctx = runScopeCleanupTickMock.mock.calls[0][0];
    expect(ctx.scopes).toBe(fakeScopes); // the exact two scopes userStorageScopes returned, unmodified
    expect(ctx.scopes).toHaveLength(2);
    expect(ctx.prefix).toBe(`users/${USER_A}/`);
    expect(ctx.maxDeleteAttemptsPerKey).toBe(3); // MAX_DELETE_ATTEMPTS_PER_KEY
    expect(ctx.heartbeatIntervalMs).toBe(15000); // HEARTBEAT_INTERVAL_MS
  });

  it("'advance': persists storage_scopes, then calls admin_delete_user and marks the job completed with its returned purge_result", async () => {
    const job = baseJob({ status: 'purging_user' });
    db.user_deletion_jobs = [job as unknown as Row];
    rpcHandlers.claim_user_deletion_job = () => ({ data: { ok: true, job }, error: null });
    rpcHandlers.admin_delete_user = () => ({ data: { purged_workspaces: 0 }, error: null });
    runScopeCleanupTickMock.mockImplementationOnce(async (ctx: { state: Record<string, unknown> }) => {
      ctx.state.default = { status: 'done', verified: true };
      return { kind: 'advance' };
    });

    workerMod.startUserDeletionWorker({} as never);
    await flush();

    const call = rpcCalls.find((c) => c.fn === 'admin_delete_user');
    expect(call?.args).toEqual({ _actor_user_id: ACTOR, _user_id: USER_A });
    expect(currentJobRow().status).toBe('completed');
    expect(currentJobRow().purge_result).toEqual({ purged_workspaces: 0 });
    expect(currentJobRow().completed_at).toBeTruthy();
    expect((currentJobRow().storage_scopes as Record<string, unknown>).default).toEqual({ status: 'done', verified: true });
  });

  it("'progress': persists storage_scopes and releases the lock, but does NOT call admin_delete_user yet (re-claimed next tick)", async () => {
    const job = baseJob({ status: 'purging_user', locked_by: 'worker-x', lease_expires_at: new Date().toISOString() });
    db.user_deletion_jobs = [job as unknown as Row];
    rpcHandlers.claim_user_deletion_job = () => ({ data: { ok: true, job }, error: null });
    runScopeCleanupTickMock.mockImplementationOnce(async (ctx: { state: Record<string, unknown> }) => {
      ctx.state.default = { status: 'in_progress', cursor: 'tok-1' };
      return { kind: 'progress' };
    });

    workerMod.startUserDeletionWorker({} as never);
    await flush();

    expect(rpcCalls.filter((c) => c.fn === 'admin_delete_user')).toHaveLength(0);
    expect(currentJobRow().status).toBe('purging_user');
    expect((currentJobRow().storage_scopes as Record<string, unknown>).default).toEqual({ status: 'in_progress', cursor: 'tok-1' });
    expect(currentJobRow().locked_by).toBeNull();
    expect(currentJobRow().lease_expires_at).toBeNull();
  });

  it("'error': retries with backoff (does not fail immediately), persisting whatever storage_scopes progress was made", async () => {
    const job = baseJob({ status: 'purging_user', attempt_count: 0 });
    db.user_deletion_jobs = [job as unknown as Row];
    rpcHandlers.claim_user_deletion_job = () => ({ data: { ok: true, job }, error: null });
    runScopeCleanupTickMock.mockImplementationOnce(async (ctx: { state: Record<string, unknown> }) => {
      ctx.state.privacy_export = { status: 'failed', error: 'storage_config_changed' };
      return { kind: 'error', message: 'scope privacy_export: storage_config_changed' };
    });

    workerMod.startUserDeletionWorker({} as never);
    await flush();

    expect(rpcCalls.filter((c) => c.fn === 'admin_delete_user')).toHaveLength(0);
    expect(currentJobRow().status).toBe('purging_user');
    expect(currentJobRow().attempt_count).toBe(1);
    expect(currentJobRow().error_message).toMatch(/storage_config_changed/);
    expect(currentJobRow().next_retry_at).toBeTruthy();
    expect((currentJobRow().storage_scopes as Record<string, unknown>).privacy_export).toEqual({ status: 'failed', error: 'storage_config_changed' });
  });

  it("'error': pushes the job to terminal failed once attempt_count is already at the exhaustion threshold", async () => {
    const job = baseJob({ status: 'purging_user', attempt_count: 4 });
    db.user_deletion_jobs = [job as unknown as Row];
    rpcHandlers.claim_user_deletion_job = () => ({ data: { ok: true, job }, error: null });
    runScopeCleanupTickMock.mockResolvedValueOnce({ kind: 'error', message: 'scope default: listing failed' });

    workerMod.startUserDeletionWorker({} as never);
    await flush();

    expect(currentJobRow().status).toBe('failed');
    expect(currentJobRow().attempt_count).toBe(5);
  });

  it('idempotent recovery: admin_delete_user errors but the profile is already gone — still completes', async () => {
    const job = baseJob({ status: 'purging_user' });
    db.user_deletion_jobs = [job as unknown as Row];
    db.profiles = []; // already purged by a prior crashed run
    rpcHandlers.claim_user_deletion_job = () => ({ data: { ok: true, job }, error: null });
    rpcHandlers.admin_delete_user = () => ({ data: null, error: { message: 'user not found' } });
    runScopeCleanupTickMock.mockResolvedValueOnce({ kind: 'advance' });

    workerMod.startUserDeletionWorker({} as never);
    await flush();

    expect(currentJobRow().status).toBe('completed');
  });

  it('real failure: admin_delete_user errors and the profile still exists — retries with backoff, not a terminal failure', async () => {
    const job = baseJob({ status: 'purging_user', attempt_count: 0 });
    db.user_deletion_jobs = [job as unknown as Row];
    db.profiles = [{ id: USER_A }];
    rpcHandlers.claim_user_deletion_job = () => ({ data: { ok: true, job }, error: null });
    rpcHandlers.admin_delete_user = () => ({ data: null, error: { message: 'not authorized' } });
    runScopeCleanupTickMock.mockResolvedValueOnce({ kind: 'advance' });

    workerMod.startUserDeletionWorker({} as never);
    await flush();

    expect(currentJobRow().status).toBe('purging_user');
    expect(currentJobRow().attempt_count).toBe(1);
    expect(currentJobRow().error_message).toMatch(/not authorized/);
    expect(currentJobRow().next_retry_at).toBeTruthy();
  });

  it('marks the job terminally failed once attempt_count is already at the retry threshold (admin_delete_user real failure)', async () => {
    const job = baseJob({ status: 'purging_user', attempt_count: 4 });
    db.user_deletion_jobs = [job as unknown as Row];
    db.profiles = [{ id: USER_A }];
    rpcHandlers.claim_user_deletion_job = () => ({ data: { ok: true, job }, error: null });
    rpcHandlers.admin_delete_user = () => ({ data: null, error: { message: 'not authorized' } });
    runScopeCleanupTickMock.mockResolvedValueOnce({ kind: 'advance' });

    workerMod.startUserDeletionWorker({} as never);
    await flush();

    expect(currentJobRow().status).toBe('failed'); // MAX_JOB_ATTEMPTS = 5
    expect(currentJobRow().attempt_count).toBe(5);
  });
});

describe('purgeUser — owner write lease drain (fourth corrective pass, P0 — TOCTOU close)', () => {
  it('an outstanding owner_write_lease for this user blocks the ENTIRE tick — no scope cleanup runs, no admin_delete_user call — and releases the job lease without bumping attempt_count', async () => {
    const job = baseJob({ status: 'purging_user', locked_by: 'worker-x', lease_expires_at: new Date().toISOString(), attempt_count: 0 });
    db.user_deletion_jobs = [job as unknown as Row];
    db.owner_write_leases = [{
      id: 'lease-1', lease_token: 'lease-tok-1', owner_kind: 'user', owner_id: USER_A,
      purpose: 'upload', lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    }];
    rpcHandlers.claim_user_deletion_job = () => ({ data: { ok: true, job }, error: null });

    workerMod.startUserDeletionWorker({} as never);
    await flush();

    expect(runScopeCleanupTickMock).not.toHaveBeenCalled();
    expect(rpcCalls.filter((c) => c.fn === 'admin_delete_user')).toHaveLength(0);
    expect(currentJobRow().status).toBe('purging_user');
    expect(currentJobRow().attempt_count).toBe(0);
    expect(currentJobRow().locked_by).toBeNull();
    expect(currentJobRow().lease_expires_at).toBeNull();
  });

  it('a lease that only JUST passed its nominal expiry (well within the 600s reconciliation grace period) still blocks the tick — fifth corrective pass, P0 #1: nominal TTL expiry alone is never proof the external write actually stopped', async () => {
    const job = baseJob({ status: 'purging_user', locked_by: 'worker-x', lease_expires_at: new Date().toISOString(), attempt_count: 0 });
    db.user_deletion_jobs = [job as unknown as Row];
    db.owner_write_leases = [{
      id: 'lease-1', lease_token: 'lease-tok-1', owner_kind: 'user', owner_id: USER_A,
      purpose: 'upload', lease_expires_at: new Date(Date.now() - 60_000).toISOString(),
    }];
    rpcHandlers.claim_user_deletion_job = () => ({ data: { ok: true, job }, error: null });

    workerMod.startUserDeletionWorker({} as never);
    await flush();

    expect(runScopeCleanupTickMock).not.toHaveBeenCalled();
    expect(currentJobRow().status).toBe('purging_user');
    expect(currentJobRow().attempt_count).toBe(0);
  });

  it('an owner_write_lease expired well beyond the reconciliation grace period (crashed producer, long gone) does not block — a crash never wedges account deletion forever', async () => {
    const job = baseJob({ status: 'purging_user' });
    db.user_deletion_jobs = [job as unknown as Row];
    db.owner_write_leases = [{
      id: 'lease-1', lease_token: 'lease-tok-1', owner_kind: 'user', owner_id: USER_A,
      purpose: 'upload', lease_expires_at: new Date(Date.now() - 700_000).toISOString(),
    }];
    rpcHandlers.claim_user_deletion_job = () => ({ data: { ok: true, job }, error: null });
    runScopeCleanupTickMock.mockResolvedValueOnce({ kind: 'progress' });

    workerMod.startUserDeletionWorker({} as never);
    await flush();

    expect(runScopeCleanupTickMock).toHaveBeenCalledTimes(1);
  });

  it('sixth corrective pass: a lease that appears AFTER the top-of-function drain check but BEFORE admin_delete_user is caught by the pre-purge recheck — admin_delete_user is never called, and the job is released (not purged) without bumping attempt_count, symmetric with workspaceDeletion/worker.ts\'s reassertSafeToPurge()', async () => {
    const job = baseJob({ status: 'purging_user', attempt_count: 0 });
    db.user_deletion_jobs = [job as unknown as Row];
    db.owner_write_leases = [];
    rpcHandlers.claim_user_deletion_job = () => ({ data: { ok: true, job }, error: null });
    rpcHandlers.admin_delete_user = () => ({ data: { ok: true }, error: null });
    // The top-of-function hasActiveOwnerWriteLeases() check passes (no
    // leases yet) — a lease appears only once storage cleanup itself
    // runs, modeling a producer that raced in between the two checks.
    runScopeCleanupTickMock.mockImplementationOnce(async (ctx: { state: Record<string, unknown> }) => {
      ctx.state.default = { status: 'done', verified: true };
      db.owner_write_leases = [{
        id: 'lease-late', lease_token: 'tok-late', owner_kind: 'user', owner_id: USER_A,
        purpose: 'upload', lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      }];
      return { kind: 'advance' };
    });

    workerMod.startUserDeletionWorker({} as never);
    await flush();

    expect(rpcCalls.filter((c) => c.fn === 'admin_delete_user')).toHaveLength(0);
    const row = currentJobRow();
    expect(row.status).toBe('purging_user'); // never purged
    expect(row.attempt_count).toBe(0); // not a failure — released to re-verify next tick
    expect(row.locked_by).toBeNull();
  });

  it('an owner_write_lease for a DIFFERENT user never blocks this one', async () => {
    const job = baseJob({ status: 'purging_user' });
    db.user_deletion_jobs = [job as unknown as Row];
    const OTHER_USER = '44444444-4444-4444-4444-444444444444';
    db.owner_write_leases = [{
      id: 'lease-1', lease_token: 'lease-tok-1', owner_kind: 'user', owner_id: OTHER_USER,
      purpose: 'upload', lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    }];
    rpcHandlers.claim_user_deletion_job = () => ({ data: { ok: true, job }, error: null });
    runScopeCleanupTickMock.mockResolvedValueOnce({ kind: 'progress' });

    workerMod.startUserDeletionWorker({} as never);
    await flush();

    expect(runScopeCleanupTickMock).toHaveBeenCalledTimes(1);
  });

  it('a lease for this same user_id under owner_kind "workspace" (a different owner namespace) never blocks the user-owned tick', async () => {
    const job = baseJob({ status: 'purging_user' });
    db.user_deletion_jobs = [job as unknown as Row];
    db.owner_write_leases = [{
      id: 'lease-1', lease_token: 'lease-tok-1', owner_kind: 'workspace', owner_id: USER_A,
      purpose: 'upload', lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    }];
    rpcHandlers.claim_user_deletion_job = () => ({ data: { ok: true, job }, error: null });
    runScopeCleanupTickMock.mockResolvedValueOnce({ kind: 'progress' });

    workerMod.startUserDeletionWorker({} as never);
    await flush();

    expect(runScopeCleanupTickMock).toHaveBeenCalledTimes(1);
  });
});

describe('lease fencing — a stale worker can never clobber a job reclaimed by another worker', () => {
  it('worker A finishes purging_user late (after worker B has already reclaimed the lease): the final completion write is rejected, LeaseFencedError is raised, and the row is provably unchanged by A', async () => {
    // 1. Worker A claims the job, minted lease_token 'token-A'.
    const job = baseJob({ status: 'purging_user', lease_token: 'token-A', locked_by: 'worker-A' });
    db.user_deletion_jobs = [job as unknown as Row];
    rpcHandlers.claim_user_deletion_job = () => ({ data: { ok: true, job }, error: null });
    runScopeCleanupTickMock.mockResolvedValueOnce({ kind: 'advance' });

    // 2. Worker A's storage_scopes engine settles instantly; A now calls
    //    admin_delete_user. Simulate that WHILE that RPC call is in flight,
    //    worker B's lease has expired and it reclaims the job — the row's
    //    lease_token (and locked_by) change out from under A.
    rpcHandlers.admin_delete_user = () => {
      const row = currentJobRow();
      row.lease_token = 'token-B';
      row.locked_by = 'worker-B';
      return { data: { purged_workspaces: 1 }, error: null };
    };

    // 3. Worker A "finishes late": it attempts its final persist (marking
    //    the job completed) still carrying its now-stale token 'token-A'.
    workerMod.startUserDeletionWorker({} as never);
    await flush();

    // 4. The write must be REJECTED — id+lease_token no longer matches any
    //    row (0 rows affected) — LeaseFencedError is thrown inside
    //    purgeUser, caught by tick(), and logged; nothing further happens.
    expect(console.warn).toHaveBeenCalled();
    const warnCall = vi.mocked(console.warn).mock.calls.find((c) => String(c[1] ?? '').includes('lease no longer held'));
    expect(warnCall).toBeTruthy();
    expect(String(warnCall?.[1])).toMatch(new RegExp(`${JOB_1}.*lease no longer held \\(fenced out\\).*another worker has reclaimed this job`));

    // 5. The row's state must remain provably whatever worker B (or the
    //    reclaim) set it to — never clobbered by A's rejected write.
    expect(currentJobRow().lease_token).toBe('token-B'); // still B's token, not touched by A
    expect(currentJobRow().locked_by).toBe('worker-B'); // still B's — A's `locked_by: null` patch never applied
    expect(currentJobRow().status).not.toBe('completed'); // A never got to mark it completed
    expect(currentJobRow().status).toBe('purging_user');
    expect(currentJobRow().purge_result).toBeNull(); // A never got to set this
    expect(currentJobRow().completed_at).toBeNull(); // A never got to set this
  });
});
