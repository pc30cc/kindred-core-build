/**
 * t2 with one current conversation per visitor (owner, 2026-10-23/24),
 * through the SHIPPED runtime.js, runtime-ext.js and runtime-late.js and
 * t2's real renderer and extras (coreFeaturesHarness.ts): Core's mode
 * (oneConversation.test.ts) as t2 draws it.
 *
 *  - home continues the current conversation (whatever its status: a
 *    closed one with an unseen answer too) and links to the earlier ones
 *    («گفتگوهای قبلی», with their unseen answers); no count row;
 *  - history is the list without the current one, back where it was
 *    opened, with no floating "new conversation";
 *  - a closed one opened there is read-only: t2's past bar in the
 *    composer's place, who answered and when in the bar (no presence), the
 *    transcript alone in its ⋯, the rating card still there within its
 *    window; the bar leads to the current one, else starts one;
 *  - the ⋯ of a thread and of a fresh one offers history first;
 *  - the home ask field writes into the current conversation.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boot, click, flush, key, resetWindow, typeInto, type ApiAnswer, type BootOptions, type Harness } from './coreFeaturesHarness';
import { avatarFace } from './avatarFace';

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
/** The close the server writes (a close only, owner 2026-10-24). */
const closeOf = (id: string, cid: string, min = 1): Row => ({
  id, role: 'system', sender_type: 'system', text: 'سارا closed the conversation', time: ago(min), conversation_id: cid,
  metadata: { kind: 'conversation_closed', by: 'agent', agent_name: 'سارا', operator_name: 'سارا', status: 'closed' },
});
/** What GET …/csat answers: nothing to rate, the transcript offered (the ⋯'s item); `over` for a rateable close. */
const CSAT = (over: Row = {}) => ({ closed_id: null, rateable: false, rating: null, operator: null, transcript: { available: true, to: 'a•••@example.com' }, ...over });
/** A page of this tab left on home (the current one restored behind it, its answers still unseen). */
const ON_HOME = { tab: 'home', conversationId: null };
const WORKSPACE = 'فروشگاه نیلوفر';

function start(opts: BootOptions & { csat?: (cid: string) => Row | undefined } = {}): Harness {
  const history: Record<string, Row[]> = {};
  for (const c of opts.conversations || []) history[c.id] = threadOf(c.id);
  const csat = opts.csat || (() => CSAT());
  return boot({
    renderer: 't2',
    realtime: true,
    identity: { identity_state: 'identified', contact: { name: 'علی', email: 'ali@example.com' } },
    assignedOperator: { name: 'سارا', avatar: null, online: true },
    api: (url: string): ApiAnswer | undefined => {
      const m = /\/conversations\/([^/]+)\/csat\?/.exec(url);
      return m ? { body: csat(decodeURIComponent(m[1])) || CSAT() } : undefined;
    },
    ...opts,
    history: { ...history, ...(opts.history || {}) },
  });
}
const cid = (h: Harness) => h.runtime.__test.chatState().conversationId as string | null;
const view = (h: Harness) => h.panel.getAttribute('data-view');
const sends = (h: Harness) => h.posts.filter((p) => p.url === 'chat:sendMessage').map((p) => p.body);
const listVm = (h: Harness) => h.lastCall('conversationListHtml')![0] as Row;
const pastBar = (h: Harness) => h.q('[data-past-bar]');
const composerShown = (h: Harness) => h.q<HTMLElement>('[data-input-bar]')!.style.display !== 'none';
const menuItems = (h: Harness) => Array.from(h.shadow.querySelectorAll('[data-chat-header] [data-chat-menu-action]')).map((e) => e.getAttribute('data-chat-menu-action'));
async function online(h: Harness) { h.runtime.__test.setConnectionState('online'); await flush(5); }
async function home(h: Harness) { h.runtime.setTab('home'); await flush(10); }
async function openPast(h: Harness, id: string) {
  h.runtime.setTab('list');
  await flush(10);
  click(h.q(`[data-conversation-open="${id}"]`));
  await flush(30);
}

describe('t2 home: the current conversation, and a link to the earlier ones', () => {
  it('continues the current one (a resolved one is still the visitor\'s); the others are «گفتگوهای قبلی», no count row', async () => {
    const h = start({
      conversations: [
        { id: 'c-live', status: 'resolved', operatorName: 'سارا', unreadCount: 2 },
        { id: 'c-past', status: 'closed', operatorName: 'مهدی' },
        { id: 'c-old', status: 'closed' },
      ],
      hint: ON_HOME,
    });
    await flush(40);
    await home(h);
    const row = h.q('.wy-view-home .list > .r[data-conversation-open="c-live"]')!;
    expect(row.querySelector('.t1')!.textContent).toBe('ادامه گفتگو با سارا');
    expect(row.querySelector('.end .nb')!.textContent).toBe('۲');
    expect(h.q('.wy-view-home [data-conversation-open="c-past"], .wy-view-home [data-conversation-open="c-old"]')).toBeNull();
    expect(h.q('.wy-view-home .list [data-view="list"]')).toBeNull();
    expect(h.q('.wy-view-home')!.textContent).not.toContain('گفتگوهای شما');
    const link = h.q('.wy-view-home .more[data-view="list"]')!;
    expect(link.textContent).toBe('گفتگوهای قبلی');
    expect(link.querySelector('.nb')).toBeNull();

    // History: the others, back home, no door to a second conversation.
    click(link);
    await flush(10);
    expect(view(h)).toBe('list');
    expect(listVm(h)).toMatchObject({ back: 'home' });
    expect(Array.from(h.shadow.querySelectorAll('.wy-view-list [data-conversation-open]')).map((e) => e.getAttribute('data-conversation-open'))).toEqual(['c-past', 'c-old']);
    expect(h.q('.wy-view-list .ttl')!.textContent).toBe('گفتگوهای قبلی');
    expect(h.q('.wy-view-list [data-home-action="chat"], .wy-view-list .fab, .wy-view-list .pill')).toBeNull();
    click(h.q('.wy-view-list [data-view-back]'));
    await flush(10);
    expect(view(h)).toBe('home');
  });

  it('a closed one with an answer unseen is home\'s continue row, with its badge; one in history counts on the link', async () => {
    const h = start({ conversations: [{ id: 'c-closed', status: 'closed', operatorName: 'سارا', unreadCount: 1, unreadReplies: 1 }], hint: ON_HOME });
    await flush(40);
    await home(h);
    expect(h.q('.list > .r[data-conversation-open="c-closed"] .end .nb')!.textContent).toBe('۱');
    expect(h.q('.more[data-view="list"]')).toBeNull();

    resetWindow();
    const two = start({
      conversations: [
        { id: 'c-new', status: 'open', operatorName: 'سارا' },
        { id: 'c-closed', status: 'closed', operatorName: 'مهدی', unreadCount: 1, unreadReplies: 1 },
      ],
      hint: ON_HOME,
    });
    await flush(40);
    await home(two);
    expect(two.q('.list > .r[data-conversation-open="c-new"]')).not.toBeNull();
    expect(two.q('.more[data-view="list"] .nb')!.textContent).toBe('۱');
  });
});

describe('t2: a past conversation is read, not written', () => {
  it('t2\'s bar in the composer\'s place; who answered and when, never a presence; the transcript alone in its ⋯; the way back', async () => {
    const h = start({ conversations: [{ id: 'c-live', status: 'open', operatorName: 'سارا' }, { id: 'c-past', status: 'closed', operatorName: 'سارا' }] });
    await flush(40);
    await online(h);
    expect(cid(h)).toBe('c-live');
    await openPast(h, 'c-past');
    expect(cid(h)).toBe('c-past');
    expect(composerShown(h)).toBe(false);
    const bar = pastBar(h)!;
    expect(bar.matches('.ro')).toBe(true);
    expect(bar.querySelector('.box > .lk')!.textContent).toBe('این گفتگو به پایان رسیده و فقط خواندنی است');
    expect(bar.querySelector('.box > .more[data-chat-current]')!.textContent).toBe('گفتگوی فعلی');
    // In the composer's place, inside the chat frame (the stylesheet hides reply and heart there).
    expect(bar.nextElementSibling).toBe(h.q('[data-input-bar]'));
    expect(bar.closest('.wy-view-chat')).not.toBeNull();
    // The bar: the workspace, who answered and when; no dot, no away.
    expect(h.q('[data-chat-header] .nm')!.textContent).toBe(WORKSPACE);
    expect(h.q('[data-chat-header] .st')!.textContent).toMatch(/^سارا · ./);
    expect(h.q('[data-chat-header] .pr, [data-chat-header] .ondot, [data-chat-header] .st.off')).toBeNull();
    expect(h.q('[data-chat-header] [data-view-back="list"]')).not.toBeNull();
    // Its ⋯: the transcript (the server offers it), no sound, no history.
    await flush(20);
    expect(menuItems(h)).toEqual(['transcript']);

    click(bar.querySelector('[data-chat-current]'));
    await flush(30);
    expect([cid(h), composerShown(h), pastBar(h)]).toEqual(['c-live', true, null]);
  });

  it('nothing current: the bar\'s button starts a fresh thread, the workspace in the bar (no «گفتگوی جدید», no stack)', async () => {
    const h = start({ conversations: [{ id: 'c-past', status: 'closed', operatorName: 'سارا' }] });
    await flush(40);
    await online(h);
    await openPast(h, 'c-past');
    const button = h.q('[data-past-bar].ro > button.btn[data-chat-current]')!;
    expect(button).not.toBeNull();
    expect(h.q('[data-past-bar] .box [data-chat-current]')).toBeNull();
    click(button);
    await flush(30);
    expect(cid(h)).toBeNull();
    expect([composerShown(h), pastBar(h)]).toEqual([true, null]);
    expect(h.q('[data-chat-header] .avs')).toBeNull();
    expect(avatarFace(h.q('[data-chat-header] .who > .av'))).toBe('workspace');
    expect(h.q('[data-chat-header] .nm')!.textContent).toBe(WORKSPACE);
    expect(h.q('[data-chat-header]')!.textContent).not.toContain('گفتگوی جدید');
    // The first message starts the conversation (force_new).
    const input = h.q<HTMLTextAreaElement>('[data-msg-input]')!;
    typeInto(input, 'سلام دوباره');
    key(input, 'Enter');
    await flush(10);
    expect(sends(h)).toHaveLength(1);
    expect(sends(h)[0]).toMatchObject({ forceNewConversation: true });
    expect(sends(h)[0].conversationId ?? null).toBeNull();
  });

  it('the rating card stays under its close within the window: asked for, drawn and sent from the past thread', async () => {
    const h = start({
      conversations: [{ id: 'c-live', status: 'open', operatorName: 'سارا' }, { id: 'c-past', status: 'closed', operatorName: 'سارا' }],
      history: { 'c-past': [...threadOf('c-past'), closeOf('cl9', 'c-past')] },
      csat: (id) => (id === 'c-past' ? CSAT({ closed_id: 'cl9', rateable: true, operator: { name: 'سارا', avatar: null } }) : undefined),
    });
    await flush(40);
    await online(h);
    await openPast(h, 'c-past');
    await flush(20);
    expect(pastBar(h)).not.toBeNull();
    const pills = Array.from(h.shadow.querySelectorAll('[data-chat-messages] .msg-system-pill')).map((p) => p.textContent);
    expect(pills).toEqual(['سارا گفتگو را به پایان رساند']);
    const card = h.q('[data-csat]')!;
    expect(card).not.toBeNull();
    expect(h.fetches.some((u) => u.includes('/conversations/c-past/csat?'))).toBe(true);
    click(card.querySelector('[data-csat-rate="4"]'));
    click(h.q('[data-csat-submit]'));
    await flush(5);
    const sent = h.posts.filter((p) => p.url.endsWith('/conversations/c-past/csat')).map((p) => p.body);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ workspace_id: 'ws-test', closed_id: 'cl9', rating: 4 });
  });
});

describe('t2: the ⋯ offers the earlier conversations', () => {
  it('first, in a thread; a press opens history, whose back is the chat', async () => {
    const h = start({ conversations: [{ id: 'c-live', status: 'open', operatorName: 'سارا' }, { id: 'c-past', status: 'closed' }] });
    await flush(40);
    await online(h);
    h.runtime.setTab('chat');
    await flush(20);
    expect(cid(h)).toBe('c-live');
    expect(menuItems(h)[0]).toBe('history');
    expect(h.q('[data-chat-menu-action="history"]')!.textContent).toBe('گفتگوهای قبلی');
    click(h.q('[data-chat-menu-toggle]'));
    await flush(5);
    click(h.q('[data-chat-menu-action="history"]'));
    await flush(10);
    expect(view(h)).toBe('list');
    expect(listVm(h)).toMatchObject({ back: 'chat' });
    expect(h.q('.wy-view-list [data-view-back="chat"]')).not.toBeNull();
    click(h.q('.wy-view-list [data-view-back]'));
    await flush(20);
    expect([view(h), cid(h)]).toEqual(['chat', 'c-live']);
  });

  it('on a fresh thread too (no transcript before a message), with the unseen answers there', async () => {
    const h = start({ conversations: [{ id: 'c-past', status: 'closed' }, { id: 'c-older', status: 'closed', unreadCount: 0 }] });
    await flush(40);
    await online(h);
    h.runtime.setTab('chat');
    await flush(20);
    expect(cid(h)).toBeNull();
    expect(menuItems(h)[0]).toBe('history');
    expect(menuItems(h)).not.toContain('transcript');
    expect(h.q('[data-chat-menu-action="history"] .nb')).toBeNull();
  });
});

describe('t2: the home ask field writes into the current conversation', () => {
  async function ask(h: Harness, text: string) {
    await home(h);
    const field = h.q<HTMLTextAreaElement>('textarea[data-home-ask]')!;
    typeInto(field, text);
    key(field, 'Enter');
    await flush(30);
  }

  it('a live one takes the question (no force_new); with nothing current a fresh one starts', async () => {
    const h = start({ conversations: [{ id: 'c-live', status: 'open', operatorName: 'سارا' }, { id: 'c-past', status: 'closed' }] });
    await flush(40);
    await online(h);
    await ask(h, 'سفارشم کی می‌رسد؟');
    expect(view(h)).toBe('chat');
    expect(sends(h).map((b) => [b.text, b.conversationId, b.forceNewConversation])).toEqual([['سفارشم کی می‌رسد؟', 'c-live', false]]);

    resetWindow();
    const fresh = start({ conversations: [{ id: 'c-past', status: 'closed' }] });
    await flush(40);
    await online(fresh);
    await ask(fresh, 'سایز ۴۲ دارید؟');
    expect(sends(fresh)).toHaveLength(1);
    expect(sends(fresh)[0]).toMatchObject({ text: 'سایز ۴۲ دارید؟', forceNewConversation: true });
    expect(sends(fresh)[0].conversationId ?? null).toBeNull();
  });
});
