import { describe, it, expect, vi } from 'vitest';

const lookupMock = vi.fn();
vi.mock('node:dns/promises', () => ({ default: { lookup: (...a: any[]) => lookupMock(...a) }, lookup: (...a: any[]) => lookupMock(...a) }));
vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => ({}) }));
vi.mock('../../../server/middleware/adminBypass.js', () => ({ isGlobalAdmin: async () => false }));

const { isSafeOutboundUrl, checkOutboundUrl } = await import('../../../server/lib/workspaceAuth.js');

describe('isSafeOutboundUrl', () => {
  it.each([
    'http://api.openai.com/v1',
    'https://localhost/v1',
    'https://127.0.0.1/v1',
    'https://169.254.169.254/latest/meta-data',
    'https://10.0.0.5/v1',
    'https://192.168.1.1/v1',
    'https://172.16.0.1/v1',
    'https://[::1]/v1',
    'https://[::ffff:127.0.0.1]/v1',
    'https://metadata.google.internal/v1',
    'https://user:pass@api.example.com/v1',
    'file:///etc/passwd',
    'not a url',
  ])('rejects %s', (url) => {
    expect(isSafeOutboundUrl(url)).toBe(false);
  });

  it('accepts a normal public https endpoint', () => {
    expect(isSafeOutboundUrl('https://api.openai.com/v1')).toBe(true);
  });
});

describe('checkOutboundUrl (DNS aware)', () => {
  it('rejects a public hostname that resolves to a private address', async () => {
    lookupMock.mockResolvedValueOnce([{ address: '10.1.2.3', family: 4 }]);
    expect(await checkOutboundUrl('https://evil.example.com/v1')).toEqual({ ok: false, reason: 'private_ip' });
  });

  it('rejects when any answer is private', async () => {
    lookupMock.mockResolvedValueOnce([
      { address: '93.184.216.34', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ]);
    expect((await checkOutboundUrl('https://mixed.example.com')).ok).toBe(false);
  });

  it('fails closed on DNS errors', async () => {
    lookupMock.mockRejectedValueOnce(new Error('ENOTFOUND'));
    expect(await checkOutboundUrl('https://nope.example.com')).toEqual({ ok: false, reason: 'dns_failure' });
  });

  it('allows a public hostname resolving to public addresses', async () => {
    lookupMock.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    expect(await checkOutboundUrl('https://api.openai.com/v1')).toEqual({ ok: true });
  });
});
