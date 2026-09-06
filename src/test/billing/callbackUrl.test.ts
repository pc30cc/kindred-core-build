import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../server/services/platformOrigins.js', () => ({
  allowedOrigins: () => ['https://app.example.com', 'https://configured.example.com'],
}));

const { isAllowedBillingCallbackUrl, isSafeSignedBillingCallback } = await import(
  '../../../server/services/billing/callbackUrl.js'
);

const config = { corsOrigins: ['https://configured.example.com'] } as any;

function request(headers: Record<string, string>, protocol = 'https') {
  return {
    protocol,
    get: (name: string) => headers[name.toLowerCase()],
  };
}

describe('billing callback URL boundary', () => {
  it('accepts the authenticated browser origin behind a proxy', () => {
    const req = request({
      origin: 'https://preview.example.com',
      host: 'internal-api:3001',
    }, 'http');
    expect(isAllowedBillingCallbackUrl(req, config, 'https://preview.example.com/ws/billing')).toBe(true);
  });

  it('accepts platform, configured, referer and forwarded origins', () => {
    expect(isAllowedBillingCallbackUrl(request({}), config, 'https://app.example.com/billing')).toBe(true);
    expect(isAllowedBillingCallbackUrl(request({}), config, 'https://configured.example.com/billing')).toBe(true);
    expect(isAllowedBillingCallbackUrl(
      request({ referer: 'https://referer.example.com/ws/billing' }),
      config,
      'https://referer.example.com/ws/billing',
    )).toBe(true);
    expect(isAllowedBillingCallbackUrl(
      request({ 'x-forwarded-host': 'public.example.com', 'x-forwarded-proto': 'https' }, 'http'),
      config,
      'https://public.example.com/ws/billing',
    )).toBe(true);
  });

  it('rejects unknown, insecure and non-http callback URLs', () => {
    expect(isAllowedBillingCallbackUrl(request({}), config, 'https://evil.example.com/billing')).toBe(false);
    expect(isAllowedBillingCallbackUrl(request({}), config, 'http://app.example.com/billing')).toBe(false);
    expect(isAllowedBillingCallbackUrl(request({}), config, 'javascript:alert(1)')).toBe(false);
  });

  it('allows a signed simulator callback across split app/API hosts', () => {
    expect(isSafeSignedBillingCallback('https://app.example.com/ws/billing')).toBe(true);
    expect(isSafeSignedBillingCallback('http://localhost:8080/ws/billing')).toBe(true);
    expect(isSafeSignedBillingCallback('http://evil.example.com/ws/billing')).toBe(false);
  });
});