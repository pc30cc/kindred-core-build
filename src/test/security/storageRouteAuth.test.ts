/**
 * Regression tests for the cross-workspace access vulnerability in
 * `server/routes/storage.ts`.
 *
 * Before the fix these routes accepted the *publishable* anon key as proof of
 * identity and trusted a client-supplied `workspaceId` / `fileKey` while using
 * a service-role client that bypasses RLS.
 *
 * All dependencies are mocked at module boundaries — no network, no real DB.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const ANON_KEY = "anon-key-public";
const SERVICE_KEY = "service-role-key";
const WS_A = "11111111-1111-1111-1111-111111111111";
const WS_B = "22222222-2222-2222-2222-222222222222";

const state: {
  user: { data: { user: { id: string } | null }; error: unknown };
  isMember: boolean;
  role: string | null;
  isAdmin: boolean;
} = {
  user: { data: { user: { id: "user-1" } }, error: null },
  isMember: true,
  role: "owner",
  isAdmin: false,
};

const sbMock = {
  auth: { getUser: async () => state.user },
  rpc: async (name: string, args: Record<string, unknown>) => {
    if (name === "is_workspace_member") {
      // Membership is only granted for workspace A in these tests.
      return { data: state.isMember && args._workspace_id === WS_A, error: null };
    }
    if (name === "has_role") return { data: state.isAdmin, error: null };
    return { data: null, error: null };
  },
  from: () => {
    const builder: Record<string, unknown> = {};
    Object.assign(builder, {
      select: () => builder,
      eq: () => builder,
      maybeSingle: async () => ({ data: { role: state.role }, error: null }),
    });
    return builder;
  },
};

vi.mock("../../../server/supabase.js", () => ({ getServiceClient: () => sbMock }));

// Identity now comes from the gs_session cookie (server/lib/workspaceAuth.ts
// → server/services/auth/sessions.ts), not a Bearer JWT. This mock preserves
// the exact security property the "anon/service key rejected" tests below
// check: those specific well-known string values can never resolve to a
// session — same as in production, where they'd simply never match a real
// auth_sessions.token_hash row. Everything else routes through the same
// `state.user` toggle the old auth.getUser mock used, so beforeEach/test
// bodies that flip state.user to simulate "no/invalid identity" keep working.
vi.mock("../../../server/services/auth/sessions.js", () => ({
  SESSION_COOKIE_NAME: "gs_session",
  validateSessionToken: async (_config: unknown, token: string | undefined) => {
    if (!token || token === ANON_KEY || token === SERVICE_KEY) return null;
    const user = state.user.data.user;
    if (!user) return null;
    return { sessionId: "test-session", userId: user.id, email: "test@example.com" };
  },
}));

vi.mock("../../../server/middleware/featureGating.js", () => ({
  requireLimit: () => async (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../../server/services/billing/usageResolvers.js", () => ({
  usageFnForLimit: () => () => 0,
}));

const { uploadFileMock, deleteFileMock, getFileUrlMock, resolveStorageConfigMock } = vi.hoisted(() => ({
  uploadFileMock: vi.fn(async () => ({ success: true, fileKey: "k" })),
  deleteFileMock: vi.fn(async () => ({ success: true })),
  getFileUrlMock: vi.fn(async () => "https://cdn.example/x"),
  resolveStorageConfigMock: vi.fn(async () => ({ provider: "s3", bucket: "b" })),
}));
vi.mock("../../../server/services/storage/index.js", () => ({
  uploadFile: uploadFileMock,
  deleteFile: deleteFileMock,
  getFileUrl: getFileUrlMock,
  testStorageConnection: vi.fn(async () => ({ success: true, latencyMs: 1 })),
  resolveStorageConfig: resolveStorageConfigMock,
}));

import { storageRouter } from "../../../server/routes/storage";

type RouteLayer = {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: (req: unknown, res: unknown, next: () => void) => unknown }>;
  };
};

function getHandler(method: string, path: string) {
  const layer = (storageRouter as unknown as { stack: RouteLayer[] }).stack.find(
    (l) => l.route?.path === path && l.route.methods[method],
  );
  if (!layer?.route) throw new Error(`route ${method} ${path} not found`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function makeReqRes(opts: {
  token?: string | null;
  body?: Record<string, unknown>;
  query?: Record<string, unknown>;
  params?: Record<string, unknown>;
}) {
  const headers: Record<string, string> = {};
  if (opts.token !== null && opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
  const req = {
    headers,
    cookies: opts.token !== null && opts.token !== undefined ? { gs_session: opts.token } : {},
    body: opts.body ?? {},
    query: opts.query ?? {},
    params: opts.params ?? {},
    serverConfig: {
      supabaseUrl: "http://local",
      supabaseAnonKey: ANON_KEY,
      supabaseServiceRoleKey: SERVICE_KEY,
    },
  };
  let statusCode = 200;
  let jsonBody: unknown;
  const res = {
    status(code: number) { statusCode = code; return res; },
    json(b: unknown) { jsonBody = b; return res; },
  };
  return { req, res, get: () => ({ statusCode, jsonBody }) };
}

const validKeyA = `workspace/${WS_A}/uploads/photo.png`;
const b64 = Buffer.from("hello").toString("base64");

beforeEach(() => {
  state.user = { data: { user: { id: "user-1" } }, error: null };
  state.isMember = true;
  state.role = "owner";
  state.isAdmin = false;
  uploadFileMock.mockClear();
  deleteFileMock.mockClear();
  getFileUrlMock.mockClear();
  resolveStorageConfigMock.mockClear();
});

describe("storage routes — identity is required", () => {
  it("1. no Authorization header → 401", async () => {
    const { req, res, get } = makeReqRes({
      token: null,
      body: { workspaceId: WS_A, fileKey: validKeyA, data: b64 },
    });
    await getHandler("post", "/upload")(req, res, () => {});
    expect(get().statusCode).toBe(401);
    expect(uploadFileMock).not.toHaveBeenCalled();
  });

  it("2. anon (publishable) key is rejected on every route", async () => {
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ["post", "/upload", { body: { workspaceId: WS_A, fileKey: validKeyA, data: b64 } }],
      ["post", "/delete", { body: { workspaceId: WS_A, fileKey: validKeyA } }],
      ["get", "/url", { query: { workspaceId: WS_A, fileKey: validKeyA } }],
      ["get", "/config/:workspaceId", { params: { workspaceId: WS_A } }],
      ["post", "/test", { body: { provider: "s3" } }],
    ];
    for (const [method, path, extra] of cases) {
      const { req, res, get } = makeReqRes({ token: ANON_KEY, ...extra });
      await getHandler(method, path)(req, res, () => {});
      expect(get().statusCode, `${method} ${path}`).toBe(401);
    }
    expect(uploadFileMock).not.toHaveBeenCalled();
    expect(deleteFileMock).not.toHaveBeenCalled();
    expect(getFileUrlMock).not.toHaveBeenCalled();
  });

  it("2b. raw service-role key is not accepted as a public identity", async () => {
    const { req, res, get } = makeReqRes({
      token: SERVICE_KEY,
      body: { workspaceId: WS_A, fileKey: validKeyA, data: b64 },
    });
    await getHandler("post", "/upload")(req, res, () => {});
    expect(get().statusCode).toBe(401);
    expect(uploadFileMock).not.toHaveBeenCalled();
  });

  it("7. invalid / expired JWT → 401", async () => {
    state.user = { data: { user: null }, error: { message: "jwt expired" } };
    const { req, res, get } = makeReqRes({
      token: "expired.jwt.value",
      body: { workspaceId: WS_A, fileKey: validKeyA, data: b64 },
    });
    await getHandler("post", "/upload")(req, res, () => {});
    expect(get().statusCode).toBe(401);
    expect(uploadFileMock).not.toHaveBeenCalled();
  });
});

describe("storage routes — workspace authorization", () => {
  it("3. member of their own workspace can upload (previous success behaviour preserved)", async () => {
    const { req, res, get } = makeReqRes({
      token: "valid.jwt",
      body: { workspaceId: WS_A, fileKey: validKeyA, data: b64, contentType: "image/png" },
    });
    await getHandler("post", "/upload")(req, res, () => {});
    expect(get().statusCode).toBe(200);
    expect(get().jsonBody).toEqual({ success: true, fileKey: "k" });
    expect(uploadFileMock).toHaveBeenCalledTimes(1);
  });

  it("4. member of workspace A passing workspace B → 403", async () => {
    const { req, res, get } = makeReqRes({
      token: "valid.jwt",
      body: { workspaceId: WS_B, fileKey: `workspace/${WS_B}/x.png`, data: b64 },
    });
    await getHandler("post", "/upload")(req, res, () => {});
    expect(get().statusCode).toBe(403);
    expect(uploadFileMock).not.toHaveBeenCalled();
  });

  it("5. deleting another workspace's file is rejected", async () => {
    const { req, res, get } = makeReqRes({
      token: "valid.jwt",
      body: { workspaceId: WS_B, fileKey: `workspace/${WS_B}/secret.pdf` },
    });
    await getHandler("post", "/delete")(req, res, () => {});
    expect(get().statusCode).toBe(403);
    expect(deleteFileMock).not.toHaveBeenCalled();
  });

  it("5b. IDOR: member of A cannot delete a B-scoped key by claiming workspace A", async () => {
    const { req, res, get } = makeReqRes({
      token: "valid.jwt",
      body: { workspaceId: WS_A, fileKey: `workspace/${WS_B}/secret.pdf` },
    });
    await getHandler("post", "/delete")(req, res, () => {});
    expect(get().statusCode).toBe(400);
    expect(deleteFileMock).not.toHaveBeenCalled();
  });

  it("5c. a plain agent cannot delete (owner/admin required)", async () => {
    state.role = "agent";
    const { req, res, get } = makeReqRes({
      token: "valid.jwt",
      body: { workspaceId: WS_A, fileKey: validKeyA },
    });
    await getHandler("post", "/delete")(req, res, () => {});
    expect(get().statusCode).toBe(403);
    expect(deleteFileMock).not.toHaveBeenCalled();
  });

  it("owner can delete their own workspace file", async () => {
    const { req, res, get } = makeReqRes({
      token: "valid.jwt",
      body: { workspaceId: WS_A, fileKey: validKeyA },
    });
    await getHandler("post", "/delete")(req, res, () => {});
    expect(get().statusCode).toBe(200);
    expect(deleteFileMock).toHaveBeenCalledWith(expect.anything(), WS_A, validKeyA);
  });

  it("/url: member of A cannot read a B-scoped key", async () => {
    const { req, res, get } = makeReqRes({
      token: "valid.jwt",
      query: { workspaceId: WS_A, fileKey: `workspace/${WS_B}/private.png` },
    });
    await getHandler("get", "/url")(req, res, () => {});
    expect(get().statusCode).toBe(400);
    expect(getFileUrlMock).not.toHaveBeenCalled();
  });

  it("/config: non owner/admin member → 403, owner → 200", async () => {
    state.role = "agent";
    const denied = makeReqRes({ token: "valid.jwt", params: { workspaceId: WS_A } });
    await getHandler("get", "/config/:workspaceId")(denied.req, denied.res, () => {});
    expect(denied.get().statusCode).toBe(403);

    state.role = "owner";
    const allowed = makeReqRes({ token: "valid.jwt", params: { workspaceId: WS_A } });
    await getHandler("get", "/config/:workspaceId")(allowed.req, allowed.res, () => {});
    expect(allowed.get().statusCode).toBe(200);
    expect((allowed.get().jsonBody as { configured?: boolean }).configured).toBe(true);
  });

  it("/test requires a global admin", async () => {
    const denied = makeReqRes({ token: "valid.jwt", body: { provider: "s3" } });
    await getHandler("post", "/test")(denied.req, denied.res, () => {});
    expect(denied.get().statusCode).toBe(403);

    state.isAdmin = true;
    const allowed = makeReqRes({ token: "valid.jwt", body: { provider: "s3" } });
    await getHandler("post", "/test")(allowed.req, allowed.res, () => {});
    expect(allowed.get().statusCode).toBe(200);
  });
});

describe("storage routes — path traversal", () => {
  const traversals = [
    "../../etc/passwd",
    `workspace/${WS_A}/../${WS_B}/file.png`,
    `workspace/${WS_A}/%2e%2e/x.png`,
    "/absolute/path.png",
    "https://evil.example/x.png",
    `workspace\\${WS_A}\\x.png`,
    "uploads/no-prefix.png",
  ];

  it("6. traversal / unscoped keys are rejected with 400 and never reach storage", async () => {
    for (const key of traversals) {
      const { req, res, get } = makeReqRes({
        token: "valid.jwt",
        body: { workspaceId: WS_A, fileKey: key, data: b64 },
      });
      await getHandler("post", "/upload")(req, res, () => {});
      expect(get().statusCode, key).toBe(400);
    }
    expect(uploadFileMock).not.toHaveBeenCalled();
  });

  it("non-UUID workspaceId is rejected with 400", async () => {
    const { req, res, get } = makeReqRes({
      token: "valid.jwt",
      body: { workspaceId: "not-a-uuid", fileKey: "workspace/not-a-uuid/x.png", data: b64 },
    });
    await getHandler("post", "/upload")(req, res, () => {});
    expect(get().statusCode).toBe(400);
    expect(uploadFileMock).not.toHaveBeenCalled();
  });
});

describe("storage routes — error messages leak nothing", () => {
  it("500 handlers return generic messages", async () => {
    deleteFileMock.mockRejectedValueOnce(new Error("s3://bucket secret-key-abc failed"));
    const { req, res, get } = makeReqRes({
      token: "valid.jwt",
      body: { workspaceId: WS_A, fileKey: validKeyA },
    });
    await getHandler("post", "/delete")(req, res, () => {});
    expect(get().statusCode).toBe(500);
    expect(JSON.stringify(get().jsonBody)).not.toContain("secret-key-abc");
  });
});
