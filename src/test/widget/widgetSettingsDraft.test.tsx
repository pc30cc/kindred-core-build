/**
 * The widget page's saves (useWidgetSettingsDraft over useUpdateWidgetSettings,
 * the real hooks against a stubbed fetch): W-02 and W-05.
 *
 *   - typing drafts at once and sends one PATCH with the last value after the
 *     delay; a whole object (labels, hours) edited twice in a row composes;
 *   - a refused save is never silent: the toast says why in the dashboard's
 *     language (a field too long, the plan, an ended session, no network),
 *     the status reads "Not saved", and the field goes back to the stored
 *     value unless a newer edit replaced it;
 *   - a draft-only change (hours not valid yet) sends nothing and drops the
 *     waiting save, and the status goes back to what it read before it;
 *   - leaving the page (unmount, pagehide) sends what still waits; a small
 *     PATCH is a keepalive request, so it outlives the page;
 *   - a success reads "All changes saved".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@/i18n';
import en from '@/i18n/locales/en';
import type { WidgetSettings } from '@/types/models';

const toastMock = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/use-toast', () => ({ toast: toastMock }));

const { useWidgetSettingsDraft } = await import('@/hooks/useWidgetSettingsDraft');

const S = en.widgetPage.save;
type Answer = { status: number; body: unknown } | 'network';
let answers: Answer[];
const sent: Array<{ body: Record<string, unknown>; keepalive?: boolean }> = [];
const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
  sent.push({ body: JSON.parse(String(init?.body || '{}')), keepalive: init?.keepalive });
  const next = answers.shift() ?? { status: 200, body: { settings: {} } };
  if (next === 'network') throw new TypeError('Failed to fetch');
  return new Response(JSON.stringify(next.body), { status: next.status });
});

const stored = { brand_name: 'Acme', welcome_message: 'Hi', availability_labels: { en: { online: 'Here' } } } as unknown as WidgetSettings;

function mount(widget: WidgetSettings = stored) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en" initialTranslations={en}>{children}</I18nProvider>
    </QueryClientProvider>
  );
  return renderHook(() => useWidgetSettingsDraft('ws-1', widget), { wrapper });
}

beforeEach(() => {
  answers = [];
  sent.length = 0;
  toastMock.mockClear();
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('drafting and the debounced save', () => {
  it('typing shows at once and sends one PATCH with the last value', async () => {
    const { result } = mount();
    act(() => { result.current.setField('brand_name', 'Ac', 30); });
    act(() => { result.current.setField('brand_name', 'Acme Store', 30); });
    expect(result.current.live.brand_name).toBe('Acme Store');
    expect(result.current.status).toBe('saving');
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].body).toEqual({ brand_name: 'Acme Store' });
    await waitFor(() => expect(result.current.status).toBe('saved'));
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('a whole object edited twice in a row composes from the draft, not from the stale server copy', async () => {
    const { result } = mount();
    act(() => {
      const labels = result.current.live.availability_labels as Record<string, Record<string, string>>;
      result.current.setFields({ availability_labels: { ...labels, en: { ...labels.en, offline: 'Aw' } } }, { delay: 30 });
    });
    act(() => {
      const labels = result.current.live.availability_labels as Record<string, Record<string, string>>;
      result.current.setFields({ availability_labels: { ...labels, en: { ...labels.en, offline: 'Away' } } }, { delay: 30 });
    });
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].body).toEqual({ availability_labels: { en: { online: 'Here', offline: 'Away' } } });
  });

  it('a draft-only change sends nothing and drops the save waiting for that field', async () => {
    const { result } = mount();
    act(() => { result.current.setFields({ business_hours: { enabled: true, timezone: 'UTC', weekly: {} } }, { delay: 30 }); });
    act(() => {
      result.current.setFields({ business_hours: { enabled: true, timezone: 'UTC', weekly: { mon: [{ from: '18:00', to: '09:00' }] } } }, { delay: 30, draftOnly: true });
    });
    await new Promise((r) => setTimeout(r, 80));
    expect(sent).toHaveLength(0);
    expect(result.current.live.business_hours).toEqual({ enabled: true, timezone: 'UTC', weekly: { mon: [{ from: '18:00', to: '09:00' }] } });
  });

  it('a waiting save dropped by a draft-only change does not leave "Saving…" behind', async () => {
    const { result } = mount();
    expect(result.current.status).toBe('idle');
    // A valid hour, then an invalid one (an <input type="time"> typed digit by digit).
    act(() => { result.current.setFields({ business_hours: { a: 1 } } as unknown as Partial<WidgetSettings>, { delay: 50 }); });
    expect(result.current.status).toBe('saving');
    act(() => { result.current.setFields({ business_hours: { a: 2 } } as unknown as Partial<WidgetSettings>, { delay: 50, draftOnly: true }); });
    await new Promise((r) => setTimeout(r, 120));
    expect(sent).toHaveLength(0);
    expect(result.current.status).toBe('idle');
    // After a save, it goes back to "All changes saved".
    act(() => { result.current.setField('brand_name', 'Acme Store', 0); });
    await waitFor(() => expect(result.current.status).toBe('saved'));
    act(() => { result.current.setFields({ business_hours: { a: 3 } } as unknown as Partial<WidgetSettings>, { delay: 50 }); });
    act(() => { result.current.setFields({ business_hours: { a: 4 } } as unknown as Partial<WidgetSettings>, { delay: 50, draftOnly: true }); });
    await new Promise((r) => setTimeout(r, 120));
    expect(result.current.status).toBe('saved');
  });

  it('a draft-only change of one field keeps "Saving…" while another still waits', async () => {
    const { result } = mount();
    act(() => { result.current.setField('brand_name', 'Acme Store', 60); });
    act(() => { result.current.setFields({ business_hours: { a: 1 } } as unknown as Partial<WidgetSettings>, { delay: 60, draftOnly: true }); });
    expect(result.current.status).toBe('saving');
    await waitFor(() => expect(result.current.status).toBe('saved'));
    expect(sent.map((x) => x.body)).toEqual([{ brand_name: 'Acme Store' }]);
  });

  it('a small PATCH is a keepalive request', async () => {
    const { result } = mount();
    act(() => { result.current.setField('brand_name', 'X', 0); });
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].keepalive).toBe(true);
  });
});

describe('a save that does not go through', () => {
  it('too long: the toast names the field, the status reads "Not saved", the field shows the stored value again', async () => {
    answers = [{ status: 400, body: { error: 'Invalid input', issues: [{ path: 'brand_name', message: 'too_big' }] } }];
    const { result } = mount();
    act(() => { result.current.setField('brand_name', 'x'.repeat(250), 0); });
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.live.brand_name).toBe('Acme');
    const message = S.errorInvalidField.replace('{{field}}', en.widgetPage.appearance.brandName);
    expect(result.current.errorMessage).toBe(message);
    expect(toastMock).toHaveBeenCalledWith({ title: S.failedTitle, description: message, variant: 'destructive' });
  });

  it('a newer edit made meanwhile is kept when the older save is refused', async () => {
    let release: (v: Response) => void = () => {};
    fetchMock.mockImplementationOnce((_url: string, init?: RequestInit) => {
      sent.push({ body: JSON.parse(String(init?.body || '{}')) });
      return new Promise<Response>((r) => { release = r; });
    });
    const { result } = mount();
    act(() => { result.current.setField('welcome_message', 'first', 0); });
    await waitFor(() => expect(sent).toHaveLength(1));
    act(() => { result.current.setField('welcome_message', 'second', 1000); });
    await act(async () => { release(new Response(JSON.stringify({ error: 'plan_upgrade_required', denied: ['widget_welcome_message'] }), { status: 403 })); });
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.live.welcome_message).toBe('second');
    expect(result.current.errorMessage).toBe(S.errorPlan);
  });

  it.each([
    ['no network', 'network' as Answer, S.errorNetwork],
    ['an ended session', { status: 401, body: { error: 'unauthorized' } }, S.errorSession],
    ['the plan', { status: 403, body: { error: 'plan_upgrade_required' } }, S.errorPlan],
    ['no permission', { status: 403, body: { error: 'forbidden' } }, S.errorForbidden],
    ['a server failure', { status: 500, body: { error: 'boom' } }, S.errorGeneric],
  ])('%s: says so', async (_name, answer, message) => {
    answers = [answer];
    const { result } = mount();
    act(() => { result.current.saveNow({ chat_enabled: false }); });
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.errorMessage).toBe(message);
    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it('a later success clears the error', async () => {
    answers = [{ status: 500, body: { error: 'boom' } }];
    const { result } = mount();
    act(() => { result.current.saveNow({ chat_enabled: false }); });
    await waitFor(() => expect(result.current.status).toBe('error'));
    act(() => { result.current.saveNow({ chat_enabled: false }); });
    await waitFor(() => expect(result.current.status).toBe('saved'));
    expect(result.current.errorMessage).toBeNull();
  });
});

describe('leaving the page', () => {
  it('unmounting sends what still waits for its delay', async () => {
    const { result, unmount } = mount();
    act(() => { result.current.setField('welcome_message', 'Bye', 10_000); });
    expect(sent).toHaveLength(0);
    unmount();
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].body).toEqual({ welcome_message: 'Bye' });
  });

  it('pagehide sends it too, once', async () => {
    const { result } = mount();
    act(() => { result.current.setField('fab_label', 'Ask us', 10_000); });
    act(() => { window.dispatchEvent(new Event('pagehide')); });
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ body: { fab_label: 'Ask us' }, keepalive: true });
    await new Promise((r) => setTimeout(r, 30));
    expect(sent).toHaveLength(1);
  });
});
