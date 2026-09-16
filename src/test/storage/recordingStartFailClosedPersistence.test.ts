/**
 * Sixth corrective pass, P0 #1 — an independent review found that
 * `server/routes/calls.ts` (chat-call recording) and
 * `server/services/callCenter/recordingControl.ts` (Call Center
 * recording) both silently accepted a PostgREST `{ data: null, error }`
 * response from the `call_sessions` write that backs the fifth pass's
 * two-phase durable recording-start intent — the phase-1 `onStarting`
 * write ('pending', before StartRoomCompositeEgress is ever called) and
 * the phase-2 `onStarted` write (the recording_id, after it returns).
 * Neither checked `.error`; both set `persisted = true` unconditionally.
 * That defeats the entire unknown-Egress reconciliation design: a
 * resolved-but-failed write looks identical to a successful one to the
 * caller, so the provider believes durable persistence succeeded (never
 * triggering its own compensating StopEgress) when in fact nothing was
 * ever recorded.
 *
 * These tests drive the REAL production code for both flows —
 * `livekitProvider.ts`'s `startRecording()` (unmocked, including its
 * owner-write-lease acquire/release and StartRoomCompositeEgress/
 * StopEgress orchestration), the REAL `calls.ts` route handler (invoked
 * directly, bypassing only the Express middleware chain — auth/session
 * resolution is stubbed, matching the existing pattern in
 * src/test/billing/recordingStartRoutes.test.ts), and the REAL
 * `recordingControl.ts`'s exported `startCallCenterRecording` — against
 * a mocked Supabase client whose `call_sessions` UPDATE resolves
 * `{ data: null, error: {...} }` (never a thrown exception) exactly like
 * real Supabase/PostgREST does. Only LiveKit's own Twirp transport and
 * config resolution are mocked (never a real network call), plus the
 * handful of workspace/entitlement/capability lookups each route needs
 * to reach the provider call at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const WS_A = '11111111-1111-1111-1111-111111111111';
const CALL_ID = '22222222-2222-2222-2222-222222222222';

interface DbErr { message: string; code?: string }

const dbState = {
  // Controls the call_sessions UPDATE that carries recording_state:'pending'
  // (the phase-1 onStarting write, issued BEFORE StartRoomCompositeEgress).
  onStartingError: null as DbErr | null,
  // Controls the call_sessions UPDATE that persists the recording_id /
  // flips recording_state to 'recording' (the phase-2 onStarted write,
  // issued AFTER StartRoomCompositeEgress returns).
  onStartedError: null as DbErr | null,
};

function callSessionRow(): Record<string, unknown> {
  return {
    id: CALL_ID,
    workspace_id: WS_A,
    provider: 'livekit',
    provider_room_id: 'room-1',
    context_id: null,
    context_type: null,
    call_type: 'voice',
    recording_enabled: false,
    metadata: null,
    state: 'active',
    entry_source: 'call_widget',
    recording_state: 'available',
    // patchRecordingMeta() now compare-and-sets on `updated_at` so a
    // concurrent writer (operator wrap-up notes share this `metadata`
    // column) cannot silently drop `recording_id`. The mock therefore has
    // to carry the version stamp and bump it on every accepted write,
    // exactly like `trg_call_sessions_updated_at` does.
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

/** Monotonic counter backing the mocked `updated_at` bump. */
let writeSeq = 0;

const JOB_ID = '99999999-9999-9999-9999-999999999999';
function baseWorkspaceDeletionJob(): Record<string, unknown> {
  return {
    id: JOB_ID, workspace_id: WS_A, lease_token: 'job-lease-tok',
    attempt_count: 0, storage_scopes: {}, status: 'storage_cleanup',
  };
}

// Sixth corrective pass, P0 (StopEgress success ≠ terminal): `sessionRow`
// and `jobRow` are REAL mutable state (not a fresh fixture per read) so
// the end-to-end regression test below can drive the real recording-start
// flow AND the real workspaceDeletion/worker.ts quiescence logic against
// the SAME row, observing genuine state transitions across both.
let sessionRow: Record<string, unknown> = callSessionRow();
let jobRow: Record<string, unknown> = baseWorkspaceDeletionJob();

const { twirpMock } = vi.hoisted(() => ({ twirpMock: vi.fn() }));

// ─── owner_write_leases RPC — same shape as writeBarrierLateWrites.test.ts,
// a single always-active-and-writable WS_A is all these tests need.
const leases: Array<{ id: string; token: string; expiresAtMs: number }> = [];
let leaseCounter = 0;

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'acquire_owner_write_lease') {
        leaseCounter += 1;
        const lease = { id: `lease-${leaseCounter}`, token: `token-${leaseCounter}`, expiresAtMs: Date.now() + 120_000 };
        leases.push(lease);
        return { data: { ok: true, lease_id: lease.id, lease_token: lease.token, lease_expires_at: new Date(lease.expiresAtMs).toISOString() }, error: null };
      }
      if (fn === 'renew_owner_write_lease') {
        const lease = leases.find((l) => l.id === args._lease_id && l.token === args._lease_token);
        if (!lease) return { data: { ok: false, error: 'lease_not_found' }, error: null };
        lease.expiresAtMs = Date.now() + 120_000;
        return { data: { ok: true, lease_expires_at: new Date(lease.expiresAtMs).toISOString() }, error: null };
      }
      if (fn === 'release_owner_write_lease') {
        const idx = leases.findIndex((l) => l.id === args._lease_id && l.token === args._lease_token);
        if (idx >= 0) leases.splice(idx, 1);
        return { data: { ok: true }, error: null };
      }
      if (fn === 'has_active_owner_write_leases') {
        const graceSeconds = typeof args._reconciliation_grace_seconds === 'number' ? args._reconciliation_grace_seconds : 600;
        const active = leases.some((l) => l.expiresAtMs + graceSeconds * 1000 > Date.now());
        return { data: { ok: true, active }, error: null };
      }
      return { data: null, error: null };
    },
    from: (table: string) => {
      if (table === 'call_sessions') {
        return {
          select: () => {
            const filters: Array<(r: Record<string, unknown>) => boolean> = [];
            const chain = {
              eq: (col: string, val: unknown) => { filters.push((r) => r[col] === val); return chain; },
              in: (col: string, vals: unknown[]) => { filters.push((r) => vals.includes(r[col])); return chain; },
              maybeSingle: async () => {
                const match = filters.every((f) => f(sessionRow));
                return { data: match ? sessionRow : null, error: null };
              },
              // findNonTerminalRecordings() (workspaceDeletion/worker.ts)
              // ends its chain on .in(), not .maybeSingle() — a bare
              // thenable resolving an array, exactly like the real
              // PostgREST builder.
              then: (resolve: (v: { data: unknown; error: null }) => void) => {
                const match = filters.every((f) => f(sessionRow));
                resolve({ data: match ? [sessionRow] : [], error: null });
              },
            };
            return chain;
          },
          update: (patch: Record<string, unknown>) => {
            const filters: Array<(r: Record<string, unknown>) => boolean> = [];
            // One place decides the outcome, so a caller that ends its
            // chain on `.eq()` (the legacy shape) and one that ends on
            // `.select().maybeSingle()` (the compare-and-set shape) see
            // exactly the same result and the same injected error.
            const apply = (): { data: { id: unknown } | null; error: DbErr | null } => {
              // A filter that does not match is a LOST RACE, not an error:
              // real PostgREST returns zero rows with error === null.
              if (!filters.every((f) => f(sessionRow))) return { data: null, error: null };
              if (patch.recording_state === 'pending') {
                if (dbState.onStartingError) return { data: null, error: dbState.onStartingError };
              } else if (patch.recording_state === 'recording' || 'recording_enabled' in patch) {
                // Both flows' phase-2 write sets recording_state to
                // 'recording' (chat-call) or includes recording_enabled
                // (Call Center's persistRecordingStart's topLevel patch).
                if (dbState.onStartedError) return { data: null, error: dbState.onStartedError };
              }
              // Any other write (a 'failed' cleanup mark, or a
              // quiesceLiveKitEgress() reconciliation write) always
              // succeeds and is actually persisted.
              Object.assign(sessionRow, patch);
              sessionRow.updated_at = `2026-01-01T00:00:${String(++writeSeq).padStart(2, '0')}.000Z`;
              return { data: { id: sessionRow.id }, error: null };
            };
            const chain = {
              eq: (col: string, val: unknown) => { filters.push((r) => r[col] === val); return chain; },
              select: () => ({
                maybeSingle: async () => apply(),
              }),
              then: (resolve: (v: { data: unknown; error: DbErr | null }) => void) => {
                const r = apply();
                resolve({ data: null, error: r.error });
              },
            };
            return chain;
          },
        };
      }
      if (table === 'workspace_deletion_jobs') {
        return {
          update: (patch: Record<string, unknown>) => {
            const filters: Array<(r: Record<string, unknown>) => boolean> = [];
            const chain = {
              eq: (col: string, val: unknown) => { filters.push((r) => r[col] === val); return chain; },
              select: () => ({
                then: (resolve: (v: { data: unknown; error: null }) => void) => {
                  const match = filters.every((f) => f(jobRow));
                  if (match) Object.assign(jobRow, patch);
                  resolve({ data: match ? [{ id: jobRow.id }] : [], error: null });
                },
              }),
            };
            return chain;
          },
        };
      }
      // Generic passthrough for call_events / call_participants / etc. —
      // none of these are under test here.
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
        insert: () => Promise.resolve({ data: null, error: null }),
        update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
      };
    },
  }),
}));

vi.mock('../../../server/services/calls/livekitConfig.js', () => ({
  loadLiveKitConfig: async () => ({
    egress_enabled: true,
    recording_storage: { bucket: 'recordings', access_key: 'AKIA', secret_key: 'secret', region: null, endpoint: null },
    egress_url: null,
    rtc_url: 'https://lk.example.test',
    api_key: 'key',
    api_secret: 'secret',
  }),
  isMinimallyConfigured: () => true,
}));

vi.mock('../../../server/services/calls/livekitTwirp.js', () => ({
  twirp: twirpMock,
  mintParticipantToken: vi.fn(),
  LiveKitTwirpError: class LiveKitTwirpError extends Error {
    code: string;
    constructor(code: string, message: string) { super(message); this.code = code; }
  },
}));

vi.mock('../../../server/services/calls/controlPlane.js', () => ({
  loadCallControlPlane: async () => ({
    enabled: true, primary_provider: 'livekit', secondary_provider: 'jitsi', fallback_policy: 'lenient',
    recording_default_type: 'composite',
  }),
  loadWorkspaceCallOverrides: async () => ({
    allow_voice: true, allow_video: true, allow_recording: true, provider_override: null,
  }),
}));

vi.mock('../../../server/services/calls/entitlementComposer.js', () => ({
  loadEffectiveCallEntitlements: async () => ({ recording_enabled: true }),
}));

vi.mock('../../../server/middleware/featureGating.js', () => ({
  checkEntitlementFromDB: async () => ({ allowed: true, limit: -1 }),
}));

vi.mock('../../../server/services/billing/usageResolvers.js', () => ({
  resolveUsage: async () => ({ supported: false, value: 0 }),
}));

vi.mock('../../../server/lib/workspaceAuth.js', () => ({
  requireUser: async () => 'u-1',
  authorizeWorkspaceAccess: async () => ({ userId: 'u-1', isAdmin: true, role: null }),
}));

vi.mock('../../../server/services/callCenter/settings.js', () => ({
  getOrCreateWorkspaceSettings: async () => ({}),
  getPlatformCallCenterSettings: async () => ({}),
}));

vi.mock('../../../server/services/callCenter/recording.js', () => ({
  computeRecordingCapability: () => ({
    enabled_by_platform: true, enabled_by_plan: true, enabled_by_workspace: true,
    consent_required: false, provider_supported: true, provider_configured: true,
    effective_enabled: true,
  }),
}));

// ─── used only by the end-to-end "StopEgress success ≠ terminal"
// regression describe block below — workspaceDeletion/worker.ts's OWN
// scope-walking algorithm has full dedicated coverage in
// scopeCleanupEngine.test.ts / workspaceDeletionWorker.test.ts; here it's
// mocked so its outcome (called or not) is the only thing observed.
const { runScopeCleanupTickMock } = vi.hoisted(() => ({ runScopeCleanupTickMock: vi.fn() }));
vi.mock('../../../server/services/storage/scopeCleanupEngine.js', () => ({
  runScopeCleanupTick: runScopeCleanupTickMock,
}));
vi.mock('../../../server/services/storage/workspaceScopes.js', () => ({
  workspaceStorageScopes: () => [],
  workspaceScopePrefix: (workspaceId: string) => `workspace/${workspaceId}/`,
}));
// Storage cleanup also purges the independent analytics namespace; this
// block only observes WHETHER cleanup ran at all, so the analytics half is
// stubbed to a single namespace with no vendors.
vi.mock('../../../server/services/analytics/deletionScopes.js', () => ({
  analyticsStorageScopes: async () => [],
  analyticsWorkspacePrefixes: async (_c: unknown, workspaceId: string) => [
    { poolPrefix: 'analytics/web/', workspacePrefix: `analytics/web/workspace=${workspaceId}/` },
  ],
}));

function findHandler(router: import('express').Router, method: string, path: string) {
  const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...a: unknown[]) => unknown }> } }> }).stack;
  const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`route ${method} ${path} not found`);
  const stk = layer.route.stack;
  return stk[stk.length - 1].handle;
}

function makeReqRes() {
  const req: Record<string, unknown> = {
    params: { id: CALL_ID },
    query: {},
    body: {},
    headers: { authorization: 'Bearer t' },
    cookies: { gs_session: 't' },
    serverConfig: { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' },
  };
  let statusCode = 200;
  let jsonBody: unknown;
  const res = {
    status(c: number) { statusCode = c; return res; },
    json(b: unknown) { jsonBody = b; return res; },
  };
  return { req, res, get: () => ({ statusCode, jsonBody }) };
}

beforeEach(() => {
  dbState.onStartingError = null;
  dbState.onStartedError = null;
  leases.length = 0;
  leaseCounter = 0;
  twirpMock.mockReset();
  sessionRow = callSessionRow();
  jobRow = baseWorkspaceDeletionJob();
  runScopeCleanupTickMock.mockReset();
});

describe('chat-call recording start (server/routes/calls.ts) — fail-closed on PostgREST {error}', () => {
  it('1. onStarting resolves {error}: StartRoomCompositeEgress is NEVER called, and the route reports failure (not 200)', async () => {
    const { callsRouter } = await import('../../../server/routes/calls');
    const { hasActiveOwnerWriteLeases } = await import('../../../server/services/storage/writerLease');
    dbState.onStartingError = { message: 'transient_db_failure' };

    const handler = findHandler(callsRouter, 'post', '/:id/recording/start');
    const { req, res, get } = makeReqRes();
    await handler(req, res, () => {});

    expect(twirpMock).not.toHaveBeenCalled();
    expect(get().statusCode).not.toBe(200);
    // The lease was acquired then released synchronously by
    // livekitProvider.startRecording()'s own finally (onStarting threw
    // before any external write was ever attempted, so nothing is
    // ambiguous here — a clean release is correct).
    expect(await hasActiveOwnerWriteLeases({} as never, 'workspace', WS_A)).toBe(false);
  });

  it('2. onStarted resolves {error} after StartRoomCompositeEgress succeeds: the compensating StopEgress runs', async () => {
    const { callsRouter } = await import('../../../server/routes/calls');
    twirpMock.mockResolvedValueOnce({ egress_id: 'egr-1', status: 'EGRESS_ACTIVE' }); // Start
    twirpMock.mockResolvedValueOnce({}); // Stop
    dbState.onStartedError = { message: 'transient_db_failure' };

    const handler = findHandler(callsRouter, 'post', '/:id/recording/start');
    const { req, res, get } = makeReqRes();
    await handler(req, res, () => {});

    expect(twirpMock).toHaveBeenCalledTimes(2);
    expect(twirpMock.mock.calls[0][0]).toMatchObject({ method: 'StartRoomCompositeEgress' });
    expect(twirpMock.mock.calls[1][0]).toMatchObject({ method: 'StopEgress' });
    expect(get().statusCode).not.toBe(200);
  });

  it('3. onStarted {error} AND the compensating StopEgress itself fails: the write lease is retained (never released), so the durable phase-1 "pending" marker stays discoverable for reconciliation', async () => {
    const { callsRouter } = await import('../../../server/routes/calls');
    const { hasActiveOwnerWriteLeases } = await import('../../../server/services/storage/writerLease');
    twirpMock.mockResolvedValueOnce({ egress_id: 'egr-2', status: 'EGRESS_ACTIVE' }); // Start
    twirpMock.mockRejectedValueOnce(new Error('livekit_unreachable')); // Stop fails
    dbState.onStartedError = { message: 'transient_db_failure' };

    const handler = findHandler(callsRouter, 'post', '/:id/recording/start');
    const { req, res, get } = makeReqRes();
    await handler(req, res, () => {});

    expect(get().statusCode).not.toBe(200);
    // The double-failure case — needsReconciliation — must leave the
    // lease outstanding rather than releasing it, exactly like the
    // fifth-pass "retains the write lease" test proves at the provider
    // level; this proves the SAME real code path is reached when the
    // persistence failure originates from a resolved PostgREST {error}
    // rather than a directly-thrown exception.
    expect(await hasActiveOwnerWriteLeases({} as never, 'workspace', WS_A)).toBe(true);
  });
});

describe('Call Center recording start (server/services/callCenter/recordingControl.ts) — fail-closed on PostgREST {error}', () => {
  it('1. onStarting (patchRecordingMeta) resolves {error}: StartRoomCompositeEgress is NEVER called, and startCallCenterRecording rejects', async () => {
    const { startCallCenterRecording, RecordingControlException } = await import('../../../server/services/callCenter/recordingControl');
    dbState.onStartingError = { message: 'transient_db_failure' };

    await expect(
      startCallCenterRecording({} as never, { workspaceId: WS_A, callId: CALL_ID, actorUserId: 'u-1' }),
    ).rejects.toThrow(RecordingControlException);
    expect(twirpMock).not.toHaveBeenCalled();
  });

  it('2. onStarted (persistRecordingStart) resolves {error} after StartRoomCompositeEgress succeeds: the compensating StopEgress runs', async () => {
    const { startCallCenterRecording } = await import('../../../server/services/callCenter/recordingControl');
    twirpMock.mockResolvedValueOnce({ egress_id: 'egr-3', status: 'EGRESS_ACTIVE' }); // Start
    twirpMock.mockResolvedValueOnce({}); // Stop
    dbState.onStartedError = { message: 'transient_db_failure' };

    await expect(
      startCallCenterRecording({} as never, { workspaceId: WS_A, callId: CALL_ID, actorUserId: 'u-1' }),
    ).rejects.toThrow();

    expect(twirpMock).toHaveBeenCalledTimes(2);
    expect(twirpMock.mock.calls[0][0]).toMatchObject({ method: 'StartRoomCompositeEgress' });
    expect(twirpMock.mock.calls[1][0]).toMatchObject({ method: 'StopEgress' });
  });

  it('3. onStarted {error} AND the compensating StopEgress itself fails: the write lease is retained (never released) — same matrix as the chat-call flow, for patchRecordingMeta', async () => {
    const { startCallCenterRecording } = await import('../../../server/services/callCenter/recordingControl');
    const { hasActiveOwnerWriteLeases } = await import('../../../server/services/storage/writerLease');
    twirpMock.mockResolvedValueOnce({ egress_id: 'egr-4', status: 'EGRESS_ACTIVE' }); // Start
    twirpMock.mockRejectedValueOnce(new Error('livekit_unreachable')); // Stop fails
    dbState.onStartedError = { message: 'transient_db_failure' };

    await expect(
      startCallCenterRecording({} as never, { workspaceId: WS_A, callId: CALL_ID, actorUserId: 'u-1' }),
    ).rejects.toThrow();

    expect(await hasActiveOwnerWriteLeases({} as never, 'workspace', WS_A)).toBe(true);
  });
});

/**
 * A seventh-review P0: a compensating StopEgress call that does not
 * THROW is not the same as Egress being terminal — `stopRecording()`
 * itself reports `status:'finalizing'` on its ordinary success path
 * (LiveKit can still asynchronously finalize/upload after that call
 * returns). `livekitProvider.ts`'s `startRecording()` now sets
 * `needsReconciliation=true` in this branch too (not only when the
 * compensating stop itself fails), so neither real caller marks the row
 * 'failed' — it stays at its durable phase-1 'pending' marker, which
 * workspaceDeletion/worker.ts's `quiesceLiveKitEgress()` (via
 * `findActiveEgressForRoom`'s real `ListEgress` call, only Twirp mocked)
 * discovers and refuses to treat as safe until LiveKit itself confirms a
 * terminal state — never merely because a Stop call returned.
 */
describe('END-TO-END: StopEgress succeeding after onStarted persistence failure does NOT mean Egress is terminal', () => {
  it('chat-call flow (server/routes/calls.ts): call_session stays non-terminal (never "failed") and workspace deletion storage cleanup is blocked until LiveKit reconciliation confirms no active Egress', async () => {
    const { callsRouter } = await import('../../../server/routes/calls');
    const { runStorageCleanup } = await import('../../../server/services/workspaceDeletion/worker');

    dbState.onStartedError = { message: 'transient_db_failure' };
    twirpMock.mockImplementation(async (args: { method: string }) => {
      if (args.method === 'StartRoomCompositeEgress') return { egress_id: 'egr-e2e-1', status: 'EGRESS_ACTIVE' };
      if (args.method === 'StopEgress') return {}; // succeeds -> stopRecording() reports status:'finalizing', not terminal
      if (args.method === 'ListEgress') return { items: [{ egress_id: 'egr-e2e-1', status: 'EGRESS_ACTIVE' }] };
      throw new Error(`unexpected twirp method ${args.method}`);
    });

    // 1. onStarting persists successfully. 2. StartRoomCompositeEgress
    // succeeds. 3. onStarted returns a realistic PostgREST {error}.
    // 4. compensating StopEgress succeeds.
    const handler = findHandler(callsRouter, 'post', '/:id/recording/start');
    const { req, res, get } = makeReqRes();
    await handler(req, res, () => {});
    expect(get().statusCode).not.toBe(200);

    // 5. call_session MUST NOT become 'failed'. 6. it remains
    // 'pending' — the durable phase-1 marker — and discoverable.
    expect(sessionRow.recording_state).toBe('pending');

    // 7. workspace deletion MUST NOT run storage cleanup yet — LiveKit
    // (via the real findActiveEgressForRoom/ListEgress call) still
    // reports this egress active, so quiesceLiveKitEgress() discovers
    // it, issues its own stop, and marks the row 'finalizing' — still
    // not a state storage cleanup may trust.
    await runStorageCleanup({} as never, jobRow as never);
    expect(runScopeCleanupTickMock).not.toHaveBeenCalled();
    expect(sessionRow.recording_state).toBe('finalizing');
    expect(jobRow.status).toBe('storage_cleanup'); // never advanced, never purged

    // 8. only once LiveKit's own webhook (covered independently by
    // livekitWebhookRetry.test.ts) confirms a genuinely terminal state
    // does cleanup proceed — modeled here as that write's accepted
    // outcome, since re-testing the webhook route itself is out of
    // scope for this regression.
    sessionRow.recording_state = 'available';
    runScopeCleanupTickMock.mockResolvedValue({ kind: 'advance' });
    await runStorageCleanup({} as never, jobRow as never);
    expect(runScopeCleanupTickMock).toHaveBeenCalledTimes(2); // general + analytics namespaces
  });

  it('Call Center flow (server/services/callCenter/recordingControl.ts): the SAME invariant for patchRecordingMeta', async () => {
    const { startCallCenterRecording } = await import('../../../server/services/callCenter/recordingControl');
    const { runStorageCleanup } = await import('../../../server/services/workspaceDeletion/worker');

    dbState.onStartedError = { message: 'transient_db_failure' };
    twirpMock.mockImplementation(async (args: { method: string }) => {
      if (args.method === 'StartRoomCompositeEgress') return { egress_id: 'egr-e2e-2', status: 'EGRESS_ACTIVE' };
      if (args.method === 'StopEgress') return {};
      if (args.method === 'ListEgress') return { items: [{ egress_id: 'egr-e2e-2', status: 'EGRESS_ACTIVE' }] };
      throw new Error(`unexpected twirp method ${args.method}`);
    });

    await expect(
      startCallCenterRecording({} as never, { workspaceId: WS_A, callId: CALL_ID, actorUserId: 'u-1' }),
    ).rejects.toThrow();

    expect(sessionRow.recording_state).toBe('pending');

    await runStorageCleanup({} as never, jobRow as never);
    expect(runScopeCleanupTickMock).not.toHaveBeenCalled();
    expect(sessionRow.recording_state).toBe('finalizing');
    expect(jobRow.status).toBe('storage_cleanup');

    sessionRow.recording_state = 'available';
    runScopeCleanupTickMock.mockResolvedValue({ kind: 'advance' });
    await runStorageCleanup({} as never, jobRow as never);
    expect(runScopeCleanupTickMock).toHaveBeenCalledTimes(2); // general + analytics namespaces
  });
});
