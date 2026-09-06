/**
 * Split-deployment contract: APP_ORIGIN !== API_ORIGIN.
 *
 * The bug this guards against: `paymentReturnUrls()` used to derive the
 * gateway (bank) callback from the BROWSER return URL's origin
 * (`new URL('/api/billing/return', browserReturn.origin)`), and the internal
 * test gateway derived its own page's host from that same callback URL. Both
 * are architecturally wrong — the API origin is a separate, canonical value
 * (`platform_domains.api_base_url`) that must never be inferred from
 * client-supplied input, and this must work even when the app host does NOT
 * reverse-proxy `/api/*`.
 */
import { describe, expect, it, vi } from 'vitest';

const APP_ORIGIN = 'https://app.example.com';
const API_ORIGIN = 'https://api.example.com';

describe('split-origin billing callback contract (APP != API)', () => {
  describe('resolvePublicApiOrigin', () => {
    it('prefers platform_domains.api_base_url over everything else', async () => {
      vi.resetModules();
      vi.doMock('@supabase/supabase-js', () => ({
        createClient: () => ({
          from: () => ({
            select: () => ({
              limit: () => ({
                maybeSingle: async () => ({
                  data: { app_base_url: APP_ORIGIN, api_base_url: API_ORIGIN },
                }),
              }),
            }),
          }),
        }),
      }));
      const { resolvePublicApiOrigin } = await import('../../../server/services/billing/callbackUrl.js');
      await expect(resolvePublicApiOrigin('url', 'key')).resolves.toBe(API_ORIGIN);
      vi.doUnmock('@supabase/supabase-js');
    });

    it('falls back to API_BASE_URL env, never to the app origin, when no db value is set', async () => {
      vi.resetModules();
      vi.doMock('@supabase/supabase-js', () => ({
        createClient: () => ({
          from: () => ({
            select: () => ({
              limit: () => ({
                maybeSingle: async () => ({ data: { app_base_url: APP_ORIGIN, api_base_url: null } }),
              }),
            }),
          }),
        }),
      }));
      const prevApiBase = process.env.API_BASE_URL;
      process.env.API_BASE_URL = API_ORIGIN;
      try {
        const { resolvePublicApiOrigin } = await import('../../../server/services/billing/callbackUrl.js');
        await expect(resolvePublicApiOrigin('url', 'key')).resolves.toBe(API_ORIGIN);
      } finally {
        if (prevApiBase === undefined) delete process.env.API_BASE_URL;
        else process.env.API_BASE_URL = prevApiBase;
        vi.doUnmock('@supabase/supabase-js');
      }
    });

    it('only falls back to the app origin for a genuine single-origin deployment', async () => {
      vi.resetModules();
      vi.doMock('@supabase/supabase-js', () => ({
        createClient: () => ({
          from: () => ({
            select: () => ({
              limit: () => ({
                maybeSingle: async () => ({ data: { app_base_url: APP_ORIGIN, api_base_url: null } }),
              }),
            }),
          }),
        }),
      }));
      const prevApiBase = process.env.API_BASE_URL;
      const prevPublicApi = process.env.PUBLIC_API_URL;
      delete process.env.API_BASE_URL;
      delete process.env.PUBLIC_API_URL;
      try {
        const { resolvePublicApiOrigin } = await import('../../../server/services/billing/callbackUrl.js');
        await expect(resolvePublicApiOrigin('url', 'key')).resolves.toBe(APP_ORIGIN);
      } finally {
        if (prevApiBase === undefined) delete process.env.API_BASE_URL; else process.env.API_BASE_URL = prevApiBase;
        if (prevPublicApi === undefined) delete process.env.PUBLIC_API_URL; else process.env.PUBLIC_API_URL = prevPublicApi;
        vi.doUnmock('@supabase/supabase-js');
      }
    });

    it('never trusts a client-provided value — the function takes no such parameter', async () => {
      vi.resetModules();
      const mod = await import('../../../server/services/billing/callbackUrl.js');
      // Compile-time contract: resolvePublicApiOrigin(supabaseUrl, serviceRoleKey)
      // has no callback/origin argument for a caller to smuggle a value through.
      expect(mod.resolvePublicApiOrigin.length).toBe(2);
    });
  });

  describe('paymentReturnUrls (server/routes/billingCustomer.ts)', () => {
    it('keeps the browser return on the app origin and the gateway callback on the API origin', async () => {
      const { paymentReturnUrls } = await import('../../../server/routes/billingCustomer.js');
      const { browserReturnUrl, gatewayCallbackUrl } = paymentReturnUrls(
        `${APP_ORIGIN}/acme/billing/pay/invoice/123`,
        'intent-abc',
        'internal_test',
        API_ORIGIN,
      );

      const browser = new URL(browserReturnUrl);
      const gateway = new URL(gatewayCallbackUrl);

      expect(browser.origin).toBe(APP_ORIGIN);
      expect(gateway.origin).toBe(API_ORIGIN);
      expect(gateway.origin).not.toBe(browser.origin);
      expect(gateway.pathname).toBe('/api/billing/return');
      expect(browser.searchParams.get('intent')).toBe('intent-abc');
      expect(browser.searchParams.get('provider')).toBe('internal_test');
      expect(gateway.searchParams.get('intent')).toBe('intent-abc');
      expect(gateway.searchParams.get('provider')).toBe('internal_test');

      // The bank callback must resolve to a real route on the API host
      // regardless of whether the app host proxies `/api/*` at all.
      expect(gatewayCallbackUrl.startsWith('https://app.example.com/api')).toBe(false);
    });
  });

  describe('internal simulator (server/services/billing/providers/internal-test.ts)', () => {
    it('serves the simulator page from the API origin, independent of the browser callback', async () => {
      const { internalTestProvider } = await import(
        '../../../server/services/billing/providers/internal-test.js'
      );
      const result = await internalTestProvider.createCheckoutSession(
        { provider: 'internal_test', currency: 'IRR', gateway_base_url: API_ORIGIN },
        {
          workspaceId: 'ws-1',
          planId: 'invoice',
          interval: 'monthly',
          currency: 'IRR',
          callbackUrl: `${APP_ORIGIN}/acme/billing/pay/invoice/123?intent=x&provider=internal_test`,
          metadata: { amount: '250000' },
        },
      );
      const paymentUrl = new URL(result.paymentUrl);
      expect(paymentUrl.origin).toBe(API_ORIGIN);
      expect(paymentUrl.pathname).toBe('/api/billing/test-gateway');
      // No dependency whatsoever on app.example.com/api/* being proxied.
      expect(result.paymentUrl.startsWith('https://app.example.com')).toBe(false);
    });
  });
});
