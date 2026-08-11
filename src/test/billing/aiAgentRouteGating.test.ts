/**
 * AI Agent route audit + selective gating phase.
 *
 * Verifies the smallest safe rollout on server/routes/aiAgent.ts:
 *   - POST /generate-business-description is gated by requireModule('ai_assistant')
 *   - POST /learning-candidates/generate is gated by requireModule('ai_assistant')
 *
 * Routes intentionally left admin-safe / deferred (settings, sources, runs,
 * qna CRUD, knowledge-index, operator-assist analytics, files, workflows,
 * topics, test-cases) MUST NOT carry the module guard.
 *
 * The middleware itself is exercised end-to-end against a mocked
 * `check_module_access` RPC to confirm allow / deny semantics.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Mock the supabase client used by the gating middleware.
const rpcState: { allowed: boolean } = { allowed: true };
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: async (name: string) => {
      if (name === "check_module_access") {
        return { data: { allowed: rpcState.allowed, plan: "starter", source: "plan" }, error: null };
      }
      return { data: null, error: null };
    },
  }),
}));

import { requireModule, clearEntitlementCache } from "../../../server/middleware/featureGating";

function makeReqRes(body: any = {}) {
  const req: any = {
    body,
    query: {},
    params: {},
    serverConfig: { supabaseUrl: "http://x", supabaseServiceRoleKey: "k" },
  };
  let statusCode: number | undefined;
  let jsonBody: any;
  const res: any = {
    status(c: number) { statusCode = c; return res; },
    json(b: any) { jsonBody = b; return res; },
  };
  return { req, res, get: () => ({ statusCode, jsonBody }) };
}

describe("AI Agent — selective module gating (phase rollout)", () => {
  beforeEach(() => {
    clearEntitlementCache();
  });

  it("requireModule('ai_assistant') denies with 403 when plan disallows", async () => {
    rpcState.allowed = false;
    const mw = requireModule("ai_assistant");
    const { req, res, get } = makeReqRes({ workspaceId: "11111111-1111-1111-1111-111111111111" });
    let nextCalled = false;
    await mw(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(false);
    expect(get().statusCode).toBe(403);
    expect(get().jsonBody?.module).toBe("ai_assistant");
    expect(get().jsonBody?.upgrade_required).toBe(true);
  });

  it("requireModule('ai_assistant') proceeds when plan allows", async () => {
    rpcState.allowed = true;
    const mw = requireModule("ai_assistant");
    const { req, res } = makeReqRes({ workspaceId: "22222222-2222-2222-2222-222222222222" });
    let nextCalled = false;
    await mw(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
  });
});

describe("AI Agent — source-level gate placement invariants", () => {
  // Phase 3 mechanical router split: the monolithic aiAgent.ts (which this
  // suite originally read directly) is now a compatibility re-export; the
  // actual route declarations live in per-domain subrouters under
  // server/routes/ai-agent/, each using its own `<domain>Router` variable
  // instead of the old shared `aiAgentRouter` name. Concatenate all domain
  // router source files so these invariants still hold across the split,
  // and match any `<word>Router.` call rather than the one old name.
  const domainFiles = [
    "platform", "assistant", "activity", "operatorAssist",
    "knowledge", "automation", "internalQa",
  ];
  const src = domainFiles
    .map((f) => readFileSync(
      resolve(__dirname, `../../../server/routes/ai-agent/${f}.ts`),
      "utf8",
    ))
    .join("\n");

  it("gates POST /generate-business-description with requireModule('ai_assistant')", () => {
    expect(src).toMatch(
      /\w+Router\.post\(\s*'\/generate-business-description'\s*,\s*requireModule\('ai_assistant'\)/,
    );
  });

  it("gates POST /learning-candidates/generate with requireModule('ai_assistant')", () => {
    expect(src).toMatch(
      /\w+Router\.post\(\s*'\/learning-candidates\/generate'\s*,\s*requireModule\('ai_assistant'\)/,
    );
  });

  it("preserves the existing POST /playground/test gate", () => {
    expect(src).toMatch(
      /\w+Router\.post\(\s*'\/playground\/test'\s*,\s*requireModule\('ai_assistant'\)/,
    );
  });

  it("does NOT add module gates to admin-safe / deferred routes", () => {
    // Intentionally left ungated so admin/operator tooling and read/status
    // surfaces remain reachable. Each pattern matches only the bare route
    // signature with no middleware between path and handler.
    const ungated: Array<[string, string]> = [
      ["GET",   "/settings"],
      ["PUT",   "/settings"],
      ["GET",   "/platform/settings"],
      ["GET",   "/diagnostics"],
      ["GET",   "/runs"],
      ["GET",   "/runs/:id/inspect"],
      ["GET",   "/qna"],
      ["POST",  "/qna"],
      ["POST",  "/knowledge-index/rebuild"],
      ["GET",   "/knowledge-index/status"],
      ["GET",   "/data-sources"],
      ["POST",  "/data-sources/website"],
      ["GET",   "/files"],
      ["POST",  "/files/upload"],
      ["GET",   "/operator-assist/analytics"],
      ["GET",   "/learning-candidates"],
      ["POST",  "/learning-candidates/:id/approve"],
      ["POST",  "/workflows/preview"],
      ["POST",  "/topics/test"],
    ];
    for (const [method, path] of ungated) {
      const lower = method.toLowerCase();
      const escaped = path.replace(/\//g, "\\/").replace(/:/g, ":");
      const re = new RegExp(
        `\\w+Router\\.${lower}\\(\\s*'${escaped}'\\s*,\\s*async`,
      );
      expect(src, `${method} ${path} should remain ungated`).toMatch(re);
    }
  });
});