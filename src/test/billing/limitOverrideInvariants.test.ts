/**
 * Cross-cutting invariant tests for usage-backed limit overrides.
 *
 * The canonical effective-limit resolver lives in the SQL RPC
 * `check_workspace_entitlement`, which now consults
 * `workspace_limit_overrides` before falling back to the plan limit.
 *
 * The TypeScript enforcement layer (`requireLimit`) is opaque to the
 * resolver source — it simply consumes the `limit` value the RPC
 * returns. These tests pin that invariant from the consumer side:
 *
 *   1. plan default is honored when no override exists
 *   2. workspace override wins when present (lower)
 *   3. workspace override wins when present (higher)
 *   4. override of -1 preserves unlimited semantics
 *   5. enforcement and diagnostics agree on the same final value
 *      (because both read from the same RPC contract)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const rpcMock = vi.fn();
const counterRowMock = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: (...args: unknown[]) => rpcMock(...args),
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: async () => counterRowMock() }),
        }),
      }),
    }),
  }),
}));

import {
  requireLimit,
  clearEntitlementCache,
  checkEntitlementFromDB,
} from "../../../server/middleware/featureGating";
import { usageFnForLimit } from "../../../server/services/billing/usageResolvers";

function makeReqRes(body: Record<string, unknown> = {}) {
  const req: any = {
    body, query: {}, params: {},
    serverConfig: { supabaseUrl: "http://stub", supabaseServiceRoleKey: "stub-key" },
  };
  let statusCode: number | undefined;
  let jsonBody: any;
  const res: any = {
    status(c: number) { statusCode = c; return res; },
    json(b: any) { jsonBody = b; return res; },
  };
  return { req, res, get: () => ({ statusCode, jsonBody }) };
}

describe("usage-backed limit override invariants", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    counterRowMock.mockReset();
    clearEntitlementCache();
  });

  it("plan default applies when no workspace override exists", async () => {
    rpcMock.mockResolvedValue({
      data: { allowed: true, limit: 100, plan: "pro", source: "plan" },
      error: null,
    });
    counterRowMock.mockResolvedValue({ data: { conversations_count: 50 }, error: null });
    const mw = requireLimit("max_conversations", usageFnForLimit("max_conversations"));
    const { req, res, get } = makeReqRes({ workspace_id: "ws-plan" });
    const next = vi.fn();
    await mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(get().statusCode).toBeUndefined();
    expect((req as any).entitlement?.limit).toBe(100);
  });

  it("workspace override (lower) wins over plan default and triggers 403 sooner", async () => {
    rpcMock.mockResolvedValue({
      data: { allowed: true, limit: 5, plan: "pro", source: "override" },
      error: null,
    });
    counterRowMock.mockResolvedValue({ data: { conversations_count: 5 }, error: null });
    const mw = requireLimit("max_conversations", usageFnForLimit("max_conversations"));
    const { req, res, get } = makeReqRes({ workspace_id: "ws-override-low" });
    const next = vi.fn();
    await mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(get().statusCode).toBe(403);
    expect(get().jsonBody?.limit).toBe(5);
  });

  it("workspace override (higher) wins over plan default and allows past plan cap", async () => {
    rpcMock.mockResolvedValue({
      data: { allowed: true, limit: 1000, plan: "pro", source: "override" },
      error: null,
    });
    counterRowMock.mockResolvedValue({ data: { conversations_count: 500 }, error: null });
    const mw = requireLimit("max_conversations", usageFnForLimit("max_conversations"));
    const { req, res, get } = makeReqRes({ workspace_id: "ws-override-high" });
    const next = vi.fn();
    await mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(get().statusCode).toBeUndefined();
  });

  it("override of -1 preserves unlimited semantics (skips usage check)", async () => {
    rpcMock.mockResolvedValue({
      data: { allowed: true, limit: -1, plan: "free", source: "override" },
      error: null,
    });
    const mw = requireLimit("max_contacts", usageFnForLimit("max_contacts"));
    const { req, res } = makeReqRes({ workspace_id: "ws-unlimited" });
    const next = vi.fn();
    await mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(counterRowMock).not.toHaveBeenCalled();
  });

  it("diagnostics and enforcement see the same effective value (single RPC contract)", async () => {
    rpcMock.mockResolvedValue({
      data: { allowed: true, limit: 42, plan: "pro", source: "override" },
      error: null,
    });
    const direct = await checkEntitlementFromDB("http://stub", "stub-key", "ws-x", "max_contacts");
    expect(direct.limit).toBe(42);

    counterRowMock.mockResolvedValue({ data: { conversations_count: 0 }, error: null });
    const mw = requireLimit("max_contacts", usageFnForLimit("max_contacts"));
    const { req, res } = makeReqRes({ workspace_id: "ws-x" });
    const next = vi.fn();
    await mw(req, res, next);
    expect((req as any).entitlement?.limit).toBe(42);
  });
});