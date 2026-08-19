/**
 * POST /api/calls/:id/invite Route-Shape Split + Selective Gating
 *
 * Verifies deny-on-create / allow-on-continuity for the invite route:
 *   - reason: 'new' is gated by the canonical composer
 *     (audio session → eff.voice_enabled, video → eff.video_enabled)
 *   - reason: 'reissue' (and the legacy/no-reason default) stays
 *     reachable even when the corresponding entitlement is false
 *
 * Does NOT broaden into queue/visitor/numeric-limits scope.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const state: { effective: any; sessionCallType: "audio" | "video" } = {
  effective: null,
  sessionCallType: "audio",
};

vi.mock("../../../server/services/calls/entitlementComposer.js", () => ({
  loadEffectiveCallEntitlements: async () => state.effective,
}));

const inserted: any[] = [];
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
        get call_type() { return state.sessionCallType; },
        state: "ringing",
        context_type: "conversation",
        context_id: null,
      },
      select() { return chain; },
      eq() { return chain; },
      maybeSingle: async () => ({ data: chain._row, error: null }),
      insert(row: any) { inserted.push({ _t, row }); return { error: null }; },
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

vi.mock("../../../server/services/realtime/publish.js", () => ({
  publishConversationEvent: async () => {},
}));
vi.mock("../../../server/services/calls/availability.js", () => ({
  markInCall: async () => {}, clearInCall: async () => {},
}));
vi.mock("../../../server/services/calls/endSession.js", () => ({
  endCallSession: async () => ({ ok: true }),
}));
vi.mock("../../../server/services/calls/providerResolver.js", () => ({
  resolveEffectiveCallProvider: async () => ({ id: "livekit", provider: {} }),
  resolveCallProvider: () => ({ supportsRecording: () => true, createParticipantToken: async () => ({}) }),
  resolveCallProviderOrder: vi.fn(),
}));

import { callsRouter } from "../../../server/routes/calls";

function findHandler(method: string, path: string) {
  const layer = (callsRouter as any).stack.find(
    (l: any) => l.route?.path === path && l.route.methods[method],
  );
  if (!layer) throw new Error(`route ${method} ${path} not found`);
  const stk = layer.route.stack;
  return stk[stk.length - 1].handle;
}

function makeReqRes(body: any) {
  const req: any = {
    params: { id: "call-1" },
    query: {}, body,
    headers: { authorization: "Bearer t" },
    cookies: { gs_session: "t" },
    serverConfig: { supabaseUrl: "http://x", supabaseServiceRoleKey: "k" },
  };
  let statusCode: number | undefined; let jsonBody: any;
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

describe("POST /api/calls/:id/invite — route-shape split + selective gating", () => {
  beforeEach(() => {
    state.effective = { ...fullEff };
    state.sessionCallType = "audio";
    inserted.length = 0;
  });

  it("reason='new' on audio session: 403 plan_forbidden when voice_enabled=false", async () => {
    state.effective = { ...fullEff, voice_enabled: false };
    const handler = findHandler("post", "/:id/invite");
    const { req, res, get } = makeReqRes({ participant_type: "operator", reason: "new" });
    await handler(req, res, () => {});
    expect(get().statusCode).toBe(403);
    expect(get().jsonBody?.error).toBe("plan_forbidden");
    expect(get().jsonBody?.capability).toBe("voice_video.voice");
    expect(inserted.filter((i) => i._t === "call_participants")).toHaveLength(0);
  });

  it("reason='new' on video session: 403 when video_enabled=false even if voice_enabled=true", async () => {
    state.sessionCallType = "video";
    state.effective = { ...fullEff, video_enabled: false };
    const handler = findHandler("post", "/:id/invite");
    const { req, res, get } = makeReqRes({ participant_type: "operator", reason: "new" });
    await handler(req, res, () => {});
    expect(get().statusCode).toBe(403);
    expect(get().jsonBody?.capability).toBe("voice_video.video");
  });

  it("reason='new' proceeds when the matching entitlement is true", async () => {
    const handler = findHandler("post", "/:id/invite");
    const { req, res, get } = makeReqRes({ participant_type: "operator", reason: "new" });
    await handler(req, res, () => {});
    expect(get().statusCode).not.toBe(403);
    expect(inserted.some((i) => i._t === "call_participants")).toBe(true);
  });

  it("reason='reissue' stays reachable when voice_enabled=false (allow-on-continuity)", async () => {
    state.effective = { ...fullEff, voice_enabled: false, video_enabled: false };
    const handler = findHandler("post", "/:id/invite");
    const { req, res, get } = makeReqRes({ participant_type: "operator", reason: "reissue" });
    await handler(req, res, () => {});
    expect(get().statusCode).not.toBe(403);
    expect(inserted.some((i) => i._t === "call_participants")).toBe(true);
  });

  it("legacy caller without reason defaults to reissue and stays reachable when entitlement is false", async () => {
    state.effective = { ...fullEff, voice_enabled: false, video_enabled: false };
    const handler = findHandler("post", "/:id/invite");
    const { req, res, get } = makeReqRes({ participant_type: "operator" });
    await handler(req, res, () => {});
    expect(get().statusCode).not.toBe(403);
  });
});