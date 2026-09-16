/**
 * Workspace deletion worker — server/services/workspaceDeletion/worker.ts.
 *
 * Covers this worker's OWN responsibilities post-rewrite (the shared
 * scope-walking algorithm itself — dedup, verification, drift detection,
 * heartbeat-during-delete-loop — has full dedicated coverage in
 * src/test/storage/scopeCleanupEngine.test.ts and is deliberately NOT
 * re-tested here; runScopeCleanupTick is mocked so its outcome is fully
 * controllable):
 *   - claimNext's translation of the claim RPC's {ok, job} shape
 *   - runStorageCleanup wiring: calling runScopeCleanupTick with the right
 *     scopes/prefix/heartbeat/persist, and translating its outcome
 *     ('advance' | 'progress' | 'error') into the right job-row patch
 *   - every job-row write is conditioned on `id AND lease_token`
 *     (persistFenced) — proven both via the heartbeat/persist callbacks
 *     directly and via retry/backoff and runDbCleanup's completion write
 *   - retry/backoff vs. terminal 'failed' once MAX_JOB_ATTEMPTS is reached
 *   - runDbCleanup's idempotent-recovery when admin_delete_workspace errors
 *     but the workspace row is already gone (a prior crashed run already
 *     committed the purge)
 *   - THE LEASE FENCING RACE: a worker whose lease was reclaimed by another
 *     worker must have its late write rejected (LeaseFencedError), and must
 *     never clobber the reclaiming worker's state
 *   - the outer `started` same-process guard on startWorkspaceDeletionWorker
 *
 * tickRunning (the INNER same-process guard against a second tick
 * overlapping a slow one within one process) is not directly exported and
 * has no clean observation point through the public API — verified by
 * reading worker.ts instead: tick() checks `if (tickRunning) return;` before
 * any work and clears it in a `finally`, so no dedicated test is forced here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  claimNext,
  runStorageCleanup,
  runDbCleanup,
  startWorkspaceDeletionWorker,
  LeaseFencedError,
} from '../../../server/services/workspaceDeletion/worker';
import type { WorkspaceDeletionJobRow, StorageScopesState } from '../../../server/services/workspaceDeletion/types';
import type { ScopeCleanupContext, ScopeCleanupOutcome } from '../../../server/services/storage/scopeCleanupEngine';
import type { WorkspaceStorageScope } from '../../../server/services/storage/workspaceScopes';

const WS_A = '11111111-1111-1111-1111-111111111111';
/** Stand-in for the analytics topology's scopes — see the deletionScopes mock below. */
const ANALYTICS_SCOPES = [{ name: 'analytics[analytics/web/]:arvan_storage', resolve: vi.fn() }];
const JOB_1 = '77777777-7777-7777-7777-777777777771';
const ACTOR = '99999999-9999-9999-9999-999999999999';

const {
  runScopeCleanupTickMock, workspaceStorageScopesMock, stopRecordingMock, findActiveEgressForRoomMock,
  analyticsStorageScopesMock, analyticsWorkspacePrefixesMock,
} = vi.hoisted(() => ({
  runScopeCleanupTickMock: vi.fn<(ctx: ScopeCleanupContext) => Promise<ScopeCleanupOutcome>>(),
  workspaceStorageScopesMock: vi.fn<(config: unknown, workspaceId: string) => WorkspaceStorageScope[]>(),
  analyticsStorageScopesMock: vi.fn(),
  analyticsWorkspacePrefixesMock: vi.fn(),
  stopRecordingMock: vi.fn<(config: unknown, recordingId: string) => Promise<{ recordingId: string; status: string }>>(),
  // Fifth corrective pass, P0: provider-side discovery for a call_session
  // stuck with no recording_id in metadata — mocked so its outcome
  // (found active egress(es) / confirmed none / unreachable) is
  // controllable without a real LiveKit connection.
  findActiveEgressForRoomMock: vi.fn<(config: unknown, roomName: string) => Promise<Array<{ egressId: string; status: string }>>>(),
}));

// worker.ts no longer talks to storage/index.js directly for listing/
// deleting — that moved entirely into scopeCleanupEngine.ts, which already
// has its own dedicated coverage. Here we mock the engine's single entry
// point directly so its outcome is fully controllable without driving the
// real listing/dedup/verification/drift logic.
vi.mock('../../../server/services/storage/scopeCleanupEngine.js', () => ({
  runScopeCleanupTick: runScopeCleanupTickMock,
}));

vi.mock('../../../server/services/storage/workspaceScopes.js', () => ({
  workspaceStorageScopes: workspaceStorageScopesMock,
  workspaceScopePrefix: (workspaceId: string) => `workspace/${workspaceId}/`,
}));

// Storage cleanup now purges TWO namespaces: the general `workspace/<id>/`
// objects and the independent analytics topology's
// `analytics/.../workspace=<id>/` objects. Which vendors and prefixes the
// analytics half resolves to is covered by
// src/test/analytics/analyticsDeletion.test.ts; here it is mocked so this
// file stays about the worker's own wiring and outcome translation.
vi.mock('../../../server/services/analytics/deletionScopes.js', () => ({
  analyticsStorageScopes: analyticsStorageScopesMock,
  analyticsWorkspacePrefixes: analyticsWorkspacePrefixesMock,
}));

// The LiveKit-Egress-quiescence step (third corrective pass) calls
// livekitProvider.stopRecording() directly — mocked so its outcome
// (a still-finalizing vs. an immediately-terminal stop) is controllable
// without a real LiveKit connection.
vi.mock('../../../server/services/calls/providers/livekitProvider.js', () => ({
  livekitProvider: { stopRecording: stopRecordingMock },
  findActiveEgressForRoom: findActiveEgressForRoomMock,
}));

type Row = Record<string, unknown>;
// Typed as unknown[] per table (rather than Row[]) so seeding a table with a
// concrete named type (e.g. `db.workspace_deletion_jobs = [baseJob()]`) type
// checks without a cast — WorkspaceDeletionJobRow has no index signature, so
// TS refuses to assign it directly into a Row[]-typed slot even though it is
// structurally a Row at runtime.
const db: Record<string, unknown[]> = {};
const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];

type RpcResponse = { data: unknown; error: { message: string } | null };
let claimResponseOverride: RpcResponse | null = null;
let renewResponseOverride: RpcResponse | null = null;
let adminDeleteResponse: RpcResponse = { data: null, error: null };
let claimTokenCounter = 0;

/**
 * `.from('workspace_deletion_jobs').update(patch).eq('id', x).eq('lease_token', y).select('id')`
 * must actually check EVERY `.eq()`/`.in()` predicate against the in-memory
 * row (not just the first one) — that's what lets the lease-fencing tests
 * below prove a stale worker's write is rejected once lease_token no longer
 * matches, exactly as the real Postgres `UPDATE ... WHERE id = $1 AND
 * lease_token = $2` would.
 *
 * Both the select and update chains are thenable so a caller can `await`
 * them directly without a trailing `.maybeSingle()`/`.select()` call —
 * exactly what `findNonTerminalRecordings()` (a bare `.select().eq().eq()
 * .in()`) and `quiesceLiveKitEgress()`'s `call_sessions` update (a bare
 * `.update().eq()`, no `.select()`) do against the real supabase-js client.
 */
function makeBuilder(table: string) {
  const rows = (db[table] || (db[table] = [])) as Row[];
  return {
    select: (_cols?: string) => {
      const filters: Array<(r: Row) => boolean> = [];
      const chain: Record<string, unknown> = {
        eq: (col: string, val: unknown) => {
          filters.push((r) => r[col] === val);
          return chain;
        },
        in: (col: string, vals: unknown[]) => {
          filters.push((r) => vals.includes(r[col]));
          return chain;
        },
        gt: (col: string, val: unknown) => {
          filters.push((r) => String(r[col]) > String(val));
          return chain;
        },
        limit: (_n: number) => chain,
        maybeSingle: async () => {
          const matched = rows.filter((r) => filters.every((f) => f(r)));
          return { data: matched[0] ?? null, error: null };
        },
        then: (resolve: (v: { data: Row[]; error: null }) => void) => {
          const matched = rows.filter((r) => filters.every((f) => f(r)));
          resolve({ data: matched, error: null });
        },
      };
      return chain;
    },
    update: (patch: Row) => {
      const filters: Array<(r: Row) => boolean> = [];
      const chain: Record<string, unknown> = {
        eq: (col: string, val: unknown) => {
          filters.push((r) => r[col] === val);
          return chain;
        },
        select: async (_cols?: string) => {
          const matched = rows.filter((r) => filters.every((f) => f(r)));
          for (const r of matched) Object.assign(r, patch);
          return { data: matched.map((r) => ({ id: r.id })), error: null };
        },
        then: (resolve: (v: { data: null; error: null }) => void) => {
          const matched = rows.filter((r) => filters.every((f) => f(r)));
          for (const r of matched) Object.assign(r, patch);
          resolve({ data: null, error: null });
        },
      };
      return chain;
    },
  };
}

/**
 * rpc() handles three distinct RPCs:
 *   - claim_workspace_deletion_job: by default mints a fresh fake
 *     lease_token on the single seeded workspace_deletion_jobs row (exactly
 *     as claim_workspace_deletion_job()'s `gen_random_uuid()` would on a
 *     fresh claim OR a reclaim), so real claimNext() calls compose with the
 *     fencing tests below. A test can override this entirely via
 *     claimResponseOverride for the simpler claimNext() unit tests.
 *   - renew_workspace_deletion_lease: by default succeeds only if the
 *     caller's _lease_token still matches the row's current lease_token,
 *     mirroring 185_deletion_lease_fencing.sql's WHERE clause.
 *   - admin_delete_workspace: fully controlled by adminDeleteResponse.
 */
async function rpc(fn: string, args: Record<string, unknown>): Promise<RpcResponse> {
  rpcCalls.push({ fn, args });

  if (fn === 'claim_workspace_deletion_job') {
    if (claimResponseOverride) return claimResponseOverride;
    const row = db.workspace_deletion_jobs?.[0] as Row | undefined;
    if (!row) return { data: { ok: true, job: null }, error: null };
    claimTokenCounter += 1;
    row.lease_token = `token-${claimTokenCounter}`;
    if (row.status === 'pending') row.status = 'storage_cleanup';
    return { data: { ok: true, job: { ...row } }, error: null };
  }

  if (fn === 'renew_workspace_deletion_lease') {
    if (renewResponseOverride) return renewResponseOverride;
    const row = db.workspace_deletion_jobs?.[0] as Row | undefined;
    const ok = !!row && row.lease_token === args._lease_token;
    return {
      data: ok ? { ok: true, lease_expires_at: new Date().toISOString() } : { ok: false, error: 'fenced_out' },
      error: null,
    };
  }

  if (fn === 'admin_delete_workspace') return adminDeleteResponse;

  if (fn === 'has_active_owner_write_leases') {
    // Mirrors 188_owner_write_lease_hardening.sql's DB-time,
    // grace-extended comparison — a lease keeps counting as active
    // until `lease_expires_at + reconciliation_grace_seconds`, not just
    // `lease_expires_at`.
    const ownerKind = args._owner_kind as string;
    const ownerId = args._owner_id as string;
    const graceSeconds = typeof args._reconciliation_grace_seconds === 'number' ? args._reconciliation_grace_seconds : 600;
    const rows = (db.owner_write_leases || []) as Row[];
    const nowMs = Date.now();
    const active = rows.some((r) => r.owner_kind === ownerKind && r.owner_id === ownerId
      && new Date(r.lease_expires_at as string).getTime() + graceSeconds * 1000 > nowMs);
    return { data: { ok: true, active }, error: null };
  }

  return { data: null, error: null };
}

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: (table: string) => makeBuilder(table),
    rpc,
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
    lease_token: 'lease-token-1',
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

function currentJobRow(): Row {
  return db.workspace_deletion_jobs[0] as Row;
}

beforeEach(() => {
  for (const key of Object.keys(db)) delete db[key];
  runScopeCleanupTickMock.mockReset();
  analyticsStorageScopesMock.mockReset();
  analyticsWorkspacePrefixesMock.mockReset();
  analyticsStorageScopesMock.mockResolvedValue(ANALYTICS_SCOPES);
  analyticsWorkspacePrefixesMock.mockResolvedValue([
    { poolPrefix: 'analytics/web/', workspacePrefix: `analytics/web/workspace=${WS_A}/` },
  ]);
  workspaceStorageScopesMock.mockReset();
  workspaceStorageScopesMock.mockReturnValue([]);
  stopRecordingMock.mockReset();
  findActiveEgressForRoomMock.mockReset();
  findActiveEgressForRoomMock.mockResolvedValue([]);
  rpcCalls.length = 0;
  claimResponseOverride = null;
  renewResponseOverride = null;
  adminDeleteResponse = { data: null, error: null };
  claimTokenCounter = 0;
});

function callSessionRow(overrides: Partial<Row> = {}): Row {
  return {
    id: 'cs-1',
    workspace_id: WS_A,
    provider: 'livekit',
    provider_room_id: 'room-1',
    recording_state: 'recording',
    metadata: { recording: { recording_id: 'egress-1' } },
    ...overrides,
  };
}

describe('claimNext', () => {
  it('returns the claimed job (including lease_token) when the RPC reports ok with a job', async () => {
    const job = baseJob({ lease_token: 'tok-abc' });
    claimResponseOverride = { data: { ok: true, job }, error: null };

    const claimed = await claimNext({} as never);

    expect(claimed).toEqual(job);
    expect(claimed?.lease_token).toBe('tok-abc');
    expect(rpcCalls[0].fn).toBe('claim_workspace_deletion_job');
    expect(rpcCalls[0].args).toMatchObject({ _lease_seconds: 60 });
  });

  it('returns null when the RPC reports ok with nothing claimable', async () => {
    claimResponseOverride = { data: { ok: true, job: null }, error: null };

    expect(await claimNext({} as never)).toBeNull();
  });

  it('returns null when the RPC itself errors', async () => {
    claimResponseOverride = { data: null, error: { message: 'boom' } };

    expect(await claimNext({} as never)).toBeNull();
  });

  it('returns null when data.ok is false', async () => {
    claimResponseOverride = { data: { ok: false, job: null }, error: null };

    expect(await claimNext({} as never)).toBeNull();
  });
});

describe('runStorageCleanup — engine wiring', () => {
  it('calls runScopeCleanupTick with the scopes from workspaceStorageScopes, the workspace prefix, and heartbeat/persist functions', async () => {
    const scopes = [{ name: 'attachment', resolve: vi.fn() }] as unknown as WorkspaceStorageScope[];
    workspaceStorageScopesMock.mockReturnValue(scopes);
    runScopeCleanupTickMock.mockResolvedValueOnce({ kind: 'progress' });
    const job = baseJob();
    db.workspace_deletion_jobs = [baseJob()];

    await runStorageCleanup({} as never, job);

    expect(workspaceStorageScopesMock).toHaveBeenCalledWith({}, WS_A);
    // The general namespace goes first and, having reported progress, the
    // tick returns before the analytics pass — progress always yields the
    // lease rather than running every namespace in one tick.
    expect(runScopeCleanupTickMock).toHaveBeenCalledTimes(1);
    const ctx = runScopeCleanupTickMock.mock.calls[0][0];
    expect(ctx.scopes).toBe(scopes);
    expect(ctx.prefix).toBe(`workspace/${WS_A}/`);
    expect(typeof ctx.heartbeat).toBe('function');
    expect(typeof ctx.persist).toBe('function');
  });

  it('purges the ANALYTICS namespace too, with its own scopes and its own prefix, before db_cleanup', async () => {
    const scopes = [{ name: 'attachment', resolve: vi.fn() }] as unknown as WorkspaceStorageScope[];
    workspaceStorageScopesMock.mockReturnValue(scopes);
    runScopeCleanupTickMock.mockResolvedValue({ kind: 'advance' });
    db.workspace_deletion_jobs = [baseJob({ status: 'storage_cleanup' })];

    await runStorageCleanup({} as never, baseJob({ status: 'storage_cleanup' }));

    expect(runScopeCleanupTickMock).toHaveBeenCalledTimes(2);

    const general = runScopeCleanupTickMock.mock.calls[0][0];
    expect(general.prefix).toBe(`workspace/${WS_A}/`);
    expect(general.scopes).toBe(scopes);

    const analytics = runScopeCleanupTickMock.mock.calls[1][0];
    // A DIFFERENT namespace on a DIFFERENT topology — never the general one.
    expect(analytics.prefix).toBe(`analytics/web/workspace=${WS_A}/`);
    expect(analytics.scopes).toBe(ANALYTICS_SCOPES);
    // Both passes share one persisted state map, so progress survives a restart.
    expect(analytics.state).toBe(general.state);

    expect(currentJobRow().status).toBe('db_cleanup');
  });

  it('walks EVERY prefix the analytics pool has ever used, so a prefix change cannot strand a deleted workspace\u2019s objects', async () => {
    workspaceStorageScopesMock.mockReturnValue([] as unknown as WorkspaceStorageScope[]);
    analyticsWorkspacePrefixesMock.mockResolvedValue([
      { poolPrefix: 'analytics/old/', workspacePrefix: `analytics/old/workspace=${WS_A}/` },
      { poolPrefix: 'analytics/web/', workspacePrefix: `analytics/web/workspace=${WS_A}/` },
    ]);
    runScopeCleanupTickMock.mockResolvedValue({ kind: 'advance' });
    db.workspace_deletion_jobs = [baseJob({ status: 'storage_cleanup' })];

    await runStorageCleanup({} as never, baseJob({ status: 'storage_cleanup' }));

    const prefixes = runScopeCleanupTickMock.mock.calls.map((c) => c[0].prefix);
    expect(prefixes).toEqual([
      `workspace/${WS_A}/`,
      `analytics/old/workspace=${WS_A}/`,
      `analytics/web/workspace=${WS_A}/`,
    ]);
    expect(currentJobRow().status).toBe('db_cleanup');
  });

  it('never reaches db_cleanup while the ANALYTICS namespace is still being walked', async () => {
    workspaceStorageScopesMock.mockReturnValue([] as unknown as WorkspaceStorageScope[]);
    runScopeCleanupTickMock
      .mockResolvedValueOnce({ kind: 'advance' })   // general namespace finished
      .mockResolvedValueOnce({ kind: 'progress' }); // analytics namespace still going
    db.workspace_deletion_jobs = [baseJob({ status: 'storage_cleanup' })];

    await runStorageCleanup({} as never, baseJob({ status: 'storage_cleanup' }));

    expect(runScopeCleanupTickMock).toHaveBeenCalledTimes(2);
    expect(currentJobRow().status).toBe('storage_cleanup');
    expect(currentJobRow().locked_by).toBeNull();
  });

  it('an analytics-namespace failure retries the job and never advances to the DB purge', async () => {
    workspaceStorageScopesMock.mockReturnValue([] as unknown as WorkspaceStorageScope[]);
    runScopeCleanupTickMock
      .mockResolvedValueOnce({ kind: 'advance' })
      .mockResolvedValueOnce({ kind: 'error', message: 'analytics[analytics/web/]:minio listing failed: unreachable' });
    db.workspace_deletion_jobs = [baseJob({ status: 'storage_cleanup' })];

    await runStorageCleanup({} as never, baseJob({ status: 'storage_cleanup' }));

    const row = currentJobRow();
    expect(row.status).toBe('storage_cleanup');
    expect(row.attempt_count).toBe(1);
    expect(String(row.error_message)).toContain('analytics');
  });

  it('a failure to resolve the analytics topology blocks the purge rather than silently skipping it', async () => {
    workspaceStorageScopesMock.mockReturnValue([] as unknown as WorkspaceStorageScope[]);
    analyticsWorkspacePrefixesMock.mockRejectedValue(new Error('analytics pool unreadable'));
    db.workspace_deletion_jobs = [baseJob({ status: 'storage_cleanup' })];

    await runStorageCleanup({} as never, baseJob({ status: 'storage_cleanup' }));

    expect(runScopeCleanupTickMock).not.toHaveBeenCalled();
    expect(currentJobRow().status).toBe('storage_cleanup');
    expect(String(currentJobRow().error_message)).toContain('analytics pool unreadable');
  });

  it('on {kind:"advance"} from EVERY namespace: advances status to db_cleanup and releases the lock, conditioned on lease_token', async () => {
    runScopeCleanupTickMock.mockResolvedValue({ kind: 'advance' });
    db.workspace_deletion_jobs = [
      baseJob({ status: 'storage_cleanup', locked_by: 'worker-x', lease_expires_at: new Date().toISOString() }),
    ];

    await runStorageCleanup({} as never, baseJob({ status: 'storage_cleanup' }));

    const row = currentJobRow();
    expect(row.status).toBe('db_cleanup');
    expect(row.locked_by).toBeNull();
    expect(row.lease_expires_at).toBeNull();
  });

  it('on {kind:"progress"}: persists storage_scopes and releases the lock, but does NOT advance status to db_cleanup', async () => {
    const progressState: StorageScopesState = {
      attachment: { status: 'in_progress', cursor: 'tok-1', objects_found: 1, objects_deleted: 1, error: null, fingerprint: 'fp-a', dedup_of: null, verified: false },
    };
    runScopeCleanupTickMock.mockImplementationOnce(async (ctx) => {
      Object.assign(ctx.state, progressState); // the real engine mutates ctx.state in place
      return { kind: 'progress' };
    });
    db.workspace_deletion_jobs = [baseJob({ status: 'storage_cleanup', locked_by: 'worker-x' })];

    await runStorageCleanup({} as never, baseJob({ status: 'storage_cleanup' }));

    const row = currentJobRow();
    expect(row.status).toBe('storage_cleanup'); // unchanged
    expect(row.locked_by).toBeNull();
    expect(row.storage_scopes).toEqual(progressState);
  });

  it('on {kind:"error"}: retries with backoff (attempt_count increments, next_retry_at set) and does NOT set status to failed while below MAX_JOB_ATTEMPTS', async () => {
    runScopeCleanupTickMock.mockResolvedValueOnce({ kind: 'error', message: 'scope attachment listing failed: provider_unreachable' });
    db.workspace_deletion_jobs = [baseJob({ status: 'storage_cleanup', attempt_count: 0 })];

    await runStorageCleanup({} as never, baseJob({ status: 'storage_cleanup', attempt_count: 0 }));

    const row = currentJobRow();
    expect(row.status).toBe('storage_cleanup'); // retry path never sets status
    expect(row.attempt_count).toBe(1);
    expect(row.next_retry_at).toBeTruthy();
    expect(row.error_message).toMatch(/provider_unreachable/);
    expect(row.locked_by).toBeNull();
    expect(row.lease_expires_at).toBeNull();
  });

  it('on {kind:"error"}: terminally fails once attempt_count reaches MAX_JOB_ATTEMPTS=5 (starting from attempt_count 4)', async () => {
    runScopeCleanupTickMock.mockResolvedValueOnce({ kind: 'error', message: 'permission_denied' });
    db.workspace_deletion_jobs = [baseJob({ status: 'storage_cleanup', attempt_count: 4 })];

    await runStorageCleanup({} as never, baseJob({ status: 'storage_cleanup', attempt_count: 4 }));

    const row = currentJobRow();
    expect(row.status).toBe('failed');
    expect(row.attempt_count).toBe(5);
    expect(row.error_message).toMatch(/permission_denied/);
  });

  it('the heartbeat callback calls renew_workspace_deletion_lease with the job id and lease_token', async () => {
    runScopeCleanupTickMock.mockResolvedValueOnce({ kind: 'progress' });
    const job = baseJob({ lease_token: 'tok-hb' });
    db.workspace_deletion_jobs = [baseJob({ lease_token: 'tok-hb' })];

    await runStorageCleanup({} as never, job);
    const ctx = runScopeCleanupTickMock.mock.calls[0][0];

    const stillHeld = await ctx.heartbeat();

    expect(stillHeld).toBe(true);
    const renewCall = rpcCalls.find((c) => c.fn === 'renew_workspace_deletion_lease');
    expect(renewCall?.args).toMatchObject({ _job_id: JOB_1, _lease_token: 'tok-hb' });
  });

  it('the persist callback conditions its write on id AND lease_token — succeeds while the token matches, throws LeaseFencedError once it no longer does', async () => {
    runScopeCleanupTickMock.mockResolvedValueOnce({ kind: 'progress' });
    const job = baseJob({ lease_token: 'tok-persist' });
    db.workspace_deletion_jobs = [baseJob({ lease_token: 'tok-persist' })];

    await runStorageCleanup({} as never, job);
    const ctx = runScopeCleanupTickMock.mock.calls[0][0];

    const newState: StorageScopesState = {
      attachment: { status: 'done', cursor: null, objects_found: 1, objects_deleted: 1, error: null, fingerprint: 'fp', dedup_of: null, verified: true },
    };
    await ctx.persist(newState);
    expect(currentJobRow().storage_scopes).toEqual(newState);

    // Another worker reclaims the job — id still matches, lease_token does not.
    currentJobRow().lease_token = 'someone-elses-token';
    await expect(ctx.persist(newState)).rejects.toThrow(LeaseFencedError);
  });
});

describe('runStorageCleanup — LiveKit Egress quiescence (third corrective pass, P0 #3)', () => {
  it('no active recordings for the workspace: quiescent immediately, storage cleanup proceeds on the same tick', async () => {
    runScopeCleanupTickMock.mockResolvedValueOnce({ kind: 'progress' });
    db.workspace_deletion_jobs = [baseJob({ status: 'storage_cleanup' })];
    db.call_sessions = [];

    await runStorageCleanup({} as never, baseJob({ status: 'storage_cleanup' }));

    expect(runScopeCleanupTickMock).toHaveBeenCalledTimes(1);
    expect(stopRecordingMock).not.toHaveBeenCalled();
  });

  it('already-running LiveKit Egress (recording_state=recording) at deletion start: stop is requested, storage cleanup does NOT run this tick, and the job stays in storage_cleanup without bumping attempt_count', async () => {
    db.call_sessions = [callSessionRow({ recording_state: 'recording' })];
    stopRecordingMock.mockResolvedValueOnce({ recordingId: 'egress-1', status: 'finalizing' });
    db.workspace_deletion_jobs = [
      baseJob({ status: 'storage_cleanup', locked_by: 'worker-x', lease_expires_at: new Date().toISOString(), attempt_count: 0 }),
    ];

    await runStorageCleanup({} as never, baseJob({ status: 'storage_cleanup', attempt_count: 0 }));

    expect(stopRecordingMock).toHaveBeenCalledWith({}, 'egress-1');
    expect(runScopeCleanupTickMock).not.toHaveBeenCalled();
    const call = (db.call_sessions[0] as Row);
    expect(call.recording_state).toBe('finalizing'); // stop requested, not yet confirmed terminal by the webhook
    const row = currentJobRow();
    expect(row.status).toBe('storage_cleanup'); // never advanced while Egress is still capable of producing bytes
    expect(row.attempt_count).toBe(0); // not a failure — released the lease and waits for a later tick, doesn't count toward MAX_JOB_ATTEMPTS
    expect(row.locked_by).toBeNull();
    expect(row.lease_expires_at).toBeNull();
  });

  it('a recording already in recording_state=finalizing (stop already requested by a prior tick) is left alone — no redundant stop call — and storage cleanup still does not run until the webhook marks it terminal', async () => {
    db.call_sessions = [callSessionRow({ recording_state: 'finalizing' })];
    db.workspace_deletion_jobs = [baseJob({ status: 'storage_cleanup' })];

    await runStorageCleanup({} as never, baseJob({ status: 'storage_cleanup' }));

    expect(stopRecordingMock).not.toHaveBeenCalled();
    expect(runScopeCleanupTickMock).not.toHaveBeenCalled();
    expect(currentJobRow().status).toBe('storage_cleanup');
  });

  it('once the webhook has already marked every recording terminal (available/failed/disabled), quiescence is immediate and storage cleanup runs — this is the "only trust final verification after quiescence" ordering', async () => {
    runScopeCleanupTickMock.mockResolvedValue({ kind: 'advance' });
    db.call_sessions = [
      callSessionRow({ id: 'cs-1', recording_state: 'available' }),
      callSessionRow({ id: 'cs-2', recording_state: 'failed' }),
    ];
    db.workspace_deletion_jobs = [baseJob({ status: 'storage_cleanup' })];

    await runStorageCleanup({} as never, baseJob({ status: 'storage_cleanup' }));

    expect(stopRecordingMock).not.toHaveBeenCalled();
    // One pass for the general namespace, one for the analytics namespace.
    expect(runScopeCleanupTickMock).toHaveBeenCalledTimes(2);
    expect(currentJobRow().status).toBe('db_cleanup');
  });

  it('Egress shutdown/finalization ordering: a recording resolves to terminal only across ticks, never on the same tick a stop was issued — trusting storage never happens before that', async () => {
    db.call_sessions = [callSessionRow({ recording_state: 'recording' })];
    stopRecordingMock.mockResolvedValueOnce({ recordingId: 'egress-1', status: 'finalizing' });
    db.workspace_deletion_jobs = [baseJob({ status: 'storage_cleanup' })];

    // Tick 1: stop requested, still not quiescent — storage untouched.
    await runStorageCleanup({} as never, baseJob({ status: 'storage_cleanup' }));
    expect(runScopeCleanupTickMock).not.toHaveBeenCalled();
    expect((db.call_sessions[0] as Row).recording_state).toBe('finalizing');

    // The webhook lands between ticks and marks it terminal.
    (db.call_sessions[0] as Row).recording_state = 'available';

    // Tick 2: now quiescent — storage cleanup finally runs.
    runScopeCleanupTickMock.mockResolvedValueOnce({ kind: 'progress' });
    await runStorageCleanup({} as never, baseJob({ status: 'storage_cleanup' }));
    expect(runScopeCleanupTickMock).toHaveBeenCalledTimes(1);
  });

  it('a call_session with a non-terminal recording_state, no recoverable LiveKit recording id in metadata, AND no provider_room_id fails the tick (retryable) rather than silently proceeding — storage cleanup never runs', async () => {
    // Cannot even ATTEMPT provider-side discovery without a room to ask
    // LiveKit about — this is the one case fifth-pass reconciliation
    // cannot resolve, and it must still fail loudly and retryably.
    db.call_sessions = [callSessionRow({ recording_state: 'recording', metadata: {}, provider_room_id: null })];
    db.workspace_deletion_jobs = [baseJob({ status: 'storage_cleanup', attempt_count: 0 })];

    await runStorageCleanup({} as never, baseJob({ status: 'storage_cleanup', attempt_count: 0 }));

    expect(stopRecordingMock).not.toHaveBeenCalled();
    expect(findActiveEgressForRoomMock).not.toHaveBeenCalled();
    expect(runScopeCleanupTickMock).not.toHaveBeenCalled();
    const row = currentJobRow();
    expect(row.status).toBe('storage_cleanup'); // retry path, never advances and never purges
    expect(row.attempt_count).toBe(1);
    expect(row.error_message).toMatch(/no provider_room_id/);
  });

  it('a call_session with a non-terminal recording_state and no recoverable recording id, but WITH a provider_room_id: provider-side discovery finds nothing active — resolved as terminal (available), storage cleanup still waits this same tick, and the job is not counted as a failed attempt', async () => {
    db.call_sessions = [callSessionRow({ recording_state: 'recording', metadata: {} })]; // default provider_room_id: 'room-1'
    findActiveEgressForRoomMock.mockResolvedValueOnce([]);
    db.workspace_deletion_jobs = [baseJob({ status: 'storage_cleanup', attempt_count: 0 })];

    await runStorageCleanup({} as never, baseJob({ status: 'storage_cleanup', attempt_count: 0 }));

    expect(findActiveEgressForRoomMock).toHaveBeenCalledWith({}, 'room-1');
    expect(stopRecordingMock).not.toHaveBeenCalled();
    expect(runScopeCleanupTickMock).not.toHaveBeenCalled(); // resolved via discovery this tick — never trust storage on the same tick a row was just resolved
    expect((db.call_sessions[0] as Row).recording_state).toBe('available');
    const row = currentJobRow();
    expect(row.status).toBe('storage_cleanup'); // not a failure — released and waits for the next tick
    expect(row.attempt_count).toBe(0);
    expect(row.error_message).toBeNull();
  });

  it('a call_session with a non-terminal recording_state and no recoverable recording id, but WITH a provider_room_id: provider-side discovery finds an active egress — its id is persisted, it is stopped, and the row is marked finalizing (never immediately trusted)', async () => {
    db.call_sessions = [callSessionRow({ recording_state: 'recording', metadata: {} })];
    findActiveEgressForRoomMock.mockResolvedValueOnce([{ egressId: 'egress-discovered', status: 'active' }]);
    stopRecordingMock.mockResolvedValueOnce({ recordingId: 'egress-discovered', status: 'finalizing' });
    db.workspace_deletion_jobs = [baseJob({ status: 'storage_cleanup', attempt_count: 0 })];

    await runStorageCleanup({} as never, baseJob({ status: 'storage_cleanup', attempt_count: 0 }));

    expect(findActiveEgressForRoomMock).toHaveBeenCalledWith({}, 'room-1');
    expect(stopRecordingMock).toHaveBeenCalledWith({}, 'egress-discovered');
    expect(runScopeCleanupTickMock).not.toHaveBeenCalled();
    const call = db.call_sessions[0] as Row;
    expect(call.recording_state).toBe('finalizing');
    expect((call.metadata as Row).recording).toMatchObject({ recording_id: 'egress-discovered' });
    const row = currentJobRow();
    expect(row.status).toBe('storage_cleanup');
    expect(row.attempt_count).toBe(0); // discovering and stopping a real egress is not a job failure
  });

  it('provider-side discovery itself failing (LiveKit unreachable) is a retryable job error — never silently treated as "nothing active"', async () => {
    db.call_sessions = [callSessionRow({ recording_state: 'recording', metadata: {} })];
    findActiveEgressForRoomMock.mockRejectedValueOnce(new Error('livekit_list_egress_unreachable'));
    db.workspace_deletion_jobs = [baseJob({ status: 'storage_cleanup', attempt_count: 0 })];

    await runStorageCleanup({} as never, baseJob({ status: 'storage_cleanup', attempt_count: 0 }));

    expect(stopRecordingMock).not.toHaveBeenCalled();
    expect(runScopeCleanupTickMock).not.toHaveBeenCalled();
    const row = currentJobRow();
    expect(row.status).toBe('storage_cleanup');
    expect(row.attempt_count).toBe(1);
    expect(row.error_message).toMatch(/livekit_list_egress_unreachable/);
  });

  it('Egress shutdown failure prevents DB purge: a stopRecording() failure is a retryable job error, never treated as quiescent, and storage cleanup does not run that tick', async () => {
    db.call_sessions = [callSessionRow({ recording_state: 'recording' })];
    stopRecordingMock.mockRejectedValueOnce(new Error('livekit_egress_unreachable'));
    db.workspace_deletion_jobs = [baseJob({ status: 'storage_cleanup', attempt_count: 0 })];

    await runStorageCleanup({} as never, baseJob({ status: 'storage_cleanup', attempt_count: 0 }));

    expect(runScopeCleanupTickMock).not.toHaveBeenCalled();
    const row = currentJobRow();
    expect(row.status).toBe('storage_cleanup');
    expect(row.attempt_count).toBe(1);
    expect(row.error_message).toMatch(/livekit_egress_unreachable/);
  });

  it('Egress shutdown failure exhausting MAX_JOB_ATTEMPTS terminally fails the job — it still never reaches db_cleanup, so admin_delete_workspace (the DB purge) is never called while Egress could still produce a workspace-owned recording', async () => {
    db.call_sessions = [callSessionRow({ recording_state: 'recording' })];
    stopRecordingMock.mockRejectedValueOnce(new Error('livekit_egress_unreachable'));
    db.workspace_deletion_jobs = [baseJob({ status: 'storage_cleanup', attempt_count: 4 })];

    await runStorageCleanup({} as never, baseJob({ status: 'storage_cleanup', attempt_count: 4 }));

    expect(runScopeCleanupTickMock).not.toHaveBeenCalled();
    const row = currentJobRow();
    expect(row.status).toBe('failed'); // terminal — a human must intervene, but this is not the same as purging the DB
    expect(rpcCalls.some((c) => c.fn === 'admin_delete_workspace')).toBe(false);
  });

  it('only recordings belonging to THIS workspace and provider=livekit gate quiescence — an unrelated workspace or a non-LiveKit provider row never blocks storage cleanup', async () => {
    runScopeCleanupTickMock.mockResolvedValueOnce({ kind: 'progress' });
    const OTHER_WS = '44444444-4444-4444-4444-444444444444';
    db.call_sessions = [
      callSessionRow({ id: 'cs-other-ws', workspace_id: OTHER_WS, recording_state: 'recording' }),
      callSessionRow({ id: 'cs-other-provider', provider: 'twilio', recording_state: 'recording' }),
    ];
    db.workspace_deletion_jobs = [baseJob({ status: 'storage_cleanup' })];

    await runStorageCleanup({} as never, baseJob({ status: 'storage_cleanup' }));

    expect(stopRecordingMock).not.toHaveBeenCalled();
    expect(runScopeCleanupTickMock).toHaveBeenCalledTimes(1);
  });
});

function ownerWriteLeaseRow(overrides: Partial<Row> = {}): Row {
  return {
    id: 'lease-1', lease_token: 'lease-tok-1', owner_kind: 'workspace', owner_id: WS_A,
    purpose: 'upload', lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

describe('runStorageCleanup — owner write lease drain (fourth corrective pass, P0 — TOCTOU close)', () => {
  it('an outstanding owner_write_lease for this workspace blocks the ENTIRE tick — no LiveKit quiesce query, no scope cleanup — and releases the job lease without bumping attempt_count', async () => {
    db.owner_write_leases = [ownerWriteLeaseRow()];
    db.workspace_deletion_jobs = [baseJob({ status: 'storage_cleanup', locked_by: 'worker-x', lease_expires_at: new Date().toISOString(), attempt_count: 0 })];

    await runStorageCleanup({} as never, baseJob({ status: 'storage_cleanup', attempt_count: 0 }));

    expect(stopRecordingMock).not.toHaveBeenCalled();
    expect(runScopeCleanupTickMock).not.toHaveBeenCalled();
    const row = currentJobRow();
    expect(row.status).toBe('storage_cleanup');
    expect(row.attempt_count).toBe(0);
    expect(row.locked_by).toBeNull();
    expect(row.lease_expires_at).toBeNull();
  });

  it('a lease expired well beyond the reconciliation grace period (600s) does not block — a crash never wedges deletion forever', async () => {
    runScopeCleanupTickMock.mockResolvedValueOnce({ kind: 'progress' });
    db.owner_write_leases = [ownerWriteLeaseRow({ lease_expires_at: new Date(Date.now() - 700_000).toISOString() })];
    db.workspace_deletion_jobs = [baseJob({ status: 'storage_cleanup' })];

    await runStorageCleanup({} as never, baseJob({ status: 'storage_cleanup' }));

    expect(runScopeCleanupTickMock).toHaveBeenCalledTimes(1);
  });

  it('MANDATORY: a lease that only JUST passed its nominal expiry (well within the 600s reconciliation grace period) still blocks the tick — nominal expiry alone is never proof the write has stopped', async () => {
    db.owner_write_leases = [ownerWriteLeaseRow({ lease_expires_at: new Date(Date.now() - 60_000).toISOString() })];
    db.workspace_deletion_jobs = [baseJob({ status: 'storage_cleanup', attempt_count: 0 })];

    await runStorageCleanup({} as never, baseJob({ status: 'storage_cleanup', attempt_count: 0 }));

    expect(runScopeCleanupTickMock).not.toHaveBeenCalled();
    const row = currentJobRow();
    expect(row.status).toBe('storage_cleanup');
    expect(row.attempt_count).toBe(0);
  });

  it('an owner_write_lease for a DIFFERENT workspace never blocks this one', async () => {
    runScopeCleanupTickMock.mockResolvedValueOnce({ kind: 'progress' });
    const OTHER_WS = '33333333-3333-3333-3333-333333333333';
    db.owner_write_leases = [ownerWriteLeaseRow({ owner_id: OTHER_WS })];
    db.workspace_deletion_jobs = [baseJob({ status: 'storage_cleanup' })];

    await runStorageCleanup({} as never, baseJob({ status: 'storage_cleanup' }));

    expect(runScopeCleanupTickMock).toHaveBeenCalledTimes(1);
  });

  /**
   * The exact race the review specified for LiveKit recording start vs.
   * workspace deletion:
   *   1. startRecording acquires its workspace write lease (purpose:
   *      livekit_recording_start) — modeled here as a seeded
   *      owner_write_leases row, since livekitProvider.ts's own
   *      acquire/persist/release sequence is covered directly in
   *      writeBarrierLateWrites.test.ts.
   *   2. the writability check that gated it was valid (no 'deleting'
   *      race at acquisition time)
   *   3. the Twirp StartEgress call is "paused" — modeled by the lease
   *      still being outstanding and NO call_sessions row existing yet
   *   4. workspace deletion starts (irrelevant here — enqueue is a
   *      separate RPC/module; this worker only sees storage_cleanup)
   *   5. the deletion worker runs a tick
   *   6. it MUST see the outstanding writer lease and MUST NOT query
   *      call_sessions / touch any storage scope
   *   7. StartEgress "returns" and recording_id/state is durably
   *      persisted — modeled by adding the call_sessions row now
   *   8. the start lease releases — modeled by clearing
   *      db.owner_write_leases
   *   9. the deletion worker's NEXT tick now sees the non-terminal
   *      recording via quiesceLiveKitEgress()
   *   10. it stops/quiesces Egress — only once THAT reaches a terminal
   *       state (a later tick, not modeled further here — already
   *       covered by the "LiveKit Egress quiescence" describe block
   *       above) does storage cleanup ever run
   */
  it('LiveKit start-vs-delete race: an outstanding recording-start lease blocks the tick entirely; once it releases and the call_session row exists, the NEXT tick correctly falls through to quiescing the now-visible non-terminal recording', async () => {
    // Steps 1-6: lease outstanding, no call_sessions row yet, no db_cleanup-
    // eligible state — the tick must see the lease and stop cold.
    db.owner_write_leases = [ownerWriteLeaseRow({ purpose: 'livekit_recording_start' })];
    db.call_sessions = [];
    db.workspace_deletion_jobs = [baseJob({ status: 'storage_cleanup' })];

    await runStorageCleanup({} as never, baseJob({ status: 'storage_cleanup' }));

    expect(runScopeCleanupTickMock).not.toHaveBeenCalled();
    expect(stopRecordingMock).not.toHaveBeenCalled();
    expect(currentJobRow().status).toBe('storage_cleanup');

    // Steps 7-8: StartEgress returned, recording_id/state persisted
    // durably, the start lease released.
    db.owner_write_leases = [];
    db.call_sessions = [callSessionRow({ recording_state: 'recording' })];
    stopRecordingMock.mockResolvedValueOnce({ recordingId: 'egress-1', status: 'finalizing' });

    // Steps 9-10: the next tick now passes the lease-drain gate, reaches
    // quiesceLiveKitEgress(), sees the (now-visible) non-terminal
    // recording, and requests a stop — storage cleanup STILL does not
    // run this tick either, because Egress isn't terminal yet.
    await runStorageCleanup({} as never, baseJob({ status: 'storage_cleanup' }));

    expect(stopRecordingMock).toHaveBeenCalledWith({}, 'egress-1');
    expect(runScopeCleanupTickMock).not.toHaveBeenCalled();
    expect((db.call_sessions[0] as Row).recording_state).toBe('finalizing');
  });
});

describe('THE LEASE FENCING RACE', () => {
  it('rejects a stale worker\'s late write once another worker has reclaimed the job, and never clobbers the reclaiming worker\'s state', async () => {
    // Seed the job row, unleased, in storage_cleanup.
    db.workspace_deletion_jobs = [baseJob({ status: 'storage_cleanup', lease_token: null, locked_by: null })];

    // 1. Worker A calls claimNext and gets lease_token T1.
    const jobA = await claimNext({} as never);
    expect(jobA).not.toBeNull();
    const tokenT1 = jobA!.lease_token;
    expect(tokenT1).toBeTruthy();
    expect(currentJobRow().lease_token).toBe(tokenT1);

    // 2. The lease expires and worker B reclaims the job: its lease_token
    // changes to T2, exactly as a fresh claim_workspace_deletion_job() call
    // would mint on a reclaim.
    const tokenT2 = 'worker-b-token';
    currentJobRow().lease_token = tokenT2;
    const statusBeforeStaleWrite = currentJobRow().status;

    // 3. Worker B now holds T2 — nothing further needed from B for this test.

    // 4. Worker A "finishes late" and tries to advance the job, still
    // carrying the STALE token T1, believing its cleanup is done. Every
    // namespace it walks reports advance, so it reaches the status write.
    runScopeCleanupTickMock.mockResolvedValue({ kind: 'advance' });

    // 5. Worker A's write must be rejected outright, not silently no-op'd —
    // and must never crash a real poll loop the way an unhandled rejection
    // would (worker.ts's tick() catches exactly this error).
    await expect(runStorageCleanup({} as never, jobA!)).rejects.toThrow(LeaseFencedError);

    const row = currentJobRow();
    expect(row.status).toBe(statusBeforeStaleWrite); // never advanced by A
    expect(row.status).not.toBe('db_cleanup');
    expect(row.lease_token).toBe(tokenT2); // still B's — never overwritten by A
  });
});

describe('runDbCleanup', () => {
  it('calls admin_delete_workspace with the actor and workspace id, then marks the job completed conditioned on lease_token', async () => {
    db.workspace_deletion_jobs = [baseJob({ status: 'db_cleanup' })];

    await runDbCleanup({} as never, baseJob({ status: 'db_cleanup' }));

    const call = rpcCalls.find((c) => c.fn === 'admin_delete_workspace');
    expect(call?.args).toEqual({ _actor_user_id: ACTOR, _workspace_id: WS_A });
    const row = currentJobRow();
    expect(row.status).toBe('completed');
    expect(row.db_cleanup_completed_at).toBeTruthy();
    expect(row.completed_at).toBeTruthy();
  });

  it('retries with backoff (does not fail immediately) when the RPC errors and the workspace row still exists', async () => {
    adminDeleteResponse = { data: null, error: { message: 'not authorized' } };
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
    adminDeleteResponse = { data: null, error: { message: 'not authorized' } };
    db.workspace_deletion_jobs = [baseJob({ status: 'db_cleanup', attempt_count: 4 })];
    db.workspaces = [{ id: WS_A }];

    await runDbCleanup({} as never, baseJob({ status: 'db_cleanup', attempt_count: 4 }));

    const row = currentJobRow();
    expect(row.status).toBe('failed');
    expect(row.attempt_count).toBe(5);
  });

  it('treats an RPC error as an already-completed idempotent resume when the workspace row is already gone', async () => {
    adminDeleteResponse = { data: null, error: { message: 'Workspace not found' } };
    db.workspace_deletion_jobs = [baseJob({ status: 'db_cleanup' })];
    db.workspaces = []; // already purged by a prior crashed run

    await runDbCleanup({} as never, baseJob({ status: 'db_cleanup' }));

    const row = currentJobRow();
    expect(row.status).toBe('completed');
  });

  it('throws LeaseFencedError (and does not mark the job completed) when another worker has reclaimed the job before the completion write', async () => {
    db.workspace_deletion_jobs = [baseJob({ status: 'db_cleanup', lease_token: 'tok-stale' })];
    const staleJob = baseJob({ status: 'db_cleanup', lease_token: 'tok-stale' });
    currentJobRow().lease_token = 'tok-fresh'; // reclaimed out from under it

    await expect(runDbCleanup({} as never, staleJob)).rejects.toThrow(LeaseFencedError);

    const row = currentJobRow();
    expect(row.status).not.toBe('completed');
  });
});

describe('startWorkspaceDeletionWorker — same-process started guard', () => {
  it('calling it twice only ever registers one setInterval', () => {
    vi.useFakeTimers();
    try {
      claimResponseOverride = { data: { ok: true, job: null }, error: null };
      const setIntervalSpy = vi.spyOn(global, 'setInterval');

      startWorkspaceDeletionWorker({} as never);
      startWorkspaceDeletionWorker({} as never);

      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
