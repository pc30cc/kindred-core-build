/**
 * Runtime behavior tests for `enforceMaxConversationsLimit`.
 *
 * The helper wraps the shared `requireLimit('max_conversations', ...)`
 * middleware. Tests confirm:
 *   - allowed plan + below cap → returns true (caller proceeds)
 *   - cap reached → returns false and middleware writes 403
 *
 * Note on the "reply branch is not gated" rule: this helper is the ONLY
 * import seam between conversation routes and the cap. Reply branches
 * (POST /api/conversations/send-message, existing-conversation widget
 * branch) intentionally never import or invoke this helper. That guarantee
 * remains protected by the static single-writer / wiring invariants in
 * `singleWriterInvariants.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const rpcMock = vi.fn();
const counterRowMock = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: (...args: unknown[]) => rpcMock(...args),
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => counterRowMock(),
          }),
        }),
      }),
    }),
  }),
}));

import { enforceMaxConversationsLimit } from "../../../server/services/billing/conversationLimit";
import { clearEntitlementCache } from "../../../server/middleware/featureGating";

function makeReqRes(body: Record<string, unknown> = { workspace_id: "ws-c" }) {
  const req = {
    body,
    query: {},
    params: {},
    serverConfig: { supabaseUrl: "http://stub", supabaseServiceRoleKey: "key" },
  } as unknown as Request;
  let statusCode: number | undefined;
  const res = {
    status(code: number) { statusCode = code; return res; },
    json() { return res; },
  } as unknown as Response;
  return { req, res, getStatus: () => statusCode };
}

describe("enforceMaxConversationsLimit — runtime behavior", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    counterRowMock.mockReset();
    clearEntitlementCache();
  });

  it("returns true on the create branch when below the cap", async () => {
    rpcMock.mockResolvedValue({
      data: { allowed: true, limit: 100, plan: "pro" },
      error: null,
    });
    counterRowMock.mockResolvedValue({
      data: { conversations_count: 3 },
      error: null,
    });
    const { req, res, getStatus } = makeReqRes();
    const ok = await enforceMaxConversationsLimit(req, res, "ws-c");
    expect(ok).toBe(true);
    expect(getStatus()).toBeUndefined();
  });

  it("returns false and middleware writes 403 when cap is reached", async () => {
    rpcMock.mockResolvedValue({
      data: { allowed: true, limit: 3, plan: "free" },
      error: null,
    });
    counterRowMock.mockResolvedValue({
      data: { conversations_count: 3 },
      error: null,
    });
    const { req, res, getStatus } = makeReqRes();
    const ok = await enforceMaxConversationsLimit(req, res, "ws-c");
    expect(ok).toBe(false);
    expect(getStatus()).toBe(403);
  });

  it("returns false with 400 when workspace_id is missing", async () => {
    const { req, res, getStatus } = makeReqRes({});
    const ok = await enforceMaxConversationsLimit(req, res, "");
    expect(ok).toBe(false);
    expect(getStatus()).toBe(400);
  });

  it("does not fall back to body fields when the authorized workspace id is empty", async () => {
    const { req, res, getStatus } = makeReqRes({ workspace_id: "ws-c", workspaceId: "ws-c" });
    const ok = await enforceMaxConversationsLimit(req, res, "");
    expect(ok).toBe(false);
    expect(getStatus()).toBe(400);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("evaluates the authorized workspace, ignoring a spoofed body workspaceId", async () => {
    // Regression: a widget visitor added "workspaceId":"<unlimited ws>" next
    // to the token-validated workspace_id and the cap was checked on the
    // unlimited workspace instead.
    rpcMock.mockImplementation(async (_fn: string, args: { _workspace_id: string }) => ({
      data: args._workspace_id === "ws-unlimited"
        ? { allowed: true, limit: -1, plan: "enterprise" }
        : { allowed: true, limit: 3, plan: "free" },
      error: null,
    }));
    counterRowMock.mockResolvedValue({ data: { conversations_count: 3 }, error: null });
    const { req, res, getStatus } = makeReqRes({ workspace_id: "ws-c", workspaceId: "ws-unlimited" });
    const ok = await enforceMaxConversationsLimit(req, res, "ws-c");
    expect(ok).toBe(false);
    expect(getStatus()).toBe(403);
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock.mock.calls[0][1]._workspace_id).toBe("ws-c");
  });
});