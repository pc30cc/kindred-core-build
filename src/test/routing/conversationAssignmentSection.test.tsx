/**
 * Widget → Behaviour → Conversation assignment
 * (src/components/app/widget/ConversationAssignmentSection.tsx), over a
 * stubbed GET /api/workspace-departments/:id/routing-policy:
 *
 *   - each mode says what it does (auto: fewest open conversations now;
 *     round robin: turns per department; manual: Unassigned and the queue),
 *     with the department fallback as the platform has it;
 *   - a plan without automatic routing shows Manual, locked, everything
 *     greyed out (the server routes it as manual too);
 *   - the returning-visitor switch and its window, the default maximum and
 *     the first-response timeout save valid whole numbers only (Persian
 *     digits too), on blur or Enter;
 *   - the Super Admin's platform switch greys the returning-visitor switch
 *     out and says why;
 *   - in Manual the timeout is off and the returning-visitor hint says what
 *     it still decides (a reopened conversation);
 *   - a refused save is undone and said.
 */
import { useState } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@/i18n';
import fa from '@/i18n/locales/fa';

const toastMock = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/use-toast', () => ({ toast: toastMock, useToast: () => ({ toasts: [], toast: toastMock }) }));

const { ConversationAssignmentSection } = await import('@/components/app/widget/ConversationAssignmentSection');

beforeAll(() => {
  window.HTMLElement.prototype.hasPointerCapture ??= () => false;
  window.HTMLElement.prototype.releasePointerCapture ??= () => undefined;
  window.HTMLElement.prototype.scrollIntoView ??= () => undefined;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
});

let policy: Record<string, boolean>;
beforeEach(() => {
  policy = { general_pool_enabled: true, last_agent_routing_enabled: true, owner_fallback_for_chat: true };
  toastMock.mockReset();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('/routing-policy')) return new Response(JSON.stringify({ policy }), { status: 200 });
    return new Response('{}', { status: 404 });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const SETTINGS = {
  assignment_mode: 'auto' as const,
  last_agent_routing_enabled: true,
  last_agent_window_days: 30,
  default_max_concurrent_chats: 5,
  first_response_timeout_minutes: 5,
};

type Props = Parameters<typeof ConversationAssignmentSection>[0];

/**
 * The page's part: settings the server stores and hands back, as WidgetPage
 * does (its save resolves once the settings are refetched).
 */
function Harness({ initial, onSave, ...rest }: Omit<Props, 'settings' | 'onSave'> & {
  initial: Props['settings'];
  onSave: (patch: Record<string, unknown>) => Promise<unknown>;
}) {
  const [settings, setSettings] = useState(initial);
  return (
    <ConversationAssignmentSection
      {...rest}
      settings={settings}
      onSave={async (patch) => {
        await onSave(patch);
        setSettings((cur) => ({ ...cur, ...patch }));
      }}
    />
  );
}

async function mount(props: Partial<Props> = {}, locale?: 'fa') {
  const onSave = (props.onSave ?? vi.fn(async () => undefined)) as ReturnType<typeof vi.fn>;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider {...(locale ? { initialLocale: locale, initialTranslations: fa } : {})}>
        <Harness
          workspaceId="ws-1"
          planAllowsRouting={props.planAllowsRouting ?? true}
          initial={props.settings ?? SETTINGS}
          onSave={onSave}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
  // The provider renders once its locale is loaded.
  await screen.findByRole('combobox');
  return onSave;
}

const help = () => document.querySelector('[data-assignment-help]') as HTMLElement;
const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

describe('ConversationAssignmentSection', () => {
  it('Auto: what it does, the department fallback, who counts as available and what happens with nobody', async () => {
    await mount();
    expect(help().getAttribute('data-assignment-help')).toBe('auto');
    expect(help().textContent).toContain('fewest open conversations right now');
    await waitFor(() => expect(help().textContent).toContain('its operators come first, then the whole team'));
    expect(help().textContent).toContain('idle for less than 30 minutes');
    expect(help().textContent).toContain('chose Away from desk gets no new chats');
    expect(help().textContent).toContain('waits in Unassigned');
    // The promise the old hint made is gone: routing now runs with the AI off too.
    expect(screen.getByText(/at the visitor's first message when the AI is off/)).toBeTruthy();
    expect(screen.getByText(/staff never do/)).toBeTruthy();
  });

  it('the platform\'s general pool off: a department\'s chats stay with it', async () => {
    policy.general_pool_enabled = false;
    await mount();
    await waitFor(() => expect(help().textContent).toContain('only its operators receive the conversation'));
  });

  it('picking Round robin saves it and explains turns per department', async () => {
    const onSave = await mount();
    fireEvent.click(screen.getByRole('combobox'));
    const listbox = await screen.findByRole('listbox');
    fireEvent.click(within(listbox).getByText('Round robin — available operators take turns'));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ assignment_mode: 'round_robin' }));
    expect(help().getAttribute('data-assignment-help')).toBe('round_robin');
    expect(help().textContent).toContain('separate rotation for each department');
  });

  it('a plan without automatic routing: Manual, locked, nothing editable', async () => {
    await mount({ planAllowsRouting: false });
    const select = screen.getByRole('combobox') as HTMLButtonElement;
    expect(select.disabled).toBe(true);
    expect(select.textContent).toContain('Manual');
    expect(document.querySelector('[data-assignment-locked]')).not.toBeNull();
    expect(help().getAttribute('data-assignment-help')).toBe('manual');
    expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(true);
    expect(field('Maximum open conversations per operator').disabled).toBe(true);
    expect(field('First-response timeout').disabled).toBe(true);
    expect(field('Look back').disabled).toBe(true);
  });

  it('Manual: the timeout does not apply; the returning-visitor switch only decides a reopened conversation', async () => {
    await mount({ settings: { ...SETTINGS, assignment_mode: 'manual' } });
    expect(help().textContent).toContain('Nobody is assigned automatically');
    expect(field('First-response timeout').disabled).toBe(true);
    expect(screen.getByText(/Only for conversations assigned automatically/)).toBeTruthy();
    expect(screen.getByText(/In Manual mode this only decides whether a resolved conversation/)).toBeTruthy();
    expect(field('Maximum open conversations per operator').disabled).toBe(false);
  });

  it('numbers save on blur or Enter, only whole numbers within range', async () => {
    const onSave = await mount();
    const cap = field('Maximum open conversations per operator');
    fireEvent.focus(cap);
    fireEvent.change(cap, { target: { value: '8' } });
    fireEvent.blur(cap);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ default_max_concurrent_chats: 8 }));

    onSave.mockClear();
    fireEvent.focus(cap);
    fireEvent.change(cap, { target: { value: '0' } });
    fireEvent.blur(cap);
    expect(screen.getByRole('alert').textContent).toBe('Enter a whole number from 1 to 50.');
    expect(onSave).not.toHaveBeenCalled();

    const timeout = field('First-response timeout');
    fireEvent.focus(timeout);
    fireEvent.change(timeout, { target: { value: '0' } });
    fireEvent.keyDown(timeout, { key: 'Enter' });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ first_response_timeout_minutes: 0 }));

    const days = field('Look back');
    fireEvent.focus(days);
    fireEvent.change(days, { target: { value: '400' } });
    fireEvent.blur(days);
    expect(screen.getAllByRole('alert').some((a) => a.textContent === 'Enter a whole number from 1 to 365.')).toBe(true);
    expect(onSave).not.toHaveBeenCalledWith({ last_agent_window_days: 400 });

    // An unchanged value saves nothing.
    onSave.mockClear();
    fireEvent.focus(days);
    fireEvent.change(days, { target: { value: '30' } });
    fireEvent.blur(days);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('Persian digits count, and the Persian copy uses the shared terms', async () => {
    const onSave = await mount({}, 'fa');
    const cap = await screen.findByLabelText('حداکثر گفتگوی باز هر اپراتور') as HTMLInputElement;
    fireEvent.focus(cap);
    fireEvent.change(cap, { target: { value: '۱۲' } });
    fireEvent.blur(cap);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ default_max_concurrent_chats: 12 }));
    expect(help().textContent).toContain('«بدون تخصیص»');
    expect(help().textContent).not.toMatch(/مکالمه|چت/);
  });

  it('the returning-visitor switch saves; off greys its window out', async () => {
    const onSave = await mount({ settings: { ...SETTINGS, last_agent_routing_enabled: false } });
    const sw = screen.getByRole('switch') as HTMLButtonElement;
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(field('Look back').disabled).toBe(true);
    fireEvent.click(sw);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ last_agent_routing_enabled: true }));
  });

  it('the Super Admin turned returning visitors off for every workspace: off, locked, and said', async () => {
    policy.last_agent_routing_enabled = false;
    await mount();
    await screen.findByText('Turned off for every workspace by the platform administrator.');
    const sw = screen.getByRole('switch') as HTMLButtonElement;
    expect(sw.disabled).toBe(true);
    expect(sw.getAttribute('aria-checked')).toBe('false');
  });

  it('a refused save is undone and said', async () => {
    const onSave = vi.fn(async () => { throw new Error('plan_feature_denied'); });
    await mount({ onSave });
    const sw = screen.getByRole('switch') as HTMLButtonElement;
    expect(sw.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(sw);
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
      title: 'The change was not saved',
      description: 'plan_feature_denied',
      variant: 'destructive',
    })));
    expect(sw.getAttribute('aria-checked')).toBe('true');
  });
});
