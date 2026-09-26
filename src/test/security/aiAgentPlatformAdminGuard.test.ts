/**
 * AI Agent platform endpoints — admin guard cannot be skipped by re-spelling
 * the URL.
 *
 * Express routers are case-insensitive and non-strict, so
 * `/platform/settings/` and `/Platform/settings` reach the
 * `/platform/settings` handler. The ADVANCED_PATH_PATTERNS guard used to
 * match `req.path` with `$`-anchored, case-sensitive regexes (and the
 * platform guard skips everything under `/platform/`), so those spellings
 * reached the unauthenticated GET handlers. The guard now matches a
 * normalized path and the GET handlers carry their own admin check.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import http from 'node:http';
import express from 'express';

let sessionUserId: string | null = null;
let globalAdmin = false;

vi.mock('../../../server/services/auth/sessions.js', () => ({
  SESSION_COOKIE_NAME: 'gs_session',
  validateSessionToken: async (_config: unknown, token: string | undefined) => {
    if (!token || !sessionUserId) return null;
    return { sessionId: 's', userId: sessionUserId, email: 'u@example.com' };
  },
  verifyOriginForMutation: () => true,
}));

vi.mock('../../../server/middleware/adminBypass.js', () => ({
  isGlobalAdmin: async () => globalAdmin,
  logGateBypass: async () => {},
}));

vi.mock('../../../server/services/ai-agent/platformSettings.js', () => ({
  getPlatformAiAgentSettings: async () => ({ ai_agent_enabled: true, secret_marker: 'PLATFORM_SETTINGS' }),
  updatePlatformAiAgentSettings: async () => {
    throw new Error('forbidden');
  },
  isPlatformSettingsLookupFailed: () => false,
}));

vi.mock('../../../server/supabase.js', () => {
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    gte: () => builder,
    limit: async () => ({ data: [], error: null }),
    then: (resolve: any) => resolve({ count: 0, data: [], error: null }),
  };
  return { getServiceClient: () => ({ from: () => builder, rpc: async () => ({ data: null, error: null }) }) };
});

vi.mock('../../../server/services/observability/collector/index.js', () => ({
  getMonitoringCollector: () => ({ queryRealtimeCount: () => 0 }),
}));

const { normalizeAiAgentGuardPath } = await import('../../../server/services/ai-agent/platformGuards.js');
const { platformRouter } = await import('../../../server/routes/ai-agent/platform.js');

function makeServer(mount: (app: express.Express) => void) {
  const app = express();
  app.use((req, _res, next) => {
    (req as any).serverConfig = {
      supabaseUrl: 'https://example.supabase.co',
      supabaseServiceRoleKey: 'SERVICE_KEY',
    };
    next();
  });
  app.use(express.json());
  mount(app);
  return http.createServer(app).listen(0);
}

function call(server: http.Server, method: string, path: string, withSession = true) {
  const port = (server.address() as any).port;
  const headers: Record<string, string> = withSession ? { authorization: 'Bearer session-token' } : {};
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: d }));
    });
    req.on('error', reject);
    req.end();
  });
}

// The platform domain router alone, with NO upstream path guard: the
// handlers must protect themselves.
const bareServer = makeServer((app) => app.use('/api/ai-agent', platformRouter));

afterAll(() => {
  bareServer.close();
});

beforeEach(() => {
  sessionUserId = null;
  globalAdmin = false;
  delete process.env.ENABLE_AI_ADVANCED_TOOLS;
});

describe('normalizeAiAgentGuardPath', () => {
  it.each([
    ['/platform/settings', '/platform/settings'],
    ['/platform/settings/', '/platform/settings'],
    ['/platform/settings///', '/platform/settings'],
    ['/Platform/Settings', '/platform/settings'],
    ['//platform//settings', '/platform/settings'],
    ['/PLATFORM/AI-PROACTIVE-STATS/', '/platform/ai-proactive-stats'],
    ['/', '/'],
    ['', '/'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeAiAgentGuardPath(input)).toBe(expected);
  });
});

describe('platform GET handlers enforce platform admin themselves', () => {
  const paths = [
    '/api/ai-agent/platform/settings',
    '/api/ai-agent/platform/settings/',
    '/api/ai-agent/Platform/settings',
    '/api/ai-agent/platform/ai-proactive-stats',
    '/api/ai-agent/platform/ai-proactive-stats/',
    '/api/ai-agent/PLATFORM/AI-PROACTIVE-STATS',
  ];

  it.each(paths)('%s → 401 without a session', async (path) => {
    const r = await call(bareServer, 'GET', path, false);
    expect(r.status).toBe(401);
    expect(r.body).not.toContain('PLATFORM_SETTINGS');
  });

  it.each(paths)('%s → 403 for a signed-in non-admin', async (path) => {
    sessionUserId = 'user-1';
    globalAdmin = false;
    const r = await call(bareServer, 'GET', path);
    expect(r.status).toBe(403);
    expect(r.body).not.toContain('PLATFORM_SETTINGS');
  });

  it('GET /platform/settings → 200 for a platform admin', async () => {
    sessionUserId = 'admin-1';
    globalAdmin = true;
    const r = await call(bareServer, 'GET', '/api/ai-agent/platform/settings');
    expect(r.status).toBe(200);
    expect(r.body).toContain('PLATFORM_SETTINGS');
  });

  it('GET /platform/ai-proactive-stats → 200 for a platform admin', async () => {
    sessionUserId = 'admin-1';
    globalAdmin = true;
    const r = await call(bareServer, 'GET', '/api/ai-agent/platform/ai-proactive-stats');
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toHaveProperty('counters');
  });
});

describe('ADVANCED_PATH_PATTERNS guard matches re-spelled paths', () => {
  // Load the real top-level router lazily: it pulls in every AI Agent
  // domain router. Only the guard ordering matters here — a non-admin must
  // be stopped before any handler runs, whatever the spelling.
  let fullServer: http.Server | null = null;

  afterAll(() => {
    fullServer?.close();
  });

  it.each([
    '/api/ai-agent/platform/settings/',
    '/api/ai-agent/Platform/settings',
    '/api/ai-agent/platform/ai-proactive-stats/',
    '/api/ai-agent/Test-Cases',
    '/api/ai-agent/debug/retrieval/',
  ])('%s is rejected for a non-admin by the top-level guard', async (path) => {
    if (!fullServer) {
      const { aiAgentRouter } = await import('../../../server/routes/ai-agent/index.js');
      fullServer = makeServer((app) => app.use('/api/ai-agent', aiAgentRouter));
    }
    sessionUserId = 'user-1';
    globalAdmin = false;
    const r = await call(fullServer, 'GET', path);
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body).error).toBe('advanced_ai_tools_not_available');
  });
});
