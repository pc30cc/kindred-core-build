import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import crypto from 'node:crypto';

const rawToken = '4c9e7425-0dd7-43f8-b987-5fa3738f2525';
const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
let rpcData: unknown = [];
let tokenRow: Record<string, unknown> | null = null;
let verifiedAt: string | null = null;

vi.mock('../../../server/services/auth/identity.js', () => ({
  findIdentityByEmail: vi.fn(),
  findIdentityById: vi.fn(async () => verifiedAt ? { emailVerifiedAt: verifiedAt } : null),
}));
vi.mock('../../../server/services/auth-email.js', () => ({ issueRecoveryEmail: vi.fn(), issueVerificationEmail: vi.fn() }));
vi.mock('../../../server/services/auth/password.js', () => ({ hashPassword: vi.fn(), InvalidPasswordError: class extends Error {} }));
vi.mock('../../../server/middleware/security.js', () => ({ logSecurityEvent: vi.fn() }));
vi.mock('../../../server/lib/workspaceAuth.js', () => ({ requireUser: vi.fn() }));
vi.mock('../../../server/services/auth/emailOtp.js', () => ({
  startEmailVerificationOtp: vi.fn(), resendEmailVerificationOtp: vi.fn(), confirmEmailVerificationOtp: vi.fn(),
  EmailOtpUnavailableError: class extends Error {}, EmailOtpRateLimitedError: class extends Error {},
}));
vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    rpc: async () => ({ data: rpcData, error: null }),
    from: () => {
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: tokenRow, error: null }),
      };
      return builder;
    },
  }),
}));

const { authEmailRouter } = await import('../../../server/routes/auth-email.js');
const app = express();
app.use((req, _res, next) => { (req as any).serverConfig = {}; next(); });
app.use(express.json());
app.use('/api/auth-email', authEmailRouter);
const server = http.createServer(app).listen(0);

function verify(token: string) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const body = JSON.stringify({ token });
    const req = http.request({
      host: '127.0.0.1', port: (server.address() as any).port,
      path: '/api/auth-email/verify-email', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: JSON.parse(data) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

beforeEach(() => {
  rpcData = [];
  tokenRow = null;
  verifiedAt = null;
});

describe('email verification links', () => {
  it('accepts the first atomic redemption', async () => {
    rpcData = [{ redeemed_user_id: crypto.randomUUID(), redeemed_email: 'user@example.com' }];
    const result = await verify(`  ${rawToken}  `);
    expect(result).toMatchObject({ status: 200, body: { success: true, email: 'user@example.com' } });
  });

  it('treats reopening an already-consumed valid link as success', async () => {
    tokenRow = { user_id: crypto.randomUUID(), email: 'user@example.com', token_hash: tokenHash, used_at: new Date().toISOString(), revoked_at: null };
    verifiedAt = new Date().toISOString();
    const result = await verify(rawToken);
    expect(result).toMatchObject({ status: 200, body: { success: true, already_verified: true } });
  });

  it('still rejects unknown links', async () => {
    const result = await verify('unknown-token');
    expect(result.status).toBe(400);
  });
});