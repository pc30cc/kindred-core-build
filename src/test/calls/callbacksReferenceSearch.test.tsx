/**
 * Call Center → Callbacks: the search finds a callback by the reference code
 * the visitor saw on the call widget's screen 19 ("Callback scheduled",
 * the first eight characters of the callback id, upper-cased; 2026-10 call
 * widget design B7), as well as by name, e-mail, phone and subject.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@/i18n';
import en from '@/i18n/locales/en';

const CALLBACKS = [
  {
    id: '3fa85f64-5717-4562-b3fc-2c963f66afa6', workspace_id: 'ws-1', status: 'requested', channel: 'voice',
    metadata: { name: 'Sara Ahmadi', subject: 'Invoice' }, contact_email: 'sara@x.test', created_at: '2026-10-19T10:00:00Z',
  },
  {
    id: '9b2e1c00-0000-4000-8000-000000000001', workspace_id: 'ws-1', status: 'requested', channel: 'video',
    metadata: { name: 'Reza Karimi', subject: 'Delivery' }, contact_phone: '+98 912 000 0000', created_at: '2026-10-19T11:00:00Z',
  },
];

vi.mock('@/hooks/useWorkspace', () => ({ useActiveWorkspace: () => ({ workspace: { id: 'ws-1' }, notFound: false }) }));
vi.mock('@/hooks/useCallCenter', () => ({
  useCallCenterCallbacks: () => ({ data: { callbacks: CALLBACKS }, isFetching: false, refetch: vi.fn(), dataUpdatedAt: 0 }),
}));
vi.mock('@/hooks/useVisitorNetwork', () => ({ useVisitorNetworkBatchBySession: () => ({ data: undefined }) }));
vi.mock('@/hooks/useGeoEnrichmentRealtime', () => ({ useGeoEnrichmentRealtime: () => undefined }));
vi.mock('@/features/visitors/VisitorNetworkCard', () => ({ VisitorNetworkInline: () => null }));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));

const CallbacksPage = (await import('@/pages/app/call-center/CallbacksPage')).default;

afterEach(cleanup);

function mount() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <I18nProvider initialLocale="en" initialTranslations={en}>
          <CallbacksPage />
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return screen.getByPlaceholderText(en.callCenter.callbacks.searchPlaceholder);
}

const shown = () => ({ sara: !!screen.queryByText('Sara Ahmadi'), reza: !!screen.queryByText('Reza Karimi') });

describe('the callbacks search', () => {
  it('finds a callback by the reference code a visitor reads out, in any case, with or without #', () => {
    const search = mount();
    expect(shown()).toEqual({ sara: true, reza: true });
    for (const q of ['3FA85F64', '3fa85f64', '#3FA85F64']) {
      fireEvent.change(search, { target: { value: q } });
      expect(shown()).toEqual({ sara: true, reza: false });
    }
    fireEvent.change(search, { target: { value: '9B2E1C00' } });
    expect(shown()).toEqual({ sara: false, reza: true });
  });

  it('a part of the id past the code is not a match', () => {
    const search = mount();
    fireEvent.change(search, { target: { value: '5717' } });
    expect(shown()).toEqual({ sara: false, reza: false });
  });

  it('name, subject, e-mail and phone still match', () => {
    const search = mount();
    for (const [q, who] of [['sara a', 'sara'], ['delivery', 'reza'], ['x.test', 'sara'], ['912 000', 'reza']] as const) {
      fireEvent.change(search, { target: { value: q } });
      expect(shown()[who]).toBe(true);
    }
  });

  it('the placeholder names the reference code', () => {
    expect(en.callCenter.callbacks.searchPlaceholder.toLowerCase()).toContain('reference');
  });
});
