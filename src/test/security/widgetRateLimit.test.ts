import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpc = vi.fn();
vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    rpc: (...a: any[]) => rpc(...a),
    from: () => ({ insert: async () => ({}) }),
  }),
}));

const { ipBlockMiddleware, resolveRateLimitWorkspaceKey, widgetWorkspaceRateLimiter } =
  await import('../../../server/middleware/security.js');

function makeRes() {
  const state: any = { code: 0, body: null };
  return {
    state,
    status(c: number) { state.code = c; return this; },
    json(b: any) { state.body = b; return this; },
    setHeader() { /* noop */ },
  } as any;
}

describe('ipBlockMiddleware is fail-closed', () => {
  beforeEach(() => rpc.mockReset());

  it('rejects with 503 when the block lookup throws', async () => {
    rpc.mockRejectedValue(new Error('db down'));
    const req: any = { ip: `1.2.3.${Math.floor(Math.random() * 250)}`, socket: {}, serverConfig: {} };
    const res = makeRes();
    const next = vi.fn();
    await ipBlockMiddleware()(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.state.code).toBe(503);
  });

  it('blocks with 403 when the IP is flagged', async () => {
    rpc.mockResolvedValue({ data: true });
    const req: any = { ip: '9.9.9.9', socket: {}, serverConfig: {} };
    const res = makeRes();
    const next = vi.fn();
    await ipBlockMiddleware()(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.state.code).toBe(403);
  });

  it('passes clean IPs through', async () => {
    rpc.mockResolvedValue({ data: false });
    const req: any = { ip: '8.8.4.4', socket: {}, serverConfig: {} };
    const res = makeRes();
    const next = vi.fn();
    await ipBlockMiddleware()(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});

describe('per-workspace widget rate limiting', () => {
  it('keys on the workspace, not the IP, when workspace context exists', () => {
    expect(resolveRateLimitWorkspaceKey({ ip: '1.1.1.1', query: { workspace_id: 'ws-a' }, body: {} } as any)).toBe('ws:ws-a');
    expect(resolveRateLimitWorkspaceKey({ ip: '2.2.2.2', query: {}, body: { workspace_id: 'ws-a' } } as any)).toBe('ws:ws-a');
    // Same workspace from two different IPs → same bucket (IP rotation resistant)
    const a = resolveRateLimitWorkspaceKey({ ip: '1.1.1.1', query: {}, body: { workspaceId: 'ws-b' } } as any);
    const b = resolveRateLimitWorkspaceKey({ ip: '3.3.3.3', query: {}, body: { workspaceId: 'ws-b' } } as any);
    expect(a).toBe(b);
  });

  it('falls back to an IP bucket when no workspace is present', () => {
    expect(resolveRateLimitWorkspaceKey({ ip: '4.4.4.4', query: {}, body: {} } as any)).toBe('ip:4.4.4.4');
  });

  it('is mounted as a real express-rate-limit middleware', () => {
    expect(typeof widgetWorkspaceRateLimiter).toBe('function');
  });
});
