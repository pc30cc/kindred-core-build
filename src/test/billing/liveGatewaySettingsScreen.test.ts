/**
 * Super Admin → Providers for the two gateways that go live:
 *   - live ZarinPal and live Paddle have no sandbox switch (their sandboxes
 *     are the separate zarinpal_test / paddle_sandbox gateways);
 *   - live Paddle's hints give the webhook destination and the token shapes;
 *   - the Test button of a billing gateway runs the server's own check with
 *     the saved settings instead of the browser registry's "unknown".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getVendorSchema } from '@/features/providers/schemas';
import { testProviderConnection } from '@/providers/sync';

afterEach(() => vi.unstubAllGlobals());

describe('provider schemas of the live gateways', () => {
  it('live ZarinPal and live Paddle have no sandbox switch; their sandboxes are separate gateways', () => {
    expect(getVendorSchema('billing', 'zarinpal')!.fields.map((f) => f.key)).not.toContain('sandbox');
    expect(getVendorSchema('billing', 'paddle')!.fields.map((f) => f.key)).not.toContain('sandbox');
    expect(getVendorSchema('billing', 'zarinpal_test')).toBeDefined();
    expect(getVendorSchema('billing', 'paddle_sandbox')).toBeDefined();
  });

  it('live Paddle names its webhook destination and the live token shapes', () => {
    const fields = Object.fromEntries(getVendorSchema('billing', 'paddle')!.fields.map((f) => [f.key, f]));
    expect(fields.webhook_secret.hint).toContain('https://<api domain>/api/billing/webhook/paddle (not /paddle_sandbox)');
    expect(fields.client_token.placeholder).toBe('live_...');
    expect(fields.client_token.hint).toContain('"live_"');
    expect(fields.api_key.placeholder).toBe('pdl_live_apikey_...');
  });
});

describe('Test button for a billing gateway', () => {
  it('asks the server to test the saved settings and shows its answer', async () => {
    const fetchMock = vi.fn(async (): Promise<{ ok: boolean; status: number; json: () => Promise<{ success: boolean; error?: string }> }> => ({ ok: true, status: 200, json: async () => ({ success: false, error: 'ZarinPal -11 (terminal is not active)' }) }));
    vi.stubGlobal('fetch', fetchMock);
    const out = await testProviderConnection('billing', 'zarinpal');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/admin\/billing\/providers\/zarinpal\/test$/);
    expect(init.method).toBe('POST');
    expect(out).toMatchObject({ status: 'auth_failed', message: 'ZarinPal -11 (terminal is not active)' });

    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true }) });
    expect(await testProviderConnection('billing', 'paddle')).toMatchObject({ status: 'healthy' });
  });

  it('reports a request that failed as a network error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ error: 'Forbidden' }) })));
    expect(await testProviderConnection('billing', 'paddle')).toMatchObject({ status: 'network_error', message: 'Forbidden' });
  });
});
