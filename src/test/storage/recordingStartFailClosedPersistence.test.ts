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
  };
}

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
          select: () => ({
            eq: () => ({
              eq: () => ({ maybeSingle: async () => ({ data: callSessionRow(), error: null }) }),
              maybeSingle: async () => ({ data: callSessionRow(), error: null }),
            }),
          }),
          update: (patch: Record<string, unknown>) => ({
            eq: () => {
              if (patch.recording_state === 'pending') {
                return Promise.resolve(dbState.onStartingError ? { data: null, error: dbState.onStartingError } : { data: null, error: null });
              }
              // Both flows' phase-2 write sets recording_state to
              // 'recording' (chat-call) or includes recording_enabled
              // (Call Center's persistRecordingStart's topLevel patch).
              if (patch.recording_state === 'recording' || 'recording_enabled' in patch) {
                return Promise.resolve(dbState.onStartedError ? { data: null, error: dbState.onStartedError } : { data: null, error: null });
              }
              // Any other write (e.g. a 'failed' cleanup mark) always succeeds.
              return Promise.resolve({ data: null, error: null });
            },
          }),
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
