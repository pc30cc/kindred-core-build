/**
 * Runtime route handler tests for the operator-side call-invitation
 * creation endpoint. This is the first call route gated by the canonical
 * call entitlement composer (Plan AND Runtime). Cancel / GET / LIST are
 * intentionally NOT gated and remain reachable after downgrade so
 * in-flight invitations stay visible and cancellable.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

/** Minimal stand-ins for the Express objects the handler touches. */
interface MockReq {
  body: unknown;
  params: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string>;
  cookies: Record<string, string>;
  serverConfig: { supabaseUrl: string; supabaseServiceRoleKey: string };
}
type MockJsonBody = Record<string, unknown> & {
  error?: unknown;
  capability?: unknown;
  invitation?: { id?: unknown } | null;
};
interface MockRes {
  status(code: number): MockRes;
  json(body: MockJsonBody): MockRes;
}
type Handler = (req: MockReq, res: MockRes, next: () => void) => Promise<unknown> | unknown;
interface RouteLayer {
  route?: {
    path?: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: Handler }>;
  };
}

interface Chain {
  select(): Chain;
  eq(): Chain;
  maybeSingle(): Promise<{ data: unknown; error: null }>;
}

const state: {
  user: { data: { user: { id: string } | null }; error: unknown } | null;
  isMember: { data: boolean; error: unknown } | null;
  effective: Record<string, unknown> | null;
  createCalled: boolean;
} = {
  user: null,
  isMember: null,
  effective: null,
  createCalled: false,
};

/** The member's row as authorizeWorkspaceAccess reads it (null: not a member). */
let memberRow: { role: string; suspended_at: string | null } | null = null;
const sbMock = {
  auth: { getUser: async () => state.user },
  rpc: async (name: string) => {
    if (name === "is_workspace_member") return state.isMember;
    return { data: null, error: null };
  },
  from: (_table: string) => {
    const chain: Chain = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => ({ data: memberRow, error: null }),
    };
    return chain;
  },
};

vi.mock("../../../server/supabase.js", () => ({
  getServiceClient: () => sbMock,
}));
vi.mock("../../../server/middleware/adminBypass.js", () => ({ isGlobalAdmin: async () => false }));
vi.mock("../../../server/services/billing/locks/state.js", () => ({ resolveLockState: async () => ({}) }));
vi.mock("../../../server/services/billing/locks/predicates.js", () => ({ isMemberLocked: () => false }));

vi.mock("../../../server/services/auth/sessions.js", () => ({
  SESSION_COOKIE_NAME: "gs_session",
  validateSessionToken: async (_config: unknown, token: string | undefined) => {
    if (!token) return null;
    const user = state.user?.data?.user;
    if (!user) return null;
    return { sessionId: "test-session", userId: user.id, email: "test@example.com" };
  },
  verifyOriginForMutation: () => true,
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

const { concurrency } = vi.hoisted(() => ({
  concurrency: { decision: { allowed: true, limit: -1 } as Record<string, unknown> },
}));
vi.mock("../../../server/services/calls/concurrencyLimit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../server/services/calls/concurrencyLimit.js")>()),
  checkPlanConcurrencyCeiling: async () => concurrency.decision,
}));

import { callInvitationsRouter } from "../../../server/routes/callInvitations";

function getHandler(method: string, path: string) {
  const layer = (callInvitationsRouter.stack as unknown as RouteLayer[]).find(
    (l) => l.route?.path === path && l.route.methods[method],
  );
  if (!layer) throw new Error(`route ${method} ${path} not found`);
  const stack = layer.route!.stack;
  return stack[stack.length - 1].handle;
}

function makeReqRes(body: unknown) {
  const req: MockReq = {
    body,
    params: {},
    query: {},
    headers: { authorization: "Bearer t" },
    cookies: { gs_session: "t" },
    serverConfig: { supabaseUrl: "http://x", supabaseServiceRoleKey: "k" },
  };
  let statusCode: number | undefined;
  let jsonBody: MockJsonBody | undefined;
  const res: MockRes = {
    status(code: number) { statusCode = code; return res; },
    json(b: MockJsonBody) { jsonBody = b; return res; },
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
  plan: {} as Record<string, unknown>,
  runtime: {} as Record<string, unknown>,
};

const WS = "22222222-2222-2222-2222-222222222222";
const CONV = "33333333-3333-3333-3333-333333333333";

describe("callInvitations POST / — composed plan+runtime gate", () => {
  beforeEach(() => {
    state.user = { data: { user: { id: "u-1" } }, error: null };
    state.isMember = { data: true, error: null };
    memberRow = { role: "agent", suspended_at: null };
    state.effective = { ...allEffective };
    state.createCalled = false;
    concurrency.decision = { allowed: true, limit: -1 };
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

  it("a suspended member is refused, though is_workspace_member says yes (calls-11)", async () => {
    memberRow = { role: "agent", suspended_at: "2026-11-01T00:00:00Z" };
    const handler = getHandler("post", "/");
    const { req, res, get } = makeReqRes({
      workspace_id: WS, conversation_id: CONV, channel: "audio",
    });
    await handler(req, res, () => {});
    expect(get().statusCode).toBe(403);
    expect(get().jsonBody?.error).toBe("membership_suspended");
    expect(createInvitationMock).not.toHaveBeenCalled();
  });

  it("a non-member is refused", async () => {
    memberRow = null;
    const handler = getHandler("post", "/");
    const { req, res, get } = makeReqRes({
      workspace_id: WS, conversation_id: CONV, channel: "audio",
    });
    await handler(req, res, () => {});
    expect(get().statusCode).toBe(403);
    expect(createInvitationMock).not.toHaveBeenCalled();
  });

  it("at the plan's max_concurrent_calls the invitation is refused up front (429), as /api/calls/create refuses", async () => {
    concurrency.decision = { allowed: false, reason: "plan_limit_reached", limit: 2, used: 2, plan: "small" };
    const handler = getHandler("post", "/");
    const { req, res, get } = makeReqRes({
      workspace_id: WS, conversation_id: CONV, channel: "audio",
    });
    await handler(req, res, () => {});
    expect(get().statusCode).toBe(429);
    expect(get().jsonBody).toMatchObject({ error: "plan_limit_reached", capability: "max_concurrent_calls", limit: 2, used: 2 });
    expect(createInvitationMock).not.toHaveBeenCalled();
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