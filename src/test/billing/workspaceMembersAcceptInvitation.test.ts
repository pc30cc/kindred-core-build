/**
 * Workspace Member Write Boundary — canonical seat-creation route test.
 *
 * Phase: "Workspace Member Write Boundary — Strict Seat-Creation
 * Canonicalization Pass."
 *
 * Verifies:
 *   - POST /api/workspace-members/accept-invitation routes through
 *     the Express handler (not directly through Supabase JS).
 *   - It calls accept_workspace_invitation RPC with the JWT-scoped
 *     client and forwards the RPC result body verbatim on success.
 *   - Auth, body validation, and RPC error mapping are correct.
 *   - max_agents enforcement is NOT mounted yet (no requireLimit
 *     middleware on this route) — the route exists as a pure
 *     pass-through chokepoint while the RPC bypass remains open.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── createClient mock: track which client was constructed and what
//    Authorization header was forwarded into the user-scoped client.
const constructedClients: Array<{ url: string; key: string; headers?: Record<string, string> }> = [];
const rpcMock = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: (url: string, key: string, opts?: any) => {
    constructedClients.push({
      url,
      key,
      headers: opts?.global?.headers,
    });
    return {
      rpc: (name: string, args: any) => rpcMock(name, args),
      auth: {},
    };
  },
}));

// ── Service client mock used by requireUser (token verification only).
const getUserMock = vi.fn();
vi.mock("../../../server/supabase.js", () => ({
  getServiceClient: () => ({ auth: { getUser: (t: string) => getUserMock(t) } }),
}));

import { workspaceMembersRouter } from "../../../server/routes/workspaceMembers";

function findHandler(method: string, path: string) {
  const layer = (workspaceMembersRouter as any).stack.find(
    (l: any) => l.route?.path === path && l.route.methods[method],
  );
  if (!layer) throw new Error(`route ${method} ${path} not found`);
  // Compose all route handlers (requireUser + final handler) into a
  // single async chain so assertions cover the middleware too.
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
  const req: any = {
    body,
    headers: authHeader ? { authorization: authHeader } : {},
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
    constructedClients.length = 0;
    rpcMock.mockReset();
    getUserMock.mockReset();
    getUserMock.mockResolvedValue({ data: { user: { id: "u-1" } }, error: null });
  });

  it("rejects 401 when Authorization header missing", async () => {
    const handler = findHandler("post", "/accept-invitation");
    const { req, res, get } = makeReqRes({ token: "abc" });
    await handler(req, res);
    expect(get().statusCode).toBe(401);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("rejects 401 when token verification fails", async () => {
    getUserMock.mockResolvedValueOnce({ data: null, error: { message: "bad" } });
    const handler = findHandler("post", "/accept-invitation");
    const { req, res, get } = makeReqRes({ token: "abc" }, "Bearer bad-token");
    await handler(req, res);
    expect(get().statusCode).toBe(401);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("rejects 400 invalid_body when token missing", async () => {
    const handler = findHandler("post", "/accept-invitation");
    const { req, res, get } = makeReqRes({}, "Bearer good");
    await handler(req, res);
    expect(get().statusCode).toBe(400);
    expect(get().jsonBody?.error).toBe("invalid_body");
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("on success: forwards JWT into a scoped client and returns RPC body verbatim", async () => {
    rpcMock.mockResolvedValue({
      data: {
        success: true,
        already_member: false,
        workspace_id: "ws-1",
        workspace_name: "Acme",
        workspace_slug: "acme",
        role: "agent",
      },
      error: null,
    });
    const handler = findHandler("post", "/accept-invitation");
    const { req, res, get } = makeReqRes({ token: "tok-123" }, "Bearer user-jwt-xyz");
    await handler(req, res);

    // RPC was called with the canonical name + token.
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith("accept_workspace_invitation", { _token: "tok-123" });

    // The route built a JWT-scoped client (anon key + Authorization
    // header carrying the user's JWT) — NOT a service-role client.
    // This is the contract that preserves auth.uid() inside the RPC.
    const userScoped = constructedClients.find(
      (c) => c.headers?.Authorization === "Bearer user-jwt-xyz",
    );
    expect(userScoped, "expected one createClient call with user JWT in headers").toBeDefined();
    expect(userScoped!.key).toBe("anon-key-fake");

    // Success body is returned verbatim — UI text path stays unchanged.
    expect(get().statusCode).toBeUndefined(); // res.json() w/o status = 200
    expect(get().jsonBody?.success).toBe(true);
    expect(get().jsonBody?.workspace_slug).toBe("acme");
  });

  it("maps known RPC errors to 400 (invalid / expired / revoked / wrong email)", async () => {
    const cases = [
      "Invalid invitation token",
      "Invitation has expired",
      "Invitation has been revoked",
      "This invitation is for a different email address",
    ];
    for (const msg of cases) {
      rpcMock.mockResolvedValueOnce({ data: null, error: { message: msg } });
      const handler = findHandler("post", "/accept-invitation");
      const { req, res, get } = makeReqRes({ token: "x" }, "Bearer t");
      await handler(req, res);
      expect(get().statusCode, `case: ${msg}`).toBe(400);
      expect(get().jsonBody?.error).toBe(msg);
    }
  });

  it("maps 'Not authenticated' RPC error to 401", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "Not authenticated" } });
    const handler = findHandler("post", "/accept-invitation");
    const { req, res, get } = makeReqRes({ token: "x" }, "Bearer t");
    await handler(req, res);
    expect(get().statusCode).toBe(401);
  });

  it("maps unknown RPC errors to 500", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "internal boom" } });
    const handler = findHandler("post", "/accept-invitation");
    const { req, res, get } = makeReqRes({ token: "x" }, "Bearer t");
    await handler(req, res);
    expect(get().statusCode).toBe(500);
  });

  it("does NOT mount any requireLimit('max_agents', ...) middleware yet", () => {
    // The phase explicitly defers max_agents enforcement until the
    // direct supabase.rpc('accept_workspace_invitation') bypass is
    // closed. If a future change wires requireLimit here without
    // closing that bypass, this test fails so the regression is
    // visible. See docs/MAX_AGENTS_POLICY.md.
    const layer = (workspaceMembersRouter as any).stack.find(
      (l: any) => l.route?.path === "/accept-invitation",
    );
    const stack = layer.route.stack;
    const handlerNames = stack.map((s: any) => s.handle.name);
    expect(handlerNames.some((n: string) => /requireLimit|max_agents/i.test(n))).toBe(false);
  });
});