/**
 * Explicit self-host billing-less entitlement boundary.
 *
 * `checkEntitlementFromDB` (server/middleware/featureGating.ts) only treats
 * a missing `check_workspace_entitlement` RPC as "unlimited" when BOTH:
 *   1. `ServerConfig.selfHostBillingUnlimited` (SELF_HOST_BILLING_MODE=
 *      unlimited) is explicitly set — a server-only, request-uncontrollable
 *      deployment flag, defaulting to false/fail-closed when absent.
 *   2. The RPC error precisely names `check_workspace_entitlement` as
 *      absent (isCheckWorkspaceEntitlementFunctionMissing in
 *      entitlementParse.ts).
 *
 * Neither is sufficient alone: PostgREST's own docs note PGRST202 can also
 * mean a stale schema-cache entry on a deployment where the function
 * genuinely exists, so error-parsing alone cannot prove deployment type.
 * These tests prove the full interaction matrix (cases A-G from the task's
 * required test list), in a file of its own — deliberately NOT appended to
 * requireLimitMiddleware.test.ts, whose own mock/cache state has a
 * pre-existing, unrelated contamination bug across its later describe
 * blocks (documented separately; several of ITS OWN pre-existing tests
 * already fail before any of this work, same signature, same file).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const rpcMock = vi.fn();
const counterRowMock = vi.fn();

// `server/` carries its OWN nested node_modules/@supabase/supabase-js
// (a different physical package than the root one) — featureGating.ts's
// `import { createClient } from '@supabase/supabase-js'` resolves against
// THAT nested copy. Mocking the bare root-relative specifier silently does
// not intercept it (confirmed: without this, checkEntitlementFromDB makes a
// REAL fetch to the stub URL and fails with ENOTFOUND) — mock the actual
// resolved path instead, exactly as
// workspaceInvitationAcceptance.pg.test.ts already does for the same reason.
vi.mock("../../../server/node_modules/@supabase/supabase-js", () => ({
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

import { requireLimit, requireFeature, clearEntitlementCache } from "../../../server/middleware/featureGating";
import { usageFnForLimit } from "../../../server/services/billing/usageResolvers";

function makeReqRes(body: Record<string, unknown> = {}, configOverrides: Record<string, unknown> = {}) {
  const req: any = {
    body,
    query: {},
    params: {},
    serverConfig: {
      supabaseUrl: "http://stub",
      supabaseServiceRoleKey: "stub-key",
      ...configOverrides,
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

const missingFnError = (opts: { code?: string; message?: string } = {}) => ({
  data: null,
  error: {
    code: opts.code ?? "42883",
    message:
      opts.message ??
      "function public.check_workspace_entitlement(uuid, text) does not exist",
  },
});

describe("requireLimit/requireFeature — explicit self-host billing-less boundary", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    counterRowMock.mockReset();
    clearEntitlementCache();
  });

  it("A: selfHostBillingUnlimited=true + 42883 naming check_workspace_entitlement → allowed, limit -1, next() called, no usage check", async () => {
    rpcMock.mockResolvedValue(missingFnError());
    const mw = requireLimit("max_agents", usageFnForLimit("max_conversations"));
    const { req, res, getResult } = makeReqRes(
      { workspace_id: "shu-a" },
      { selfHostBillingUnlimited: true },
    );
    const next = vi.fn();
    await mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(getResult().statusCode).toBeUndefined();
    expect((req as any).entitlement?.allowed).toBe(true);
    expect((req as any).entitlement?.limit).toBe(-1);
    expect(counterRowMock).not.toHaveBeenCalled();
  });

  it("B: selfHostBillingUnlimited absent + PGRST202 for check_workspace_entitlement → 503, not allowed", async () => {
    rpcMock.mockResolvedValue(
      missingFnError({ code: "PGRST202", message: "Could not find the function public.check_workspace_entitlement in the schema cache" }),
    );
    const mw = requireLimit("max_agents", usageFnForLimit("max_conversations"));
    const { req, res, getResult } = makeReqRes({ workspace_id: "shu-b" });
    const next = vi.fn();
    await mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(getResult().statusCode).toBe(503);
    expect(getResult().jsonBody?.retryable).toBe(true);
  });

  it("C: selfHostBillingUnlimited absent (hosted/default) + 42883 naming check_workspace_entitlement → 503, not allowed", async () => {
    rpcMock.mockResolvedValue(missingFnError());
    const mw = requireLimit("max_agents", usageFnForLimit("max_conversations"));
    const { req, res, getResult } = makeReqRes({ workspace_id: "shu-c" });
    const next = vi.fn();
    await mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(getResult().statusCode).toBe(503);
  });

  // The exact scenario the reviewer flagged: a stale hosted schema-cache
  // entry (PGRST202) must never silently unlock unlimited access, even
  // though the raw error is textually identical to the self-host case.
  it("D: selfHostBillingUnlimited absent (hosted/default) + PGRST202 schema-cache message → 503, not allowed", async () => {
    rpcMock.mockResolvedValue(
      missingFnError({ code: "PGRST202", message: "Could not find the function public.check_workspace_entitlement without parameters in the schema cache" }),
    );
    const mw = requireLimit("max_agents", usageFnForLimit("max_conversations"));
    const { req, res, getResult } = makeReqRes({ workspace_id: "shu-d" }, { selfHostBillingUnlimited: false });
    const next = vi.fn();
    await mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(getResult().statusCode).toBe(503);
  });

  it("E: selfHostBillingUnlimited=true + permission denied → 503, not allowed (error doesn't precisely name the function as absent)", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { code: "42501", message: "permission denied for function check_workspace_entitlement" },
    });
    const mw = requireLimit("max_agents", usageFnForLimit("max_conversations"));
    const { req, res, getResult } = makeReqRes({ workspace_id: "shu-e" }, { selfHostBillingUnlimited: true });
    const next = vi.fn();
    await mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(getResult().statusCode).toBe(503);
  });

  it("F: selfHostBillingUnlimited=true + generic timeout/network error → 503, not allowed", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "timeout" } });
    const mw = requireLimit("max_agents", usageFnForLimit("max_conversations"));
    const { req, res, getResult } = makeReqRes({ workspace_id: "shu-f" }, { selfHostBillingUnlimited: true });
    const next = vi.fn();
    await mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(getResult().statusCode).toBe(503);
  });

  it("G1: selfHostBillingUnlimited=true + a real, well-formed allowed payload behaves exactly as before (usage check still runs)", async () => {
    rpcMock.mockResolvedValue({ data: { allowed: true, limit: 5, plan: "pro" }, error: null });
    counterRowMock.mockResolvedValue({ data: { conversations_count: 2 }, error: null });
    const mw = requireLimit("max_conversations", usageFnForLimit("max_conversations"));
    const { req, res, getResult } = makeReqRes({ workspace_id: "shu-g1" }, { selfHostBillingUnlimited: true });
    const next = vi.fn();
    await mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(getResult().statusCode).toBeUndefined();
    expect((req as any).entitlement?.limit).toBe(5);
    expect(counterRowMock).toHaveBeenCalled();
  });

  it("G2: selfHostBillingUnlimited=true + a real, well-formed denial behaves exactly as before (403)", async () => {
    rpcMock.mockResolvedValue({ data: { allowed: false, plan: "free" }, error: null });
    const mw = requireLimit("max_conversations", usageFnForLimit("max_conversations"));
    const { req, res, getResult } = makeReqRes({ workspace_id: "shu-g2" }, { selfHostBillingUnlimited: true });
    const next = vi.fn();
    await mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(getResult().statusCode).toBe(403);
    expect(getResult().jsonBody?.upgrade_required).toBe(true);
  });

  it("G3: selfHostBillingUnlimited=true + requireFeature real denial behaves exactly as before (403)", async () => {
    rpcMock.mockResolvedValue({ data: { allowed: false, plan: "free" }, error: null });
    const { req, res, getResult } = makeReqRes({ workspace_id: "shu-g3" }, { selfHostBillingUnlimited: true });
    const next = vi.fn();
    await requireFeature("ai_assistant")(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(getResult().statusCode).toBe(403);
    expect(getResult().jsonBody?.upgrade_required).toBe(true);
  });

  it("G4: selfHostBillingUnlimited=true + requireFeature real allow behaves exactly as before (next())", async () => {
    rpcMock.mockResolvedValue({ data: { allowed: true, plan: "pro" }, error: null });
    const { req, res } = makeReqRes({ workspace_id: "shu-g4" }, { selfHostBillingUnlimited: true });
    const next = vi.fn();
    await requireFeature("ai_assistant")(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
