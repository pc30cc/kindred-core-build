/**
 * Operator Call Route Split + Selective Gating —
 * Verifies POST /api/calls/create denies on the new-action boundary
 * via the canonical composer, branch-by-branch by call_type, while
 * cleanup/lifecycle branches (hangup) in the same router remain
 * unaffected by the composer (deny-on-create / allow-cleanup).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const state: { effective: any } = { effective: null };

vi.mock("../../../server/services/calls/entitlementComposer.js", () => ({
  loadEffectiveCallEntitlements: async () => state.effective,
}));

// Phase: max_concurrent_calls — Dual-Knob Activation.
// The operator /create route now also calls the plan-level
// concurrency ceiling helper. These tests target the composer gate,
// not the concurrency gate, so we stub the helper to always allow.
vi.mock("../../../server/services/calls/concurrencyLimit.js", () => ({
  checkPlanConcurrencyCeiling: async () => ({ allowed: true, limit: -1 }),
  planConcurrencyDenialBody: (d: any) => ({ error: d.reason, capability: "max_concurrent_calls" }),
}));

// Phase: max_call_minutes_per_month — Final Activation.
// The operator /create route also enforces the monthly minutes ceiling.
// That gate has its own dedicated suite (maxCallMinutesPerMonth.test.ts);
// here we stub it to allow so the composer gate is what is under test.
vi.mock("../../../server/services/calls/monthlyMinutesLimit.js", () => ({
  checkPlanMonthlyMinutesCeiling: async () => ({ allowed: true, limit: -1 }),
  planMinutesDenialBody: (d: any) => ({ error: d.reason, capability: "max_call_minutes_per_month" }),
}));

const insertedRows: any[] = [];
const sbMock: any = {
  auth: { getUser: async () => ({ data: { user: { id: "u-1" } }, error: null }) },
  rpc: async (name: string) => {
    if (name === "is_workspace_member") return { data: true, error: null };
    return { data: null, error: null };
  },
  from(_t: string) {
    const chain: any = {
      _row: {
        id: "call-1",
        workspace_id: "11111111-1111-1111-1111-111111111111",
        provider: "livekit",
        provider_room_id: "room-1",
        call_type: "audio",
        state: "ringing",
        context_type: "conversation",
        context_id: null,
        recording_enabled: false,
      },
      select() { return chain; },
      eq() { return chain; },
      maybeSingle: async () => ({ data: chain._row, error: null }),
      single: async () => ({ data: { ...chain._row, id: "call-new" }, error: null }),
      insert(row: any) { insertedRows.push(row); return chain; },
      update() { return chain; },
    };
    return chain;
  },
};
vi.mock("../../../server/supabase.js", () => ({ getServiceClient: () => sbMock }));

vi.mock("../../../server/services/auth/sessions.js", () => ({
  SESSION_COOKIE_NAME: "gs_session",
  validateSessionToken: async (_config: unknown, token: string | undefined) => {
    if (!token) return null;
    return { sessionId: "test-session", userId: "u-1", email: "test@example.com" };
  },
  verifyOriginForMutation: () => true,
}));

vi.mock("../../../server/services/calls/controlPlane.js", () => ({
  loadCallControlPlane: async () => ({
    enabled: true,
    recording_default_enabled: false,
    recording_default_type: "composite",
    max_participants: 4,
  }),
  loadWorkspaceCallOverrides: async () => ({
    allow_voice: true, allow_video: true, allow_recording: true,
  }),
}));

const resolveProviderMock = vi.fn(async (..._args: any[]) => ({
  id: "livekit",
  provider: {
    createRoom: async () => ({ providerRoomId: "room-x" }),
  },
}));
vi.mock("../../../server/services/calls/providerResolver.js", () => ({
  resolveEffectiveCallProvider: (...a: any[]) => resolveProviderMock(...a),
  resolveCallProvider: () => ({ supportsRecording: () => true }),
  resolveCallProviderOrder: vi.fn(),
}));

vi.mock("../../../server/services/calls/availability.js", () => ({
  markInCall: async () => {}, clearInCall: async () => {},
}));
vi.mock("../../../server/services/calls/endSession.js", () => ({
  endCallSession: async () => ({ ok: true }),
}));
vi.mock("../../../server/services/realtime/publish.js", () => ({
  publishConversationEvent: async () => {},
}));

import { callsRouter } from "../../../server/routes/calls";

function findHandler(method: string, path: string) {
  const layer = callsRouter.stack.find(
    (l: any) => l.route?.path === path && l.route.methods[method],
  );
  if (!layer) throw new Error(`route ${method} ${path} not found`);
  const stk = (layer as any).route.stack;
  return stk[stk.length - 1].handle;
}

function makeReqRes(body: any) {
  const req: any = {
    params: { id: "call-1" },
    query: {},
    body,
    headers: { authorization: "Bearer t" },
    cookies: { gs_session: "t" },
    serverConfig: { supabaseUrl: "http://x", supabaseServiceRoleKey: "k" },
  };
  let statusCode: number | undefined;
  let jsonBody: any;
  const res: any = {
    status(c: number) { statusCode = c; return res; },
    json(b: any) { jsonBody = b; return res; },
  };
  return { req, res, get: () => ({ statusCode, jsonBody }) };
}

const fullEff = {
  voice_enabled: true, video_enabled: true,
  visitor_voice_enabled: true, visitor_video_enabled: true,
  recording_enabled: true, queue_enabled: true,
  callbacks_enabled: true, call_center_enabled: true,
  plan: {} as any, runtime: {} as any,
};

const WS = "11111111-1111-1111-1111-111111111111";
const baseBody = {
  workspace_id: WS,
  context_type: "conversation",
  context_id: null,
};

describe("operator call /create gating — deny-on-create / allow-cleanup", () => {
  beforeEach(() => {
    state.effective = { ...fullEff };
    insertedRows.length = 0;
    resolveProviderMock.mockClear();
  });

  it("audio create: 403 plan_forbidden when voice_enabled=false", async () => {
    state.effective = { ...fullEff, voice_enabled: false };
    const handler = findHandler("post", "/create");
    const { req, res, get } = makeReqRes({ ...baseBody, call_type: "audio" });
    await handler(req, res, () => {});
    expect(get().statusCode).toBe(403);
    expect(get().jsonBody?.error).toBe("plan_forbidden");
    expect(get().jsonBody?.capability).toBe("voice_video.voice");
    expect(resolveProviderMock).not.toHaveBeenCalled();
    expect(insertedRows).toHaveLength(0);
  });

  it("video create: 403 plan_forbidden when video_enabled=false even if voice_enabled=true", async () => {
    state.effective = { ...fullEff, video_enabled: false };
    const handler = findHandler("post", "/create");
    const { req, res, get } = makeReqRes({ ...baseBody, call_type: "video" });
    await handler(req, res, () => {});
    expect(get().statusCode).toBe(403);
    expect(get().jsonBody?.capability).toBe("voice_video.video");
    expect(resolveProviderMock).not.toHaveBeenCalled();
  });

  it("audio create: proceeds when voice_enabled=true", async () => {
    const handler = findHandler("post", "/create");
    const { req, res, get } = makeReqRes({ ...baseBody, call_type: "audio" });
    await handler(req, res, () => {});
    expect(get().statusCode).not.toBe(403);
    expect(resolveProviderMock).toHaveBeenCalledTimes(1);
  });

  it("hangup (cleanup) NOT gated by composer — reachable when voice/video disabled", async () => {
    state.effective = { ...fullEff, voice_enabled: false, video_enabled: false };
    const handler = findHandler("post", "/:id/hangup");
    const { req, res, get } = makeReqRes({});
    await handler(req, res, () => {});
    expect(get().statusCode).not.toBe(403);
  });

  it("reject (cleanup) NOT gated by composer", async () => {
    state.effective = { ...fullEff, voice_enabled: false, video_enabled: false };
    const handler = findHandler("post", "/:id/reject");
    const { req, res, get } = makeReqRes({});
    await handler(req, res, () => {});
    expect(get().statusCode).not.toBe(403);
  });
});
