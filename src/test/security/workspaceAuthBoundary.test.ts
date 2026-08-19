import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock the DB/session layers so this stays a pure unit test of the
// authorization *logic* (who gets let through, who doesn't) rather than a
// DB integration test — that's covered separately by the real-Postgres
// migration tests.
const validateSessionToken = vi.fn();
const isGlobalAdmin = vi.fn();
const rpc = vi.fn();
const from = vi.fn();

vi.mock('../../../server/services/auth/sessions', () => ({
  validateSessionToken: (...args: unknown[]) => validateSessionToken(...args),
  SESSION_COOKIE_NAME: 'gs_session',
}));
vi.mock('../../../server/middleware/adminBypass', () => ({
  isGlobalAdmin: (...args: unknown[]) => isGlobalAdmin(...args),
}));
vi.mock('../../../server/supabase', () => ({
  getServiceClient: () => ({ rpc, from }),
}));

function mockReqRes(cookieValue?: string) {
  const req = { cookies: cookieValue !== undefined ? { gs_session: cookieValue } : {}, serverConfig: {} };
  const res = { statusCode: 0, body: undefined as unknown, status(code: number) { this.statusCode = code; return this; }, json(body: unknown) { this.body = body; return this; } };
  return { req, res };
}

const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';

describe('workspaceAuth.ts — requireUser (root of trust)', () => {
  beforeEach(() => {
    validateSessionToken.mockReset();
    isGlobalAdmin.mockReset();
    rpc.mockReset();
    from.mockReset();
  });

  it('401s with no cookie at all', async () => {
    validateSessionToken.mockResolvedValue(null);
    const { requireUser } = await import('../../../server/lib/workspaceAuth');
    const { req, res } = mockReqRes(undefined);
    const userId = await requireUser(req, res);
    expect(userId).toBeNull();
    expect(res.statusCode).toBe(401);
  });

  it('401s when the session token does not resolve (invalid/expired/revoked)', async () => {
    validateSessionToken.mockResolvedValue(null);
    const { requireUser } = await import('../../../server/lib/workspaceAuth');
    const { req, res } = mockReqRes('some-token');
    const userId = await requireUser(req, res);
    expect(userId).toBeNull();
    expect(res.statusCode).toBe(401);
  });

  it('returns the userId for a valid session, with no error response written', async () => {
    validateSessionToken.mockResolvedValue({ sessionId: 's1', userId: USER_ID, email: 'a@b.com' });
    const { requireUser } = await import('../../../server/lib/workspaceAuth');
    const { req, res } = mockReqRes('valid-token');
    const userId = await requireUser(req, res);
    expect(userId).toBe(USER_ID);
    expect(res.statusCode).toBe(0);
  });

  it('gives an identical 401 response shape for missing vs. invalid session (no information leak)', async () => {
    const { requireUser } = await import('../../../server/lib/workspaceAuth');

    validateSessionToken.mockResolvedValue(null);
    const missing = mockReqRes(undefined);
    await requireUser(missing.req, missing.res);

    validateSessionToken.mockResolvedValue(null);
    const invalid = mockReqRes('garbage-token');
    await requireUser(invalid.req, invalid.res);

    expect(missing.res.body).toEqual(invalid.res.body);
    expect(missing.res.statusCode).toBe(invalid.res.statusCode);
  });
});

describe('workspaceAuth.ts — authorizeWorkspaceAccess (tenant isolation)', () => {
  beforeEach(() => {
    validateSessionToken.mockReset();
    isGlobalAdmin.mockReset();
    rpc.mockReset();
    from.mockReset();
  });

  it('401s before any workspace check when unauthenticated', async () => {
    validateSessionToken.mockResolvedValue(null);
    const { authorizeWorkspaceAccess } = await import('../../../server/lib/workspaceAuth');
    const { req, res } = mockReqRes(undefined);
    const result = await authorizeWorkspaceAccess(req, res, WORKSPACE_ID);
    expect(result).toBeNull();
    expect(res.statusCode).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('400s on a malformed workspaceId (not a UUID) — never reaches the membership RPC', async () => {
    validateSessionToken.mockResolvedValue({ sessionId: 's1', userId: USER_ID, email: 'a@b.com' });
    const { authorizeWorkspaceAccess } = await import('../../../server/lib/workspaceAuth');
    const { req, res } = mockReqRes('valid-token');
    const result = await authorizeWorkspaceAccess(req, res, 'not-a-uuid');
    expect(result).toBeNull();
    expect(res.statusCode).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('rejects a real, authenticated user who is not a member of the target workspace (cross-tenant IDOR)', async () => {
    validateSessionToken.mockResolvedValue({ sessionId: 's1', userId: USER_ID, email: 'a@b.com' });
    isGlobalAdmin.mockResolvedValue(false);
    rpc.mockResolvedValue({ data: false, error: null }); // is_workspace_member → false
    const { authorizeWorkspaceAccess } = await import('../../../server/lib/workspaceAuth');
    const { req, res } = mockReqRes('valid-token');
    const result = await authorizeWorkspaceAccess(req, res, WORKSPACE_ID);
    expect(result).toBeNull();
    expect(res.statusCode).toBe(403);
  });

  it('allows a genuine member and returns their resolved role', async () => {
    validateSessionToken.mockResolvedValue({ sessionId: 's1', userId: USER_ID, email: 'a@b.com' });
    isGlobalAdmin.mockResolvedValue(false);
    rpc.mockResolvedValue({ data: true, error: null }); // is_workspace_member → true
    from.mockReturnValue({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { role: 'agent' }, error: null }) }) }) }),
    });
    const { authorizeWorkspaceAccess } = await import('../../../server/lib/workspaceAuth');
    const { req, res } = mockReqRes('valid-token');
    const result = await authorizeWorkspaceAccess(req, res, WORKSPACE_ID);
    expect(result).toEqual({ userId: USER_ID, isAdmin: false, role: 'agent' });
    expect(res.statusCode).toBe(0);
  });

  it('rejects a member with an insufficient role when manage:true is required (privilege boundary)', async () => {
    validateSessionToken.mockResolvedValue({ sessionId: 's1', userId: USER_ID, email: 'a@b.com' });
    isGlobalAdmin.mockResolvedValue(false);
    rpc.mockResolvedValue({ data: true, error: null });
    from.mockReturnValue({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { role: 'agent' }, error: null }) }) }) }),
    });
    const { authorizeWorkspaceAccess } = await import('../../../server/lib/workspaceAuth');
    const { req, res } = mockReqRes('valid-token');
    const result = await authorizeWorkspaceAccess(req, res, WORKSPACE_ID, { manage: true });
    expect(result).toBeNull();
    expect(res.statusCode).toBe(403);
  });

  it('allows an owner/admin role when manage:true is required', async () => {
    validateSessionToken.mockResolvedValue({ sessionId: 's1', userId: USER_ID, email: 'a@b.com' });
    isGlobalAdmin.mockResolvedValue(false);
    rpc.mockResolvedValue({ data: true, error: null });
    from.mockReturnValue({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { role: 'owner' }, error: null }) }) }) }),
    });
    const { authorizeWorkspaceAccess } = await import('../../../server/lib/workspaceAuth');
    const { req, res } = mockReqRes('valid-token');
    const result = await authorizeWorkspaceAccess(req, res, WORKSPACE_ID, { manage: true });
    expect(result).toEqual({ userId: USER_ID, isAdmin: false, role: 'owner' });
  });

  it('lets a platform (global) admin bypass workspace membership entirely', async () => {
    validateSessionToken.mockResolvedValue({ sessionId: 's1', userId: USER_ID, email: 'a@b.com' });
    isGlobalAdmin.mockResolvedValue(true);
    const { authorizeWorkspaceAccess } = await import('../../../server/lib/workspaceAuth');
    const { req, res } = mockReqRes('valid-token');
    const result = await authorizeWorkspaceAccess(req, res, WORKSPACE_ID);
    expect(result).toEqual({ userId: USER_ID, isAdmin: true, role: null });
    expect(rpc).not.toHaveBeenCalled(); // never even queries membership
  });

  it('fails closed (500, not "not a member") when the membership RPC itself errors', async () => {
    validateSessionToken.mockResolvedValue({ sessionId: 's1', userId: USER_ID, email: 'a@b.com' });
    isGlobalAdmin.mockResolvedValue(false);
    rpc.mockResolvedValue({ data: null, error: { message: 'db down' } });
    const { authorizeWorkspaceAccess } = await import('../../../server/lib/workspaceAuth');
    const { req, res } = mockReqRes('valid-token');
    const result = await authorizeWorkspaceAccess(req, res, WORKSPACE_ID);
    expect(result).toBeNull();
    expect(res.statusCode).toBe(500);
  });
});
