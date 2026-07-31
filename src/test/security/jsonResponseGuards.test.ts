import { describe, it, expect } from 'vitest';
import { isCaptchaVerifyResponse } from '../../../server/middleware/security';
import { isResendSendResponse } from '../../../server/services/email/providers/resend';
import { isCentrifugoApiResponse } from '../../../server/services/realtime/centrifugo';

describe('isCaptchaVerifyResponse', () => {
  it('accepts a valid siteverify payload', () => {
    expect(isCaptchaVerifyResponse({ success: true, hostname: 'example.com' })).toBe(true);
    expect(isCaptchaVerifyResponse({ success: false, 'error-codes': ['bad-request'] })).toBe(true);
  });

  it('rejects a payload missing the required success flag', () => {
    expect(isCaptchaVerifyResponse({ hostname: 'example.com' })).toBe(false);
  });

  it('rejects a payload where success has the wrong type', () => {
    expect(isCaptchaVerifyResponse({ success: 'true' })).toBe(false);
    expect(isCaptchaVerifyResponse(null)).toBe(false);
    expect(isCaptchaVerifyResponse('success')).toBe(false);
  });
});

describe('isResendSendResponse', () => {
  it('accepts a valid send response', () => {
    expect(isResendSendResponse({ id: '4ef9a417-02e9-4d39-ad75-9611e0fcc33c' })).toBe(true);
  });

  it('rejects a payload missing the required id', () => {
    expect(isResendSendResponse({ to: 'user@example.com' })).toBe(false);
  });

  it('rejects a payload where id has the wrong type', () => {
    expect(isResendSendResponse({ id: 12345 })).toBe(false);
    expect(isResendSendResponse(null)).toBe(false);
  });
});

describe('isCentrifugoApiResponse', () => {
  it('accepts result and error envelopes', () => {
    expect(isCentrifugoApiResponse({ result: {} })).toBe(true);
    expect(isCentrifugoApiResponse({ error: { code: 102, message: 'unknown channel' } })).toBe(true);
  });

  it('rejects a null body (the .catch(() => null) fallback)', () => {
    expect(isCentrifugoApiResponse(null)).toBe(false);
  });

  it('rejects non-object bodies', () => {
    expect(isCentrifugoApiResponse('ok')).toBe(false);
    expect(isCentrifugoApiResponse(undefined)).toBe(false);
  });
});