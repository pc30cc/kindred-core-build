/**
 * The Core → Telephony Control Service boundary must fail CLOSED: with no base
 * URL or no shared secret, every gateway call refuses instead of falling back
 * to an unauthenticated request. Saved credentials alone must never make the
 * plugin look connected.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  gatewayHealth,
  isTelephonyGatewayConfigured,
  TELEPHONY_SECRET_HEADER,
} from '../../../server/services/telephony/gatewayClient.js';

const configured = {
  telephonyInternalBaseUrl: 'http://telephony.internal:8088',
  telephonyInternalSecret: 'secret-value',
} as never;

afterEach(() => { vi.unstubAllGlobals(); });

describe('telephony gateway client', () => {
  it('refuses when the gateway is not deployed', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    for (const config of [
      {},
      { telephonyInternalBaseUrl: 'http://telephony.internal:8088' },
      { telephonyInternalSecret: 'secret-value' },
    ]) {
      const res = await gatewayHealth(config as never);
      expect(res.ok).toBe(false);
      expect(res.ok === false && res.errorCode).toBe('gateway_not_configured');
      expect(isTelephonyGatewayConfigured(config as never)).toBe(false);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('authenticates in both transports when configured', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ healthy: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const res = await gatewayHealth(configured);
    expect(res.ok).toBe(true);

    const init = (fetchSpy.mock.calls[0] as unknown as unknown[])[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer secret-value');
    expect(headers[TELEPHONY_SECRET_HEADER]).toBe('secret-value');
  });

  it('maps transport failures to safe error codes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('getaddrinfo ENOTFOUND sip.example.com'); }));
    const dns = await gatewayHealth(configured);
    expect(dns.ok === false && dns.errorCode).toBe('dns_failure');

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('The operation was aborted'); }));
    const timeout = await gatewayHealth(configured);
    expect(timeout.ok === false && timeout.errorCode).toBe('registration_timeout');

    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 502 })));
    const down = await gatewayHealth(configured);
    expect(down.ok === false && down.errorCode).toBe('gateway_unavailable');
  });
});
