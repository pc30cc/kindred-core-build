/**
 * Widget → Behaviour → Conversation assignment saves through the page's save
 * layer (useWidgetSettingsDraft.saveNow), like every other control there:
 *
 *   - a refused value is said once, by the page's toast, naming the field
 *     (not a second toast of the section's own), the save status reads
 *     "Not saved", and the field shows the stored value again;
 *   - a saved one reads "saved", with no toast;
 *   - saveNow tells its caller which of the two happened (true / false) and
 *     never rejects.
 *
 * The real hooks and the real section, against a stubbed fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@/i18n';
import en from '@/i18n/locales/en';
import type { WidgetSettings } from '@/types/models';

const toastMock = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/use-toast', () => ({ toast: toastMock, useToast: () => ({ toasts: [], toast: toastMock }) }));
vi.mock('@/hooks/useChatRouting', () => ({
  useChatRoutingPolicy: () => ({
    data: { general_pool_enabled: true, last_agent_routing_enabled: true, owner_fallback_for_chat: true },
  }),
}));

const { useWidgetSettingsDraft } = await import('@/hooks/useWidgetSettingsDraft');
const { ConversationAssignmentSection } = await import('@/components/app/widget/ConversationAssignmentSection');

type Answer = { status: number; body: unknown };
let answers: Answer[];
const sent: Array<Record<string, unknown>> = [];
const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
  sent.push(JSON.parse(String(init?.body || '{}')));
  const next = answers.shift() ?? { status: 200, body: { settings: {} } };
  return new Response(JSON.stringify(next.body), { status: next.status });
});

const stored = {
  assignment_mode: 'auto',
  last_agent_routing_enabled: true,
  last_agent_window_days: 30,
  default_max_concurrent_chats: 5,
  first_response_timeout_minutes: 5,
} as unknown as WidgetSettings;

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en" initialTranslations={en}>{children}</I18nProvider>
    </QueryClientProvider>
  );
}

function Page() {
  const draft = useWidgetSettingsDraft('ws-1', stored);
  return (
    <>
      <ConversationAssignmentSection
        workspaceId="ws-1"
        settings={draft.live}
        planAllowsRouting
        onSave={(patch) => draft.saveNow(patch)}
      />
      <span data-testid="status">{draft.status}</span>
    </>
  );
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

describe('Conversation assignment over the save layer', () => {
  it('a refused capacity: one toast naming the field, "Not saved", the stored value back', async () => {
    answers = [{
      status: 400,
      body: { error: 'Invalid input', issues: [{ path: 'default_max_concurrent_chats', message: 'Too big' }] },
    }];
    render(<Page />, { wrapper });
    const input = screen.getByLabelText(en.widgetPage.behavior.assignment.capacity) as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '8' } });
    fireEvent.blur(input);

    await waitFor(() => expect(sent).toEqual([{ default_max_concurrent_chats: 8 }]));
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('error'));
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
      title: en.widgetPage.save.failedTitle,
      description: en.widgetPage.save.errorInvalidField.replace('{{field}}', en.widgetPage.behavior.assignment.capacity),
    }));
    await waitFor(() => expect(input.value).toBe('5'));
  });

  it('a refused inactivity close names its field, and the field shows the default it follows again', async () => {
    answers = [{
      status: 400,
      body: { error: 'Invalid input', issues: [{ path: 'inactivity_close_hours', message: 'Too big' }] },
    }];
    render(<Page />, { wrapper });
    const input = screen.getByLabelText(en.widgetPage.behavior.assignment.inactivityClose) as HTMLInputElement;
    expect(input.value).toBe('24');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '12' } });
    fireEvent.blur(input);

    await waitFor(() => expect(sent).toEqual([{ inactivity_close_hours: 12 }]));
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('error'));
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
      description: en.widgetPage.save.errorInvalidField.replace('{{field}}', en.widgetPage.behavior.assignment.inactivityClose),
    }));
    await waitFor(() => expect(input.value).toBe('24'));
  });

  it('a saved switch: "saved", no toast', async () => {
    render(<Page />, { wrapper });
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(sent).toEqual([{ last_agent_routing_enabled: false }]));
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('saved'));
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('saveNow resolves true when saved and false when refused, never rejecting', async () => {
    answers = [{ status: 200, body: { settings: {} } }, { status: 403, body: { error: 'plan_upgrade_required' } }];
    const { result } = renderHook(() => useWidgetSettingsDraft('ws-1', stored), { wrapper });
    let saved: boolean | undefined;
    let refused: boolean | undefined;
    await act(async () => { saved = await result.current.saveNow({ assignment_mode: 'round_robin' }); });
    await act(async () => { refused = await result.current.saveNow({ assignment_mode: 'manual' }); });
    expect(saved).toBe(true);
    expect(refused).toBe(false);
    expect(toastMock).toHaveBeenCalledTimes(1);
  });
});
