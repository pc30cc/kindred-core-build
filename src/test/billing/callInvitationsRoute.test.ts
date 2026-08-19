/**
 * Runtime route handler tests for the operator-side call-invitation
 * creation endpoint. This is the first call route gated by the canonical
 * call entitlement composer (Plan AND Runtime). Cancel / GET / LIST are
 * intentionally NOT gated and remain reachable after downgrade so
 * in-flight invitations stay visible and cancellable.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const state: {
  user: any;
  isMember: any;
  effective: any;
  createCalled: boolean;
} = {
  user: null,
  isMember: null,
  effective: null,
  createCalled: false,
};

const sbMock = {
  auth: { getUser: async () => state.user },
  rpc: async (name: string) => {
    if (name === "is_workspace_member") return state.isMember;
    return { data: null, error: null };
  },
};

vi.mock("../../../server/supabase.js", () => ({
  getServiceClient: () => sbMock,
}));

vi.mock("../../../server/services/auth/sessions.js", () => ({
  SESSION_COOKIE_NAME: "gs_session",
  validateSessionToken: async (_config: unknown, token: string | undefined) => {
    if (!token) return null;
    const user = state.user?.data?.user;
    if (!user) return null;
    return { sessionId: "test-session", userId: user.id, email: "test@example.com" };
  },
}));

vi.mock("../../../server/services/calls/entitlementComposer.js", () => ({
  loadEffectiveCallEntitlements: async () => state.effective,
}));

const { createInvitationMock } = vi.hoisted(() => ({
  createInvitationMock: vi.fn(),
}));
vi.mock("../../../server/services/calls/invitations.js", () => ({
  createInvitation: createInvitationMock,
  cancelInvitation: vi.fn(),
  getInvitationById: vi.fn(),
  listInvitationsForConversation: vi.fn(),
  getInvitationTtlSeconds: () => 30,
  INVITE_TTL_MIN_SECONDS: 5,
  INVITE_TTL_MAX_SECONDS: 300,
}));

import { callInvitationsRouter } from "../../../server/routes/callInvitations";

function getHandler(method: string, path: string) {
  const layer: any = (callInvitationsRouter as any).stack.find(
    (l: any) => l.route?.path === path && l.route.methods[method],
  );
  if (!layer) throw new Error(`route ${method} ${path} not found`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function makeReqRes(body: any) {
  const req: any = {
    body,
    params: {},
    query: {},
    headers: { authorization: "Bearer t" },
    cookies: { gs_session: "t" },
    serverConfig: { supabaseUrl: "http://x", supabaseServiceRoleKey: "k" },
  };
  let statusCode: number | undefined;
  let jsonBody: any;
  const res: any = {
    status(code: number) { statusCode = code; return res; },
    json(b: any) { jsonBody = b; return res; },
  };
  return { req, res, get: () => ({ statusCode, jsonBody }) };
}

const allEffective = {
  voice_enabled: true,
  video_enabled: true,
  visitor_voice_enabled: true,
  visitor_video_enabled: true,
  recording_enabled: true,
  queue_enabled: true,
  callbacks_enabled: true,
  call_center_enabled: true,
  plan: {} as any,
  runtime: {} as any,
};

const WS = "22222222-2222-2222-2222-222222222222";
const CONV = "33333333-3333-3333-3333-333333333333";

describe("callInvitations POST / — composed plan+runtime gate", () => {
  beforeEach(() => {
    state.user = { data: { user: { id: "u-1" } }, error: null };
    state.isMember = { data: true, error: null };
    state.effective = { ...allEffective };
    state.createCalled = false;
    createInvitationMock.mockReset();
    createInvitationMock.mockImplementation(async () => {
      state.createCalled = true;
      return { ok: true, invitation: { id: "inv-1" } };
    });
  });

  it("denies audio invitation with 403 plan_forbidden when voice_enabled=false", async () => {
    state.effective = { ...allEffective, voice_enabled: false };
    const handler = getHandler("post", "/");
    const { req, res, get } = makeReqRes({
      workspace_id: WS, conversation_id: CONV, channel: "audio",
    });
    await handler(req, res, () => {});
    expect(get().statusCode).toBe(403);
    expect(get().jsonBody?.error).toBe("plan_forbidden");
    expect(get().jsonBody?.capability).toBe("voice");
    expect(createInvitationMock).not.toHaveBeenCalled();
  });

  it("denies video invitation with 403 plan_forbidden when video_enabled=false", async () => {
    state.effective = { ...allEffective, video_enabled: false };
    const handler = getHandler("post", "/");
    const { req, res, get } = makeReqRes({
      workspace_id: WS, conversation_id: CONV, channel: "video",
    });
    await handler(req, res, () => {});
    expect(get().statusCode).toBe(403);
    expect(get().jsonBody?.capability).toBe("video");
    expect(createInvitationMock).not.toHaveBeenCalled();
  });

  it("video remains allowed when only voice is denied (channel-scoped)", async () => {
    state.effective = { ...allEffective, voice_enabled: false };
    const handler = getHandler("post", "/");
    const { req, res, get } = makeReqRes({
      workspace_id: WS, conversation_id: CONV, channel: "video",
    });
    await handler(req, res, () => {});
    expect(createInvitationMock).toHaveBeenCalledTimes(1);
    expect(get().jsonBody?.invitation?.id).toBe("inv-1");
  });

  it("proceeds to createInvitation when composed entitlement allows", async () => {
    const handler = getHandler("post", "/");
    const { req, res, get } = makeReqRes({
      workspace_id: WS, conversation_id: CONV, channel: "audio",
    });
    await handler(req, res, () => {});
    expect(createInvitationMock).toHaveBeenCalledTimes(1);
    expect(get().jsonBody?.invitation?.id).toBe("inv-1");
  });
});