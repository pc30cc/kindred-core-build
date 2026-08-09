/**
 * Runtime route handler tests for the visitor-facing widget attachment
 * upload endpoint. Verifies the storage_gb gate denial branch marks the
 * reserved row status='failed' and prevents the upload from running, and
 * that the allow branch produces a normal 'uploaded' transition.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const state: {
  attachmentRow: any;
  updates: Array<{ table: string; patch: any }>;
  gateAllow: boolean;
} = { attachmentRow: null, updates: [], gateAllow: true };

const sbMock = {
  from: (table: string) => {
    const builder: any = {
      select: () => builder,
      eq: () => builder,
      maybeSingle: async () => {
        if (table === "conversation_attachments")
          return { data: state.attachmentRow, error: null };
        return { data: null, error: null };
      },
      update: (patch: any) => ({
        eq: async () => {
          state.updates.push({ table, patch });
          return { data: null, error: null };
        },
      }),
    };
    return builder;
  },
};

vi.mock("../../../server/supabase.js", () => ({
  getServiceClient: () => sbMock,
}));

vi.mock("../../../server/middleware/featureGating.js", () => ({
  requireLimit: () => async (_req: any, res: any, next: any) => {
    if (state.gateAllow) return next();
    res.status(403).json({ error: "over_limit", upgrade_required: true });
  },
}));

vi.mock("../../../server/services/billing/usageResolvers.js", () => ({
  usageFnForLimit: () => () => 0,
}));

const { uploadFileMock } = vi.hoisted(() => ({
  uploadFileMock: vi.fn(async () => ({ success: true })),
}));
vi.mock("../../../server/services/storage/index.js", () => ({
  uploadFile: uploadFileMock,
  downloadFile: vi.fn(),
}));

vi.mock("../../../server/services/widget/security.js", () => ({
  enforceWidgetToken: (_req: any, _res: any, next: any) => next(),
  enforceOrigin: (_req: any, _res: any, next: any) => next(),
  widgetRateLimit: () => (_req: any, _res: any, next: any) => next(),
  resolveWorkspaceId: () =>
    "22222222-2222-2222-2222-222222222222",
  verifyConversationOwnership: async () => true,
}));

import { widgetAttachmentsRouter } from "../../../server/routes/widgetAttachments";

function getHandler(method: string, path: string) {
  const layer: any = (widgetAttachmentsRouter as any).stack.find(
    (l: any) => l.route?.path === path && l.route.methods[method],
  );
  if (!layer) throw new Error(`route ${method} ${path} not found`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function makeReqRes(body: any) {
  const req: any = {
    body,
    params: { id: "11111111-1111-1111-1111-111111111111" },
    query: {},
    headers: {},
    serverConfig: { supabaseUrl: "http://x", supabaseServiceRoleKey: "k" },
  };
  let statusCode: number | undefined;
  let jsonBody: any;
  const res: any = {
    headersSent: false,
    status(code: number) { statusCode = code; res.headersSent = true; return res; },
    json(b: any) { jsonBody = b; return res; },
  };
  return { req, res, get: () => ({ statusCode, jsonBody }) };
}

describe("widgetAttachments POST /:id/upload — entitlement cleanup", () => {
  beforeEach(() => {
    state.attachmentRow = {
      id: "11111111-1111-1111-1111-111111111111",
      workspace_id: "22222222-2222-2222-2222-222222222222",
      storage_path:
        "workspace/22222222-2222-2222-2222-222222222222/attachments/2026/06/uuid-name.png",
      storage_provider: "local",
      mime_type: "image/png",
      size_bytes: 12,
      status: "uploading",
    };
    state.updates = [];
    state.gateAllow = true;
    uploadFileMock.mockReset();
    uploadFileMock.mockImplementation(async () => ({ success: true }));
  });

  it("when storage_gb gate rejects, marks reserved row 'failed' and skips upload", async () => {
    state.gateAllow = false;
    const handler = getHandler("post", "/:id/upload");
    const tinyB64 = Buffer.from("hello world!").toString("base64");
    const { req, res, get } = makeReqRes({ data: tinyB64 });
    await handler(req, res, () => {});
    expect(uploadFileMock).not.toHaveBeenCalled();
    const failed = state.updates.find(
      (u) => u.table === "conversation_attachments" && u.patch.status === "failed",
    );
    expect(failed).toBeTruthy();
    expect(failed!.patch.error_message).toMatch(/storage_gb/);
    expect(get().statusCode).toBe(403);
  });

  it("when storage_gb gate allows, upload proceeds and row transitions to 'uploaded'", async () => {
    state.gateAllow = true;
    const handler = getHandler("post", "/:id/upload");
    const tinyB64 = Buffer.from("hello world!").toString("base64");
    const { req, res, get } = makeReqRes({ data: tinyB64 });
    await handler(req, res, () => {});
    expect(uploadFileMock).toHaveBeenCalledTimes(1);
    expect(state.updates.some((u) => u.patch.status === "failed")).toBe(false);
    expect(state.updates.some((u) => u.patch.status === "uploaded")).toBe(true);
    expect(get().jsonBody?.status).toBe("uploaded");
  });
});