/**
 * Admin SMS API — authentication, authorization, redaction and rate limiting.
 * Supabase and the SMS service are mocked; no credential value is asserted on.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import http from 'node:http';

const ADMIN_TOKEN = 'admin-token';
const USER_TOKEN = 'user-token';

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    auth: {
      getUser: async (token: string) => {
        if (token === ADMIN_TOKEN) return { data: { user: { id: 'admin-id' } }, error: null };
        if (token === USER_TOKEN) return { data: { user: { id: 'user-id' } }, error: null };
        return { data: { user: null }, error: { message: 'invalid' } };
      },
    },
    rpc: async (_fn: string, args: { _user_id: string }) => ({ data: args._user_id === 'admin-id' }),
    from: () => ({
      select: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null }) }) }),
    }),
  }),
}));

const state = {
  info: {
    providerName: 'kavenegar', configured: true, enabled: true, hasApiKey: true,
    sender: '10008663', verifyTemplate: 'verifyLogin', updatedAt: '2026-01-01T00:00:00.000Z',
  },
  test: { success: true, provider: 'kavenegar', latencyMs: 12, balance: 5000, currency: 'IRR', accountType: 'master' } as Record<string, unknown>,
  saveThrows: null as unknown,
};
const saved: unknown[] = [];

vi.mock('../../../server/services/sms/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../../server/services/sms/index.js')>(
    '../../../server/services/sms/index.js',
  );
  return {
    ...actual,
    getSmsProviderInfo: async () => state.info,
    saveSmsProviderConfig: async (_c: unknown, input: unknown) => {
      if (state.saveThrows) throw state.saveThrows;
      saved.push(input);
      return state.info;
    },
    deleteSmsProviderConfig: async () => ({
      providerName: 'disabled', configured: false, enabled: false,
      hasApiKey: false, sender: null, verifyTemplate: null, updatedAt: null,
    }),
    testSmsProvider: async () => state.test,
  };
});

const { adminRouter } = await import('../../../server/routes/admin.js');
const { __resetSmsTestRateLimit } = await import('../../../server/routes/adminSmsProviders.js');

const app = express();
app.use((req, _res, next) => {
  (req as unknown as { serverConfig: unknown }).serverConfig = {
    supabaseUrl: 'https://example.supabase.co',
    supabaseAnonKey: 'ANON',
    supabaseServiceRoleKey: 'SERVICE',
    corsOrigins: [],
  };
  next();
});
app.use(express.json());
app.use('/api/admin', adminRouter);

const server = http.createServer(app).listen(0);
const port = () => (server.address() as { port: number }).port;

function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const payload = opts.body === undefined ? null : JSON.stringify(opts.body);
  return new Promise<{ status: number; json: Record<string, unknown> }>((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1', port: port(), path, method,
        headers: {
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          let parsed: Record<string, unknown> = {};
          try { parsed = JSON.parse(d || '{}'); } catch { parsed = { raw: d }; }
          resolve({ status: res.statusCode ?? 0, json: parsed });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const BASE = '/api/admin/providers/sms';

beforeEach(() => {
  saved.length = 0;
  state.saveThrows = null;
  __resetSmsTestRateLimit();
});

describe('authentication and authorization', () => {
  it('rejects an anonymous read', async () => {
    expect((await call('GET', BASE)).status).toBe(401);
  });

  it('rejects an invalid token', async () => {
    expect((await call('GET', BASE, { token: 'nope' })).status).toBe(401);
  });

  it('rejects a signed-in non-admin', async () => {
    expect((await call('GET', BASE, { token: USER_TOKEN })).status).toBe(403);
  });

  it('rejects a non-admin write', async () => {
    const res = await call('PUT', BASE, {
      token: USER_TOKEN,
      body: { providerName: 'kavenegar', enabled: true, apiKey: 'x', verifyTemplate: 'verifyLogin' },
    });
    expect(res.status).toBe(403);
    expect(saved).toHaveLength(0);
  });

  it('rejects a non-admin test request', async () => {
    expect((await call('POST', BASE + '/test', { token: USER_TOKEN, body: {} })).status).toBe(403);
  });

  it('rejects an anonymous delete', async () => {
    expect((await call('DELETE', BASE)).status).toBe(401);
  });
});

describe('GET — redacted status', () => {
  it('returns status without any credential field', async () => {
    const res = await call('GET', BASE, { token: ADMIN_TOKEN });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ hasApiKey: true, providerName: 'kavenegar' });
    expect(res.json).not.toHaveProperty('apiKey');
    expect(res.json).not.toHaveProperty('config');
  });
});

describe('PUT — validation', () => {
  it('accepts a valid payload', async () => {
    const res = await call('PUT', BASE, {
      token: ADMIN_TOKEN,
      body: { providerName: 'kavenegar', enabled: true, apiKey: 'new-placeholder', verifyTemplate: 'verifyLogin' },
    });
    expect(res.status).toBe(200);
    expect(saved).toHaveLength(1);
    expect(res.json).not.toHaveProperty('apiKey');
  });

  it('rejects an unsupported vendor', async () => {
    const res = await call('PUT', BASE, {
      token: ADMIN_TOKEN,
      body: { providerName: 'twilio', enabled: true, apiKey: 'x', verifyTemplate: 'verifyLogin' },
    });
    expect(res.status).toBe(400);
    expect(saved).toHaveLength(0);
  });

  it('rejects a malformed verification template', async () => {
    const res = await call('PUT', BASE, {
      token: ADMIN_TOKEN,
      body: { providerName: 'kavenegar', enabled: true, apiKey: 'x', verifyTemplate: 'verify login' },
    });
    expect(res.status).toBe(400);
  });

  it('rejects unknown fields', async () => {
    const res = await call('PUT', BASE, {
      token: ADMIN_TOKEN,
      body: { providerName: 'kavenegar', enabled: true, verifyTemplate: 'verifyLogin', evil: true },
    });
    expect(res.status).toBe(400);
  });

  it('allows omitting the key on update', async () => {
    const res = await call('PUT', BASE, {
      token: ADMIN_TOKEN,
      body: { providerName: 'kavenegar', enabled: true, verifyTemplate: 'verifyLogin' },
    });
    expect(res.status).toBe(200);
  });
});

describe('DELETE', () => {
  it('returns a wiped, disabled status', async () => {
    const res = await call('DELETE', BASE, { token: ADMIN_TOKEN });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ configured: false, enabled: false, hasApiKey: false });
  });
});

describe('POST /test', () => {
  it('returns sanitized account info', async () => {
    const res = await call('POST', BASE + '/test', { token: ADMIN_TOKEN, body: {} });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ success: true, balance: 5000, currency: 'IRR' });
    expect(res.json).not.toHaveProperty('apiKey');
  });

  it('reports a normalized failure without leaking provider internals', async () => {
    state.test = { success: false, provider: 'kavenegar', latencyMs: 3, errorCode: 'sms_auth_failed', error: 'SMS authentication failed' };
    const res = await call('POST', BASE + '/test', { token: ADMIN_TOKEN, body: {} });
    expect(res.json).toMatchObject({ success: false, errorCode: 'sms_auth_failed' });
    state.test = { success: true, provider: 'kavenegar', latencyMs: 12, balance: 5000, currency: 'IRR', accountType: 'master' };
  });

  it('rate limits to 5 test requests per minute', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await call('POST', BASE + '/test', { token: ADMIN_TOKEN, body: {} })).status).toBe(200);
    }
    const blocked = await call('POST', BASE + '/test', { token: ADMIN_TOKEN, body: {} });
    expect(blocked.status).toBe(429);
    expect(blocked.json).toMatchObject({ error: 'too_many_test_requests' });
  });
});

describe('PUT — SMS.ir payloads', () => {
  const VALID = {
    providerName: 'smsir', enabled: true, apiKey: 'new-placeholder',
    lineNumber: '30007732', verifyTemplateId: 100000, verifyParameterName: 'CODE',
  };

  it('accepts a valid SMS.ir payload', async () => {
    const res = await call('PUT', BASE, { token: ADMIN_TOKEN, body: VALID });
    expect(res.status).toBe(200);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ providerName: 'smsir', lineNumber: '30007732', verifyTemplateId: 100000 });
    expect(res.json).not.toHaveProperty('apiKey');
  });

  it('rejects a Kavenegar field mixed into an SMS.ir payload', async () => {
    const res = await call('PUT', BASE, { token: ADMIN_TOKEN, body: { ...VALID, verifyTemplate: 'verifyLogin' } });
    expect(res.status).toBe(400);
    expect(saved).toHaveLength(0);
  });

  it('rejects a non-numeric line number', async () => {
    const res = await call('PUT', BASE, { token: ADMIN_TOKEN, body: { ...VALID, lineNumber: '3000-7732' } });
    expect(res.status).toBe(400);
  });

  it('rejects a string template id', async () => {
    const res = await call('PUT', BASE, { token: ADMIN_TOKEN, body: { ...VALID, verifyTemplateId: '100000' } });
    expect(res.status).toBe(400);
  });

  it('rejects an unsafe parameter name', async () => {
    const res = await call('PUT', BASE, { token: ADMIN_TOKEN, body: { ...VALID, verifyParameterName: 'my code' } });
    expect(res.status).toBe(400);
  });

  it('rejects a missing line number', async () => {
    const { lineNumber: _drop, ...rest } = VALID;
    const res = await call('PUT', BASE, { token: ADMIN_TOKEN, body: rest });
    expect(res.status).toBe(400);
  });

  it('allows omitting the key when re-saving SMS.ir', async () => {
    const { apiKey: _drop, ...rest } = VALID;
    const res = await call('PUT', BASE, { token: ADMIN_TOKEN, body: rest });
    expect(res.status).toBe(200);
  });

  it('surfaces a service-level validation reason', async () => {
    state.saveThrows = Object.assign(new Error('invalid_line_number'), {
      name: 'SmsConfigValidationError', reason: 'invalid_line_number',
    });
    const res = await call('PUT', BASE, { token: ADMIN_TOKEN, body: VALID });
    expect(res.status).toBe(500);
  });
});
