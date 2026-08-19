/**
 * Canonical seat-creation route test.
 *
 * Phases:
 *   - "Workspace Member Write Boundary" (introduced the route).
 *   - "Service-Role Companion RPC + Max Agents Activation" (this
 *     test's current shape — companion RPC + live max_agents gate).
 *
 * Verifies:
 *   - Auth + body validation.
 *   - Pre-flight invitation lookup mirrors the original RPC's
 *     well-formed errors (Invalid / Revoked / Expired / email
 *     mismatch) at the Express layer.
 *   - On success the route calls the SERVICE-ROLE-ONLY companion
 *     RPC `accept_workspace_invitation_as(_token, _user_id)` — NOT
 *     the original `accept_workspace_invitation(_token)`.
 *   - max_agents enforcement IS mounted and denies at-limit seat
 *     creation, but is bypassed for already-member re-accepts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Service-client stub ─────────────────────────────────────────
// Configurable per-test through `serviceState`. Supports the exact
// surface the route uses: auth.getUser, .from(table).select(...).eq...
// .maybeSingle(), and .rpc(name, args).

type Row = Record<string, any> | null;
const serviceState: {
  user: { data: any; error: any };
  invitation: Row;
  invitationError: any;
  profile: Row;
  existingMember: Row;
  rpcResult: { data: any; error: any };
} = {
  user: { data: { user: { id: "u-1" } }, error: null },
  invitation: null,
  invitationError: null,
  profile: null,
  existingMember: null,
  rpcResult: { data: null, error: null },
};
const rpcCalls: Array<{ name: string; args: any }> = [];

function makeServiceClient() {
  const builder = (rows: () => { data: Row; error: any }) => {
    const b: any = {
      select: () => b,
      eq: () => b,
      maybeSingle: async () => rows(),
    };
    return b;
  };
  return {
    auth: { getUser: async (_t: string) => serviceState.user },
    from: (table: string) => {
      if (table === "workspace_invitations") {
        return builder(() => ({
          data: serviceState.invitation,
          error: serviceState.invitationError,
        }));
      }
      if (table === "profiles") {
        return builder(() => ({ data: serviceState.profile, error: null }));
      }
      if (table === "workspace_members") {
        return builder(() => ({ data: serviceState.existingMember, error: null }));
      }
      return builder(() => ({ data: null, error: null }));
    },
    rpc: async (name: string, args: any) => {
      rpcCalls.push({ name, args });
      return serviceState.rpcResult;
    },
  };
}

vi.mock("../../../server/supabase.js", () => ({
  getServiceClient: () => makeServiceClient(),
}));

vi.mock("../../../server/services/auth/sessions.js", () => ({
  SESSION_COOKIE_NAME: "gs_session",
  validateSessionToken: async (_config: unknown, token: string | undefined) => {
    if (!token) return null;
    const user = serviceState.user?.data?.user;
    if (!user) return null;
    return { sessionId: "test-session", userId: user.id, email: "test@example.com" };
  },
  verifyOriginForMutation: () => true,
}));

// ─── Feature-gating middleware stub ──────────────────────────────
// Returns a configurable passthrough so we can simulate at-limit
// without standing up the real check_workspace_entitlement RPC.
let limitMwBehavior: "allow" | "deny" = "allow";
const limitMwCalls: Array<{ feature: string }> = [];
vi.mock("../../../server/middleware/featureGating.js", () => ({
  requireLimit: (feature: string, _fn: any) => async (req: any, res: any, next: any) => {
    limitMwCalls.push({ feature });
    if (limitMwBehavior === "deny") {
      return res.status(403).json({
        error: `Limit reached: ${feature}`,
        feature,
        upgrade_required: true,
      });
    }
    return next();
  },
}));

// ─── Usage resolver stub (the route imports usageFnForLimit eagerly) ─
vi.mock("../../../server/services/billing/usageResolvers.js", () => ({
  usageFnForLimit: (_k: string) => async () => 0,
}));

import { workspaceMembersRouter } from "../../../server/routes/workspaceMembers";

function findHandler(method: string, path: string) {
  const layer = (workspaceMembersRouter as any).stack.find(
    (l: any) => l.route?.path === path && l.route.methods[method],
  );
  if (!layer) throw new Error(`route ${method} ${path} not found`);
  const stack = layer.route.stack;
  return async (req: any, res: any) => {
    for (const entry of stack) {
      let nextCalled = false;
      let earlyReturn = false;
      const next = () => { nextCalled = true; };
      const wrappedRes = new Proxy(res, {
        get(t: any, p: string) {
          if (p === "status") {
            return (c: number) => { earlyReturn = true; return t.status(c); };
          }
          return t[p];
        },
      });
      await entry.handle(req, wrappedRes, next);
      if (earlyReturn || !nextCalled) return;
    }
  };
}

function makeReqRes(body: any, authHeader?: string) {
  const tokenMatch = authHeader ? /^Bearer (.+)$/.exec(authHeader) : null;
  const req: any = {
    body,
    headers: authHeader ? { authorization: authHeader } : {},
    cookies: tokenMatch ? { gs_session: tokenMatch[1] } : {},
    serverConfig: {
      supabaseUrl: "http://x",
      supabaseAnonKey: "anon-key-fake",
      supabaseServiceRoleKey: "svc-key-fake",
    },
  };
  let statusCode: number | undefined;
  let jsonBody: any;
  const res: any = {
    status(c: number) { statusCode = c; return res; },
    json(b: any) { jsonBody = b; return res; },
  };
  return { req, res, get: () => ({ statusCode, jsonBody }) };
}

describe("POST /api/workspace-members/accept-invitation — canonical seat-creation boundary", () => {
  beforeEach(() => {
    rpcCalls.length = 0;
    limitMwCalls.length = 0;
    limitMwBehavior = "allow";
    serviceState.user = { data: { user: { id: "u-1" } }, error: null };
    serviceState.invitation = {
      id: "inv-1",
      workspace_id: "ws-1",
      role: "agent",
      invited_email: null,
      expires_at: null,
      revoked_at: null,
    };
    serviceState.invitationError = null;
    serviceState.profile = { email: "user@example.com" };
    serviceState.existingMember = null;
    serviceState.rpcResult = {
      data: {
        success: true,
        already_member: false,
        workspace_id: "ws-1",
        workspace_name: "Acme",
        workspace_slug: "acme",
        role: "agent",
      },
      error: null,
    };
  });

  it("rejects 401 when Authorization header missing", async () => {
    const handler = findHandler("post", "/accept-invitation");
    const { req, res, get } = makeReqRes({ token: "abc" });
    await handler(req, res);
    expect(get().statusCode).toBe(401);
    expect(rpcCalls).toHaveLength(0);
  });

  it("rejects 401 when token verification fails", async () => {
    serviceState.user = { data: null, error: { message: "bad" } };
    const handler = findHandler("post", "/accept-invitation");
    const { req, res, get } = makeReqRes({ token: "abc" }, "Bearer bad-token");
    await handler(req, res);
    expect(get().statusCode).toBe(401);
    expect(rpcCalls).toHaveLength(0);
  });

  it("rejects 400 invalid_body when token missing", async () => {
    const handler = findHandler("post", "/accept-invitation");
    const { req, res, get } = makeReqRes({}, "Bearer good");
    await handler(req, res);
    expect(get().statusCode).toBe(400);
    expect(get().jsonBody?.error).toBe("invalid_body");
    expect(rpcCalls).toHaveLength(0);
  });

  it("pre-flight: 400 'Invalid invitation token' when token does not exist", async () => {
    serviceState.invitation = null;
    const handler = findHandler("post", "/accept-invitation");
    const { req, res, get } = makeReqRes({ token: "missing" }, "Bearer t");
    await handler(req, res);
    expect(get().statusCode).toBe(400);
    expect(get().jsonBody?.error).toBe("Invalid invitation token");
    expect(rpcCalls).toHaveLength(0);
  });

  it("pre-flight: 400 'revoked' / 'expired' / 'different email'", async () => {
    // Revoked
    serviceState.invitation = { ...serviceState.invitation, revoked_at: new Date().toISOString() };
    let h = findHandler("post", "/accept-invitation");
    let { req, res, get } = makeReqRes({ token: "t" }, "Bearer t");
    await h(req, res);
    expect(get().statusCode).toBe(400);
    expect(get().jsonBody?.error).toBe("Invitation has been revoked");

    // Expired
    serviceState.invitation = {
      ...serviceState.invitation,
      revoked_at: null,
      expires_at: new Date(Date.now() - 1000).toISOString(),
    };
    h = findHandler("post", "/accept-invitation");
    ({ req, res, get } = makeReqRes({ token: "t" }, "Bearer t"));
    await h(req, res);
    expect(get().statusCode).toBe(400);
    expect(get().jsonBody?.error).toBe("Invitation has expired");

    // Email mismatch
    serviceState.invitation = {
      ...serviceState.invitation,
      revoked_at: null,
      expires_at: null,
      invited_email: "someone-else@example.com",
    };
    serviceState.profile = { email: "user@example.com" };
    h = findHandler("post", "/accept-invitation");
    ({ req, res, get } = makeReqRes({ token: "t" }, "Bearer t"));
    await h(req, res);
    expect(get().statusCode).toBe(400);
    expect(get().jsonBody?.error).toBe("This invitation is for a different email address");

    expect(rpcCalls).toHaveLength(0);
  });

  it("on success: calls SERVICE-ROLE companion RPC accept_workspace_invitation_as(_token, _user_id)", async () => {
    const handler = findHandler("post", "/accept-invitation");
    const { req, res, get } = makeReqRes({ token: "tok-123" }, "Bearer user-jwt-xyz");
    await handler(req, res);

    // Companion RPC, with user id taken from verified JWT.
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]).toEqual({
      name: "accept_workspace_invitation_as",
      args: { _token: "tok-123", _user_id: "u-1" },
    });

    // Original RPC must NEVER be called from the route now.
    expect(rpcCalls.find((c) => c.name === "accept_workspace_invitation")).toBeUndefined();

    // Limit gate ran for max_agents.
    expect(limitMwCalls).toEqual([{ feature: "max_agents" }]);

    expect(get().statusCode).toBeUndefined();
    expect(get().jsonBody?.success).toBe(true);
    expect(get().jsonBody?.workspace_slug).toBe("acme");
  });

  it("max_agents at-limit: denies new seat creation with 403", async () => {
    limitMwBehavior = "deny";
    const handler = findHandler("post", "/accept-invitation");
    const { req, res, get } = makeReqRes({ token: "t" }, "Bearer t");
    await handler(req, res);
    expect(get().statusCode).toBe(403);
    expect(get().jsonBody?.feature).toBe("max_agents");
    // Companion RPC must NOT be called when the limit gate denies.
    expect(rpcCalls).toHaveLength(0);
  });

  it("already-member re-accept: skips the limit gate and still calls companion RPC", async () => {
    limitMwBehavior = "deny"; // would block if reached
    serviceState.existingMember = { user_id: "u-1" };
    const handler = findHandler("post", "/accept-invitation");
    const { req, res, get } = makeReqRes({ token: "t" }, "Bearer t");
    await handler(req, res);
    // Limit middleware was NOT consulted for already-member.
    expect(limitMwCalls).toHaveLength(0);
    // Companion RPC still called (returns already_member:true in real
    // SQL; here the stub returns the configured success body).
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].name).toBe("accept_workspace_invitation_as");
    expect(get().statusCode).toBeUndefined();
  });

  it("maps unknown companion-RPC errors to 500", async () => {
    serviceState.rpcResult = { data: null, error: { message: "internal boom" } };
    const handler = findHandler("post", "/accept-invitation");
    const { req, res, get } = makeReqRes({ token: "t" }, "Bearer t");
    await handler(req, res);
    expect(get().statusCode).toBe(500);
  });
});