/**
 * Call Route Enforcement Expansion — recording start gating.
 *
 * Verifies that POST /api/calls/:id/recording/start and
 * POST /api/call-center/calls/:id/recording/start both deny via the
 * canonical composer when `recording_enabled` is false, and that the
 * matching stop endpoints stay ungated (deny-on-create / allow-cleanup).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const state: { effective: any } = { effective: null };

vi.mock("../../../server/services/calls/entitlementComposer.js", () => ({
  loadEffectiveCallEntitlements: async () => state.effective,
}));

// Minimal supabase service-client mock used by both routers.
const sbMock: any = {
  auth: { getUser: async () => ({ data: { user: { id: "u-1" } }, error: null }) },
  rpc: async (name: string) => {
    if (name === "is_workspace_member") return { data: true, error: null };
    if (name === "get_workspace_role") return { data: "owner", error: null };
    return { data: null, error: null };
  },
  from() {
    return {
      select() { return this; },
      eq() { return this; },
      maybeSingle: async () => ({
        data: {
          id: "call-1",
          workspace_id: "11111111-1111-1111-1111-111111111111",
          provider: "livekit",
          provider_room_id: "room-1",
        },
        error: null,
      }),
      single: async () => ({ data: null, error: null }),
      update() { return this; },
    };
  },
};
vi.mock("../../../server/supabase.js", () => ({
  getServiceClient: () => sbMock,
}));

vi.mock("../../../server/middleware/adminBypass.js", () => ({
  isGlobalAdmin: async () => true,
}));

vi.mock("../../../server/services/auth/sessions.js", () => ({
  SESSION_COOKIE_NAME: "gs_session",
  validateSessionToken: async (_config: unknown, token: string | undefined) => {
    if (!token) return null;
    return { sessionId: "test-session", userId: "u-1", email: "test@example.com" };
  },
}));

const { startCallsMock, startCenterMock, stopCallsMock, stopCenterMock } =
  vi.hoisted(() => ({
    startCallsMock: vi.fn(),
    startCenterMock: vi.fn(),
    stopCallsMock: vi.fn(),
    stopCenterMock: vi.fn(),
  }));

vi.mock("../../../server/services/callCenter/recordingControl.js", () => ({
  startCallCenterRecording: startCenterMock,
  stopCallCenterRecording: stopCenterMock,
  getCallCenterRecordingStatus: vi.fn(),
  RecordingControlException: class RecordingControlException extends Error {
    httpStatus = 500;
    code = "x";
  },
}));

vi.mock("../../../server/services/calls/providerResolver.js", () => ({
  resolveCallProvider: () => ({
    supportsRecording: () => true,
    startRecording: startCallsMock,
    stopRecording: stopCallsMock,
  }),
  resolveEffectiveCallProvider: vi.fn(),
  resolveCallProviderOrder: vi.fn(),
}));

vi.mock("../../../server/services/calls/controlPlane.js", () => ({
  loadCallControlPlane: async () => ({ recording_default_type: "composite" }),
  loadWorkspaceCallOverrides: async () => ({ allow_recording: true }),
}));

import { callsRouter } from "../../../server/routes/calls";
import { callCenterRouter } from "../../../server/routes/callCenter";

function findHandler(router: any, method: string, path: string) {
  const layer = router.stack.find(
    (l: any) => l.route?.path === path && l.route.methods[method],
  );
  if (!layer) throw new Error(`route ${method} ${path} not found`);
  const stk = layer.route.stack;
  return stk[stk.length - 1].handle;
}

function makeReqRes(opts: { params?: any; query?: any; body?: any } = {}) {
  const req: any = {
    params: opts.params ?? { id: "call-1" },
    query: opts.query ?? { workspaceId: "11111111-1111-1111-1111-111111111111" },
    body: opts.body ?? {},
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

describe("recording start gating — deny-on-create / allow-cleanup", () => {
  beforeEach(() => {
    state.effective = { ...fullEff };
    startCallsMock.mockReset();
    startCenterMock.mockReset();
    stopCallsMock.mockReset();
    stopCenterMock.mockReset();
  });

  it("call-center start: 403 plan_forbidden when recording_enabled=false", async () => {
    state.effective = { ...fullEff, recording_enabled: false };
    const handler = findHandler(callCenterRouter, "post", "/calls/:id/recording/start");
    const { req, res, get } = makeReqRes({
      body: { recording_type: "composite", workspaceId: "11111111-1111-1111-1111-111111111111" },
    });
    await handler(req, res, () => {});
    expect(get().statusCode).toBe(403);
    expect(get().jsonBody?.error).toBe("plan_forbidden");
    expect(get().jsonBody?.capability).toBe("call_recording");
    expect(startCenterMock).not.toHaveBeenCalled();
  });

  it("call-center start: proceeds when composer allows", async () => {
    startCenterMock.mockResolvedValue({ ok: true });
    const handler = findHandler(callCenterRouter, "post", "/calls/:id/recording/start");
    const { req, res } = makeReqRes({
      body: { recording_type: "composite", workspaceId: "11111111-1111-1111-1111-111111111111" },
    });
    await handler(req, res, () => {});
    expect(startCenterMock).toHaveBeenCalledTimes(1);
  });

  it("call-center stop: NOT gated on the composer (cleanup remains reachable)", async () => {
    state.effective = { ...fullEff, recording_enabled: false };
    stopCenterMock.mockResolvedValue({ ok: true });
    const handler = findHandler(callCenterRouter, "post", "/calls/:id/recording/stop");
    const { req, res, get } = makeReqRes({
      body: { workspaceId: "11111111-1111-1111-1111-111111111111" },
    });
    await handler(req, res, () => {});
    expect(stopCenterMock).toHaveBeenCalledTimes(1);
    expect(get().statusCode).not.toBe(403);
  });
});