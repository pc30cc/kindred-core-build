import { describe, it, expect, vi, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import cookieParser from 'cookie-parser';

let authUser: { id: string } | null = null;
let memberOf: Record<string, string> = {};

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: authUser }, error: authUser ? null : new Error('bad') }),
    },
    rpc: async (_fn: string, args: { _workspace_id: string }) => ({ data: Boolean(memberOf[args._workspace_id]), error: null }),
    from: () => {
      interface MemberQuery {
        _ws?: string;
        select: () => MemberQuery;
        eq: (column: string, value: string) => MemberQuery;
        maybeSingle: () => Promise<{ data: { role: string } | null; error: null }>;
      }
      const b: MemberQuery = {
        select: () => b,
        eq: (_c: string, v: string) => {
          if (!b._ws) b._ws = v;
          return b;
        },
        maybeSingle: async () => ({
          data: b._ws && memberOf[b._ws] ? { role: memberOf[b._ws] } : null,
          error: null,
        }),
      };
      return b;
    },
  }),
}));

vi.mock('../../../server/middleware/adminBypass.js', () => ({
  isGlobalAdmin: async () => false,
  logGateBypass: async () => {},
}));

vi.mock('../../../server/services/auth/sessions.js', () => ({
  SESSION_COOKIE_NAME: 'gs_session',
  validateSessionToken: async (_config: unknown, token: string | undefined) => {
    if (!token) return null;
    if (!authUser) return null;
    return { sessionId: 'test-session', userId: authUser.id, email: 'test@example.com' };
  },
  verifyOriginForMutation: () => true,
}));

const calls: string[] = [];
let moduleAllowed = true;
interface CreditsResult { success: boolean; credits_used?: number; credits_limit?: number; reason?: string }
let creditsResult: CreditsResult = { success: true, credits_used: 1, credits_limit: 100 };

const checkModuleAccess = vi.fn(async (..._args: unknown[]) => {
  calls.push('module');
  return moduleAllowed ? { allowed: true } : { allowed: false, plan: 'free' };
});
const deductAICredits = vi.fn(async (..._args: unknown[]) => {
  calls.push('credits');
  return creditsResult;
});
const incrementUsage = vi.fn((..._args: unknown[]) => {
  calls.push('usage');
});

vi.mock('../../../server/middleware/featureGating.js', () => ({
  checkModuleAccess: (...a: unknown[]) => checkModuleAccess(...a),
  deductAICredits: (...a: unknown[]) => deductAICredits(...a),
  incrementUsage: (...a: unknown[]) => incrementUsage(...a),
}));

const logSecurityEvent = vi.fn(async (..._args: unknown[]) => {
  calls.push('securitylog');
});
vi.mock('../../../server/middleware/security.js', () => ({
  logSecurityEvent: (...a: unknown[]) => logSecurityEvent(...a),
}));

const executeAICompletion = vi.fn(async (..._args: unknown[]) => {
  calls.push('provider');
  return {
    text: 'ok',
    model: 'm',
    provider: 'openai',
    promptTokens: 1,
    completionTokens: 1,
    totalTokens: 2,
    latencyMs: 1,
  };
});
vi.mock('../../../server/services/ai/index.js', () => ({
  executeAICompletion: (...a: unknown[]) => executeAICompletion(...a),
  executeAICompletionWithConfig: (_c: unknown, _cfg: unknown, req: unknown) => executeAICompletion(_c, req),
  testAIConnection: async () => ({ success: true, latencyMs: 1, model: 'm' }),
  resolveAIConfig: async () => null,
  // No usage row is written here, so the route counts the request itself:
  // that is the 'usage' step in the gate order below.
  wasRequestCounted: () => false,
}));

const { aiRouter } = await import('../../../server/routes/ai.js');

const app = express();
app.use((req, _res, next) => {
  (req as express.Request & { serverConfig?: unknown }).serverConfig = {
    supabaseUrl: 'https://example.supabase.co',
    supabaseAnonKey: 'ANON_KEY',
    supabaseServiceRoleKey: 'SERVICE_KEY',
  };
  next();
});
app.use(cookieParser());
app.use(express.json());
app.use('/api/ai', aiRouter);

const server = http.createServer(app).listen(0);
const port = () => (server.address() as AddressInfo).port;

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const payload = JSON.stringify(body);
  const finalHeaders: Record<string, string> = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(payload)),
    ...headers,
  };
  const authMatch = /^Bearer (.+)$/.exec(finalHeaders.authorization || '');
  if (authMatch) finalHeaders.cookie = `gs_session=${authMatch[1]}`;
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: port(),
        path,
        method: 'POST',
        headers: finalHeaders,
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode || 0, body: d }));
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

let wsCounter = 0;
/** Each test gets a fresh workspace id so the in-process rate window is isolated. */
function freshWorkspace(): string {
  wsCounter++;
  return `33333333-3333-4333-8333-${String(wsCounter).padStart(12, '0')}`;
}

const AUTH = { authorization: 'Bearer user-jwt' };

beforeEach(() => {
  authUser = { id: 'user-1' };
  memberOf = {};
  moduleAllowed = true;
  creditsResult = { success: true, credits_used: 1, credits_limit: 100 };
  calls.length = 0;
  checkModuleAccess.mockClear();
  deductAICredits.mockClear();
  incrementUsage.mockClear();
  executeAICompletion.mockClear();
  logSecurityEvent.mockClear();
});

describe('POST /api/ai/complete gate ordering', () => {
  it('does not deduct credit for a rate-limited (429) request', async () => {
    const ws = freshWorkspace();
    memberOf[ws] = 'member';

    for (let i = 0; i < 60; i++) {
      const ok = await post('/api/ai/complete', { workspaceId: ws, prompt: 'hi' }, AUTH);
      expect(ok.status).toBe(200);
    }
    expect(deductAICredits).toHaveBeenCalledTimes(60);
    expect(executeAICompletion).toHaveBeenCalledTimes(60);

    deductAICredits.mockClear();
    executeAICompletion.mockClear();
    incrementUsage.mockClear();
    logSecurityEvent.mockClear();

    const limited = await post('/api/ai/complete', { workspaceId: ws, prompt: 'hi' }, AUTH);
    expect(limited.status).toBe(429);
    expect(deductAICredits).toHaveBeenCalledTimes(0);
    expect(executeAICompletion).toHaveBeenCalledTimes(0);
    expect(incrementUsage).toHaveBeenCalledTimes(0);
    expect(logSecurityEvent).toHaveBeenCalledTimes(1);
  });

  it('asserts the full gate order for an allowed request', async () => {
    const ws = freshWorkspace();
    memberOf[ws] = 'member';
    const res = await post('/api/ai/complete', { workspaceId: ws, prompt: 'hi' }, AUTH);
    expect(res.status).toBe(200);
    expect(calls).toEqual(['module', 'credits', 'provider', 'usage']);
    expect(deductAICredits).toHaveBeenCalledTimes(1);
    expect(executeAICompletion).toHaveBeenCalledTimes(1);
  });

  it('does not deduct credit without a JWT', async () => {
    const ws = freshWorkspace();
    memberOf[ws] = 'member';
    const res = await post('/api/ai/complete', { workspaceId: ws, prompt: 'hi' });
    expect(res.status).toBe(401);
    expect(deductAICredits).not.toHaveBeenCalled();
  });

  it('does not deduct credit for a cross-tenant workspace', async () => {
    const ws = freshWorkspace();
    const res = await post('/api/ai/complete', { workspaceId: ws, prompt: 'hi' }, AUTH);
    expect(res.status).toBe(403);
    expect(deductAICredits).not.toHaveBeenCalled();
  });

  it('does not deduct credit when the module is disabled', async () => {
    const ws = freshWorkspace();
    memberOf[ws] = 'member';
    moduleAllowed = false;
    const res = await post('/api/ai/complete', { workspaceId: ws, prompt: 'hi' }, AUTH);
    expect(res.status).toBe(403);
    expect(deductAICredits).not.toHaveBeenCalled();
  });

  it('never calls the provider when credits are exhausted', async () => {
    const ws = freshWorkspace();
    memberOf[ws] = 'member';
    creditsResult = { success: false, reason: 'exhausted', credits_used: 100, credits_limit: 100 };
    const res = await post('/api/ai/complete', { workspaceId: ws, prompt: 'hi' }, AUTH);
    expect(res.status).toBe(403);
    expect(executeAICompletion).not.toHaveBeenCalled();
  });

  it('keeps rate-limit counters independent per workspace', async () => {
    const a = freshWorkspace();
    const b = freshWorkspace();
    memberOf[a] = 'member';
    memberOf[b] = 'member';
    for (let i = 0; i < 61; i++) await post('/api/ai/complete', { workspaceId: a, prompt: 'hi' }, AUTH);
    const other = await post('/api/ai/complete', { workspaceId: b, prompt: 'hi' }, AUTH);
    expect(other.status).toBe(200);
  });
});