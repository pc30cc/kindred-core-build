/**
 * Route-level test proving the server-side rule from the reconnect-
 * classification fix: reconnect telemetry must never be emitted from an
 * UNAUTHENTICATED request, for either the widget or the operator
 * lightweight reconnect-signal endpoint. Mounted against the REAL
 * realtimeRouter (server/routes/realtime.ts), not a reimplementation —
 * both endpoints already check auth before touching the monitoring
 * collector or emitMetric, this test proves that ordering holds.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import http from 'node:http';

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key-realtime-security';

// A garbage session cookie still reaches validateSessionToken's DB lookup
// (auth_sessions) before it can be rejected — mock the client so that
// lookup resolves immediately to "not found" instead of hanging on a real
// network call the sandbox blocks.
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => {
      const b: any = {
        select: () => b,
        eq: () => b,
        is: () => b,
        maybeSingle: async () => ({ data: null, error: null }),
      };
      return b;
    },
    rpc: async () => ({ data: null, error: null }),
  }),
}));
vi.mock('../../../server/supabase.js', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  const client = (createClient as any)();
  return { getServiceClient: () => client };
});

const { realtimeRouter } = await import('../../../server/routes/realtime.js');
const { getMonitoringCollector, __resetMonitoringCollectorForTests } = await import(
  '../../../server/services/observability/collector/index.js'
);

const app = express();
app.use((req, _res, next) => {
  (req as any).serverConfig = {
    supabaseUrl: 'https://example.supabase.co',
    supabaseAnonKey: 'ANON_KEY',
    supabaseServiceRoleKey: 'SERVICE_KEY',
    corsOrigins: [],
  };
  next();
});
app.use(express.json());
app.use(cookieParser());
app.use('/api/realtime', realtimeRouter);

function request(path: string, headers: Record<string, string> = {}, body: any = {}): Promise<{ status: number; body: any }> {
  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.listen(0, () => {
      const { port } = server.address() as any;
      const payload = JSON.stringify(body);
      const req = http.request(
        { host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers } },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            server.close();
            let parsed: any = null;
            try { parsed = JSON.parse(data); } catch { /* noop */ }
            resolve({ status: res.statusCode || 0, body: parsed });
          });
        },
      );
      req.on('error', (err) => { server.close(); reject(err); });
      req.write(payload);
      req.end();
    });
  });
}

const WS = '11111111-1111-4111-8111-111111111111';

describe('reconnect-signal endpoints — unauthenticated calls produce zero reconnect telemetry', () => {
  beforeEach(() => {
    __resetMonitoringCollectorForTests();
  });

  it('POST /api/realtime/reconnect-signal with no widget token is rejected and records nothing', async () => {
    const before = getMonitoringCollector().queryRealtimeCount('realtime.reconnect_attempt', 3600);
    const res = await request('/api/realtime/reconnect-signal', {}, { workspace_id: WS });

    expect(res.status).toBe(401);
    const after = getMonitoringCollector().queryRealtimeCount('realtime.reconnect_attempt', 3600);
    expect(after).toBe(before);
    expect(after).toBe(0);
  });

  it('POST /api/realtime/reconnect-signal with a garbage widget token is rejected and records nothing', async () => {
    const res = await request('/api/realtime/reconnect-signal', { 'X-Widget-Token': 'not-a-real-token' }, { workspace_id: WS });

    expect(res.status).toBe(401);
    expect(getMonitoringCollector().queryRealtimeCount('realtime.reconnect_attempt', 3600)).toBe(0);
  });

  it('POST /api/realtime/operator-reconnect-signal with no session cookie is rejected and records nothing', async () => {
    const res = await request('/api/realtime/operator-reconnect-signal', {}, { workspace_id: WS });

    expect(res.status).toBe(401);
    expect(getMonitoringCollector().queryRealtimeCount('realtime.reconnect_attempt', 3600)).toBe(0);
  });

  it('POST /api/realtime/operator-reconnect-signal with a garbage session cookie is rejected and records nothing', async () => {
    const res = await request('/api/realtime/operator-reconnect-signal', { Cookie: 'gs_session=not-a-real-session' }, { workspace_id: WS });

    expect(res.status).toBe(401);
    expect(getMonitoringCollector().queryRealtimeCount('realtime.reconnect_attempt', 3600)).toBe(0);
  });
});
