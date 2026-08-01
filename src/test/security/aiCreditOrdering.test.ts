import { describe, it, expect, vi, beforeEach } from 'vitest';
import http from 'node:http';
import express from 'express';

let authUser: { id: string } | null = null;
let memberOf: Record<string, string> = {};

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: authUser }, error: authUser ? null : new Error('bad') }),
    },
    rpc: async (_fn: string, args: any) => ({ data: Boolean(memberOf[args._workspace_id]), error: null }),
    from: () => {
      const b: any = {
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

const calls: string[] = [];
let moduleAllowed = true;
let creditsResult: any = { success: true, credits_used: 1, credits_limit: 100 };

const checkModuleAccess = vi.fn(async () => {
  calls.push('module');
  return moduleAllowed ? { allowed: true } : { allowed: false, plan: 'free' };
});
const deductAICredits = vi.fn(async () => {
  calls.push('credits');
  return creditsResult;
});
const incrementUsage = vi.fn(() => {
  calls.push('usage');
});

vi.mock('../../../server/middleware/featureGating.js', () => ({
  checkModuleAccess: (...a: any[]) => (checkModuleAccess as any)(...a),
  deductAICredits: (...a: any[]) => (deductAICredits as any)(...a),
  incrementUsage: (...a: any[]) => (incrementUsage as any)(...a),
}));

const logSecurityEvent = vi.fn(async () => {
  calls.push('securitylog');
});
vi.mock('../../../server/middleware/security.js', () => ({
  logSecurityEvent: (...a: any[]) => (logSecurityEvent as any)(...a),
}));

const executeAICompletion = vi.fn(async () => {
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
  executeAICompletion: (...a: any[]) => (executeAICompletion as any)(...a),
  testAIConnection: async () => ({ success: true, latencyMs: 1, model: 'm' }),
  resolveAIConfig: async () => null,
}));

const { aiRouter } = await import('../../../server/routes/ai.js');

const app = express();
app.use((req, _res, next) => {
  (req as any).serverConfig = {
    supabaseUrl: 'https://example.supabase.co',
    supabaseAnonKey: 'ANON_KEY',
    supabaseServiceRoleKey: 'SERVICE_KEY',
  };
  next();
});
app.use(express.json());
app.use('/api/ai', aiRouter);

const server = http.createServer(app).listen(0);
const port = () => (server.address() as any).port;

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const payload = JSON.stringify(body);
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: port(),
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          ...headers,
        },
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