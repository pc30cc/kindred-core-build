/**
 * Runtime route handler tests for the operator conversation-attachment
 * upload endpoint. Closes the last meaningful entitlement-cleanup behavior
 * gap: when the storage_gb limit middleware rejects the upload, the
 * reserved `conversation_attachments` row must be marked status='failed'
 * and the file MUST NOT be uploaded.
 *
 * Dependencies are mocked at module boundaries (supabase service client,
 * shared `requireLimit`, storage uploadFile). No external network or DB.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const state: {
  attachmentRow: any;
  isMember: any;
  user: any;
  updates: Array<{ table: string; patch: any }>;
  uploadCalled: boolean;
  gateAllow: boolean;
} = {
  attachmentRow: null,
  isMember: null,
  user: null,
  updates: [],
  uploadCalled: false,
  gateAllow: true,
};

const sbMock = {
  auth: { getUser: async () => state.user },
  rpc: async (name: string) => {
    if (name === "is_workspace_member") return state.isMember;
    return { data: null, error: null };
  },
  from: (table: string) => {
    const builder: any = {
      select: () => builder,
      eq: () => builder,
      order: () => builder,
      limit: () => builder,
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

vi.mock("../../../server/services/auth/sessions.js", () => ({
  SESSION_COOKIE_NAME: "gs_session",
  validateSessionToken: async (_config: unknown, token: string | undefined) => {
    if (!token) return null;
    const user = state.user?.data?.user;
    if (!user) return null;
    return { sessionId: "test-session", userId: user.id, email: "test@example.com" };
  },
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
}));

import { conversationAttachmentsRouter } from "../../../server/routes/conversationAttachments";

function getHandler(method: string, path: string) {
  const layer: any = (conversationAttachmentsRouter as any).stack.find(
    (l: any) => l.route?.path === path && l.route.methods[method],
  );
  if (!layer) throw new Error(`route ${method} ${path} not found`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function makeReqRes(body: any, params: any = { id: "att-1" }) {
  const req: any = {
    body,
    params,
    query: {},
    headers: { authorization: "Bearer token-x" },
    cookies: { gs_session: "token-x" },
    serverConfig: { supabaseUrl: "http://x", supabaseServiceRoleKey: "k" },
  };
  let statusCode: number | undefined;
  let jsonBody: any;
  const res: any = {
    status(code: number) { statusCode = code; return res; },
    json(b: any) { jsonBody = b; return res; },
  };
  return { req, res, get: () => ({ statusCode, jsonBody }) };
}

describe("conversationAttachments POST /:id/upload — entitlement cleanup", () => {
  beforeEach(() => {
    state.user = { data: { user: { id: "user-1" } }, error: null };
    state.isMember = { data: true, error: null };
    state.attachmentRow = {
      id: "11111111-1111-1111-1111-111111111111",
      workspace_id: "22222222-2222-2222-2222-222222222222",
      storage_path:
        "workspace/22222222-2222-2222-2222-222222222222/attachments/2026/06/uuid-name.png",
      mime_type: "image/png",
      size_bytes: 12,
      status: "uploading",
      uploaded_by_id: "user-1",
      uploaded_by_type: "agent",
    };
    state.updates = [];
    state.uploadCalled = false;
    state.gateAllow = true;
    uploadFileMock.mockReset();
    uploadFileMock.mockImplementation(async () => {
      state.uploadCalled = true;
      return { success: true };
    });
  });

  it("when storage_gb gate rejects, marks reserved row 'failed' and does NOT upload", async () => {
    state.gateAllow = false;
    const handler = getHandler("post", "/:id/upload");
    const tinyB64 = Buffer.from("hello world!").toString("base64");
    const { req, res, get } = makeReqRes({
      workspace_id: "22222222-2222-2222-2222-222222222222",
      data: tinyB64,
    });
    await handler(req, res, () => {});
    expect(state.uploadCalled).toBe(false);
    expect(uploadFileMock).not.toHaveBeenCalled();
    const failed = state.updates.find(
      (u) => u.table === "conversation_attachments" && u.patch.status === "failed",
    );
    expect(failed).toBeTruthy();
    expect(failed!.patch.error_message).toMatch(/storage_gb/);
    expect(get().statusCode).toBe(403);
  });

  it("when storage_gb gate allows, upload proceeds and row is marked uploaded", async () => {
    state.gateAllow = true;
    const handler = getHandler("post", "/:id/upload");
    const tinyB64 = Buffer.from("hello world!").toString("base64");
    const { req, res, get } = makeReqRes({
      workspace_id: "22222222-2222-2222-2222-222222222222",
      data: tinyB64,
    });
    await handler(req, res, () => {});
    expect(uploadFileMock).toHaveBeenCalledTimes(1);
    expect(state.updates.some((u) => u.patch.status === "failed")).toBe(false);
    expect(state.updates.some((u) => u.patch.status === "uploaded")).toBe(true);
    expect(get().jsonBody?.status).toBe("uploaded");
  });
});