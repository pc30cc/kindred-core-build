/**
 * POST /api/auth/record-result was an unauthenticated endpoint that
 * accepted caller-controlled `success`/`eventType`/`severity`/`metadata`
 * and called recordLoginAttempt(req, email, success) directly — any
 * unauthenticated caller sending `success: true` could reset the
 * in-memory progressive brute-force tracker for an arbitrary IP/email
 * pair, and could inject arbitrary-looking security events.
 *
 * Caller audit: the only real caller was `logClientSecurityEvent`
 * (src/hooks/useSecurity.ts), which itself had zero callers anywhere in
 * the app (dead code — grep-verified). Login success/failure is already
 * recorded by POST /api/auth/login itself (recordLoginAttempt calls at
 * server/routes/auth.ts's login handler). The endpoint and its dead
 * frontend helper were removed entirely rather than re-secured.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import cookieParser from 'cookie-parser';

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }),
      insert: async () => ({ error: null }),
      update: () => ({ eq: () => ({ is: async () => ({ error: null }) }) }),
    }),
  }),
}));

const { authSecurityRouter } = await import('../../../server/routes/auth.js');

const app = express();
app.use((req, _res, next) => {
  (req as any).serverConfig = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k', corsOrigins: ['*'] };
  next();
});
app.use(cookieParser());
app.use(express.json());
app.use('/api/auth', authSecurityRouter);

const server = http.createServer(app).listen(0);
const port = () => (server.address() as any).port;

function post(path: string, body: unknown): Promise<{ status: number }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: port(),
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      },
      (res) => {
        res.on('data', () => undefined);
        res.on('end', () => resolve({ status: res.statusCode || 0 }));
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

describe('POST /api/auth/record-result — removed', () => {
  it('no longer exists (404, not 200) for a standard login-result payload', async () => {
    const res = await post('/api/auth/record-result', { email: 'victim@example.com', success: true });
    expect(res.status).toBe(404);
  });

  it('no longer exists for a generic security-event payload either', async () => {
    const res = await post('/api/auth/record-result', {
      email: 'victim@example.com',
      eventType: 'totally_fabricated_event',
      severity: 'critical',
      metadata: { anything: 'goes' },
    });
    expect(res.status).toBe(404);
  });
});

describe('logClientSecurityEvent — dead frontend helper removed', () => {
  it('is no longer exported from useSecurity.ts', async () => {
    const mod = await import('../../hooks/useSecurity');
    expect((mod as any).logClientSecurityEvent).toBeUndefined();
  });
});
