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
  requireFeature,
  requireModule,
  requireAICredits,
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
// ═══════════════════════════════════════════════════════════
// Phase 6-S5-R7.4 §15 — outage vs denial classification.
// An entitlement/credit RPC that could not be EVALUATED must never render as
// "upgrade required": the customer cannot buy their way out of our outage.
// ═══════════════════════════════════════════════════════════

describe("requireLimit — unreadable entitlement classification", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    counterRowMock.mockReset();
    clearEntitlementCache();
  });

  const run = async (rpc: unknown, ws: string) => {
    rpcMock.mockResolvedValue(rpc);
    const mw = requireLimit("max_conversations", usageFnForLimit("max_conversations"));
    const { req, res, getResult } = makeReqRes({ workspace_id: ws });
    const next = vi.fn();
    await mw(req, res, next);
    return { next, ...getResult() };
  };

  it("entitlement RPC error → 503 retryable, not 403", async () => {
    const r = await run({ data: null, error: { message: "boom" } }, "u-1");
    expect(r.next).not.toHaveBeenCalled();
    expect(r.statusCode).toBe(503);
    expect(r.jsonBody?.error).toBe("entitlement_status_unavailable");
    expect(r.jsonBody?.retryable).toBe(true);
    expect(r.jsonBody?.upgrade_required).toBeUndefined();
  });

  it("entitlement RPC null payload → 503", async () => {
    const r = await run({ data: null, error: null }, "u-2");
    expect(r.statusCode).toBe(503);
    expect(r.jsonBody?.retryable).toBe(true);
  });

  it("payload missing the allowed boolean → 503", async () => {
    const r = await run({ data: { limit: 5 }, error: null }, "u-3");
    expect(r.statusCode).toBe(503);
  });

  it("invalid response shape (array) → 503", async () => {
    const r = await run({ data: [1, 2, 3], error: null }, "u-4");
    expect(r.statusCode).toBe(503);
  });

  it("allowed=true with NO numeric limit → 503, never limit zero", async () => {
    const r = await run({ data: { allowed: true, plan: "pro" }, error: null }, "u-5");
    expect(r.next).not.toHaveBeenCalled();
    expect(r.statusCode).toBe(503);
    expect(r.jsonBody?.error).toBe("entitlement_status_unavailable");
  });

  it("allowed=true with NaN limit → 503", async () => {
    const r = await run({ data: { allowed: true, limit: Number.NaN }, error: null }, "u-6");
    expect(r.statusCode).toBe(503);
  });

  it("allowed=true with Infinity limit → 503", async () => {
    const r = await run({ data: { allowed: true, limit: Number.POSITIVE_INFINITY }, error: null }, "u-7");
    expect(r.statusCode).toBe(503);
  });

  it("allowed=true with a non-numeric string limit → 503", async () => {
    const r = await run({ data: { allowed: true, limit: "many" }, error: null }, "u-8");
    expect(r.statusCode).toBe(503);
  });

  it("allowed=false without a limit remains an authoritative 403", async () => {
    const r = await run({ data: { allowed: false, plan: "free" }, error: null }, "u-9");
    expect(r.statusCode).toBe(403);
    expect(r.jsonBody?.upgrade_required).toBe(true);
  });

  it("does not cache an unavailable answer", async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    rpcMock.mockResolvedValueOnce({ data: { allowed: true, limit: 5 }, error: null });
    counterRowMock.mockResolvedValue({ data: { conversations_count: 0 }, error: null });
    const mw = requireLimit("max_conversations", usageFnForLimit("max_conversations"));
    const a = makeReqRes({ workspace_id: "u-10" });
    await mw(a.req, a.res, vi.fn());
    expect(a.getResult().statusCode).toBe(503);
    const b = makeReqRes({ workspace_id: "u-10" });
    const next = vi.fn();
    await mw(b.req, b.res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe("requireFeature / requireModule / requireAICredits — failure classification", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    counterRowMock.mockReset();
    clearEntitlementCache();
  });

  it("requireFeature: RPC error → 503 retryable", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "down" } });
    const { req, res, getResult } = makeReqRes({ workspace_id: "f-1" });
    const next = vi.fn();
    await requireFeature("ai_assistant")(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(getResult().statusCode).toBe(503);
    expect(getResult().jsonBody?.error).toBe("entitlement_status_unavailable");
  });

  it("requireFeature: authoritative denial → 403 upgrade_required", async () => {
    rpcMock.mockResolvedValue({ data: { allowed: false, plan: "free" }, error: null });
    const { req, res, getResult } = makeReqRes({ workspace_id: "f-2" });
    const next = vi.fn();
    await requireFeature("ai_assistant")(req, res, next);
    expect(getResult().statusCode).toBe(403);
    expect(getResult().jsonBody?.upgrade_required).toBe(true);
  });

  it("requireModule: unreadable module RPC → 503, not 403", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "down" } });
    const { req, res, getResult } = makeReqRes({ workspace_id: "m-1" });
    const next = vi.fn();
    await requireModule("ai_assistant")(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(getResult().statusCode).toBe(503);
    expect(getResult().jsonBody?.error).toBe("module_status_unavailable");
    expect(getResult().jsonBody?.upgrade_required).toBeUndefined();
  });

  it("requireModule: authoritative module denial → 403", async () => {
    rpcMock.mockResolvedValue({ data: { allowed: false, plan: "free" }, error: null });
    const { req, res, getResult } = makeReqRes({ workspace_id: "m-2" });
    await requireModule("ai_assistant")(req, res, vi.fn());
    expect(getResult().statusCode).toBe(403);
    expect(getResult().jsonBody?.upgrade_required).toBe(true);
  });

  it("requireAICredits: credit RPC error → 503, not credit exhaustion", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "down" } });
    const { req, res, getResult } = makeReqRes({ workspace_id: "c-1" });
    const next = vi.fn();
    await requireAICredits(1)(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(getResult().statusCode).toBe(503);
    expect(getResult().jsonBody?.error).toBe("ai_credit_status_unavailable");
    expect(getResult().jsonBody?.upgrade_required).toBeUndefined();
  });

  it("requireAICredits: genuine exhaustion → 403 upgrade_required", async () => {
    rpcMock.mockResolvedValue({
      data: { success: false, reason: "credits_exhausted", credits_used: 10, credits_limit: 10 },
      error: null,
    });
    const { req, res, getResult } = makeReqRes({ workspace_id: "c-2" });
    await requireAICredits(1)(req, res, vi.fn());
    expect(getResult().statusCode).toBe(403);
    expect(getResult().jsonBody?.upgrade_required).toBe(true);
  });

  it("requireAICredits: success → next()", async () => {
    rpcMock.mockResolvedValue({ data: { success: true, credits_remaining: 9 }, error: null });
    const { req, res } = makeReqRes({ workspace_id: "c-3" });
    const next = vi.fn();
    await requireAICredits(1)(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
