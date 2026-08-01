/**
 * Admin resend fail-closed ordering.
 *
 * Asserts the contract of phase 6-S3B-R4: the "requested" audit must be
 * committed *before* the SMS provider is touched, an audit failure must send
 * no SMS and must invalidate the challenge, and a finalize failure must never
 * return success.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

process.env.PHONE_VERIFICATION_PEPPER = 'test-pepper-value-0123456789';

type RpcResult = { data: unknown; error: unknown };

const calls: string[] = [];
let rpcHandlers: Record<string, () => RpcResult> = {};

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    rpc: async (name: string) => {
      calls.push(`rpc:${name}`);
      const handler = rpcHandlers[name];
      return handler ? handler() : { data: { ok: true }, error: null };
    },
  }),
}));

const smsSend = vi.fn(async () => {
  calls.push('sms:send');
  return { success: true, provider: 'kavenegar', messageId: 'mid-1' };
});

vi.mock('../../../server/services/sms/index.js', () => ({
  sendSmsVerification: (...args: unknown[]) => smsSend(...(args as [])),
}));

const svc = await import('../../../server/services/phoneVerification/index.js');
const CONFIG = {} as never;

const CHALLENGE = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const ADMIN = '33333333-3333-4333-8333-333333333333';

function baseHandlers(): Record<string, () => RpcResult> {
  return {
    phone_verification_start: () => ({ data: { challengeId: null }, error: null }),
  };
}

async function runResend() {
  return svc.issueChallenge(CONFIG, {
    purpose: 'widget_access',
    subjectUserId: USER,
    phoneE164: '+989121234567',
    createdBy: 'admin',
    actorUserId: ADMIN,
    adminUserId: ADMIN,
  });
}

beforeEach(() => {
  calls.length = 0;
  smsSend.mockClear();
  rpcHandlers = baseHandlers();
});

describe('admin resend fail-closed ordering', () => {
  it('writes the requested audit before any SMS is sent', async () => {
    rpcHandlers.phone_verification_start = () => {
      const id = calls.length; // placeholder, real id injected below
      void id;
      return { data: { challengeId: currentChallengeId() }, error: null };
    };
    await expect(runResend()).resolves.toMatchObject({ success: true });
    const auditIdx = calls.indexOf('rpc:phone_verification_admin_resend_requested');
    const smsIdx = calls.indexOf('sms:send');
    expect(auditIdx).toBeGreaterThanOrEqual(0);
    expect(smsIdx).toBeGreaterThan(auditIdx);
    expect(calls).toContain('rpc:phone_verification_finalize_admin_resend');
  });

  it('sends no SMS and invalidates the challenge when the requested audit fails', async () => {
    rpcHandlers.phone_verification_start = () => ({
      data: { challengeId: currentChallengeId() },
      error: null,
    });
    rpcHandlers.phone_verification_admin_resend_requested = () => ({
      data: { error: 'phone_challenge_not_found' },
      error: null,
    });
    await expect(runResend()).rejects.toMatchObject({ code: 'phone_verification_unavailable' });
    expect(smsSend).not.toHaveBeenCalled();
    expect(calls).not.toContain('sms:send');
    expect(calls).toContain('rpc:phone_verification_invalidate');
  });

  it('sends no SMS when the requested audit RPC errors', async () => {
    rpcHandlers.phone_verification_start = () => ({
      data: { challengeId: currentChallengeId() },
      error: null,
    });
    rpcHandlers.phone_verification_admin_resend_requested = () => ({
      data: null,
      error: { message: 'boom' },
    });
    await expect(runResend()).rejects.toMatchObject({ status: 500 });
    expect(smsSend).not.toHaveBeenCalled();
  });

  it('never returns success when finalize fails, and invalidates the OTP', async () => {
    rpcHandlers.phone_verification_start = () => ({
      data: { challengeId: currentChallengeId() },
      error: null,
    });
    rpcHandlers.phone_verification_finalize_admin_resend = () => ({
      data: { error: 'phone_challenge_not_found' },
      error: null,
    });
    await expect(runResend()).rejects.toMatchObject({ code: 'phone_verification_unavailable' });
    expect(calls.filter((c) => c === 'rpc:phone_verification_invalidate')).toHaveLength(1);
  });

  it('never leaks the provider name or a raw error to the caller', async () => {
    rpcHandlers.phone_verification_start = () => ({
      data: { challengeId: currentChallengeId() },
      error: null,
    });
    const result = await runResend();
    expect(JSON.stringify(result)).not.toMatch(/kavenegar|mid-1/i);
    expect(result.phoneMasked).not.toContain('9121234567');
  });
});

/**
 * `issueChallenge` generates the challenge id internally and requires the RPC
 * to echo it back, so the mock replays whatever id the service just produced.
 */
let lastChallengeId = CHALLENGE;
function currentChallengeId(): string {
  return lastChallengeId;
}

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    default: actual,
    randomUUID: () => {
      lastChallengeId = CHALLENGE;
      return CHALLENGE;
    },
  };
});