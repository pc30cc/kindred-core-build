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
  lists: {} as Record<string, {urls:string[];includeShared:boolean}>,
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
  state.enabled = true; state.lists = {};
  state.request.mockReset().mockImplementation(async (_workspace: string, path: string, method = 'GET', body?: unknown) => {
    if (path === '/settings' && method === 'GET') return { settings: { enabled: state.enabled, identity: { name: 'Default Admin', email: 'admin@example.com', phone: '+90555' } } };
    if (path === '/settings' && method === 'PUT') { state.enabled = (body as { enabled: boolean }).enabled; return { settings: body }; }
    if (path === '/site-lists') return {lists:state.lists};
    if (path.startsWith('/site-lists/') && method === 'PUT') { const key=path.split('/').pop()!; state.lists={...state.lists,[key]:body as {urls:string[];includeShared:boolean}}; return {list:state.lists[key]}; }
    if (path === '/batches') return method === 'POST' ? { batch: { id: 'batch-1' } } : { batches: [] };
    if (path === '/batches/batch-1') return { items: [] };
    if (path === '/contacts?aiReplied=true') return { contacts: [{ ...contact, ai_replied_at:'2026-10-14T10:00:00Z', ai_reply_source:'widget_label', ai_reply_label:'AI assistant' }], hasMore:false };
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
      roundSize:1, intervalSeconds:30, allowedProviders: ['platform','crisp','raychat','goftino','custom'], enabled: false, identity: { name: 'My name', email: 'admin@example.com', phone: '+90555' },
    }));
  });
  it('saves the provider selection and starts a deduplicated ordered website batch', async () => {
    mount(<WidgetBridgeSettingsPanel workspaceId="workspace-1" slug="admin" />);
    await screen.findByLabelText('Default name');
    fireEvent.click(screen.getByLabelText('Crisp'));
    fireEvent.change(screen.getByLabelText('Sites per round (1–50)'), { target:{value:'3'} });
    fireEvent.change(screen.getByLabelText('Wait between sites (seconds, 5–3600)'), { target:{value:'60'} });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(state.request).toHaveBeenCalledWith('workspace-1', '/settings', 'PUT', expect.objectContaining({ roundSize:3,intervalSeconds:60,allowedProviders: ['platform','raychat','goftino','custom'] })));
    fireEvent.change(screen.getByLabelText('Website list (one per line)'), { target: { value: 'first.example.com\nhttps://first.example.com/#same\nsecond.example.com' } });
    fireEvent.change(screen.getByLabelText('Message for all sites'), { target: { value: 'Shared message' } });
    await waitFor(() => expect((screen.getByRole('button', { name:'Start sequential sending' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Start sequential sending' }));
    await waitFor(() => expect(state.request).toHaveBeenCalledWith('workspace-1','/batches','POST', {
      urls: ['https://first.example.com/','https://second.example.com/'], body: 'Shared message', clientBatchId: '00000000-0000-4000-8000-000000000010',
    }));
  });
  it('continues only the reviewed batch version from the pause button', async () => {
    const original=state.request.getMockImplementation()!;
    state.request.mockImplementation(async (...args: unknown[]) => {
      if (args[1]==='/batches' && (!args[2] || args[2]==='GET')) return { batches:[{id:'paused-1',body:'Review me',status:'paused',review_version:7,round_size:1,interval_seconds:30,total:2,pending:1,sent:1,failed:0,uncertain:0,skipped:0}] };
      return original(...args);
    });
    mount(<WidgetBridgeSettingsPanel workspaceId="workspace-1" slug="admin" />);
    fireEvent.click(await screen.findByRole('button',{name:'Approve and continue'}));
    await waitFor(()=>expect(state.request).toHaveBeenCalledWith('workspace-1','/batches/paused-1/continue','POST',{reviewVersion:7}));
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


it('prepares selected AI follow-ups without sending until the batch start button is pressed', async () => {
  mount(<WidgetBridgeSettingsPanel workspaceId="workspace-1" slug="admin" />);
  await screen.findByText('AI assistant', {exact:false});
  const section = screen.getByText('Answered by AI').closest('section')!;
  fireEvent.click(section.querySelector('input[type="checkbox"]')!);
  fireEvent.click(screen.getByRole('button',{name:/Prepare selected sites for follow-up/}));
  expect((screen.getByLabelText('Website list (one per line)') as HTMLTextAreaElement).value).toBe(contact.url);
  expect(state.request.mock.calls.filter(call=>call[1]==='/batches' && call[2]==='POST')).toHaveLength(0);
  fireEvent.change(screen.getByLabelText('Message for all sites'),{target:{value:'سلام'}});
  fireEvent.click(screen.getByRole('button',{name:'Start sequential sending'}));
  await waitFor(()=>expect(state.request).toHaveBeenCalledWith('workspace-1','/batches','POST',expect.objectContaining({urls:[contact.url],body:'سلام'})));
});


it('keeps provider drafts separate and combines shared sites only when opted in', async () => {
  state.lists={shared:{urls:['https://first.example.com/','https://shared.example.com/'],includeShared:false}};
  mount(<WidgetBridgeSettingsPanel workspaceId="workspace-1" slug="admin" />);
  await screen.findByLabelText('Default name');
  const provider=screen.getByLabelText('Website list provider');
  const sites=screen.getByLabelText('Saved websites (one per line)');
  fireEvent.change(sites,{target:{value:'first.example.com\nsecond.example.com'}});
  fireEvent.change(provider,{target:{value:'crisp'}});
  expect((sites as HTMLTextAreaElement).value).toBe('');
  fireEvent.change(provider,{target:{value:'goftino'}});
  expect((sites as HTMLTextAreaElement).value).toBe('first.example.com\nsecond.example.com');
  fireEvent.click(screen.getByLabelText('Include shared websites for this provider'));
  fireEvent.click(screen.getByRole('button',{name:'Save website list'}));
  await screen.findByText('Website list saved.');
  fireEvent.click(screen.getByRole('button',{name:'Prepare saved list'}));
  expect((screen.getByLabelText('Website list (one per line)') as HTMLTextAreaElement).value).toBe('https://first.example.com/\nhttps://second.example.com/\nhttps://shared.example.com/');
  expect((screen.getByLabelText('Provider for this batch') as HTMLSelectElement).value).toBe('goftino');
  expect(state.request.mock.calls.filter(call=>call[1]==='/batches' && call[2]==='POST')).toHaveLength(0);
  fireEvent.click(screen.getByLabelText('Include shared websites for this provider'));
  fireEvent.click(screen.getByRole('button',{name:'Save website list'}));
  await waitFor(()=>expect((screen.getByRole('button',{name:'Prepare saved list'}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button',{name:'Prepare saved list'}));
  expect((screen.getByLabelText('Website list (one per line)') as HTMLTextAreaElement).value).toBe('https://first.example.com/\nhttps://second.example.com/');
  fireEvent.change(screen.getByLabelText('Message for all sites'),{target:{value:'سلام'}});
  fireEvent.click(screen.getByRole('button',{name:'Start sequential sending'}));
  await waitFor(()=>expect(state.request).toHaveBeenCalledWith('workspace-1','/batches','POST',expect.objectContaining({provider:'goftino',urls:['https://first.example.com/','https://second.example.com/']})));
});
