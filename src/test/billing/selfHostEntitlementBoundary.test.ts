/**
 * Explicit self-host billing-less entitlement boundary.
 *
 * `SELF_HOST_BILLING_MODE=unlimited` (ServerConfig.selfHostBillingUnlimited)
 * is a server-only, request-uncontrollable deployment switch, false/fail-
 * closed when unset. With it, `checkEntitlementFromDB`
 * (server/middleware/featureGating.ts) answers "allowed, unlimited" without
 * consulting the database at all — whatever the billing RPC would say, and
 * whether or not it exists. Since 251 the migration chain installs
 * `check_workspace_entitlement` everywhere, so the switch can no longer be
 * inferred from the function's absence; it has to stand on its own.
 *
 * Without the switch — the default, and every hosted deployment — the plan is
 * enforced: a real denial is a 403, and every RPC failure (a missing function
 * or a stale-schema-cache PGRST202 included) fails closed with a 503. Those
 * cases are what keep a hosted install from ever being unlocked by an error.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const rpcMock = vi.fn();
const counterRowMock = vi.fn();

// featureGating.ts does `import { createClient } from '@supabase/supabase-js'`,
// and that has to be intercepted or checkEntitlementFromDB makes a real fetch
// to the stub URL, fails with ENOTFOUND, and every case below lands in the
// error path — which is also the path some of them are asserting, so the
// failures are silent in exactly the wrong way.
//
// This used to mock `server/node_modules/@supabase/supabase-js`, because
// `server/` once carried its own nested copy of the package that the bare
// specifier resolved to. There is no `server/node_modules` any more, so that
// specifier resolved to nothing and intercepted nothing. The bare specifier
// is now the one that resolves.
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

  it("A: selfHostBillingUnlimited=true + check_workspace_entitlement absent → allowed, limit -1, next() called, no usage check", async () => {
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

  // With the switch, the database is never asked: no error and no real
  // answer can change the outcome.
  for (const [label, rpcAnswer] of [
    ["permission denied", { data: null, error: { code: "42501", message: "permission denied for function check_workspace_entitlement" } }],
    ["timeout / network error", { data: null, error: { message: "timeout" } }],
    ["a real denial", { data: { allowed: false, plan: "free" }, error: null }],
    ["a real limited allow", { data: { allowed: true, limit: 5, plan: "pro" }, error: null }],
  ] as const) {
    it(`E: selfHostBillingUnlimited=true + ${label} → allowed, unlimited, the RPC is not called`, async () => {
      rpcMock.mockResolvedValue(rpcAnswer);
      const mw = requireLimit("max_conversations", usageFnForLimit("max_conversations"));
      const { req, res, getResult } = makeReqRes({ workspace_id: `shu-e-${label}` }, { selfHostBillingUnlimited: true });
      const next = vi.fn();
      await mw(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(getResult().statusCode).toBeUndefined();
      expect((req as any).entitlement?.limit).toBe(-1);
      expect(rpcMock).not.toHaveBeenCalled();
      expect(counterRowMock).not.toHaveBeenCalled();
    });
  }

  it("F: selfHostBillingUnlimited=true + requireFeature → next(), the RPC is not called", async () => {
    rpcMock.mockResolvedValue({ data: { allowed: false, plan: "free" }, error: null });
    const { req, res, getResult } = makeReqRes({ workspace_id: "shu-f" }, { selfHostBillingUnlimited: true });
    const next = vi.fn();
    await requireFeature("ai_assistant")(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(getResult().statusCode).toBeUndefined();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("G1: selfHostBillingUnlimited absent + a real, well-formed allowed payload → usage check runs", async () => {
    rpcMock.mockResolvedValue({ data: { allowed: true, limit: 5, plan: "pro" }, error: null });
    counterRowMock.mockResolvedValue({ data: { conversations_count: 2 }, error: null });
    const mw = requireLimit("max_conversations", usageFnForLimit("max_conversations"));
    const { req, res, getResult } = makeReqRes({ workspace_id: "shu-g1" });
    const next = vi.fn();
    await mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(getResult().statusCode).toBeUndefined();
    expect((req as any).entitlement?.limit).toBe(5);
    expect(counterRowMock).toHaveBeenCalled();
  });

  it("G2: selfHostBillingUnlimited absent + a real, well-formed denial → 403", async () => {
    rpcMock.mockResolvedValue({ data: { allowed: false, plan: "free" }, error: null });
    const mw = requireLimit("max_conversations", usageFnForLimit("max_conversations"));
    const { req, res, getResult } = makeReqRes({ workspace_id: "shu-g2" });
    const next = vi.fn();
    await mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(getResult().statusCode).toBe(403);
    expect(getResult().jsonBody?.upgrade_required).toBe(true);
  });

  it("G3: selfHostBillingUnlimited absent + requireFeature real denial → 403", async () => {
    rpcMock.mockResolvedValue({ data: { allowed: false, plan: "free" }, error: null });
    const { req, res, getResult } = makeReqRes({ workspace_id: "shu-g3" });
    const next = vi.fn();
    await requireFeature("ai_assistant")(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(getResult().statusCode).toBe(403);
    expect(getResult().jsonBody?.upgrade_required).toBe(true);
  });

  it("G4: selfHostBillingUnlimited absent + requireFeature real allow → next()", async () => {
    rpcMock.mockResolvedValue({ data: { allowed: true, plan: "pro" }, error: null });
    const { req, res } = makeReqRes({ workspace_id: "shu-g4" });
    const next = vi.fn();
    await requireFeature("ai_assistant")(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("G5: selfHostBillingUnlimited absent + permission denied → 503 (fails closed)", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: "42501", message: "permission denied for function check_workspace_entitlement" } });
    const mw = requireLimit("max_agents", usageFnForLimit("max_conversations"));
    const { req, res, getResult } = makeReqRes({ workspace_id: "shu-g5" });
    const next = vi.fn();
    await mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(getResult().statusCode).toBe(503);
  });
});
