/**
 * Runtime behavior tests for the shared `requireLimit` middleware.
 *
 * These exercise the real Express middleware function with a mocked
 * `@supabase/supabase-js` createClient, asserting allow / over-limit /
 * unlimited / plan-denied branches actually call (or don't call) `next()`
 * and write the expected status code. This complements the source-level
 * invariant tests with verified runtime behavior.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const rpcMock = vi.fn();
const counterRowMock = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: (...args: unknown[]) => rpcMock(...args),
    from: (_table: string) => ({
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

import {
  requireLimit,
  clearEntitlementCache,
} from "../../../server/middleware/featureGating";
import { usageFnForLimit } from "../../../server/services/billing/usageResolvers";

function makeReqRes(body: Record<string, unknown> = {}) {
  const req: any = {
    body,
    query: {},
    params: {},
    serverConfig: {
      supabaseUrl: "http://stub",
      supabaseServiceRoleKey: "stub-key",
    },
  };
  let statusCode: number | undefined;
  let jsonBody: any;
  const res: any = {
    status(code: number) { statusCode = code; return res; },
    json(b: any) { jsonBody = b; return res; },
  };
  const getResult = () => ({ statusCode, jsonBody });
  return { req, res, getResult };
}

describe("requireLimit middleware — runtime behavior", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    counterRowMock.mockReset();
    clearEntitlementCache();
  });

  it("calls next() and sets req.entitlement when usage is below limit", async () => {
    rpcMock.mockResolvedValue({
      data: { allowed: true, limit: 5, plan: "pro" },
      error: null,
    });
    counterRowMock.mockResolvedValue({
      data: { conversations_count: 2 },
      error: null,
    });
    const mw = requireLimit("max_conversations", usageFnForLimit("max_conversations"));
    const { req, res, getResult } = makeReqRes({ workspace_id: "ws-1" });
    const next = vi.fn();
    await mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(getResult().statusCode).toBeUndefined();
    expect((req as any).entitlement?.allowed).toBe(true);
  });

  it("returns 403 and does NOT call next() when usage is at or above limit", async () => {
    rpcMock.mockResolvedValue({
      data: { allowed: true, limit: 5, plan: "pro" },
      error: null,
    });
    counterRowMock.mockResolvedValue({
      data: { conversations_count: 5 },
      error: null,
    });
    const mw = requireLimit("max_conversations", usageFnForLimit("max_conversations"));
    const { req, res, getResult } = makeReqRes({ workspace_id: "ws-2" });
    const next = vi.fn();
    await mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(getResult().statusCode).toBe(403);
    expect(getResult().jsonBody?.feature).toBe("max_conversations");
    expect(getResult().jsonBody?.upgrade_required).toBe(true);
  });

  it("treats limit === -1 as unlimited and skips the usage comparison", async () => {
    rpcMock.mockResolvedValue({
      data: { allowed: true, limit: -1, plan: "enterprise" },
      error: null,
    });
    // counterRowMock intentionally not set — must not be called
    const mw = requireLimit("max_conversations", usageFnForLimit("max_conversations"));
    const { req, res } = makeReqRes({ workspace_id: "ws-3" });
    const next = vi.fn();
    await mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(counterRowMock).not.toHaveBeenCalled();
  });

  it("returns 403 with upgrade_required when plan disallows the feature outright", async () => {
    rpcMock.mockResolvedValue({
      data: { allowed: false, plan: "free", reason: "not_in_plan" },
      error: null,
    });
    const mw = requireLimit("max_conversations", usageFnForLimit("max_conversations"));
    const { req, res, getResult } = makeReqRes({ workspace_id: "ws-4" });
    const next = vi.fn();
    await mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(getResult().statusCode).toBe(403);
    expect(getResult().jsonBody?.upgrade_required).toBe(true);
  });

  it("returns 400 when no workspace id is present on the request", async () => {
    const mw = requireLimit("max_conversations", usageFnForLimit("max_conversations"));
    const { req, res, getResult } = makeReqRes({});
    const next = vi.fn();
    await mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(getResult().statusCode).toBe(400);
  });

  it("fails closed (403) when the usage resolver throws", async () => {
    rpcMock.mockResolvedValue({
      data: { allowed: true, limit: 5, plan: "pro" },
      error: null,
    });
    counterRowMock.mockResolvedValue({
      data: null,
      error: { message: "boom" },
    });
    const mw = requireLimit("max_conversations", usageFnForLimit("max_conversations"));
    const { req, res, getResult } = makeReqRes({ workspace_id: "ws-5" });
    const next = vi.fn();
    await mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    // R7.3 — an UNREADABLE usage counter is an outage, not a quota denial.
    // 403 told the customer they were over a limit the server never read and
    // pushed them toward an upgrade; 503 says "retry" and stays truthful.
    expect(getResult().statusCode).toBe(503);
    expect(getResult().jsonBody?.retryable).toBe(true);
  });
});