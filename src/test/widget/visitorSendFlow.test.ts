/**
 * The visitor's side of sending and reading, driven through the SHIPPED
 * runtime.js (and its real chat module where the request matters) in
 * jsdom, with the default, t1 and t2 renderers:
 *
 *   V-03  a send carries its idempotency key (client_message_id), the
 *         department the visitor chose and the message it answers;
 *   V-02  the runtime sends the visitor credential (X-Widget-Visitor) the
 *         loader holds, on its API calls and the realtime driver's;
 *   V-05  a failed message keeps its own "not delivered" and Retry when a
 *         later one goes through (every template);
 *   V-19  the composer stops at the server's 5,000 characters and shows
 *         what is left near it; a refusal says why (too long, too many at
 *         once, chat not available); a 429 is sent again by itself after
 *         the wait the server names;
 *   V-20  the composer stays writable while the connection is being made,
 *         and what is sent meanwhile waits on its bubble and goes once
 *         connected, in order;
 *   V-11  a reply in the open, visible thread is announced to screen
 *         readers and clears the typing row;
 *   V-21  a reply while the page is in the background counts as unread
 *         (title, badge) and is cleared when the visitor comes back;
 *   V-25  the AI's word-by-word reveal does not move under reduced motion
 *         and ends within 4 s however long the reply;
 *   V-18  a reconnect reloads the thread on screen, never the server's pick;
 *   V-15  the home "new" CTA starts a new conversation beside any earlier
 *         thread; default's "continue" offers only a live one;
 *   V-31  identify() fills the pre-chat form; an invalid email is left out;
 *   I-03  a `seen` envelope turns exactly those bubbles' ticks to seen.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { boot, click, flush, resetWindow, typeInto, win, type BootOptions, type Dict } from './coreFeaturesHarness';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const CHAT_SRC = read('public/widget/runtime-chat.js');
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
const DEPT = 'dddddddd-0000-4000-8000-000000000001';

beforeEach(() => { vi.useRealTimers(); resetWindow(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

type Harness = ReturnType<typeof boot>;
interface ChatSend {
  text: string;
  clientMessageId?: string | null;
  departmentId?: string | null;
  replyToMessageId?: string | null;
  conversationId?: string | null;
  onAccepted: (info: Dict) => void;
  onError: (err: unknown) => void;
  onConversation: (cid: string) => void;
}
const sends = (h: Harness) => h.posts.filter((p) => p.url === 'chat:sendMessage').map((p) => p.body as unknown as ChatSend);
const input = (h: Harness) => h.q<HTMLTextAreaElement>('[data-msg-input]')!;
const sendBtn = (h: Harness) => h.q<HTMLButtonElement>('[data-send-btn]')!;
const messages = (h: Harness) => h.q('[data-chat-messages]') || h.q('.messages')!;
const announcer = (h: Harness) => Array.prototype.find.call(h.panel.children, (el: Element) =>
  el.classList.contains('sr-only') && el.getAttribute('role') === 'status' && !el.classList.contains('connection-banner')) as HTMLElement;

/** A visitor on thread c1 (its history: one operator message), connected. */
async function thread(opts: BootOptions = {}) {
  const h = boot({
    hint: { tab: 'chat', conversationId: 'c1' },
    conversations: [{ id: 'c1' }],
    history: { c1: [{ id: 'op-1', role: 'agent', sender_type: 'agent', sender_name: 'سارا', text: 'چطور کمک کنم؟', time: iso(60_000) }] },
    ...opts,
  });
  await flush(40);
  h.runtime.__test.setConnectionState('online');
  await flush(5);
  return h;
}

function write(h: Harness, text: string) {
  typeInto(input(h), text);
  click(sendBtn(h));
}

/** The real runtime-chat.js behind the runtime's (already loaded) chat module. */
function useRealChatModule() {
  const fake = win.__gs_mod_chat as Dict;
  new Function(CHAT_SRC).call(window);
  const real = win.__gs_mod_chat as Dict;
  fake.sendMessage = real.sendMessage;
  win.__gs_mod_chat = fake;
}

describe('V-03 / V-02: what a send carries', () => {
  it('the request body has the idempotency key, the chosen department and the answered message; the credential rides in a header', async () => {
    const h = await thread();
    useRealChatModule();
    (win.__gs_departments as Dict).getSelectedId = () => DEPT;
    win.__gs_token = { vc: 'vc-test', get: () => '' };
    click(h.q('[data-msg-reply="op-1"]'));
    write(h, 'سفارشم کجاست؟');
    await flush(10);
    const post = h.posts.find((p) => p.url.endsWith('/api/widget/message'))!;
    expect(post).toBeTruthy();
    expect(post.body).toMatchObject({ conversation_id: 'c1', department_id: DEPT, reply_to_message_id: 'op-1' });
    expect(String(post.body.client_message_id)).toMatch(/^local_\d+_[a-z0-9]+$/);
    expect(String(post.body.message)).toContain('سفارشم کجاست؟');
    const call = (win.fetch as ReturnType<typeof vi.fn>).mock.calls.find((c) => String(c[0]).endsWith('/api/widget/message'))!;
    expect((call[1] as { headers: Record<string, string> }).headers['X-Widget-Visitor']).toBe('vc-test');
  });

  it('a retry of the same bubble sends the SAME client_message_id', async () => {
    const h = await thread();
    write(h, 'سلام');
    await flush(5);
    const [first] = sends(h);
    first.onError({ status: 500 });
    await flush(5);
    click(h.q(`[data-msg-retry="${first.clientMessageId}"]`));
    await flush(5);
    const again = sends(h)[1];
    expect(again.clientMessageId).toBe(first.clientMessageId);
  });

  it('a long quote is shortened so the message stays within 5,000 characters', async () => {
    const long = 'ب'.repeat(4990);
    const h = await thread({ history: { c1: [{ id: 'op-1', role: 'agent', sender_type: 'agent', text: long, time: iso() }] } });
    click(h.q('[data-msg-reply="op-1"]'));
    write(h, 'ج'.repeat(4000));
    await flush(5);
    const [s] = sends(h);
    expect(s.text.length).toBeLessThanOrEqual(5000);
    expect(s.replyToMessageId).toBe('op-1');
  });
});

describe('V-05: a failed message keeps its own label and Retry', () => {
  for (const renderer of ['default', 't1', 't2'] as const) {
    it(`${renderer}: after a later message goes through`, async () => {
      const h = await thread({ renderer });
      write(h, 'اولی');
      await flush(5);
      write(h, 'دومی');
      await flush(5);
      const [a, b] = sends(h);
      a.onError({ status: 403 });
      b.onAccepted({ conversationId: 'c1', messageId: 'srv-2' });
      await flush(10);
      const retry = h.q(`[data-msg-retry="${a.clientMessageId}"]`);
      expect(retry, 'the failed bubble keeps its Retry').not.toBeNull();
      expect(messages(h).textContent).toContain('گفتگو در حال حاضر در دسترس نیست');
      expect(h.q(`[data-msg-retry="${b.clientMessageId}"]`)).toBeNull();
    });
  }
});

describe('V-19: the length limit, and why a send failed', () => {
  it('the composer stops at 5,000 characters and shows what is left from 500 on, in Persian digits', async () => {
    const h = await thread();
    expect(input(h).maxLength).toBe(5000);
    const wrap = h.q('[data-input-wrap]')!;
    typeInto(input(h), 'الف'.repeat(100));
    expect(wrap.hasAttribute('data-chars-left')).toBe(false);
    typeInto(input(h), 'a'.repeat(4880));
    expect(wrap.getAttribute('data-chars-left')).toBe('۱۲۰');
    typeInto(input(h), '');
    expect(wrap.hasAttribute('data-chars-left')).toBe(false);
  });

  it('too long, chat not available: the reason in words, no automatic resend', async () => {
    const h = await thread();
    write(h, 'یک');
    await flush(5);
    sends(h)[0].onError({ status: 400, fields: ['message'] });
    await flush(5);
    expect(messages(h).textContent).toContain('پیام طولانی است؛ حداکثر ۵٬۰۰۰ نویسه');
    await new Promise((r) => setTimeout(r, 1200));
    expect(sends(h)).toHaveLength(1);
  });

  it('429: says so, then sends it again by itself after `retry_after`, with the same key', async () => {
    const h = await thread();
    write(h, 'پیام');
    await flush(5);
    const [first] = sends(h);
    first.onError({ status: 429, retryAfter: 1 });
    await flush(5);
    expect(messages(h).textContent).toContain('چند لحظهٔ دیگر دوباره ارسال می‌شود');
    expect(sends(h)).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 1100));
    await flush(5);
    const again = sends(h);
    expect(again).toHaveLength(2);
    expect(again[1].clientMessageId).toBe(first.clientMessageId);
    again[1].onAccepted({ conversationId: 'c1', messageId: 'srv-1' });
    await flush(5);
    expect(h.q(`[data-msg-retry="${first.clientMessageId}"]`)).toBeNull();
  });

  it('runtime-chat.js reads the wait and the fields from the refusal', async () => {
    new Function(CHAT_SRC).call(window);
    const mod = win.__gs_mod_chat as { sendMessage: (o: Dict) => void };
    const errors: Array<Dict> = [];
    const answer = (status: number, body: Dict) => () => Promise.resolve({
      ok: false, status, json: () => Promise.resolve(body), headers: { get: () => null },
    });
    for (const [status, body] of [[429, { code: 'RATE_LIMITED', retry_after: 7 }], [400, { details: { message: ['too long'] } }]] as const) {
      await new Promise<void>((done) => mod.sendMessage({
        apiBase: 'https://api.test', workspaceId: 'ws', text: 'x', fetchWith: answer(status, body as Dict),
        onError: (e: Dict) => { errors.push(e); done(); },
      }));
    }
    expect(errors[0]).toMatchObject({ status: 429, retryAfter: 7 });
    expect(errors[1]).toMatchObject({ status: 400, fields: ['message'] });
  });
});

describe('V-20: writing while the connection is being made', () => {
  it('the composer stays writable; the message waits, said in words, and goes once connected, in order', async () => {
    const h = await thread();
    h.runtime.__test.setConnectionState('connecting');
    await flush(5);
    expect(input(h).disabled).toBe(false);
    expect(sendBtn(h).disabled).toBe(false);
    expect(input(h).getAttribute('title')).toContain('در حال اتصال');
    write(h, 'اول');
    await flush(5);
    write(h, 'دوم');
    await flush(5);
    expect(sends(h)).toHaveLength(0);
    expect(messages(h).textContent).toContain('هنوز ارسال نشده؛ پس از برقراری اتصال ارسال می‌شود');
    h.runtime.__test.setConnectionState('online');
    await flush(5);
    expect(sends(h).map((s) => s.text)).toEqual(['اول']);
    sends(h)[0].onAccepted({ conversationId: 'c1', messageId: 'srv-a' });
    await flush(5);
    expect(sends(h).map((s) => s.text)).toEqual(['اول', 'دوم']);
    expect(input(h).hasAttribute('title')).toBe(false);
  });
});

describe('V-11 / V-21: a reply in the open thread', () => {
  it('is announced to screen readers and clears the typing row', async () => {
    const h = await thread({ realtime: true });
    h.emitTyping();
    await flush(2);
    h.emitMessages([{ id: 'op-2', conversation_id: 'c1', role: 'agent', sender_type: 'agent', sender_name: 'سارا', text: 'بسته فردا می‌رسد', time: iso() }]);
    await flush(5);
    expect(announcer(h).textContent).toBe('سارا: بسته فردا می‌رسد');
    expect(h.q<HTMLElement>('[data-typing-row]')!.hidden).toBe(true);
    // In view: no unread.
    expect(h.unread[h.unread.length - 1] || 0).toBe(0);
  });

  it('counts as unread while the page is in the background, and is cleared on return', async () => {
    document.title = 'فروشگاه';
    const h = await thread({ realtime: true });
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    h.emitMessages([{ id: 'op-3', conversation_id: 'c1', role: 'agent', sender_type: 'agent', text: 'جواب آمد', time: iso() }]);
    await flush(5);
    expect(h.unread[h.unread.length - 1]).toBe(1);
    expect(document.title).toBe('(1) فروشگاه');
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await flush(5);
    expect(h.unread[h.unread.length - 1]).toBe(0);
    expect(document.title).toBe('فروشگاه');
    expect(h.fetches.some((u) => u.includes('/api/widget/conversations/c1/read'))).toBe(true);
  });
});

describe('V-25: the AI reply reveal', () => {
  const words = (n: number) => Array.from({ length: n }, (_, i) => 'واژه' + i).join(' ');

  it('under reduced motion the whole reply is there at once', async () => {
    window.matchMedia = ((q: string) => ({ matches: /reduce/.test(q), media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    const h = await thread({ realtime: true });
    h.emitMessages([{ id: 'ai-1', conversation_id: 'c1', role: 'agent', sender_type: 'ai', text: words(40), time: iso() }]);
    await flush(5);
    expect(messages(h).textContent).toContain('واژه39');
    expect(h.q('[data-typing-active]')).toBeNull();
    delete (window as unknown as Dict).matchMedia;
  });

  it('a long reply is complete within 4 s', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const h = await thread({ realtime: true });
    h.emitMessages([{ id: 'ai-2', conversation_id: 'c1', role: 'agent', sender_type: 'ai', text: words(400), time: iso() }]);
    await flush(5);
    expect(messages(h).textContent).not.toContain('واژه399');
    vi.advanceTimersByTime(4000);
    expect(messages(h).textContent).toContain('واژه399');
  });
});

describe('V-18: a reconnect reloads the thread on screen', () => {
  it('asks for exactly that conversation, never the server\'s own pick', async () => {
    const h = await thread({ realtime: true });
    const chat = win.__gs_mod_chat as Dict;
    const exact: string[] = [];
    let picked = 0;
    const origExact = chat.loadConversationHistory as (o: Dict) => void;
    chat.loadConversationHistory = (o: Dict) => { exact.push(String(o.conversationId)); origExact(o); };
    chat.loadHistory = (o: { onResult: (r: Dict) => void }) => {
      picked += 1;
      o.onResult({ conversationId: 'c-other', messages: [{ id: 'x-1', conversation_id: 'c-other', role: 'agent', sender_type: 'agent', text: 'OTHER THREAD', time: iso() }] });
    };
    h.emitReconnect();
    await flush(10);
    expect(exact).toEqual(['c1']);
    expect(picked).toBe(0);
    expect(messages(h).textContent).not.toContain('OTHER THREAD');
    expect(h.runtime.__test.chatState().conversationId).toBe('c1');
  });
});

describe('V-15: the home CTA does what it says', () => {
  it('beside a finished thread it starts a new conversation (default offers no "continue" for it)', async () => {
    const h = boot({ conversations: [{ id: 'c-old', status: 'closed' }] });
    await flush(40);
    expect(h.body.querySelector('.wy-btn-primary[data-conversation-open]')).toBeNull();
    click(h.body.querySelector('[data-home-action="chat"]'));
    await flush(10);
    expect(h.runtime.__test.chatState().freshIntent).toBe(true);
    expect(h.runtime.__test.chatState().conversationId).toBeNull();
  });

  it('a live thread is offered to continue, and the CTA beside it starts a new one', async () => {
    const h = boot({ conversations: [{ id: 'c-live', status: 'pending' }] });
    await flush(40);
    // A live thread opens the chat; the visitor goes back to the home.
    h.runtime.setTab('home');
    await flush(10);
    expect(h.body.querySelector('[data-conversation-open="c-live"]')).not.toBeNull();
    click(h.body.querySelector('[data-home-action="chat"]'));
    await flush(10);
    expect(h.runtime.__test.chatState().freshIntent).toBe(true);
  });

  it('with no thread at all it opens the chat (nothing to start over from)', async () => {
    const h = boot({ conversations: [] });
    await flush(40);
    click(h.body.querySelector('[data-home-action="chat"]'));
    await flush(10);
    expect(h.runtime.__test.chatState().freshIntent).toBe(false);
  });
});

describe('V-31: identify() and the pre-chat form', () => {
  it('fills the empty fields; an email that is not one is left out', async () => {
    win.__gs_identify_data = { name: 'مریم', email: 'not-an-email', phone: '09121234567' };
    const h = boot({
      config: { prechatEnabled: true },
      identity: { identity_state: 'anonymous', contact: null, prechat: { ask_name: true, ask_email: true, ask_phone: true, timing: 'always' } },
      conversations: [],
    });
    await flush(40);
    h.runtime.setTab('chat');
    await flush(20);
    const field = (n: string) => h.q<HTMLInputElement>(`input[data-prechat="${n}"]`);
    const name = field('name');
    expect(name, 'the pre-chat form is shown').not.toBeNull();
    expect(name!.value).toBe('مریم');
    expect(field('phone')!.value).toBe('09121234567');
    expect(field('email')!.value).toBe('');
  });
});

describe('I-03: the visitor\'s ticks turn "seen" live', () => {
  it('exactly the named bubbles of the open thread', async () => {
    const h = await thread({ realtime: true });
    write(h, 'یک');
    await flush(5);
    write(h, 'دو');
    await flush(5);
    const [a, b] = sends(h);
    a.onAccepted({ conversationId: 'c1', messageId: 'srv-a' });
    b.onAccepted({ conversationId: 'c1', messageId: 'srv-b' });
    await flush(5);
    expect(h.q('.msg-ticks.is-seen')).toBeNull();
    // Another thread's receipt changes nothing.
    h.emitSeen({ conversation_id: 'c-other', seen_at: iso(), message_ids: ['srv-a', 'srv-b'] });
    await flush(5);
    expect(h.q('.msg-ticks.is-seen')).toBeNull();
    h.emitSeen({ conversation_id: 'c1', seen_at: iso(), message_ids: ['srv-a', 'srv-b'] });
    await flush(5);
    const state = h.runtime.__test.chatState() as unknown as { messages: Array<{ __id?: string; status?: string }> };
    expect(state.messages.filter((m) => m.__id === 'srv-a' || m.__id === 'srv-b').map((m) => m.status)).toEqual(['seen', 'seen']);
    expect(h.q('.msg-ticks.is-seen')).not.toBeNull();
  });

  it('the Centrifugo driver hands a `seen` push to the runtime and sends the credential on its token calls', async () => {
    const WS = '11111111-1111-4111-8111-111111111111';
    const CID = '22222222-2222-4222-8222-222222222222';
    const sockets: Array<{ onmessage?: (ev: { data: string }) => void; onopen?: () => void; readyState: number; send: (s: string) => void }> = [];
    const fetches: Array<{ url: string; headers: Record<string, string> }> = [];
    class FakeWs {
      readyState = 1;
      onmessage?: (ev: { data: string }) => void;
      onopen?: () => void;
      constructor() { sockets.push(this); }
      send() {}
      close() {}
    }
    const sandbox: Dict = {
      fetch: async (url: string, init: { headers: Record<string, string> }) => {
        fetches.push({ url, headers: init.headers });
        return { ok: true, json: async () => ({ vendor: 'centrifugo', token: 'sub', channel: `ws:${WS}:conv:${CID}` }) };
      },
      WebSocket: FakeWs,
      __gs_token: { get: () => 'wt', vc: 'vc-rt' },
      setTimeout, clearTimeout, setInterval, clearInterval, Promise, JSON,
    };
    sandbox.window = sandbox;
    vm.runInNewContext(read('public/widget/runtime-rt-centrifugo.js'), sandbox);
    const seen: unknown[] = [];
    const drv = (sandbox.__gs_mod_rt_centrifugo as { create: (...a: unknown[]) => Dict }).create(
      { workspaceId: WS, apiBase: 'https://api.test' },
      { vendor: 'centrifugo', token: 'ct', ws_url: 'wss://rt.test' },
      { onConnectionState() {}, onMessage() {}, onTyping() {}, onSeen: (p: unknown) => seen.push(p), fallbackToPolling() {} });
    (drv.connect as () => void)();
    (drv.subscribeConversation as (c: string) => void)(CID);
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    expect(sockets).toHaveLength(1);
    const payload = { conversation_id: CID, seen_at: '2026-10-21T10:00:00Z', message_ids: ['m1'] };
    sockets[0].onmessage!({ data: JSON.stringify({ push: { channel: `ws:${WS}:conv:${CID}`, pub: { data: { type: 'seen', payload } } } }) });
    expect(seen).toEqual([payload]);
    const sub = fetches.find((f) => f.url.endsWith('/api/realtime/subscribe'));
    if (sub) expect(sub.headers['X-Widget-Visitor']).toBe('vc-rt');
  });

  it('the Supabase driver hands a `seen` broadcast to the runtime (an older per-message copy still merges as a message)', async () => {
    const WS = '11111111-1111-4111-8111-111111111111';
    const CID = '22222222-2222-4222-8222-222222222222';
    const topic = `ws:${WS}:conv:${CID}:MAC0123456789abcdefghijklmnopqrstu`;
    const handlers: Record<string, (msg: unknown) => void> = {};
    const fakeClient = {
      channel() {
        const ch = {
          on(_type: string, filter: { event: string }, fn: (msg: unknown) => void) { handlers[filter.event] = fn; return ch; },
          subscribe: (cb: (s: string) => void) => { cb('SUBSCRIBED'); return ch; },
        };
        return ch;
      },
      removeChannel() {},
      realtime: { disconnect() {} },
    };
    const heard: Array<[string, unknown]> = [];
    const fetched: Array<Record<string, string>> = [];
    const sandbox: Dict = {
      fetch: async (_u: string, init: { headers: Record<string, string> }) => {
        fetched.push(init.headers);
        return { ok: true, json: async () => ({ vendor: 'supabase', channel: `ws:${WS}:conv:${CID}`, topic }) };
      },
      __gs_supabase_client_factory: () => fakeClient,
      __gs_token: { get: () => 'wt', vc: 'vc-sb' },
      setTimeout, clearTimeout, Promise,
    };
    sandbox.window = sandbox;
    vm.runInNewContext(read('public/widget/runtime-rt-supabase.js'), sandbox);
    const drv = (sandbox.__gs_mod_rt_supabase as { create: (...a: unknown[]) => Dict }).create(
      { workspaceId: WS, apiBase: 'https://api.test' }, { vendor: 'supabase', supabase_url: 'https://x.supabase.co', anon_key: 'anon' },
      {
        onConnectionState() {}, onTyping() {}, onPresence() {}, onReconnect() {}, onSubscribed() {}, fallbackToPolling() {},
        onMessage: (e: unknown) => heard.push(['message', e]), onSeen: (p: unknown) => heard.push(['seen', p]),
      });
    (drv.subscribeConversation as (c: string) => void)(CID);
    (drv.connect as () => void)();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    const payload = { conversation_id: CID, seen_at: '2026-10-21T10:00:00Z', message_ids: ['m1'] };
    handlers.seen({ payload });
    expect(heard).toEqual([['seen', payload]]);
    expect(fetched[0]['X-Widget-Visitor']).toBe('vc-sb');
  });
});
