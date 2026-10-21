/**
 * The operator's alerts, now mounted by the app shell instead of the Inbox
 * page: the chime follows who has the conversation, an assignment is
 * announced in the panel, and staff without an Inbox are not subscribed.
 *
 * Before: the subscription, the chime and the banner lived in InboxPage, so
 * an operator on the Visitors page heard nothing; the chime rang for every
 * visitor message in the workspace (a colleague's chats included); and an
 * assignment reached the phone only.
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const toastSpy = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: toastSpy }));

const shell = vi.hoisted(() => ({ role: 'agent' as string | null, subscribed: [] as Array<string | undefined> }));
vi.mock('@/hooks/useInboxListRealtime', () => ({
  useInboxListRealtime: (ws: string | undefined) => { shell.subscribed.push(ws); },
}));
vi.mock('@/hooks/useWorkspaceRole', () => ({
  useWorkspaceRole: () => ({ data: shell.role, isSuccess: true }),
}));
vi.mock('@/features/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 'me' } }) }));
vi.mock('@/hooks/useWorkspace', () => ({ useWorkspacePath: () => (p: string) => `/acme${p}` }));
vi.mock('@/i18n', () => ({ useTranslation: () => ({ t: (k: string) => k, dir: 'ltr', locale: 'en' }) }));

const { useOperatorMessageChime } = await import('@/features/notifications/operatorMessageSound');
const { useOperatorAssignmentAlerts, assignmentForViewer } = await import('@/features/notifications/operatorAssignmentAlert');
const { useOperatorInboxAlerts } = await import('@/features/notifications/useOperatorInboxAlerts');

/** A Web Audio stand-in that counts the notes the chime plays. */
let notes = 0;
class FakeAudioContext {
  state = 'running';
  currentTime = 0;
  destination = {};
  resume() { return Promise.resolve(); }
  createOscillator() {
    notes += 1;
    return { type: '', frequency: { setValueAtTime() {} }, connect: (g: unknown) => g, start() {}, stop() {} };
  }
  createGain() {
    return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (d: unknown) => d };
  }
}

let clock = 1_000_000;
function nextMoment() {
  clock += 5_000; // past the chime's throttle
  vi.spyOn(Date, 'now').mockReturnValue(clock);
}

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function message(conversationId: string, sender = 'contact') {
  window.dispatchEvent(new CustomEvent('inbox:new-message', {
    detail: { workspaceId: 'ws-1', conversation_id: conversationId, sender_type: sender, payload: {} },
  }));
}

async function settle() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

beforeEach(() => {
  notes = 0;
  toastSpy.mockReset();
  shell.subscribed = [];
  shell.role = 'agent';
  vi.stubGlobal('AudioContext', FakeAudioContext);
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the chime', () => {
  function Chime({ othersVisible = false }: { othersVisible?: boolean }) {
    useOperatorMessageChime('ws-1', { viewerId: 'me', othersVisible: () => othersVisible });
    return null;
  }
  function mount(qc: QueryClient, othersVisible = false) {
    qc.setQueryData(['conversations', 'ws-1', 'main'], [
      { id: 'c-mine', assigned_to: 'me' },
      { id: 'c-free', assigned_to: null },
      { id: 'c-colleague', assigned_to: 'colleague' },
    ]);
    render(<QueryClientProvider client={qc}><Chime othersVisible={othersVisible} /></QueryClientProvider>);
  }

  it('rings for my conversations and the unassigned, not for a colleague\'s', async () => {
    mount(client());
    nextMoment(); message('c-colleague'); await settle();
    expect(notes).toBe(0);
    nextMoment(); message('c-mine'); await settle();
    expect(notes).toBe(2); // two notes per chime
    nextMoment(); message('c-free'); await settle();
    expect(notes).toBe(4);
    nextMoment(); message('c-mine', 'agent'); await settle();
    expect(notes).toBe(4); // never an operator's own reply
  });

  it('rings for a colleague\'s too for a supervisor watching every conversation', async () => {
    mount(client(), true);
    nextMoment(); message('c-colleague'); await settle();
    expect(notes).toBe(2);
  });

  it('asks who has a conversation no list holds, rather than ringing for everyone', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ conversation: { id: 'c-elsewhere', assigned_to: 'colleague' } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));
    mount(client());
    nextMoment(); message('c-elsewhere'); await settle(); await settle();
    expect(notes).toBe(0);
  });

  it('honours the operator\'s "play a sound" and "which conversations"', async () => {
    const qc = client();
    mount(qc);
    const prefs = { disable_all: false, play_sound: false, push_scope: 'all', quiet_hours_enabled: false };
    qc.setQueryData(['notification-prefs'], { prefs });
    nextMoment(); message('c-mine'); await settle();
    expect(notes).toBe(0);
    qc.setQueryData(['notification-prefs'], { prefs: { ...prefs, play_sound: true, push_scope: 'none' } });
    nextMoment(); message('c-mine'); await settle();
    expect(notes).toBe(0);
  });
});

describe('"assigned to you"', () => {
  const opened: string[] = [];
  function Alerts() {
    useOperatorAssignmentAlerts({
      workspaceId: 'ws-1',
      viewerId: 'me',
      title: 'assigned-title',
      body: 'assigned-body',
      openLabel: 'open',
      onOpenConversation: (id) => opened.push(id),
    });
    return null;
  }
  const assign = (changes: Record<string, unknown>, actor: string | null = null) =>
    window.dispatchEvent(new CustomEvent('inbox:conversation-event', {
      detail: {
        workspaceId: 'ws-1',
        payload: { kind: 'conversation_updated', workspace_id: 'ws-1', conversation_id: 'c-1', actor_id: actor, changes },
      },
    }));

  beforeEach(() => { opened.length = 0; });

  it('rings and shows a toast that opens the conversation, when routing hands it to me', () => {
    const qc = client();
    render(<QueryClientProvider client={qc}><Alerts /></QueryClientProvider>);
    nextMoment();
    assign({ assigned_to: { from: null, to: 'me' } });
    expect(notes).toBe(2);
    expect(toastSpy).toHaveBeenCalledTimes(1);
    const [title, opts] = toastSpy.mock.calls[0];
    expect(title).toBe('assigned-title');
    expect(opts.description).toBe('assigned-body');
    opts.action.onClick();
    expect(opened).toEqual(['c-1']);
    // And the conversation is known to be mine from now on.
    expect(qc.getQueryData(['conversation-assignee', 'ws-1', 'c-1'])).toBe('me');
  });

  it('shows a browser notification instead while the tab is in the background', () => {
    const shown: Array<{ title: string; options: NotificationOptions }> = [];
    class FakeNotification {
      static permission = 'granted';
      onclick: (() => void) | null = null;
      constructor(title: string, options: NotificationOptions) { shown.push({ title, options }); }
      close() {}
    }
    vi.stubGlobal('Notification', FakeNotification);
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    render(<QueryClientProvider client={client()}><Alerts /></QueryClientProvider>);
    nextMoment();
    assign({ assigned_to: { from: 'colleague', to: 'me' } }, 'colleague');
    expect(shown).toHaveLength(1);
    expect(shown[0].title).toBe('assigned-title');
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it('says nothing about my own take-over, someone else\'s assignment, or with assignments switched off', () => {
    const qc = client();
    render(<QueryClientProvider client={qc}><Alerts /></QueryClientProvider>);
    nextMoment(); assign({ assigned_to: { from: null, to: 'me' } }, 'me');
    nextMoment(); assign({ assigned_to: { from: null, to: 'colleague' } });
    qc.setQueryData(['notification-prefs'], { prefs: { disable_all: false, push_assignments: false, quiet_hours_enabled: false } });
    nextMoment(); assign({ assigned_to: { from: null, to: 'me' } });
    expect(toastSpy).not.toHaveBeenCalled();
    expect(notes).toBe(0);
  });

  it('is only an assignment that moves the conversation to me', () => {
    const d = (payload: Record<string, unknown>) => ({ workspaceId: 'ws-1', payload: { conversation_id: 'c', ...payload } });
    expect(assignmentForViewer(d({ changes: { assigned_to: { from: null, to: 'me' } } }), 'me')).toBe('c');
    expect(assignmentForViewer(d({ changes: { assigned_to: { from: 'me', to: 'me' } } }), 'me')).toBeNull();
    expect(assignmentForViewer(d({ changes: { assigned_to: null } }), 'me')).toBeNull();
    expect(assignmentForViewer(d({ changes: { status: { to: 'open' } } }), 'me')).toBeNull();
    expect(assignmentForViewer(d({ changes: { assigned_to: { to: 'me' } } }), null)).toBeNull();
  });
});

describe('the app shell', () => {
  function Shell() {
    useOperatorInboxAlerts('ws-1');
    return null;
  }
  function mountShell() {
    const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify({ platform: 'web', prefs: {} }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    render(
      <MemoryRouter>
        <QueryClientProvider client={client()}><Shell /></QueryClientProvider>
      </MemoryRouter>,
    );
    return fetchMock;
  }

  it('subscribes a member of the chat team, and reads their notification settings once', async () => {
    shell.role = 'agent';
    const fetchMock = mountShell();
    await settle();
    expect(shell.subscribed.at(-1)).toBe('ws-1');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/notifications/prefs'))).toBe(true);
  });

  it('subscribes no staff member who has no Inbox', async () => {
    shell.role = 'analyst';
    const fetchMock = mountShell();
    await settle();
    expect(shell.subscribed.every((ws) => ws === undefined)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
