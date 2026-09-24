/**
 * Plugins → OpenCart panel: opening it must not start any background
 * traffic (no polling — the store is never contacted by viewing the page),
 * it lists each connected store on its own, offers the package for each
 * supported OpenCart line, and the owner's "orders" switch carries the
 * gateway's finer order permissions with it. Rendered in Persian too.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@/i18n';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import { OpenCartConfigPanel } from '@/components/plugins/OpenCartConfigPanel';

const CONNECTIONS = {
  connections: [
    { id: 'c-woo', provider_type: 'woocommerce', store_id: 'https://wp.example', permissions: {}, capabilities: [], health: 'connected', protocol_version: 'webyar-commerce/1' },
    {
      id: 'c-oc', provider_type: 'opencart', store_id: 'https://shop.example/', external_store_id: '0', platform_version: '4.1.0.4', connector_version: '1.0.0',
      protocol_version: 'webyar-commerce/1', capabilities: ['products.read', 'orders.read'], permissions: { products: true, prices: true, stock: true, orders: false, tracking: false },
      health: 'connected', last_success_at: null, last_error_code: null, last_error_at: null, last_health_check_at: null,
    },
  ],
};
const MANIFEST = { version: '1.0.0', packages: [
  { opencart: '4.1.x', path: '/downloads/opencart/4.1/webyar.ocmod.zip', file: 'webyar.ocmod.zip', php: '>=8.1' },
  { opencart: '3.0.5.x', path: '/downloads/opencart/3.0/webyar-oc3.ocmod.zip', file: 'webyar-oc3.ocmod.zip', php: '>=8.1' },
] };

type Init = { method?: string; body?: string };
let fetchMock: ReturnType<typeof vi.fn>;

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function renderPanel(locale: 'en' | 'fa' = 'en') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider initialLocale={locale} initialTranslations={locale === 'fa' ? fa : en}>
        <OpenCartConfigPanel workspaceId="ws-1" />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  fetchMock = vi.fn(async (url: string, init?: Init) => {
    if (String(url).includes('manifest.json')) return ok(MANIFEST);
    if (init?.method === 'PATCH') return ok({ ok: true });
    return ok(CONNECTIONS);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const connectionReads = () => fetchMock.mock.calls.filter((c) => String(c[0]).includes('/commerce/connections') && !(c[1] as Init | undefined)?.method);

describe('OpenCart panel', () => {
  it('lists only OpenCart stores and a download per supported line', async () => {
    renderPanel();
    await screen.findByText('https://shop.example/');
    expect(screen.queryByText('https://wp.example')).toBeNull();
    const links = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(links).toEqual(expect.arrayContaining(['/downloads/opencart/4.1/webyar.ocmod.zip', '/downloads/opencart/3.0/webyar-oc3.ocmod.zip']));
  });

  it('does not poll: one read on open, none while it stays open', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderPanel();
    await screen.findByText('https://shop.example/');
    const first = connectionReads().length;
    await act(async () => { vi.advanceTimersByTime(5 * 60_000); });
    expect(connectionReads().length).toBe(first);
    expect(first).toBe(1);
  });

  it('the orders switch also sets order status and history', async () => {
    renderPanel();
    await screen.findByText('https://shop.example/');
    const label = screen.getByText(en.plugins.opencart.permissions.orders);
    fireEvent.click(label.querySelector('button[role="switch"]')!);
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => (c[1] as Init | undefined)?.method === 'PATCH')).toBe(true));
    const patch = fetchMock.mock.calls.find((c) => (c[1] as Init | undefined)?.method === 'PATCH')!;
    expect(JSON.parse(String((patch[1] as Init).body))).toMatchObject({ orders: true, order_status: true, customer_history: true });
  });

  it('renders in Persian', async () => {
    renderPanel('fa');
    expect(await screen.findByText(fa.plugins.opencart.connect.title)).toBeTruthy();
  });
});
