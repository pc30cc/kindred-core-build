/**
 * One current conversation per visitor (owner, 2026-10-23/24), with the
 * SHIPPED runtime.js, runtime-ext.js and runtime-late.js and the real t1
 * renderer and extras, or a bare renderer (default's, with only a past bar
 * of its own) for Core alone (coreFeaturesHarness.ts).
 *
 * The mode is the renderer's: Core runs it for a renderer that draws a past
 * bar (`pastBarHtml`), never by a feature flag; default keeps the old model.
 *  - The current conversation, first of: one this tab started that the list
 *    does not know yet; the newest live one (open, pending, resolved: a
 *    resolve ends nothing for the visitor); the newest closed one with an
 *    unseen answer (`unreadReplies`, else `unreadCount`); the closed one this
 *    tab showed as current, for 30 minutes after max(it ended, first shown).
 *    Else a fresh thread, armed from the start (force_new_conversation), and
 *    never the server's latest one adopted (/identity/history).
 *  - Every chat door lands on it; history is everything else the visitor
 *    wrote in, a closed one read-only (the composer, sends, quotes, files
 *    refused) with the transport left on the current one.
 *  - A fresh thread nobody wrote in takes a live conversation the server
 *    names (/poll, an answer's frame, the intro preview), never a closed one.
 *  - The AI greeting is a preview (no row) the first message carries; a
 *    `continued` answer brings the live conversation's history in.
 *  - gs_active and the badge: live ones, and closed ones' unseen answers.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  boot, click, flush, key, resetWindow, typeInto, type ApiAnswer, type BootOptions, type ConversationSeed, type Harness,
  type RendererFactory,
} from './coreFeaturesHarness';

type Row = Record<string, unknown>;

beforeEach(() => {
  vi.useRealTimers();
  resetWindow();
  document.cookie = 'gs_active=; path=/; max-age=0';
  try { localStorage.clear(); } catch { /* jsdom */ }
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const agent = (id: string, cid: string, text = 'سلام، بفرمایید', min = 1): Row =>
  ({ id, role: 'agent', sender_type: 'agent', sender_name: 'سارا', text, time: ago(min), conversation_id: cid });
const visitor = (id: string, cid: string, text = 'یک سؤال', min = 2): Row =>
  ({ id, role: 'visitor', sender_type: 'contact', text, time: ago(min), conversation_id: cid });
const threadOf = (cid: string) => [visitor(cid + '-v', cid, 'سؤال در ' + cid), agent(cid + '-a', cid, 'پاسخ در ' + cid)];

/** Default's renderer drawing only a past bar of its own: Core's rules alone. */
const BARE: RendererFactory = () => ({
  pastBarHtml: (vm: unknown) => {
    const v = (vm || {}) as { current?: boolean; online?: boolean };
    return '<div class="bare-past" data-past-bar><p>read only</p><button type="button" data-chat-current>' +
      (v.current ? 'current' : v.online ? 'start' : 'leave') + '</button></div>';
  },
});
/** The bare renderer with home topics (runtime-ext.js's startConversationWith: the visitor's own words). */
const BARE_TOPICS: RendererFactory = (base, env) => ({
  ...BARE(base, env),
  features: { topics: true },
  homeHtml: (vm: unknown) => base.homeHtml(vm) + '<button type="button" data-topic="پیگیری سفارش">پیگیری سفارش</button>',
});
const RENDERERS = { t1: 't1', bare: BARE, topics: BARE_TOPICS } as const;
type Which = keyof typeof RENDERERS;

function start(which: Which, opts: BootOptions = {}): Harness {
  const history: Record<string, Row[]> = {};
  for (const c of opts.conversations || []) history[c.id] = threadOf(c.id);
  return boot({ renderer: RENDERERS[which], ...opts, history: { ...history, ...(opts.history || {}) } });
}
const cid = (h: Harness) => h.runtime.__test.chatState().conversationId as string | null;
const msgs = (h: Harness) => h.runtime.__test.chatState().messages as Row[];
const view = (h: Harness) => h.panel.getAttribute('data-view');
const sends = (h: Harness) => h.posts.filter((p) => p.url === 'chat:sendMessage').map((p) => p.body);
const homeVm = (h: Harness) => h.lastCall('homeHtml')![0] as Row;
const listVm = (h: Harness) => h.lastCall('conversationListHtml')![0] as Row;
const ids = (rows: unknown) => (rows as Row[]).map((c) => c.id);
/** Read markers POSTed for `id` (an earlier test's runtime may still post its own through the shared fetch). */
const reads = (h: Harness, id: string) => h.fetches.filter((u) => u.includes('/conversations/' + id + '/read')).length;
const active = () => /(^|;\s*)gs_active=1/.test(document.cookie);
const pastBar = (h: Harness) => h.q('[data-past-bar]');
const composerShown = (h: Harness) => h.q<HTMLElement>('[data-input-bar]')!.style.display !== 'none';
function write(h: Harness, text: string) {
  const input = h.q<HTMLTextAreaElement>('[data-msg-input]')!;
  typeInto(input, text);
  key(input, 'Enter');
}
async function online(h: Harness) { h.runtime.__test.setConnectionState('online'); await flush(5); }
/** The per-tab view hint a previous page of this tab left. */
function seedHint(hint: Row) { sessionStorage.setItem('gs:view:ws-test', JSON.stringify(hint)); }
const hint = () => JSON.parse(sessionStorage.getItem('gs:view:ws-test') || 'null') as Row | null;

// First in this file: the cookie is the page's, and a runtime of a later test
// would still write it when its own timers run.
describe('gs_active and the badge (live: open, pending, resolved; closed: its unseen answers)', () => {
  it('a resolved conversation keeps the runtime booting on the next page', async () => {
    start('bare', { open: false, conversations: [{ id: 'c1', status: 'resolved' }] });
    await flush(40);
    expect(active()).toBe(true);
  });

  it('a closed one: only its answers count, and reading them clears the hint', async () => {
    const h = start('bare', { open: false, conversations: [{ id: 'c1', status: 'closed', unreadCount: 3, unreadReplies: 0 }] });
    await flush(40);
    expect(active()).toBe(false);
    expect(h.unread.filter((n) => n > 0)).toEqual([]);

    resetWindow();
    const h2 = start('bare', { open: false, conversations: [{ id: 'c1', status: 'closed', unreadCount: 3, unreadReplies: 1 }] });
    await flush(40);
    expect(active()).toBe(true);
    expect(h2.unread[h2.unread.length - 1]).toBe(1);
    h2.runtime.open();
    await flush(20);
    expect(reads(h2, 'c1')).toBe(1);
    expect(active()).toBe(false);
  });
});

describe('the current conversation (rules 1-3), for t1 and a bare renderer', () => {
  for (const which of ['t1', 'bare'] as const) {
    it(`${which}: the newest live one, a resolved one too (a resolve ends nothing for the visitor)`, async () => {
      const h = start(which, { conversations: [{ id: 'c-res', status: 'resolved' }, { id: 'c-old', status: 'closed' }] });
      await flush(40);
      // A new tab lands in it, its own history read, never the server's latest one.
      expect(cid(h)).toBe('c-res');
      expect(view(h)).toBe('chat');
      expect(h.historyReads).toEqual(['c-res']);
      expect(pastBar(h)).toBeNull();
      h.runtime.setTab('home');
      await flush(10);
      expect(ids(homeVm(h).conversations)).toEqual(['c-res']);
      expect(homeVm(h).pastCount).toBe(1);
    });

    it(`${which}: a closed one with an unseen answer is current; one whose unread rows are only notices is not`, async () => {
      const h = start(which, {
        open: false,
        conversations: [{ id: 'c1', status: 'closed', unreadCount: 2, unreadReplies: 1 }, { id: 'c2', status: 'closed', unreadCount: 3, unreadReplies: 0 }],
      });
      await flush(40);
      expect(cid(h)).toBe('c1');
      // Behind a closed panel the read marker waits for the visitor.
      expect(reads(h, 'c1')).toBe(0);
      h.runtime.open();
      await flush(10);
      expect(reads(h, 'c1')).toBe(1);

      resetWindow();
      const h2 = start(which, { conversations: [{ id: 'c2', status: 'closed', unreadCount: 3, unreadReplies: 0 }] });
      await flush(40);
      expect(cid(h2)).toBeNull();
      expect(h2.runtime.__test.chatState().freshIntent).toBe(true);
    });
  }

  it('an older backend (no unreadReplies): the unread count stands for the answers', async () => {
    const h = start('bare', { open: false, conversations: [{ id: 'c1', status: 'closed', unreadCount: 1 }] });
    await flush(40);
    expect(cid(h)).toBe('c1');
  });

  it('rule 3: this tab\'s closed one stays current for 30 minutes after max(it ended, first shown here)', async () => {
    const recent = { tab: 'home', conversationId: null, held: 'c1', heldAt: Date.now() - 10 * 60_000 };
    const ended2h = { id: 'c1', status: 'closed', endedAt: ago(120) };
    seedHint(recent);
    let h = start('t1', { conversations: [ended2h] });
    await flush(40);
    expect(ids(homeVm(h).conversations)).toEqual(['c1']);

    // First shown 40 minutes ago, ended 2 hours ago: over.
    resetWindow();
    seedHint({ ...recent, heldAt: Date.now() - 40 * 60_000 });
    h = start('t1', { conversations: [ended2h] });
    await flush(40);
    expect(homeVm(h).conversations).toEqual([]);

    // Shown long ago, ended 10 minutes ago (closed while watched): still current.
    resetWindow();
    seedHint({ ...recent, heldAt: Date.now() - 120 * 60_000 });
    h = start('t1', { conversations: [{ id: 'c1', status: 'closed', endedAt: ago(10) }] });
    await flush(40);
    expect(ids(homeVm(h).conversations)).toEqual(['c1']);

    // Only this tab's: another conversation id held proves nothing.
    resetWindow();
    seedHint({ ...recent, held: 'c9' });
    h = start('t1', { conversations: [{ id: 'c1', status: 'closed', endedAt: ago(10) }] });
    await flush(40);
    expect(homeVm(h).conversations).toEqual([]);
  });

  it('rule 3: the time it was first shown is written once, then the grace runs out', async () => {
    const h = start('t1', { conversations: [{ id: 'c1', status: 'closed', unreadReplies: 1, unreadCount: 1, endedAt: ago(120) }] });
    await flush(40);
    expect(cid(h)).toBe('c1');
    const shown = hint()!.heldAt as number;
    expect(hint()!.held).toBe('c1');
    expect(Date.now() - shown).toBeLessThan(5000);
    // Read now (rule 2 no longer), repainted, the tab moved around: same anchor.
    h.runtime.setTab('home');
    await flush(10);
    h.runtime.setTab('chat');
    await flush(10);
    expect(hint()!.heldAt).toBe(shown);
    h.runtime.setTab('home');
    await flush(10);
    expect(ids(homeVm(h).conversations)).toEqual(['c1']);
    // 31 minutes on: a fresh thread is next.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 31 * 60_000 });
    h.runtime.setTab('help');
    h.runtime.setTab('home');
    expect(homeVm(h).conversations).toEqual([]);
    vi.useRealTimers();
  });
});

describe('every door lands on the current conversation', () => {
  const LIVE: ConversationSeed[] = [{ id: 'c-live', status: 'open' }, { id: 'c-past', status: 'closed' }];
  /** On home (a hint that names it), the current one taken behind it. */
  async function onHome(opts: BootOptions = {}) {
    seedHint({ tab: 'home', conversationId: null });
    const h = start('t1', { conversations: LIVE, ...opts });
    await flush(40);
    expect(view(h)).toBe('home');
    return h;
  }

  it('t1: the home card, the bar\'s chat tab, setTab(\'chat\'), help\'s chat door and the past bar', async () => {
    const h = await onHome();
    // Taken behind home, its frames and toasts reach this tab.
    expect(cid(h)).toBe('c-live');
    click(h.q('[data-body] [data-conversation-open="c-live"]'));
    await flush(10);
    expect([view(h), cid(h)]).toEqual(['chat', 'c-live']);

    h.runtime.setTab('home');
    await flush(10);
    click(h.q('.wy-tab[data-view="chat"]'));
    await flush(10);
    expect([view(h), cid(h)]).toEqual(['chat', 'c-live']);

    h.runtime.setTab('home');
    await flush(10);
    h.runtime.setTab('chat');
    await flush(10);
    expect([view(h), cid(h)]).toEqual(['chat', 'c-live']);

    // Help (no articles yet): its "chat with us".
    h.runtime.setTab('help');
    await flush(20);
    click(h.q('[data-kb-action="switch-chat"]'));
    await flush(10);
    expect([view(h), cid(h)]).toEqual(['chat', 'c-live']);

    // From a past one, its bar.
    h.runtime.setTab('list');
    await flush(10);
    click(h.q('[data-conversation-open="c-past"]'));
    await flush(10);
    expect(cid(h)).toBe('c-past');
    click(h.q('[data-past-bar] [data-chat-current]'));
    await flush(10);
    expect([view(h), cid(h)]).toEqual(['chat', 'c-live']);
    expect(pastBar(h)).toBeNull();
    // Never a second, parallel conversation.
    expect(sends(h)).toEqual([]);
  });

  it('bare: home\'s chat action, the list\'s, setTab(\'chat\')', async () => {
    seedHint({ tab: 'home', conversationId: null });
    const h = start('bare', { conversations: LIVE });
    await flush(40);
    for (const door of [() => click(h.q('[data-body] [data-home-action="chat"]')), () => h.runtime.setTab('chat')]) {
      h.runtime.setTab('home');
      await flush(10);
      door();
      await flush(10);
      expect([view(h), cid(h)]).toEqual(['chat', 'c-live']);
    }
    h.runtime.setTab('list');
    await flush(10);
    click(h.q('[data-body] [data-home-action="chat"]'));
    await flush(10);
    expect([view(h), cid(h)]).toEqual(['chat', 'c-live']);
  });

  it('a topic on home (the visitor\'s own words) goes into the current conversation, once its history is in', async () => {
    seedHint({ tab: 'home', conversationId: null });
    const h = start('topics', { asyncHistory: true, conversations: [{ id: 'c-live', status: 'open' }, { id: 'c-past', status: 'closed' }] });
    await flush(40);
    await online(h);
    // A past one read first, so the current one's history is loaded again.
    h.runtime.setTab('list');
    await flush(10);
    click(h.q('[data-conversation-open="c-past"]'));
    await flush(10);
    h.runtime.setTab('home');
    await flush(10);
    click(h.q('[data-body] [data-topic]'));
    await flush(20);
    expect([view(h), cid(h)]).toEqual(['chat', 'c-live']);
    expect(sends(h)).toHaveLength(1);
    expect(sends(h)[0]).toMatchObject({ conversationId: 'c-live', forceNewConversation: false, text: 'پیگیری سفارش' });
    // After the thread's own lines, never above them.
    expect(msgs(h).map((m) => m.sender)).toEqual(['visitor', 'operator', 'visitor']);
  });

  it('with nothing current, a topic opens a fresh thread: force_new, and no AI greeting ahead of it', async () => {
    const h = start('topics', {
      conversations: [{ id: 'c-past', status: 'closed' }],
      config: { aiAgent: { visitorFacing: true, providerReady: true, introCapable: true, introEnabled: true, suppressGreeting: true } },
    });
    await flush(40);
    await online(h);
    click(h.q('[data-body] [data-topic]'));
    await flush(20);
    expect(view(h)).toBe('chat');
    expect(sends(h)[0]).toMatchObject({ conversationId: null, forceNewConversation: true, text: 'پیگیری سفارش' });
    expect(h.fetches.filter((u) => u.includes('/ai-agent/intro'))).toEqual([]);
  });

  it('setTab(\'chat\') before the list is in waits for it, then opens the current one (not a fresh thread)', async () => {
    const h = start('bare', { holdConversations: true, conversations: [{ id: 'c-live', status: 'open' }], open: false });
    await flush(10);
    h.runtime.setTab('chat');
    await flush(10);
    expect(cid(h)).toBeNull();
    expect(h.runtime.__test.chatState().freshIntent).toBe(false);
    h.releaseConversations();
    await flush(30);
    expect([view(h), cid(h)]).toEqual(['chat', 'c-live']);
  });

  it('Smart: a live conversation keeps a chat_message away; with only history it opens a fresh thread', async () => {
    const surface = { id: 'r1', mode: 'chat_message', body: 'سلام! سؤالی دارید؟' };
    const showSmart = (h: Harness) => h.runtime.showSmart(surface);
    const live = start('bare', { conversations: [{ id: 'c-live', status: 'resolved' }] });
    await flush(40);
    expect(showSmart(live)).toBe(false);

    resetWindow();
    const past = start('bare', { conversations: [{ id: 'c-past', status: 'closed' }] });
    await flush(40);
    expect(showSmart(past)).toBe(true);
    await flush(10);
    expect(view(past)).toBe('chat');
    expect(cid(past)).toBeNull();
    expect(past.runtime.__test.chatState().freshIntent).toBe(true);
  });
});

describe('history', () => {
  it('everything but the current one and the conversations the visitor never wrote in; an older live one opens writable', async () => {
    seedHint({ tab: 'home', conversationId: null });
    const h = start('t1', {
      conversations: [
        { id: 'c-live', status: 'open' },
        { id: 'c-older', status: 'pending' },
        { id: 'c-closed', status: 'closed' },
        { id: 'c-greeting', status: 'closed', hasVisitorMessage: false },
      ],
    });
    await flush(40);
    expect(homeVm(h).pastCount).toBe(2);
    click(h.q('[data-body] .more[data-view="list"]'));
    await flush(10);
    expect(view(h)).toBe('list');
    expect(ids(listVm(h).conversations)).toEqual(['c-older', 'c-closed']);
    expect(listVm(h).back).toBe('home');
    click(h.q('[data-conversation-open="c-older"]'));
    await flush(10);
    expect(cid(h)).toBe('c-older');
    expect(pastBar(h)).toBeNull();
    expect(composerShown(h)).toBe(true);
    h.runtime.setTab('list');
    await flush(10);
    click(h.q('[data-conversation-open="c-closed"]'));
    await flush(10);
    expect(cid(h)).toBe('c-closed');
    expect(pastBar(h)).not.toBeNull();
    expect(composerShown(h)).toBe(false);
  });
});

describe('a past conversation is read-only and the current one keeps its transport', () => {
  for (const which of ['t1', 'bare'] as const) {
    it(`${which}: no send of any kind, no quote, no file; the live one's answer still counts`, async () => {
      const h = start(which, {
        realtime: true,
        publicEvents: true,
        conversations: [{ id: 'c-live', status: 'open' }, { id: 'c-past', status: 'closed' }],
      });
      await flush(40);
      await online(h);
      expect(cid(h)).toBe('c-live');
      h.runtime.setTab('list');
      await flush(10);
      click(h.q('[data-conversation-open="c-past"]'));
      await flush(20);
      expect(cid(h)).toBe('c-past');
      expect(pastBar(h)).not.toBeNull();
      expect(composerShown(h)).toBe(false);
      // Its history was read, the transport never moved to it (nor off the live one).
      expect(h.historyReads).toEqual(['c-live', 'c-past']);
      expect(h.subscriptions.filter((x) => x !== '+c-live')).toEqual([]);

      write(h, 'should not go');
      h.runtime.__test.send('nor this');
      await flush(10);
      expect(sends(h)).toEqual([]);
      click(h.q('[data-chat-messages] [data-msg-reply]'));
      expect(h.q<HTMLElement>('[data-reply-preview]')!.hidden).toBe(true);
      const file = h.q<HTMLInputElement>('[data-attach-input]');
      if (file) {
        Object.defineProperty(file, 'files', { configurable: true, value: [new File(['x'], 'a.png', { type: 'image/png' })] });
        file.dispatchEvent(new Event('change'));
        await flush(5);
        expect(h.fetches.some((u) => u.includes('/attachments/init'))).toBe(false);
      }
      // The reload keeps the list, never a writable past thread.
      expect(hint()).toMatchObject({ tab: 'list', conversationId: null });

      // The live one answers meanwhile: counted (badge, the page's event), not drawn here.
      const events = h.events.length;
      h.emitMessages([agent('m-live', 'c-live', 'پاسخ تازه')]);
      await flush(10);
      expect(msgs(h).some((m) => m.__id === 'm-live')).toBe(false);
      expect(h.unread[h.unread.length - 1]).toBe(1);
      expect(h.events.length).toBe(events + 1);

      // Back to it: writable, its thread; nothing was left or joined meanwhile.
      click(h.q('[data-past-bar] [data-chat-current]'));
      await flush(20);
      expect(h.subscriptions.filter((x) => x !== '+c-live')).toEqual([]);
      expect([cid(h), composerShown(h), pastBar(h)]).toEqual(['c-live', true, null]);
      write(h, 'into the live one');
      await flush(10);
      expect(sends(h)).toHaveLength(1);
      expect(sends(h)[0]).toMatchObject({ conversationId: 'c-live', forceNewConversation: false });
    });
  }

  it('t1: the past header has no presence and the ⋯ no sound', async () => {
    const h = start('t1', {
      realtime: true,
      assignedOperator: { name: 'سارا', avatar: null, online: true },
      conversations: [{ id: 'c-live', status: 'open' }, { id: 'c-past', status: 'closed', operatorName: 'سارا', operatorOnline: true }],
    });
    await flush(40);
    h.runtime.setTab('list');
    await flush(10);
    click(h.q('[data-conversation-open="c-past"]'));
    await flush(30);
    const vm = h.lastCall('chatHeaderHtml')![0] as Row;
    expect(vm).toMatchObject({ past: true, back: 'list', online: true });
    expect((vm.operator as Row | null)?.online ?? null).toBeNull();
    expect(h.q('[data-chat-header] .pr')).toBeNull();
    expect(Array.from(h.shadow.querySelectorAll('[data-chat-menu-action]')).map((e) => e.getAttribute('data-chat-menu-action'))).not.toContain('sound');
  });
});

describe('a fresh thread: armed from the start, nothing adopted behind it', () => {
  it('a first visit: no /identity/history at boot or on reconnect, and the first message forces a new conversation', async () => {
    const h = start('t1', { realtime: true, conversations: [{ id: 'c-old', status: 'closed' }] });
    await flush(40);
    expect(h.runtime.__test.chatState().freshIntent).toBe(true);
    h.emitReconnect();
    await flush(10);
    expect(h.historyReads).toEqual([]);
    await online(h);
    h.runtime.setTab('chat');
    await flush(10);
    write(h, 'سلام');
    await flush(10);
    expect(sends(h)[0]).toMatchObject({ conversationId: null, forceNewConversation: true });
  });

  it('default keeps the old model (no past bar, no one-conversation rules)', async () => {
    const h = boot({ renderer: 'default', realtime: true, conversations: [{ id: 'c-old', status: 'closed' }] });
    await flush(40);
    expect(h.historyReads).toContain('latest');
    expect(h.runtime.__test.chatState().freshIntent).toBe(false);
  });

  it('/poll: a live conversation it names becomes the fresh thread (an outreach opens the panel); a closed one never', async () => {
    const h = start('bare', { open: false, conversations: [], history: { 'c-out': [agent('o0', 'c-out', 'سلام! کمکی لازم دارید؟')] } });
    await flush(40);
    h.emitPollConversation('c-closed', 'closed');
    await flush(5);
    expect(cid(h)).toBeNull();
    h.emitPollConversation('c-out', 'open');
    await flush(10);
    expect(cid(h)).toBe('c-out');
    expect(h.historyReads).toEqual(['c-out']);
    h.emitPoll([agent('o1', 'c-out', 'هستید؟')]);
    await flush(10);
    expect(msgs(h).map((m) => m.__id)).toContain('o1');
    expect(h.runtime.isOpen()).toBe(true);
    expect(view(h)).toBe('chat');
  });

  it('a realtime answer adopts its conversation; a system row (a close) never does', async () => {
    const h = start('bare', { realtime: true, conversations: [] });
    await flush(40);
    h.emitMessages([{ id: 's1', role: 'system', sender_type: 'system', text: 'closed', metadata: { kind: 'conversation_closed' }, conversation_id: 'c-x', time: ago(0) }]);
    await flush(5);
    expect(cid(h)).toBeNull();
    h.emitMessages([agent('o1', 'c-out')]);
    await flush(10);
    expect(cid(h)).toBe('c-out');
  });

  it('a fresh thread the visitor wrote in is never swapped for another', async () => {
    const h = start('bare', { conversations: [] });
    await flush(40);
    await online(h);
    h.runtime.setTab('chat');
    await flush(10);
    write(h, 'سلام');
    await flush(5);
    h.emitPollConversation('c-other', 'open');
    await flush(5);
    expect(cid(h)).toBeNull();
  });
});

describe('the AI greeting before the conversation exists (the intro preview)', () => {
  const AI = { aiAgent: { visitorFacing: true, providerReady: true, introCapable: true, introEnabled: true, suppressGreeting: true } };
  const GREETING = 'سلام! من نیلو هستم. چطور کمکتان کنم؟';
  function intro(answer: Row) {
    return (url: string): ApiAnswer | undefined => (url.includes('/ai-agent/intro') ? { body: answer } : undefined);
  }
  const introPosts = (h: Harness) => h.posts.filter((p) => p.url.includes('/ai-agent/intro')).map((p) => p.body);

  it('drawn locally, carried by the first message, swapped for the server\'s copy (one greeting, above the question)', async () => {
    const h = start('t1', {
      config: AI,
      conversations: [],
      api: intro({ sent: true, preview: true, body: GREETING, agentName: 'نیلو', conversationId: null, messageId: null }),
      send: () => ({
        conversationId: 'c-new', messageId: 'm-v',
        introMessage: { id: 'srv-intro', role: 'agent', sender_type: 'ai', text: GREETING, time: ago(0), conversation_id: 'c-new', metadata: { source: 'ai_agent_intro' } },
      }),
    });
    await flush(40);
    await online(h);
    h.runtime.setTab('chat');
    await flush(20);
    expect(introPosts(h)).toHaveLength(1);
    expect(introPosts(h)[0]).toMatchObject({ preview: true, force_new_conversation: true });
    const local = msgs(h).find((m) => m.introLocal);
    expect(local).toMatchObject({ body: GREETING, introLocale: 'fa', metadata: { source: 'ai_agent_intro' } });
    expect(cid(h)).toBeNull();
    expect(h.runtime.__test.chatState().freshIntent).toBe(true);
    // A repaint asks nothing again.
    h.runtime.setTab('home');
    await flush(10);
    h.runtime.setTab('chat');
    await flush(10);
    expect(introPosts(h)).toHaveLength(1);

    write(h, 'سفارشم کجاست؟');
    await flush(20);
    expect(sends(h)[0]).toMatchObject({ forceNewConversation: true, aiIntro: { locale: 'fa' } });
    const greetings = msgs(h).filter((m) => (m.metadata as Row | null)?.source === 'ai_agent_intro');
    expect(greetings).toHaveLength(1);
    expect(greetings[0]).toMatchObject({ __id: 'srv-intro', introLocal: false });
    expect(msgs(h).indexOf(greetings[0])).toBeLessThan(msgs(h).findIndex((m) => m.sender === 'visitor'));
    // The same row again (a poll's echo): still one.
    h.emitPoll([{ id: 'srv-intro', role: 'agent', sender_type: 'ai', text: GREETING, time: ago(0), conversation_id: 'c-new', metadata: { source: 'ai_agent_intro' } }]);
    await flush(5);
    expect(msgs(h).filter((m) => (m.metadata as Row | null)?.source === 'ai_agent_intro')).toHaveLength(1);
  });

  it('continued: the message went into the visitor\'s live conversation; the local greeting goes, its history comes', async () => {
    const h = start('t1', {
      config: AI,
      conversations: [],
      history: { 'c-live': [visitor('x1', 'c-live', 'سؤال قبلی', 30), agent('x2', 'c-live', 'پاسخ قبلی', 29)] },
      api: intro({ sent: true, preview: true, body: GREETING, conversationId: null, messageId: null }),
      send: () => ({ conversationId: 'c-live', messageId: 'm-v', continued: true }),
    });
    await flush(40);
    await online(h);
    h.runtime.setTab('chat');
    await flush(20);
    expect(msgs(h).some((m) => m.introLocal)).toBe(true);
    write(h, 'سؤال تازه');
    await flush(30);
    expect(cid(h)).toBe('c-live');
    expect(msgs(h).some((m) => m.introLocal)).toBe(false);
    expect(h.historyReads).toContain('c-live');
    // Its order: the earlier lines first, then the message just sent.
    expect(msgs(h).map((m) => m.__id)).toEqual(['x1', 'x2', 'm-v']);
  });

  it('conversation_live: the visitor\'s live conversation (another tab\'s) is opened instead of a greeting', async () => {
    const h = start('t1', {
      config: AI,
      conversations: [],
      api: intro({ sent: false, reason: 'conversation_live', conversationId: 'c-live' }),
    });
    await flush(40);
    h.runtime.setTab('chat');
    await flush(30);
    expect(cid(h)).toBe('c-live');
    expect(h.historyReads).toEqual(['c-live']);
    expect(msgs(h).some((m) => m.introLocal)).toBe(false);
  });

  it('an older backend\'s answer (its row): adopted as before', async () => {
    const h = start('t1', {
      config: AI,
      conversations: [],
      api: intro({ sent: true, body: GREETING, conversationId: 'c-legacy', messageId: 'm-legacy' }),
    });
    await flush(40);
    h.runtime.setTab('chat');
    await flush(20);
    expect(cid(h)).toBe('c-legacy');
    expect(msgs(h).find((m) => m.__id === 'm-legacy')).toMatchObject({ metadata: { source: 'ai_agent_intro' } });
    expect(msgs(h).some((m) => m.introLocal)).toBe(false);
  });

  it('never asked for a conversation that exists', async () => {
    const h = start('t1', { config: AI, conversations: [{ id: 'c-live', status: 'open' }] });
    await flush(40);
    h.runtime.setTab('chat');
    await flush(10);
    expect(introPosts(h)).toEqual([]);
  });
});

describe('the message left while the team is away (t1, POST /offline-messages)', () => {
  it('continued: left in the visitor\'s live conversation (another tab\'s), that thread is shown', async () => {
    // The late pack in from the start (the away thread is its feature).
    new Function(readFileSync(resolve(process.cwd(), 'public/widget/presentation-t1-x.js'), 'utf8')).call(window);
    new Function(readFileSync(resolve(process.cwd(), 'public/widget/runtime-late.js'), 'utf8')).call(window);
    const h = start('t1', {
      conversations: [],
      config: { availability: { state: 'offline', offline_mode: 'capture_message', next_open_at: null } },
      history: { 'c-live': [visitor('x1', 'c-live', 'سؤال قبلی', 30), agent('x2', 'c-live', 'پاسخ قبلی', 29)] },
      api: (url) => (url.endsWith('/api/widget/offline-messages')
        ? { body: { ok: true, captured: true, conversation_id: 'c-live', message_id: 'm-away', continued: true } }
        : undefined),
    });
    await flush(40);
    await online(h);
    h.runtime.setTab('chat');
    await flush(30);
    write(h, 'سلام، کسی هست؟');
    await flush(30);
    expect(h.posts.filter((p) => p.url.endsWith('/api/widget/offline-messages'))).toHaveLength(1);
    expect(cid(h)).toBe('c-live');
    expect(h.historyReads).toContain('c-live');
    expect(msgs(h).map((m) => m.__id)).toEqual(['x1', 'x2', 'm-away']);
  });
});

describe('unseen answers in history (pastUnread)', () => {
  it('t1: on home\'s link and the chat bar\'s ⋯ item', async () => {
    seedHint({ tab: 'home', conversationId: null });
    const h = start('t1', {
      realtime: true,
      conversations: [{ id: 'c-live', status: 'open' }, { id: 'c-past', status: 'closed', unreadCount: 2, unreadReplies: 2 }],
    });
    await flush(40);
    expect(homeVm(h)).toMatchObject({ pastCount: 1, pastUnread: 2 });
    expect(h.q('[data-body] .more[data-view="list"] .nb')!.textContent).toBe('۲');
    click(h.q('[data-body] [data-conversation-open="c-live"]'));
    await flush(30);
    expect(h.lastCall('chatHeaderHtml')![0]).toMatchObject({ pastCount: 1, pastUnread: 2, past: false });
    expect(h.q('[data-chat-menu-action="history"] .nb')!.textContent).toBe('۲');
    // The ⋯ item opens history, whose back is this conversation.
    click(h.q('[data-chat-menu-toggle]'));
    click(h.q('[data-chat-menu-action="history"]'));
    await flush(10);
    expect(view(h)).toBe('list');
    expect(listVm(h).back).toBe('chat');
    click(h.q('[data-body] [data-view-back]'));
    await flush(10);
    expect([view(h), cid(h)]).toEqual(['chat', 'c-live']);
  });
});

describe('back is Core\'s', () => {
  it('t1: chat → where it was opened; past thread → history; history → where it was opened', async () => {
    seedHint({ tab: 'home', conversationId: null });
    const h = start('t1', { conversations: [{ id: 'c-live', status: 'open' }, { id: 'c-past', status: 'closed' }] });
    await flush(40);
    click(h.q('[data-body] [data-conversation-open="c-live"]'));
    await flush(10);
    click(h.q('[data-chat-header] [data-view-back]'));
    await flush(10);
    expect(view(h)).toBe('home');

    click(h.q('[data-body] .more[data-view="list"]'));
    await flush(10);
    click(h.q('[data-conversation-open="c-past"]'));
    await flush(10);
    expect(h.lastCall('chatHeaderHtml')![0]).toMatchObject({ back: 'list', past: true });
    click(h.q('[data-chat-header] [data-view-back]'));
    await flush(10);
    expect(view(h)).toBe('list');
    click(h.q('[data-body] [data-view-back]'));
    await flush(10);
    expect(view(h)).toBe('home');
  });
});
