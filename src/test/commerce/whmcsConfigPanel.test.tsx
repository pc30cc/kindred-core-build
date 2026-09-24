/**
 * Plugins → WHMCS panel, and the WooCommerce panel next to it.
 *
 * - each panel shows its own provider's connection (the list endpoint returns
 *   both; the WooCommerce panel used to take whichever was newest);
 * - "Check connection" is one request per press, and the button stays
 *   disabled while it runs and through the cooldown;
 * - a permission switch sends the complete WHMCS section set, because the
 *   server replaces the stored object.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: null } }) } },
}));

import { WhmcsConfigPanel } from '@/components/plugins/WhmcsConfigPanel';
import { WooCommerceConfigPanel } from '@/components/plugins/WooCommerceConfigPanel';

const WS = 'ws-1';
const WHMCS = {
  id: 'conn-whmcs', provider_type: 'whmcs', store_id: 'https://billing.example.com/whmcs', approved_origin: 'https://billing.example.com',
  protocol_version: 'webyar-commerce/1', connector_version: '1.0.0', platform_version: '8.13.1',
  permissions: { catalog: true, services: false, domains: false, invoices: true, orders: false, tickets: false },
  health: 'connected', last_success_at: '2026-09-24T10:00:00Z', last_error_at: null, last_error_code: null,
  capabilities: [], catalog_ready: false, created_at: '2026-09-24T09:00:00Z',
};
const WOO = {
  id: 'conn-woo', provider_type: 'woocommerce', store_id: 'https://shop.example.com', approved_origin: 'https://shop.example.com',
  protocol_version: 'webyar-commerce/1', connector_version: '1.1.0', woocommerce_version: '9.1', wordpress_version: '6.6', hpos_enabled: true,
  permissions: { products: true }, health: 'connected', catalog_ready: true, capabilities: ['products.read'],
  last_sync_at: null, last_event_at: null, last_error_code: null, created_at: '2026-09-01T09:00:00Z',
};

type Call = { url: string; method: string; body: unknown };
let calls: Call[];
let connections: Array<Record<string, unknown>>;
let resolveCheck: (() => void) | null;

function ok(json: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => json } as Response);
}

beforeEach(() => {
  calls = [];
  connections = [WHMCS, WOO];
  resolveCheck = null;
  vi.spyOn(global, 'fetch').mockImplementation(((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.endsWith('/commerce/connections') && method === 'GET') return ok({ connections });
    if (url.endsWith('/test')) {
      return new Promise((resolve) => {
        resolveCheck = () => resolve({ ok: true, status: 200, json: async () => ({ ok: true, health: 'connected', lastErrorCode: null, checkedAt: new Date().toISOString() }) } as Response);
      });
    }
    return ok({ ok: true });
  }) as typeof fetch);
});

afterEach(() => vi.restoreAllMocks());

function renderWith(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

describe('each panel shows its own provider', () => {
  it('the WHMCS panel shows the WHMCS install, its versions and no sync action', async () => {
    renderWith(<WhmcsConfigPanel workspaceId={WS} />);
    expect(await screen.findByText('https://billing.example.com/whmcs')).toBeTruthy();
    expect(screen.getByText('8.13.1')).toBeTruthy();
    expect(screen.queryByText(/sync/i)).toBeNull();
    expect(screen.queryByText('https://shop.example.com')).toBeNull();
  });

  it('the WooCommerce panel keeps showing the shop when WHMCS was connected later', async () => {
    renderWith(<WooCommerceConfigPanel workspaceId={WS} />);
    expect(await screen.findByText('https://shop.example.com')).toBeTruthy();
    expect(screen.queryByText('https://billing.example.com')).toBeNull();
  });

  it('with no WHMCS connection it offers the addon download, even when a shop is connected', async () => {
    connections = [WOO];
    renderWith(<WhmcsConfigPanel workspaceId={WS} />);
    const link = await screen.findByRole('link');
    expect(link.getAttribute('href')).toBe('/downloads/webyar-whmcs.zip');
  });
});

describe('Check connection', () => {
  it('sends one request per press and stays disabled while running and cooling down', async () => {
    renderWith(<WhmcsConfigPanel workspaceId={WS} />);
    const button = await screen.findByRole('button', { name: /actions\.check/ });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith('/test'))).toHaveLength(1));
    expect(screen.getByRole('button', { name: /actions\.checking/ }).hasAttribute('disabled')).toBe(true);

    resolveCheck?.();
    const again = await screen.findByRole('button', { name: /actions\.check$/ });
    expect(again.hasAttribute('disabled')).toBe(true); // cooldown
    fireEvent.click(again);
    expect(calls.filter((c) => c.url.endsWith('/test'))).toHaveLength(1);
    expect(calls.find((c) => c.url.endsWith('/test'))?.url).toBe(`/api/workspaces/${WS}/commerce/connections/conn-whmcs/test`);
  });
});

describe('permissions', () => {
  it('a switch sends every WHMCS section, flipping only the one pressed', async () => {
    renderWith(<WhmcsConfigPanel workspaceId={WS} />);
    await screen.findByText('https://billing.example.com/whmcs');
    const switches = screen.getAllByRole('switch');
    expect(switches).toHaveLength(9);
    fireEvent.click(switches[4]); // services
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.url).toBe(`/api/workspaces/${WS}/commerce/connections/conn-whmcs/permissions`);
    expect(patch?.body).toEqual({ announcements: false, knowledgebase: false, networkstatus: false, catalog: true, services: true, domains: false, invoices: true, orders: false, tickets: false });
  });
});
