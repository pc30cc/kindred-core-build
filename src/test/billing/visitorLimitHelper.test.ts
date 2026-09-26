/**
 * Runtime behavior tests for `enforceMaxVisitorsLimitIfNewThisMonth`.
 *
 * Verifies the three contracted branches:
 *   - in-month revisit short-circuits without invoking the cap middleware
 *   - true new-this-month visitor invokes the shared `requireLimit` path
 *   - read errors fail OPEN (treat as in-month) by contract
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const rpcMock = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: (...args: unknown[]) => rpcMock(...args),
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { storage_bytes: 0 }, error: null }),
          }),
        }),
      }),
    }),
  }),
}));

import { enforceMaxVisitorsLimitIfNewThisMonth } from "../../../server/services/billing/visitorLimit";
import { clearEntitlementCache } from "../../../server/middleware/featureGating";

/**
 * Minimal SupabaseClient stub for the helper's in-month membership read.
 * Returns a chain whose terminal `.maybeSingle()` resolves with the value
 * configured per test.
 */
function makeSupabaseStub(maybeSingleResult: { data: any; error: any }) {
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    gte: () => chain,
    limit: () => chain,
    maybeSingle: async () => maybeSingleResult,
  };
  const sb: any = { from: () => chain };
  return sb;
}

function makeReqRes() {
  const req: any = {
    body: { workspace_id: "ws-vis" },
    query: {},
    params: {},
    serverConfig: { supabaseUrl: "http://stub", supabaseServiceRoleKey: "key" },
  };
  let statusCode: number | undefined;
  const res: any = {
    status(code: number) { statusCode = code; return res; },
    json() { return res; },
  };
  return { req, res, getStatus: () => statusCode };
}

describe("enforceMaxVisitorsLimitIfNewThisMonth — runtime behavior", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    clearEntitlementCache();
  });

  it("returns true and skips the cap middleware on an in-month revisit", async () => {
    const sb = makeSupabaseStub({ data: { id: "session-1" }, error: null });
    const { req, res } = makeReqRes();
    const ok = await enforceMaxVisitorsLimitIfNewThisMonth(
      req, res, sb, "ws-vis", "visitor-1",
    );
    expect(ok).toBe(true);
    expect(rpcMock).not.toHaveBeenCalled(); // requireLimit was never reached
  });

  it("invokes the cap middleware on a true new-this-month visitor and proceeds when allowed", async () => {
    rpcMock.mockResolvedValue({
      data: { allowed: true, limit: -1, plan: "pro" },
      error: null,
    });
    const sb = makeSupabaseStub({ data: null, error: null });
    const { req, res } = makeReqRes();
    const ok = await enforceMaxVisitorsLimitIfNewThisMonth(
      req, res, sb, "ws-vis-2", "visitor-2",
    );
    expect(ok).toBe(true);
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });

  it("returns false (and lets middleware write 403) when the cap is reached for a new-this-month visitor", async () => {
    rpcMock.mockResolvedValue({
      data: { allowed: true, limit: 1, plan: "free" },
      error: null,
    });
    // Counter resolver in this mock returns storage_bytes=0; for max_visitors
    // it will be read as visitors_count (column not present) → 0 → below limit.
    // To force a deny we return a high count via a dedicated resolver mock:
    // override the from().maybeSingle for workspace_usage_counters by
    // re-mocking via the global createClient.
    // Simpler: assert with limit=0 to guarantee deny regardless of count.
    rpcMock.mockResolvedValue({
      data: { allowed: true, limit: 0, plan: "free" },
      error: null,
    });
    const sb = makeSupabaseStub({ data: null, error: null });
    const { req, res, getStatus } = makeReqRes();
    const ok = await enforceMaxVisitorsLimitIfNewThisMonth(
      req, res, sb, "ws-vis-3", "visitor-3",
    );
    expect(ok).toBe(false);
    expect(getStatus()).toBe(403);
  });

  it("evaluates the workspace argument, ignoring a spoofed body workspaceId", async () => {
    // Regression: the helper received the authorized workspace but the
    // shared middleware re-read req.body, preferring body.workspaceId.
    rpcMock.mockImplementation(async (_fn: string, args: { _workspace_id: string }) => ({
      data: args._workspace_id === "ws-unlimited"
        ? { allowed: true, limit: -1, plan: "enterprise" }
        : { allowed: true, limit: 0, plan: "free" },
      error: null,
    }));
    const sb = makeSupabaseStub({ data: null, error: null });
    const { req, res, getStatus } = makeReqRes();
    req.body = { workspace_id: "ws-vis-5", workspaceId: "ws-unlimited" };
    const ok = await enforceMaxVisitorsLimitIfNewThisMonth(
      req, res, sb, "ws-vis-5", "visitor-5",
    );
    expect(ok).toBe(false);
    expect(getStatus()).toBe(403);
    expect(rpcMock.mock.calls[0][1]._workspace_id).toBe("ws-vis-5");
  });

  it("fails OPEN (returns true, no rpc call) when the in-month membership read errors", async () => {
    const sb = makeSupabaseStub({ data: null, error: { message: "db down" } });
    const { req, res } = makeReqRes();
    const ok = await enforceMaxVisitorsLimitIfNewThisMonth(
      req, res, sb, "ws-vis-4", "visitor-4",
    );
    expect(ok).toBe(true);
    expect(rpcMock).not.toHaveBeenCalled();
  });
});