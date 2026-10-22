/**
 * The message left while the team is away, in the thread (t1 07·09, t2
 * 04·11; issue #340, g4 f3), with the SHIPPED runtime.js, runtime-ext.js,
 * runtime-late.js and the real t1 / t2 renderers and extras
 * (coreFeaturesHarness.ts):
 *
 *  - away (offline, capture mode, no AI answering, quota not full) the chat
 *    tab is the thread with the composer open, not the leave-a-message form;
 *    attaching waits for the conversation;
 *  - the first message goes to POST /api/widget/offline-messages with its
 *    bubble's id as `client_message_id` (a retry sends the same id), and
 *    becomes the conversation's first message; later ones go as any message;
 *  - under it, the automated reply asks for an email (POST
 *    /api/widget/identity/offline-email), then says where the reply goes; a
 *    reload finds the message again by its `offline_capture` source;
 *  - t2: "no thanks" when the email is not required, the composer's "add
 *    more" placeholder meanwhile;
 *  - the form already on screen when the late pack comes keeps the tab
 *    (no switch mid-input); an AI answering, a full quota, `default`: today's
 *    path, untouched.
 *
 * Offline from the first paint, Core's presence store holds the workspace's
 * mode at once (createPresence publishes at an offline start: the `default`
 * fix g5-3a of round 5); runtime-late.js reads it from there, and its `away`
 * hook keeps the thread and the composer where Core would draw its form.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { boot, click, flush, key, resetWindow, typeInto, type ApiAnswer, type BootOptions } from './coreFeaturesHarness';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

beforeEach(() => { vi.useRealTimers(); resetWindow(); });
afterEach(() => { vi.restoreAllMocks(); });

const AWAY = { state: 'offline', offline_mode: 'capture_message', next_open_at: null };
const MSG_ID = '55555555-5555-4555-8555-555555555555';
type Route = (url: string, body: Record<string, unknown> | null) => ApiAnswer | Promise<ApiAnswer> | undefined;
const OK: Route = (u) => {
  if (u.endsWith('/api/widget/offline-messages')) return { body: { ok: true, captured: true, conversation_id: 'c-away', message_id: MSG_ID, transitioning: false } };
  if (u.endsWith('/api/widget/identity/offline-email')) return { body: { ok: true, contact_id: 'k1' } };
  return undefined;
};
function start(opts: BootOptions & { route?: Route; renderer?: 't1' | 't2'; preloaded?: boolean; availability?: Record<string, unknown> } = {}) {
  const renderer = opts.renderer || 't1';
  if (opts.preloaded !== false) {
    new Function(read(`public/widget/presentation-${renderer}-x.js`)).call(window);
    new Function(read('public/widget/runtime-late.js')).call(window);
  }
  const route = opts.route || OK;
  return boot({
    ...opts,
    renderer,
    // The away email step as it comes back once visitor email is switched
    // on (config.visitorEmail, shared/visitorEmail.ts); off: 'no email step' below.
    config: { availability: opts.availability || AWAY, attachments: { enabled: true, allowedMimes: ['image/png'] }, visitorEmail: true, ...(opts.config || {}) },
    api: (url, init) => {
      let body: Record<string, unknown> | null = null;
      try { body = init && init.body ? JSON.parse(String(init.body)) : null; } catch { body = null; }
      return route(url, body);
    },
  });
}
async function toChat(h: ReturnType<typeof boot>) {
  await flush(30);
  h.runtime.setTab('chat');
  await flush(30);
  h.runtime.__test.setConnectionState('online');
  await flush(10);
}
const composer = (h: ReturnType<typeof boot>) => h.q<HTMLTextAreaElement>('[data-msg-input]')!;
async function send(h: ReturnType<typeof boot>, text: string) {
  typeInto(composer(h), text);
  key(composer(h), 'Enter');
  await flush(20);
}
const awayPosts = (h: ReturnType<typeof boot>) => h.posts.filter((p) => p.url.endsWith('/api/widget/offline-messages'));
const emailPosts = (h: ReturnType<typeof boot>) => h.posts.filter((p) => p.url.endsWith('/api/widget/identity/offline-email'));
const chatSends = (h: ReturnType<typeof boot>) => h.posts.filter((p) => p.url === 'chat:sendMessage');
const reply = (h: ReturnType<typeof boot>) => h.q('[data-chat-messages] .away-reply');
const t = (h: ReturnType<typeof boot>) => h.env().t as (k: string) => string;

describe('t1: the thread, away', () => {
  it('is the chat view with the composer open', async () => {
    const h = start();
    await toChat(h);
    expect(h.calls.some((c) => c.surface === 'contactFallbackHtml')).toBe(false);
    expect(h.q('.wy-view-chat')).not.toBeNull();
    expect(composer(h).disabled).toBe(false);
  });

  it('the first message is the message left for the team (its bubble\'s id makes a retry safe); later ones go as any message', async () => {
    const h = start({ identity: { identity_state: 'anonymous', contact: { name: 'علی' } } });
    await toChat(h);
    await send(h, 'سلام، برای سفارش عمده تخفیف دارید؟');
    const local = (h.runtime.__test.chatState().messages as Array<Record<string, unknown>>)[0];
    expect(awayPosts(h).map((p) => p.body)).toEqual([{
      workspace_id: 'ws-test', message: 'سلام، برای سفارش عمده تخفیف دارید؟', locale: 'fa', honeypot: '',
      client_message_id: local.localId, name: 'علی',
    }]);
    expect(chatSends(h)).toEqual([]);
    expect(h.runtime.__test.chatState().conversationId).toBe('c-away');
    expect(local.__id).toBe(MSG_ID);
    expect(local.status).toBe('sent');
    // The automated reply under it, asking for an email.
    const row = reply(h)!;
    expect(row.previousElementSibling!.classList.contains('visitor')).toBe(true);
    expect(row.querySelector('[data-fb="email"]')).not.toBeNull();
    // Attaching is open with the conversation.
    expect(h.q<HTMLButtonElement>('[data-attach-btn]')!.disabled).toBe(false);
    await send(h, 'و ارسال به شیراز؟');
    expect(awayPosts(h)).toHaveLength(1);
    expect(chatSends(h).map((p) => p.body.conversationId)).toEqual(['c-away']);
  });

  it('the message left reads «{time} · ارسال شد» (07·09), not a tick (`view.away`)', async () => {
    const h = start();
    await toChat(h);
    await send(h, 'سلام، برای سفارش عمده تخفیف دارید؟');
    const meta = () => h.q('[data-chat-messages] .msg-row.visitor .msg-meta')!;
    expect(meta().querySelector('.msg-sent')!.textContent).toBe(t(h)('msgSent'));
    expect(meta().querySelector('.msg-ticks')).toBeNull();
    expect(h.lastCall('messagesHtml')![2]).toMatchObject({ away: true });
  });

  it('a failed first message retried sends the same id (no second conversation)', async () => {
    let n = 0;
    const h = start({ route: (u, b) => (u.endsWith('/offline-messages') ? (++n === 1 ? { status: 500, body: { error: 'x' } } : OK(u, b)) : OK(u, b)) });
    await toChat(h);
    await send(h, 'سلام');
    expect(reply(h)).toBeNull();
    click(h.q('[data-msg-retry]'));
    await flush(20);
    expect(awayPosts(h)).toHaveLength(2);
    expect(awayPosts(h)[1].body.client_message_id).toBe(awayPosts(h)[0].body.client_message_id);
    expect(reply(h)).not.toBeNull();
  });

  it('a message written while the first is on its way waits for it: one conversation, then it goes as any message', async () => {
    let release: () => void = () => {};
    const h = start({
      route: (u, b) => (u.endsWith('/offline-messages')
        ? new Promise<ApiAnswer>((r) => { release = () => r(OK(u, b) as ApiAnswer); })
        : OK(u, b)),
    });
    await toChat(h);
    await send(h, 'سلام');
    await send(h, 'برای سفارش عمده');
    expect(awayPosts(h)).toHaveLength(1);
    expect(chatSends(h)).toEqual([]);
    release();
    await flush(30);
    expect(awayPosts(h)).toHaveLength(1);
    expect(chatSends(h).map((p) => [p.body.text, p.body.conversationId])).toEqual([['برای سفارش عمده', 'c-away']]);
    const msgs = h.runtime.__test.chatState().messages as Array<Record<string, unknown>>;
    expect(msgs.map((m) => [m.body, m.status])).toEqual([['سلام', 'sent'], ['برای سفارش عمده', 'sending']]);
  });

  it('a conversation started meanwhile is not taken over by the answer for the message left away', async () => {
    let release: () => void = () => {};
    const h = start({
      route: (u, b) => (u.endsWith('/offline-messages')
        ? new Promise<ApiAnswer>((r) => { release = () => r(OK(u, b) as ApiAnswer); })
        : OK(u, b)),
    });
    await toChat(h);
    await send(h, 'سلام');
    h.runtime.__test.startNew();
    await flush(10);
    release();
    await flush(30);
    expect(h.runtime.__test.chatState().conversationId).toBeFalsy();
  });

  it('the email card: a wrong address is said in place, a right one is saved and says where the reply goes', async () => {
    const h = start({ realtime: true });
    await toChat(h);
    await send(h, 'سلام');
    const field = () => h.q<HTMLInputElement>('.away-reply [data-fb="email"]')!;
    field().focus();
    typeInto(field(), 'ali@');
    click(h.q('.away-reply [data-fb-submit]'));
    await flush(10);
    expect(h.q('.away-reply [data-fb-status]')!.textContent).toBe(t(h)('invalidEmail'));
    expect(field().getAttribute('aria-invalid')).toBe('true');
    expect(emailPosts(h)).toEqual([]);
    // A repaint meanwhile (typing from the team) keeps the text and the focus.
    typeInto(field(), 'ali@example.com');
    h.emitTyping({ actor: 'agent', name: 'سارا' });
    await flush(10);
    expect(field().value).toBe('ali@example.com');
    expect(h.shadow.activeElement).toBe(field());
    // Enter in the field submits its form.
    field().form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush(20);
    expect(emailPosts(h).map((p) => p.body)).toEqual([{ workspace_id: 'ws-test', conversation_id: 'c-away', email: 'ali@example.com' }]);
    expect(h.q('.away-reply .ec.done')!.textContent).toBe('ثبت شد: ali@example.com');
    expect(h.q('.away-reply [data-fb]')).toBeNull();
  });

  it('a refused address (403, 409, the network) is said as Core\'s failure, to try again', async () => {
    const h = start({ route: (u, b) => (u.endsWith('/offline-email') ? { status: 409, body: { error: 'not_offline_capture' } } : OK(u, b)) });
    await toChat(h);
    await send(h, 'سلام');
    typeInto(h.q<HTMLInputElement>('.away-reply [data-fb="email"]')!, 'ali@example.com');
    click(h.q('.away-reply [data-fb-submit]'));
    await flush(20);
    expect(h.q('.away-reply [data-fb-status]')!.textContent).toBe(t(h)('fallbackError'));
    expect(h.q<HTMLInputElement>('.away-reply [data-fb="email"]')!.value).toBe('ali@example.com');
  });

  it('an address already known: the message carries it and the reply says where it goes', async () => {
    const h = start({ identity: { identity_state: 'identified', contact: { name: 'علی', email: 'ali@example.com' } } });
    await toChat(h);
    await send(h, 'سلام');
    expect(awayPosts(h)[0].body).toMatchObject({ email: 'ali@example.com', name: 'علی' });
    expect(h.q('.away-reply .ec.done b')!.textContent).toBe('ali@example.com');
    expect(h.q('.away-reply form')).toBeNull();
  });

  it('a reload finds the message left away by its source', async () => {
    const h = start({
      conversations: [{ id: 'c1' }],
      history: { c1: [{ id: MSG_ID, role: 'visitor', sender_type: 'contact', text: 'سلام', time: new Date().toISOString(), conversation_id: 'c1', metadata: { source: 'offline_capture' } }] },
    });
    await flush(30);
    h.runtime.__test.openConversation('c1');
    await flush(30);
    expect(reply(h)!.querySelector('[data-fb="email"]')).not.toBeNull();
  });
});

describe('no email step while visitor email is switched off (config.visitorEmail absent, shared/visitorEmail.ts)', () => {
  for (const renderer of ['t1', 't2'] as const) {
    it(`${renderer}: the message is taken, the reply says it comes here, and no address is asked or sent`, async () => {
      const sent: string[] = [];
      const h = start({
        renderer,
        config: { visitorEmail: undefined },
        route: (u, b) => { sent.push(u); return OK(u, b); },
      });
      await toChat(h);
      await send(h, 'سلام، سایز ۴۲ این کفش کی دوباره موجود می‌شود؟');
      const r = reply(h)!;
      expect(r).not.toBeNull();
      expect(r.querySelector('[data-fb="email"]')).toBeNull();
      expect(r.querySelector('[data-fb-skip]')).toBeNull();
      expect(r.textContent).toContain('پاسخ همین‌جا در گفتگو نمایش داده می‌شود');
      expect(r.textContent).not.toMatch(/ایمیل/);
      expect(sent.filter((u) => u.endsWith('/api/widget/offline-messages'))).toHaveLength(1);
      expect(sent.filter((u) => u.includes('/identity/offline-email'))).toEqual([]);
    });
  }
});

describe('t2: the thread, away', () => {
  it('asks with "no thanks" when the email is not required; skipping keeps the recorded line; the composer invites more', async () => {
    const h = start({ renderer: 't2' });
    await toChat(h);
    const ph = composer(h).getAttribute('placeholder');
    await send(h, 'سلام، سایز ۴۲ این کفش کی دوباره موجود می‌شود؟');
    expect(reply(h)!.querySelector('form.fcard [data-fb="email"]')).not.toBeNull();
    expect(composer(h).getAttribute('placeholder')).toBe('اگر چیزی اضافه دارید بنویسید…');
    click(h.q('.away-reply [data-fb-skip]'));
    await flush(10);
    // Declined: the reply comes here, and the line says so.
    expect(Array.from(reply(h)!.querySelectorAll('.msg.operator')).map((b) => b.textContent)).toEqual(['پیامتان ثبت شد. پاسخ همین‌جا در گفتگو نمایش داده می‌شود.']);
    expect(h.shadow.activeElement).toBe(composer(h));
    expect(ph).not.toBe('اگر چیزی اضافه دارید بنویسید…');
  });

  it('a required email offers no "no thanks"; saved, it says what was saved (04·11), never that the reply is mailed', async () => {
    const h = start({ renderer: 't2', identity: { identity_state: 'anonymous', contact: null, prechat: { ask_email: true, require_email: true, timing: 'never' } } });
    await toChat(h);
    await send(h, 'سلام');
    expect(h.q('.away-reply [data-fb-skip]')).toBeNull();
    typeInto(h.q<HTMLInputElement>('.away-reply [data-fb="email"]')!, 'ali@example.com');
    click(h.q('.away-reply [data-fb-submit]'));
    await flush(20);
    expect(h.q('.away-reply .fcard.done')!.textContent).toBe('ثبت شد: ali@example.com');
  });

  it('a new conversation: the composer\'s own placeholder returns', async () => {
    const h = start({ renderer: 't2' });
    await toChat(h);
    const ph = composer(h).getAttribute('placeholder');
    await send(h, 'سلام');
    expect(composer(h).getAttribute('placeholder')).not.toBe(ph);
    h.runtime.__test.startNew();
    await flush(10);
    h.runtime.setTab('chat');
    await flush(20);
    expect(composer(h).getAttribute('placeholder')).toBe(ph);
  });
});

describe('today\'s path where the thread does not apply', () => {
  // Core's own leave-a-message form, which an offline start shows since
  // round 5 published its presence (before, the composer stayed).
  const coreForm = (h: ReturnType<typeof boot>) => h.q('[data-fb="message"]');

  it('the leave-a-message form already on screen when the late pack comes keeps the tab while it is there', async () => {
    const h = start({ preloaded: false, late: 'hold' });
    await toChat(h);
    expect(coreForm(h)).not.toBeNull();
    expect(h.q('[data-msg-input]')).toBeNull();
    h.releaseLate();
    await flush(30);
    expect(coreForm(h)).not.toBeNull();
    expect(h.q('[data-msg-input]')).toBeNull();
    expect(awayPosts(h)).toEqual([]);
    // The form gone (another view, a reload): the thread takes a first message.
    h.runtime.setTab('home');
    await flush(20);
    h.runtime.setTab('chat');
    await flush(30);
    expect(coreForm(h)).toBeNull();
    await send(h, 'سلام دوباره');
    expect(awayPosts(h)).toHaveLength(1);
    expect(chatSends(h)).toEqual([]);
  });

  it('without the late pack (it failed) nothing of it: Core\'s leave-a-message form, as before the thread', async () => {
    const h = start({ preloaded: false, late: 'fail' });
    await toChat(h);
    await flush(20);
    expect(coreForm(h)).not.toBeNull();
    expect(h.q('[data-msg-input]')).toBeNull();
    expect(reply(h)).toBeNull();
    expect(awayPosts(h)).toEqual([]);
    expect(chatSends(h)).toEqual([]);
  });

  it('an AI answering away keeps the AI chat; a full quota keeps the form', async () => {
    const ai = start({ config: { aiAgent: { visitorFacing: true, providerReady: true, introCapable: false, suppressGreeting: true } } });
    await toChat(ai);
    await send(ai, 'سلام');
    expect(awayPosts(ai)).toEqual([]);
    resetWindow();
    vi.restoreAllMocks();
    const full = start({ availability: { ...AWAY, quota_full: true } });
    await toChat(full);
    expect(full.q('[data-fb="message"]')).not.toBeNull();
  });

  it('the team online: a first message goes as any message', async () => {
    const h = start({ availability: { state: 'online' } });
    await toChat(h);
    await send(h, 'سلام');
    expect(awayPosts(h)).toEqual([]);
    expect(chatSends(h)).toHaveLength(1);
  });

  it('default keeps its own path and asks nothing new', async () => {
    const h = boot({ renderer: 'default', config: { availability: AWAY } });
    await toChat(h);
    expect(coreForm(h)).not.toBeNull();
    expect(awayPosts(h)).toEqual([]);
    expect(h.q('.away-reply')).toBeNull();
    expect(h.fetches.some((u) => /offline-email|\/queue|\/reactions/.test(u))).toBe(false);
    expect(h.scripts.some((s) => /runtime-late|runtime-ext/.test(s))).toBe(false);
  });
});
