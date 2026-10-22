/**
 * Team & departments: who receives chats
 * (src/components/members/MemberChatRouting.tsx), over a stubbed
 * PATCH /api/workspace-members/:id/chat-routing:
 *
 *   - "Receive chats" sends receives_chats, and off greys the maximum out;
 *   - the maximum sends a whole number from 1 to 50, or null (empty = the
 *     workspace default, shown as the placeholder); anything else is refused
 *     before it is sent;
 *   - a refused save goes back to what the server has and says why, in the
 *     panel's language (never the server's code);
 *   - the note says who receives chats (owner and team members with the
 *     switch on, never staff), the department fallback as the platform has
 *     it, and that Manual gives nobody a chat.
 */
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider } from '@/i18n';
import fa from '@/i18n/locales/fa';

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: toastMock }));

const { MemberChatRoutingControls, ChatReceiversNote } = await import('@/components/members/MemberChatRouting');

type Row = { id: string; user_id: string; receives_chats: boolean; max_concurrent_chats: number | null };

let patches: Array<{ url: string; body: Record<string, unknown> }>;
let fail: string | null;
let failStatus: number;
let offline: boolean;
let stored: Row;

beforeEach(() => {
  patches = [];
  fail = null;
  failStatus = 400;
  offline = false;
  stored = { id: 'm-1', user_id: 'u-1', receives_chats: true, max_concurrent_chats: null };
  toastMock.success.mockReset();
  toastMock.error.mockReset();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    patches.push({ url: String(url), body });
    if (offline) throw new TypeError('Failed to fetch');
    if (fail) return new Response(JSON.stringify({ error: fail }), { status: failStatus });
    stored = { ...stored, ...body } as Row;
    return new Response(JSON.stringify({ ok: true, member: stored }), { status: 200 });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The page keeps the member list; a saved row replaces its fields. */
function Harness({ initial }: { initial: Row }) {
  const [row, setRow] = useState(initial);
  return (
    <MemberChatRoutingControls
      workspaceId="ws-1"
      memberId={row.id}
      name="Sara"
      receivesChats={row.receives_chats}
      maxConcurrentChats={row.max_concurrent_chats}
      defaultMax={5}
      onSaved={(saved) => setRow((r) => ({ ...r, ...saved }))}
    />
  );
}

async function mount(initial: Partial<Row> = {}) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <Harness initial={{ ...stored, ...initial }} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return {
    sw: (await screen.findByRole('switch', { name: 'Receive chats automatically — Sara' })) as HTMLButtonElement,
    max: screen.getByLabelText('Maximum open chats for Sara (empty: the default, 5)') as HTMLInputElement,
  };
}

function typeMax(input: HTMLInputElement, value: string) {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

describe('MemberChatRoutingControls', () => {
  it('"Receive chats" off is sent, and greys the maximum out', async () => {
    const { sw, max } = await mount();
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(max.placeholder).toBe('5');
    fireEvent.click(sw);
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0].url).toContain('/api/workspace-members/m-1/chat-routing?workspaceId=ws-1');
    expect(patches[0].body).toEqual({ receives_chats: false });
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('Chat routing updated'));
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(max.disabled).toBe(true);
  });

  it('the maximum: a number from 1 to 50, empty for the default; anything else is not sent', async () => {
    const { max } = await mount();
    typeMax(max, '8');
    await waitFor(() => expect(patches.at(-1)?.body).toEqual({ max_concurrent_chats: 8 }));
    await waitFor(() => expect(max.value).toBe('8'));

    typeMax(max, '');
    await waitFor(() => expect(patches.at(-1)?.body).toEqual({ max_concurrent_chats: null }));

    const sent = patches.length;
    typeMax(max, '51');
    expect(screen.getByRole('alert').textContent).toContain('from 1 to 50');
    typeMax(max, '2.5');
    typeMax(max, 'ten');
    expect(patches).toHaveLength(sent);
  });

  it('a refused save goes back to what the server has, and says why in the panel\'s language (never the server\'s code)', async () => {
    fail = 'member_not_found';
    const { sw, max } = await mount({ max_concurrent_chats: 3 });
    fireEvent.click(sw);
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('Could not save chat routing', { description: 'Something went wrong. Please try again.' }));
    expect(sw.getAttribute('aria-checked')).toBe('true');
    typeMax(max, '9');
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledTimes(2));
    expect(max.value).toBe('3');
  });

  it('a refusal for the role, an ended session or no connection is said as such', async () => {
    const { sw } = await mount();
    fail = 'forbidden_role';
    failStatus = 403;
    fireEvent.click(sw);
    await waitFor(() => expect(toastMock.error).toHaveBeenLastCalledWith('Could not save chat routing', { description: 'You do not have permission to change this.' }));
    failStatus = 401;
    fail = 'unauthorized';
    fireEvent.click(sw);
    await waitFor(() => expect(toastMock.error).toHaveBeenLastCalledWith('Could not save chat routing', { description: 'Your session has ended. Sign in again.' }));
    offline = true;
    fireEvent.click(sw);
    await waitFor(() => expect(toastMock.error).toHaveBeenLastCalledWith('Could not save chat routing', { description: 'No connection. Check your internet and try again.' }));
    for (const call of toastMock.error.mock.calls) expect(JSON.stringify(call)).not.toMatch(/forbidden_role|unauthorized|Failed to fetch|HTTP/);
  });
});

describe('ChatReceiversNote', () => {
  function note(props: Partial<Parameters<typeof ChatReceiversNote>[0]> = {}, locale?: 'fa') {
    render(
      <MemoryRouter>
        <I18nProvider {...(locale ? { initialLocale: locale, initialTranslations: fa } : {})}>
          <ChatReceiversNote generalPoolEnabled manual={false} defaultMax={5} behaviourPath="/acme/widget" {...props} />
        </I18nProvider>
      </MemoryRouter>,
    );
    return screen.findByText(locale ? 'چه کسی گفتگو دریافت می‌کند' : 'Who receives chats');
  }

  it('owner and team members with the switch on, never staff; then the whole team', async () => {
    await note();
    const text = document.querySelector('[data-chat-receivers-note]')!.textContent!;
    expect(text).toContain('the owner and the team members below who have “Receive chats” on');
    expect(text).toContain('(5 unless you set one for them)');
    expect(text).toContain('Staff (Staff access) never receive chats automatically');
    expect(text).toContain('then to the whole team if none of them is available');
    expect(document.querySelector('[data-chat-receivers-manual]')).toBeNull();
    expect(screen.getByRole('link', { name: 'Widget → Behaviour' }).getAttribute('href')).toBe('/acme/widget');
  });

  it('the general pool off, and Manual assignment, are said', async () => {
    await note({ generalPoolEnabled: false, manual: true });
    const text = document.querySelector('[data-chat-receivers-note]')!.textContent!;
    expect(text).toContain('goes only to its members and waits until one of them is available');
    expect(document.querySelector('[data-chat-receivers-manual]')!.textContent).toContain('nobody is given chats automatically');
  });

  it('in Persian: the shared terms', async () => {
    await note({}, 'fa');
    const text = document.querySelector('[data-chat-receivers-note]')!.textContent!;
    expect(text).toContain('دپارتمان');
    expect(text).not.toMatch(/مکالمه|چت|استخر عمومی/);
  });
});
