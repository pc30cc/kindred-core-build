/**
 * Runtime route handler tests for POST /api/ai-kb/jobs.
 *
 * Two highest-value branches:
 *   1. Global admin bypass — never invokes the monthly job-cap gate, and a
 *      job row is inserted with admin_override=true.
 *   2. Non-admin over-cap — the shared `requireLimit` gate writes 403 and
 *      no job row is inserted (route honors middleware short-circuit).
 *   3. Non-admin under-cap — gate allows; job is inserted.
 *
 * The route still uses the shared `requireLimit` + `usageFnForLimit` pair,
 * not duplicate per-route count math (verified by Phase 16 source-level
 * invariants; here we verify branching at runtime).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;

const state: {
  isAdmin: boolean;
  gateAllow: boolean;
  inserts: Array<{ table: string; row: Row }>;
  user: { data: { user: { id: string } | null }; error: null } | null;
  isMember: { data: boolean; error: { message: string } | null } | null;
} = {
  isAdmin: false,
  gateAllow: true,
  inserts: [],
  user: null,
  isMember: null,
};

const sbMock = {
  auth: { getUser: async () => state.user },
  rpc: async (name: string) => {
    if (name === "is_workspace_member") return state.isMember;
    return { data: null, error: null };
  },
  from: (table: string) => {
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: () => builder,
      order: () => builder,
      limit: () => builder,
      // Membership is the workspace_members row (is_workspace_member's
      // definition); its presence follows state.isMember.
      maybeSingle: async () =>
        table === "workspace_members"
          ? { data: state.isMember?.data ? { role: null, suspended_at: null } : null, error: state.isMember?.error ?? null }
          : { data: null, error: null },
      single: async () => ({
        data: { id: "job-1", workspace_id: "ws-uuid" },
        error: null,
      }),
      insert: (row: Row) => {
        state.inserts.push({ table, row });
        return {
          select: () => ({
            single: async () => ({
              data: { id: "job-1", ...row },
              error: null,
            }),
          }),
        };
      },
    };
    return builder;
  },
};

vi.mock("../../../server/supabase.js", () => ({
  getServiceClient: () => sbMock,
}));

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

const { gateMw } = vi.hoisted(() => ({ gateMw: vi.fn() }));
vi.mock("../../../server/middleware/featureGating.js", () => ({
  requireLimit: (..._args: unknown[]) => gateMw,
  checkModuleAccess: async () => ({ allowed: true, plan: "pro" }),
  checkEntitlementFromDB: async () => ({ allowed: true, reason: "plan" }),
}));

// Phase 6-S5-R3: the route now runs the central AI-KB gate. Entitlements and
// the platform switch are satisfied here so the test isolates the LIMIT gate.
vi.mock("../../../server/services/ai-agent/platformGuards.js", () => ({
  assertAiAgentPlatformEnabledForWorkspace: async () => ({ ok: true }),
}));
vi.mock("../../../server/services/knowledge-base/access.js", () => ({
  checkKnowledgeBasePermission: async () => null,
  // R7.2 — the AI-KB gate now distinguishes "denied" from "could not be
  // evaluated"; the granted path must be modelled explicitly.
  checkKnowledgeBasePermissionDetailed: async () => "granted",
}));

vi.mock("../../../server/services/billing/usageResolvers.js", () => ({
  usageFnForLimit: () => () => 0,
}));

vi.mock("../../../server/middleware/adminBypass.js", () => ({
  isGlobalAdmin: async () => state.isAdmin,
  logGateBypass: async () => {},
}));

vi.mock("../../../server/services/ai-kb/sourceDomain.js", () => ({
  resolveSourceDomain: async () => ({
    can_scan: true,
    domain: "example.com",
    workspace_domain_id: "wd-1",
    verified: true,
    kind: "workspace_domain",
  }),
  // R7.3 — the route now consumes the fail-closed ReadResult variant.
  resolveSourceDomainDetailed: async () => ({
    ok: true,
    value: {
      can_scan: true,
      domain: "example.com",
      workspace_domain_id: "wd-1",
      verified: true,
      kind: "workspace_domain",
    },
  }),
}));

vi.mock("../../../server/services/ai-kb/limits.js", () => ({
  resolveAiKbLimits: async () => ({
    planSlug: "pro",
    limits: { jobsPerMonth: 5, maxPagesPerJob: 50, maxArticlesPerJob: 10 },
  }),
  resolveAiKbLimitsDetailed: async () => ({
    ok: true,
    value: {
      planSlug: "pro",
      limits: { jobsPerMonth: 5, maxPagesPerJob: 50, maxArticlesPerJob: 10 },
    },
  }),
  countJobsThisMonth: async () => 0,
  countJobsThisMonthDetailed: async () => ({ ok: true, value: 0 }),
}));

vi.mock("../../../server/services/ai-kb/credits.js", () => ({
  logAiKbUsage: async () => {},
  readAiCreditState: async () => ({}),
  readAiCreditStateDetailed: async () => ({ ok: true, value: {} }),
}));

import { aiKbRouter } from "../../../server/routes/aiKb";

type MockRes = { status(code: number): MockRes; json(body: unknown): MockRes };
type Handler = (req: Row, res: MockRes, next: () => void) => Promise<void> | void;
interface RouteLayer {
  route?: { path?: string; methods?: Record<string, boolean>; stack: Array<{ handle: Handler }> };
}

function getHandler(method: string, path: string): Handler {
  const layer = aiKbRouter.stack.find((l) => {
    const route = (l as unknown as RouteLayer).route;
    return route?.path === path && !!route?.methods?.[method];
  });
  if (!layer) throw new Error(`route ${method} ${path} not found`);
  const stack = (layer as unknown as RouteLayer).route!.stack;
  return stack[stack.length - 1].handle;
}

function makeReqRes(body: Row) {
  const req: Row = {
    body,
    params: {},
    query: {},
    headers: { authorization: "Bearer t" },
    cookies: { gs_session: "t" },
    serverConfig: { supabaseUrl: "http://x", supabaseServiceRoleKey: "k" },
  };
  let statusCode: number | undefined;
  let jsonBody: unknown;
  const res: MockRes = {
    status(code: number) { statusCode = code; return res; },
    json(b: unknown) { jsonBody = b; return res; },
  };
  return { req, res, get: () => ({ statusCode, jsonBody }) };
}

describe("POST /api/ai-kb/jobs — admin bypass + cap gate", () => {
  beforeEach(() => {
    state.user = { data: { user: { id: "user-1" } }, error: null };
    state.isMember = { data: true, error: null };
    state.isAdmin = false;
    state.gateAllow = true;
    state.inserts = [];
    gateMw.mockReset();
    gateMw.mockImplementation(async (_req: unknown, res: MockRes, next: () => void) => {
      if (state.gateAllow) return next();
      res.status(403).json({ error: "over_limit", upgrade_required: true });
    });
  });

  it("global admin bypasses the job-cap gate and the job is inserted", async () => {
    state.isAdmin = true;
    state.gateAllow = false; // would deny if consulted
    const handler = getHandler("post", "/jobs");
    const { req, res, get } = makeReqRes({
      workspaceId: "33333333-3333-3333-3333-333333333333",
    });
    await handler(req, res, () => {});
    expect(gateMw).not.toHaveBeenCalled();
    const ins = state.inserts.find((i) => i.table === "ai_kb_jobs");
    expect(ins).toBeTruthy();
    expect(ins!.row.admin_override).toBe(true);
    expect(get().statusCode).toBe(201);
  });

  it("non-admin over the monthly cap is denied with 403 and NO job is inserted", async () => {
    state.isAdmin = false;
    state.gateAllow = false;
    const handler = getHandler("post", "/jobs");
    const { req, res, get } = makeReqRes({
      workspaceId: "33333333-3333-3333-3333-333333333333",
    });
    await handler(req, res, () => {});
    expect(gateMw).toHaveBeenCalledTimes(1);
    expect(state.inserts.find((i) => i.table === "ai_kb_jobs")).toBeFalsy();
    expect(get().statusCode).toBe(403);
  });

  it("non-admin below the cap proceeds through the shared gate and inserts a job", async () => {
    state.isAdmin = false;
    state.gateAllow = true;
    const handler = getHandler("post", "/jobs");
    const { req, res, get } = makeReqRes({
      workspaceId: "33333333-3333-3333-3333-333333333333",
    });
    await handler(req, res, () => {});
    expect(gateMw).toHaveBeenCalledTimes(1);
    const ins = state.inserts.find((i) => i.table === "ai_kb_jobs");
    expect(ins).toBeTruthy();
    expect(ins!.row.admin_override).toBe(false);
    expect(get().statusCode).toBe(201);
  });
});