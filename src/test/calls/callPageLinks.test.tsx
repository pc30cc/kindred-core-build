/**
 * The "Page" link of a call (Calls, Live Desk) and of a callback (Callbacks).
 * `page_url` and `page_title` come from the visitor's own request body
 * (POST /api/call-widget/calls/request, /callbacks/request), so a call could
 * show "https://shop.example/checkout" and open another site, and a callback
 * whose page did not parse threw while its row drew (`new URL`), blanking the
 * page for every operator. A call's page is now linked only as an http(s)
 * address on the call's own `origin`; a callback's only as an http(s)
 * address, under its real host (shared/callCenter/visitorPageUrl.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { I18nProvider } from '@/i18n';
import en from '@/i18n/locales/en';

const ORIGIN = 'https://shop.example';
const LEGIT = 'https://shop.example/checkout?step=2#pay';
/** What a visitor can send as the page; none of it may become a link of a call. */
const HOSTILE = [
  '/\\evil.example',
  '/\\t/evil.example',
  '/\t/evil.example',
  '//evil.example',
  'https://evil.example',
  'javascript:alert(1)',
  'x',
  'https://shop.example.evil.example/checkout',
  'http://shop.example/checkout',
];

const state = vi.hoisted(() => ({
  call: null as Record<string, unknown> | null,
  callbacks: [] as Record<string, unknown>[],
}));

vi.mock('@/hooks/useWorkspace', () => ({ useActiveWorkspace: () => ({ workspace: { id: 'ws-1' }, notFound: false }) }));
vi.mock('@/hooks/useCallCenter', () => ({
  useCallCenterCalls: () => ({ data: { calls: state.call ? [state.call] : [] } }),
  useCallCenterCall: (_ws: string, id: string | null) => ({
    data: id && state.call ? { call: state.call, events: [], rating: null } : undefined,
  }),
  useCallCenterQueue: () => ({
    data: { queue: state.call ? [{ id: 'q1', call_session_id: state.call.id, state: 'queued', channel: 'voice', priority: 100, created_at: state.call.created_at, call_session: state.call }] : [] },
    isLoading: false,
  }),
  useCallCenterOverview: () => ({ data: undefined }),
  useCallCenterSettings: () => ({ data: undefined }),
  useCallCenterCallbacks: () => ({ data: { callbacks: state.callbacks }, isFetching: false, refetch: vi.fn(), dataUpdatedAt: 0 }),
}));
vi.mock('@/hooks/useVisitorNetwork', () => ({ useVisitorNetworkBatchBySession: () => ({ data: undefined, isPending: false }) }));
vi.mock('@/hooks/useGeoEnrichmentRealtime', () => ({ useGeoEnrichmentRealtime: () => undefined }));
vi.mock('@/features/visitors/VisitorNetworkCard', () => ({ VisitorNetworkCard: () => null, VisitorNetworkInline: () => null }));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));
vi.mock('@/components/call-center/OperatorMediaConsole', () => ({ default: () => null }));
vi.mock('@/features/calls/TransferCallDialog', () => ({ TransferCallDialog: () => null }));
vi.mock('@/features/calls/CallNotesPanel', () => ({ CallNotesPanel: () => null }));
vi.mock('@/features/calls/OperatorRecordingControls', () => ({
  useOperatorRecording: () => ({}),
  RecordingStatusStrip: () => null,
  RecordingToolbarButton: () => null,
}));

const CallsPage = (await import('@/pages/app/call-center/CallsPage')).default;
const LiveQueuePage = (await import('@/pages/app/call-center/LiveQueuePage')).default;
const CallbacksPage = (await import('@/pages/app/call-center/CallbacksPage')).default;

function mount(page: ReactNode) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <I18nProvider initialLocale="en" initialTranslations={en}>
          {page}
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function call(pageUrl: string, origin: string | null = ORIGIN) {
  return {
    id: 'c0ffee00-0000-4000-8000-000000000001', workspace_id: 'ws-1', state: 'queued', call_type: 'audio',
    visitor_name: 'Sara Ahmadi', visitor_email: null, visitor_phone: null, subject: null,
    page_url: pageUrl, page_title: 'Checkout', origin, created_at: new Date().toISOString(),
    ended_at: null, duration_seconds: null, end_reason: null, provider: 'livekit', provider_room_id: null,
    entry_source: 'call_widget', metadata: {},
  };
}

/** The call's page link ("Checkout"), once the page shows the call. */
async function pageLink(which: 'calls' | 'queue'): Promise<HTMLAnchorElement | null> {
  if (which === 'calls') {
    mount(<CallsPage />);
    fireEvent.click(screen.getByText('Sara Ahmadi'));
    await screen.findByText(en.callCenter.calls.callDetail);
  } else {
    mount(<LiveQueuePage />);
    await screen.findAllByText('Sara Ahmadi');
  }
  return screen.queryByRole('link', { name: 'Checkout' }) as HTMLAnchorElement | null;
}

beforeEach(() => {
  vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ recordings: [] }) }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  state.call = null;
  state.callbacks = [];
});

describe.each(['calls', 'queue'] as const)('a call\'s page link (%s)', (which) => {
  it('links the page the visitor was on, on the call\'s own site', async () => {
    state.call = call(LEGIT);
    const a = await pageLink(which);
    expect(a?.getAttribute('href')).toBe(LEGIT);
    expect(a?.getAttribute('target')).toBe('_blank');
  });

  it.each(HOSTILE)('never links %j', async (pageUrl) => {
    state.call = call(pageUrl);
    expect(await pageLink(which)).toBeNull();
  });

  it('a call stored without its origin (before the check) gets no link', async () => {
    state.call = call(LEGIT, null);
    expect(await pageLink(which)).toBeNull();
  });
});

describe('a callback\'s page link', () => {
  function callback(pageUrl: string, name: string) {
    return {
      id: `3fa85f64-5717-4562-b3fc-${String(state.callbacks.length).padStart(12, '0')}`, workspace_id: 'ws-1',
      status: 'requested', channel: 'audio', metadata: { name, page_url: pageUrl }, created_at: new Date().toISOString(),
    };
  }

  it('one bad page does not break the list, and none of them becomes a link', () => {
    const bad = ['/\\evil.example', '/\\t/evil.example', '/\t/evil.example', '//evil.example', 'javascript:alert(1)', 'x', 'https://'];
    state.callbacks = bad.map((p, i) => callback(p, `Visitor ${i}`));
    state.callbacks.push(callback(LEGIT, 'Real visitor'));
    mount(<CallbacksPage />);
    bad.forEach((_p, i) => expect(screen.getByText(`Visitor ${i}`)).toBeTruthy());
    const links = screen.getAllByRole('link').filter((a) => a.getAttribute('target') === '_blank');
    expect(links.map((a) => [a.getAttribute('href'), a.textContent])).toEqual([[LEGIT, 'shop.example']]);
  });

  it('an absolute address elsewhere (stored before the server check) is labelled with its real host', () => {
    state.callbacks = [callback('https://evil.example/login', 'Visitor')];
    mount(<CallbacksPage />);
    const [a] = screen.getAllByRole('link').filter((l) => l.getAttribute('target') === '_blank');
    expect(a.textContent).toBe('evil.example');
  });
});
