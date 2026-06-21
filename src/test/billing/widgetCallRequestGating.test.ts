/**
 * Call Public/Queue/Callback Route Enforcement —
 * verifies visitor-facing widget create/request boundaries deny via the
 * canonical composer (deny-on-create / allow-on-cleanup-status).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const state: { effective: any } = { effective: null };

vi.mock("../../../server/services/calls/entitlementComposer.js", () => ({
  loadEffectiveCallEntitlements: async () => state.effective,
}));

vi.mock("../../../server/services/calls/callbacks.js", () => ({
  createCallbackRequest: vi.fn(async () => ({
    id: "cb-1",
    created_at: new Date().toISOString(),
  })),
}));
vi.mock("../../../server/services/calls/queue.js", () => ({
  markEntryAsCallback: vi.fn(async () => undefined),
}));
vi.mock("../../../server/supabase.js", () => ({
  getServiceClient: () => ({
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        in() { return this; },
        gte() { return this; },
        order() { return this; },
        limit() { return this; },
        maybeSingle: async () => ({ data: null, error: null }),
      };
    },
  }),
}));

import { widgetCallbacksRouter } from "../../../server/routes/widgetCallbacks";

function findHandler(router: any, method: string, path: string) {
  const layer = router.stack.find(
    (l: any) => l.route?.path === path && l.route.methods[method],
  );
  if (!layer) throw new Error(`route ${method} ${path} not found`);
  const stk = layer.route.stack;
  return stk[stk.length - 1].handle;
}

function makeReqRes(workspaceId: string | undefined) {
  const req: any = {
    body: { channel: "audio" },
    serverConfig: { supabaseUrl: "http://x", supabaseServiceRoleKey: "k" },
    _widgetWorkspaceId: workspaceId,
    visitorId: "v-1",
  };
  let statusCode: number | undefined;
  let jsonBody: any;
  const res: any = {
    status(c: number) { statusCode = c; return res; },
    json(b: any) { jsonBody = b; return res; },
  };
  return { req, res, get: () => ({ statusCode, jsonBody }) };
}

const fullEff = {
  voice_enabled: true, video_enabled: true,
  visitor_voice_enabled: true, visitor_video_enabled: true,
  recording_enabled: true, queue_enabled: true,
  callbacks_enabled: true, call_center_enabled: true,
  plan: {} as any, runtime: {} as any,
};

describe("widget callback request gating — deny-on-create / allow-on-status", () => {
  beforeEach(() => { state.effective = { ...fullEff }; });

  it("POST /request: 403 plan_forbidden when callbacks_enabled=false", async () => {
    state.effective = { ...fullEff, callbacks_enabled: false };
    const handler = findHandler(widgetCallbacksRouter, "post", "/request");
    const { req, res, get } = makeReqRes("11111111-1111-1111-1111-111111111111");
    await handler(req, res, () => {});
    expect(get().statusCode).toBe(403);
    expect(get().jsonBody?.error).toBe("plan_forbidden");
    expect(get().jsonBody?.capability).toBe("call_callbacks");
    expect(get().jsonBody?.upgrade_required).toBe(true);
  });

  it("POST /request: proceeds when composer allows", async () => {
    const handler = findHandler(widgetCallbacksRouter, "post", "/request");
    const { req, res, get } = makeReqRes("11111111-1111-1111-1111-111111111111");
    await handler(req, res, () => {});
    expect(get().statusCode).toBeUndefined();
    expect(get().jsonBody?.callback?.id).toBe("cb-1");
  });

  it("GET /status: NOT gated on the composer (visitor cleanup/read remains reachable)", async () => {
    state.effective = { ...fullEff, callbacks_enabled: false };
    const handler = findHandler(widgetCallbacksRouter, "get", "/status");
    const { req, res, get } = makeReqRes("11111111-1111-1111-1111-111111111111");
    await handler(req, res, () => {});
    expect(get().statusCode).not.toBe(403);
    expect(get().jsonBody?.has_open_callback).toBe(false);
  });
});