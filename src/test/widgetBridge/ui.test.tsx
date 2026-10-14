// @vitest-environment jsdom
import React from 'react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { widgetBridgeEn } from '../../i18n/widgetBridge';
import { WidgetBridgeSettingsPanel } from '../../features/widget-bridge/SettingsPanel';
import WidgetBridgeInboxPage from '../../pages/app/WidgetBridgeInboxPage';

const state = vi.hoisted(() => ({
  enabled: true,
  request: vi.fn(),
}));
vi.mock('@/features/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 'admin-1' } }) }));
vi.mock('@/hooks/useWorkspace', () => ({ useCurrentWorkspace: () => ({ id: 'workspace-1', slug: 'admin', owner_id: 'admin-1' }) }));
vi.mock('@/i18n', () => ({ useTranslation: () => ({
  locale: 'en', dir: 'ltr', t: (key: string) => {
    let value: unknown = widgetBridgeEn;
    for (const part of key.split('.').slice(1)) value = (value as Record<string, unknown>)?.[part];
    return typeof value === 'string' ? value : key;
  },
}) }));
vi.mock('@/features/widget-bridge/api', () => ({ bridgeRequest: (...args: unknown[]) => state.request(...args) }));

const contact = { id: 'site-1', name: 'Example support', url: 'https://example.com/', provider: 'auto', selectors: {}, enabled: true, deleting: false, status: 'connected', last_error: null, last_seen_at: null };
function mount(component: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter>{component}</MemoryRouter></QueryClientProvider>);
}
beforeEach(() => {
  state.enabled = true;
  state.request.mockReset().mockImplementation(async (_workspace: string, path: string, method = 'GET', body?: unknown) => {
    if (path === '/settings' && method === 'GET') return { settings: { enabled: state.enabled, identity: { name: 'Default Admin', email: 'admin@example.com', phone: '+90555' } } };
    if (path === '/settings' && method === 'PUT') { state.enabled = (body as { enabled: boolean }).enabled; return { settings: body }; }
    if (path === '/contacts') return { contacts: [contact] };
    if (path.endsWith('/messages') && method === 'GET') return { messages: [{ id: 'reply-1', body: 'Remote reply', direction: 'inbound', delivery: 'received', created_at: '2026-10-14T08:00:00Z' }], hasMore: false };
    return { message: { id: 'queued-1', delivery: 'queued' } };
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  vi.stubGlobal('crypto', { randomUUID: () => '00000000-0000-4000-8000-000000000010' });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Super Admin bridge UI', () => {
  it('saves default identity and disables the bridge through settings', async () => {
    mount(<WidgetBridgeSettingsPanel workspaceId="workspace-1" slug="admin" />);
    const name = await screen.findByLabelText('Default name');
    fireEvent.change(name, { target: { value: 'My name' } });
    fireEvent.click(screen.getByLabelText('Enable widget bridge'));
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(state.request).toHaveBeenCalledWith('workspace-1', '/settings', 'PUT', {
      enabled: false, identity: { name: 'My name', email: 'admin@example.com', phone: '+90555' },
    }));
  });
  it('shows received replies and queues the admin’s message instead of opening a site in the UI', async () => {
    mount(<WidgetBridgeInboxPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Example support/ }));
    expect(await screen.findByText('Remote reply')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Write a message…'), { target: { value: 'Hello from my inbox' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(state.request).toHaveBeenCalledWith('workspace-1', '/contacts/site-1/messages', 'POST', {
      body: 'Hello from my inbox', clientMessageId: '00000000-0000-4000-8000-000000000010',
    }));
  });
  it('keeps history visible but blocks the composer while disabled', async () => {
    state.enabled = false;
    mount(<WidgetBridgeInboxPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Example support/ }));
    expect(await screen.findByText('Remote reply')).toBeTruthy();
    expect((screen.getByLabelText('Write a message…') as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
