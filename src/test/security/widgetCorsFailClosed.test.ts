import { describe, it, expect, vi, beforeEach } from 'vitest';

const getWorkspaceOriginRules = vi.fn();
const resolveWorkspaceIdFromOrigin = vi.fn();

vi.mock('../../../server/services/widget/public.js', () => ({
  getWorkspaceOriginRules: (...a: any[]) => getWorkspaceOriginRules(...a),
  resolveWorkspaceIdFromOrigin: (...a: any[]) => resolveWorkspaceIdFromOrigin(...a),
  getBootstrapOrigin: (req: any) => req.headers.origin ?? null,
  getRequestBaseUrl: (req: any) => `https://${req.get('host')}`,
}));

const { widgetCorsMiddleware } = await import('../../../server/middleware/widgetCors.js');
const { isOriginAllowed } = await import('../../../server/utils/domain.js');

function makeReq(overrides: any = {}) {
  return {
    method: 'POST',
    path: '/bootstrap',
    headers: { origin: 'https://evil.example', host: 'app.mysaas.com', ...(overrides.headers || {}) },
    query: overrides.query || {},
    body: overrides.body || {},
    get: (k: string) => (k.toLowerCase() === 'host' ? 'app.mysaas.com' : undefined),
    serverConfig: overrides.serverConfig !== undefined ? overrides.serverConfig : { fake: true },
    ...overrides,
  } as any;
}

function makeRes() {
  const headers: Record<string, string> = {};
  return {
    headers,
    setHeader: (k: string, v: string) => { headers[k] = v; },
    status() { return this; },
    end() { return this; },
  } as any;
}

async function run(req: any) {
  const res = makeRes();
  const next = vi.fn();
  await widgetCorsMiddleware()(req, res, next);
  return { res, next };
}

describe('isOriginAllowed — unconfigured allow-list is fail-closed', () => {
  it('returns false when no domains are configured', () => {
    expect(isOriginAllowed('https://evil.example', [])).toBe(false);
  });
  it('still allows opt-in legacy behaviour explicitly', () => {
    expect(isOriginAllowed('https://evil.example', [], false, { allowWhenUnconfigured: true })).toBe(true);
  });
  it('allows a correctly configured domain (and www variant)', () => {
    expect(isOriginAllowed('https://www.shop.com', ['shop.com'])).toBe(true);
    expect(isOriginAllowed('https://evil.example', ['shop.com'])).toBe(false);
  });
});

describe('widgetCorsMiddleware fail-closed paths', () => {
  beforeEach(() => {
    getWorkspaceOriginRules.mockReset();
    resolveWorkspaceIdFromOrigin.mockReset();
  });

  it('unknown origin + workspace with NO configured domains → no CORS headers', async () => {
    resolveWorkspaceIdFromOrigin.mockResolvedValue('ws-1');
    getWorkspaceOriginRules.mockResolvedValue({ domains: [], allowSubdomains: false });
    const { res, next } = await run(makeReq());
    expect(res.headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });

  it('origin matching a configured domain → echoed with credentials', async () => {
    resolveWorkspaceIdFromOrigin.mockResolvedValue('ws-1');
    getWorkspaceOriginRules.mockResolvedValue({ domains: ['shop.com'], allowSubdomains: false });
    const { res } = await run(makeReq({ headers: { origin: 'https://www.shop.com', host: 'app.mysaas.com' } }));
    expect(res.headers['Access-Control-Allow-Origin']).toBe('https://www.shop.com');
    expect(res.headers['Access-Control-Allow-Credentials']).toBe('true');
  });

  it('origin NOT in the configured list → no CORS headers', async () => {
    resolveWorkspaceIdFromOrigin.mockResolvedValue('ws-1');
    getWorkspaceOriginRules.mockResolvedValue({ domains: ['shop.com'], allowSubdomains: false });
    const { res } = await run(makeReq());
    expect(res.headers['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('database error during lookup → no CORS headers (never allow)', async () => {
    resolveWorkspaceIdFromOrigin.mockResolvedValue('ws-1');
    getWorkspaceOriginRules.mockRejectedValue(new Error('db down'));
    const { res, next } = await run(makeReq());
    expect(res.headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });

  it('workspace cannot be resolved → no CORS headers for third-party origin', async () => {
    resolveWorkspaceIdFromOrigin.mockResolvedValue(null);
    const { res } = await run(makeReq());
    expect(res.headers['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('workspace cannot be resolved → same-origin is still allowed', async () => {
    resolveWorkspaceIdFromOrigin.mockResolvedValue(null);
    const { res } = await run(makeReq({ headers: { origin: 'https://app.mysaas.com', host: 'app.mysaas.com' } }));
    expect(res.headers['Access-Control-Allow-Origin']).toBe('https://app.mysaas.com');
  });

  it('missing server config → no CORS headers', async () => {
    const { res, next } = await run(makeReq({ serverConfig: undefined }));
    expect(res.headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });
});
