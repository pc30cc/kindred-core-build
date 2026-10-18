/**
 * The pre-chat one question at a time (t1, template option
 * `prechatMode: 'steps'`; issue #340, g4 f1), with the SHIPPED runtime.js,
 * runtime-ext.js, runtime-late.js and the real t1 renderer and extras
 * (coreFeaturesHarness.ts):
 *
 *  - the steps take the card's place in the chat view (a first chat too),
 *    the step takes the composer's place, one question at a time, with the
 *    edition's phone prefix; the composer and sending stay closed until the
 *    details are in;
 *  - an answer is checked as the server would (a refusal stays to be fixed
 *    in place), an optional step can be skipped, the details go in ONE POST
 *    /api/widget/identity/prechat (Persian digits and the prefix turned into
 *    a number the server keeps), a field the server refuses goes back to its
 *    step, a failure says so under the step;
 *  - the saved details' "edit" opens the steps again with the saved values;
 *  - a conversation keeps the mode its pre-chat first showed in (the card
 *    painted before the late pack stays the card), `card` is today's card,
 *    and `default` never draws a step.
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

const ASK = (over: Record<string, unknown> = {}) => ({
  identity_state: 'anonymous',
  contact: null,
  prechat: {
    ask_name: true, ask_email: true, ask_phone: true, require_name: true, require_email: true, require_phone: false,
    timing: 'always', ...over,
  },
});
/** The late pack already on the page (as an earlier paint would have brought it). */
function preload() {
  new Function(read('public/widget/presentation-t1-x.js')).call(window);
  new Function(read('public/widget/runtime-late.js')).call(window);
}
type Route = (url: string, body: Record<string, unknown> | null) => ApiAnswer | Promise<ApiAnswer> | undefined;
function start(opts: BootOptions & { route?: Route; mode?: string; preloaded?: boolean } = {}) {
  if (opts.preloaded !== false) preload();
  return boot({
    renderer: 't1',
    identity: ASK(),
    ...opts,
    config: { templateOptions: { prechatMode: opts.mode || 'steps' }, ...(opts.config || {}) },
    api: (url, init) => {
      if (!opts.route) return undefined;
      let body: Record<string, unknown> | null = null;
      try { body = init && init.body ? JSON.parse(String(init.body)) : null; } catch { body = null; }
      return opts.route(url, body);
    },
  });
}
const box = (h: ReturnType<typeof boot>) => h.q('[data-composer-zone] [data-prechat-step]');
const input = (h: ReturnType<typeof boot>) => h.q<HTMLInputElement>('[data-prechat-step-input]')!;
const bar = (h: ReturnType<typeof boot>) => h.q<HTMLElement>('[data-input-bar]')!;
const thread = (h: ReturnType<typeof boot>) => Array.from(h.shadow.querySelectorAll('[data-chat-messages] .msg-row'))
  .map((r) => (r.classList.contains('visitor') ? 'v:' : 'q:') + r.querySelector('.msg')?.textContent);
const prechatPosts = (h: ReturnType<typeof boot>) => h.posts.filter((p) => p.url.endsWith('/api/widget/identity/prechat'));
/** Home, then the chat tab (a first chat). */
async function toChat(h: ReturnType<typeof boot>) {
  await flush(30);
  h.runtime.setTab('chat');
  await flush(30);
}
/** Types into the step and presses Enter. */
async function answer(h: ReturnType<typeof boot>, value: string) {
  typeInto(input(h), value);
  key(input(h), 'Enter');
  await flush(10);
}

describe('a first chat asks one question at a time', () => {
  it('in the chat view: the questions in the thread, the step in the composer\'s place, the composer closed', async () => {
    const h = start();
    await toChat(h);
    expect(h.calls.some((c) => c.surface === 'prechatFormHtml')).toBe(false);
    expect(h.q('.wy-view-chat [data-chat-messages]')).not.toBeNull();
    expect(box(h)!.getAttribute('data-prechat-step')).toBe('name');
    expect(box(h)!.nextElementSibling).toBe(bar(h));
    expect(bar(h).style.display).toBe('none');
    expect(thread(h)).toEqual(['q:سلام! برای شروع، اسم‌تون چیه؟']);
    expect(h.q('.prog > span')!.textContent).toBe('مرحله ۱ از ۳');
    // The chat bar is the workspace's, not "new conversation".
    const head = h.lastCall('chatHeaderHtml')![0] as { isNew: boolean };
    expect(head.isNew).toBe(false);
    // The visitor is put in the field.
    expect(h.shadow.activeElement).toBe(input(h));
    // Sending is closed while the details are asked for.
    const msg = h.q<HTMLTextAreaElement>('[data-msg-input]')!;
    msg.value = 'سلام';
    key(msg, 'Enter');
    await flush(5);
    expect(h.posts.filter((p) => p.url === 'chat:sendMessage')).toEqual([]);
  });

  it('name, a refused email fixed in place, a Persian-digit phone: one POST with what the server keeps', async () => {
    const h = start();
    await toChat(h);
    expect((h.q('[data-prechat-step-submit]') as HTMLButtonElement).disabled).toBe(true);
    typeInto(input(h), 'علی رضایی');
    expect((h.q('[data-prechat-step-submit]') as HTMLButtonElement).disabled).toBe(false);
    key(input(h), 'Enter');
    await flush(10);
    expect(box(h)!.getAttribute('data-prechat-step')).toBe('email');
    expect(h.shadow.activeElement).toBe(input(h));
    await answer(h, 'ali@example');
    expect(box(h)!.getAttribute('data-prechat-step')).toBe('email');
    expect(input(h).value).toBe('ali@example');
    expect(h.q('[data-chat-messages] .msg.fail')!.textContent).toBe('ali@example');
    expect(h.q('[data-chat-messages] .st-err[role="alert"]')!.textContent).toBe('ایمیل کامل نیست · مثلاً name@example.com');
    await answer(h, 'ali@example.com');
    expect(box(h)!.getAttribute('data-prechat-step')).toBe('phone');
    expect(h.q('.prog > span')!.textContent).toBe('مرحله ۳ از ۳ · اختیاری');
    expect(h.q('.ex .pre')!.textContent).toBe('+۹۸');
    expect(thread(h)).toEqual([
      'q:سلام! برای شروع، اسم‌تون چیه؟', 'v:علی رضایی',
      'q:ممنون علی جان. ایمیل‌تون رو هم بنویسید تا جواب‌ها رو براتون بفرستیم.', 'v:ali@example', 'v:ali@example.com',
      'q:اگه بخواید شماره موبایل‌تون رو هم بدید تا پیامکی خبرتون کنیم.',
    ]);
    expect(prechatPosts(h)).toEqual([]);
    await answer(h, '۰۹۱۲ ۳۴۵ ۶۷۸۹');
    await flush(20);
    expect(prechatPosts(h).map((p) => p.body)).toEqual([
      { workspace_id: 'ws-test', name: 'علی رضایی', email: 'ali@example.com', phone: '+989123456789' },
    ]);
    // In: the saved details, the composer back, the step gone.
    expect(box(h)).toBeNull();
    expect(bar(h).style.display).toBe('flex');
    expect(h.q('[data-prechat-edit]')).not.toBeNull();
    expect(h.calls.some((c) => c.surface === 'prechatSummaryHtml')).toBe(true);
  });

  it('an optional step is skipped (no bubble, no value); a required one offers no skip', async () => {
    const h = start();
    await toChat(h);
    expect(h.q('[data-prechat-step-skip]')).toBeNull();
    await answer(h, 'Ali');
    await answer(h, 'ali@example.com');
    click(h.q('[data-prechat-step-skip]'));
    await flush(20);
    expect(prechatPosts(h).map((p) => p.body)).toEqual([{ workspace_id: 'ws-test', name: 'Ali', email: 'ali@example.com', phone: null }]);
  });

  it('a field the server refuses goes back to its step; a failure says so under the step and a retry sends again', async () => {
    let n = 0;
    const h = start({
      route: (u) => {
        if (!u.endsWith('/identity/prechat')) return undefined;
        n++;
        return n === 1 ? { status: 400, body: { error: 'email_required', field: 'email' } }
          : n === 2 ? { status: 500, body: { error: 'boom' } } : { body: { ok: true, contact_id: 'k1' } };
      },
    });
    await toChat(h);
    await answer(h, 'Ali');
    await answer(h, 'ali@example.com');
    await answer(h, '9123456789');
    await flush(20);
    expect(box(h)!.getAttribute('data-prechat-step')).toBe('email');
    const t = h.env().t as (k: string) => string;
    expect(h.q('[data-chat-messages] .st-err[role="alert"]')!.textContent).toBe(t('required'));
    // Answered again: the phone given before stands, the details go at once.
    await answer(h, 'ali@example.org');
    await flush(20);
    expect(prechatPosts(h)).toHaveLength(2);
    expect(prechatPosts(h)[1].body).toMatchObject({ email: 'ali@example.org', phone: '+989123456789' });
    expect(h.q('[data-prechat-step] .err[role="alert"]')!.textContent).toBe(t('fallbackError'));
    click(h.q('[data-prechat-step-submit]'));
    await flush(20);
    expect(prechatPosts(h)).toHaveLength(3);
    expect(box(h)).toBeNull();
  });

  it('every step optional and skipped: no POST, the chat opens', async () => {
    const h = start({ identity: ASK({ require_name: false, require_email: false }) });
    await toChat(h);
    for (let i = 0; i < 3; i++) {
      click(h.q('[data-prechat-step-skip]'));
      await flush(10);
    }
    expect(prechatPosts(h)).toEqual([]);
    expect(box(h)).toBeNull();
    expect(bar(h).style.display).toBe('flex');
    expect(h.q('[data-chat-messages] [data-prechat-step], [data-prechat]')).toBeNull();
  });

  it('typing from the team meanwhile keeps the step, its text and its focus', async () => {
    const h = start({ realtime: true });
    await toChat(h);
    typeInto(input(h), 'عل');
    const el = input(h);
    h.emitTyping({ actor: 'agent', name: 'سارا' });
    await flush(10);
    expect(input(h)).toBe(el);
    expect(input(h).value).toBe('عل');
    expect(h.shadow.activeElement).toBe(el);
  });

  it('an IME\'s Enter commits its word, never the step', async () => {
    const h = start();
    await toChat(h);
    typeInto(input(h), 'علی');
    key(input(h), 'Enter', { isComposing: true });
    key(input(h), 'Enter', { keyCode: 229 } as KeyboardEventInit);
    await flush(10);
    expect(box(h)!.getAttribute('data-prechat-step')).toBe('name');
  });
});

describe('the saved details, edited', () => {
  it('"edit" opens the steps again with the saved values, and the new ones are saved', async () => {
    const h = start();
    await toChat(h);
    await answer(h, 'Ali');
    await answer(h, 'ali@example.com');
    click(h.q('[data-prechat-step-skip]'));
    await flush(20);
    // Core parks the focus 300 ms after the panel opens (runtime.js open());
    // the visitor edits later than that (under a loaded test run it could
    // otherwise land after the edit's own focus).
    await new Promise((r) => setTimeout(r, 320));
    click(h.q('[data-prechat-edit]'));
    await flush(20);
    expect(box(h)!.getAttribute('data-prechat-step')).toBe('name');
    expect(input(h).value).toBe('Ali');
    expect(h.shadow.activeElement).toBe(input(h));
    expect(bar(h).style.display).toBe('none');
    key(input(h), 'Enter');
    await flush(10);
    expect(input(h).value).toBe('ali@example.com');
    await answer(h, 'ali@new.example');
    click(h.q('[data-prechat-step-skip]'));
    await flush(20);
    expect(prechatPosts(h)).toHaveLength(2);
    expect(prechatPosts(h)[1].body).toMatchObject({ name: 'Ali', email: 'ali@new.example' });
    expect(box(h)).toBeNull();
    expect(bar(h).style.display).toBe('flex');
    expect(h.q('.sum')!.textContent).toContain('ali@new.example');
  });
});

describe('the saved details, edited and left as they were', () => {
  it('every step optional and skipped: no POST, the summary and the composer come back', async () => {
    const h = start({ identity: ASK({ require_name: false, require_email: false }) });
    await toChat(h);
    await answer(h, 'Ali');
    await answer(h, 'ali@example.com');
    click(h.q('[data-prechat-step-skip]'));
    await flush(20);
    click(h.q('[data-prechat-edit]'));
    await flush(20);
    for (let i = 0; i < 3; i++) {
      click(h.q('[data-prechat-step-skip]'));
      await flush(10);
    }
    expect(prechatPosts(h)).toHaveLength(1);
    expect(box(h)).toBeNull();
    expect(bar(h).style.display).toBe('flex');
    expect(h.q('[data-prechat-edit]')).not.toBeNull();
    expect(h.q('.sum')!.textContent).toContain('ali@example.com');
  });
});

describe('the phone prefix comes from the edition', () => {
  const phoneOf = async (edition: string | null, typed: string) => {
    resetWindow();
    vi.restoreAllMocks();
    const h = start({ config: { edition } });
    await toChat(h);
    await answer(h, 'Ali');
    await answer(h, 'ali@example.com');
    const pre = h.q('.ex .pre');
    await answer(h, typed);
    await flush(20);
    return { pre: pre && pre.textContent, phone: prechatPosts(h)[0]?.body.phone, step: box(h)?.getAttribute('data-prechat-step') };
  };
  it('Iran: +98 for a local number; a country code (+ or 00) is kept', async () => {
    expect(await phoneOf('iran', '0912-345-6789')).toEqual({ pre: '+۹۸', phone: '+989123456789', step: undefined });
    expect(await phoneOf(null, '٠٩١٢٣٤٥٦٧٨٩')).toMatchObject({ phone: '+989123456789' });
    expect(await phoneOf('iran', '+44 20 7946 0958')).toMatchObject({ phone: '+442079460958' });
    expect(await phoneOf('iran', '0044 20 7946 0958')).toMatchObject({ phone: '+442079460958' });
  });
  it('International: no prefix; too short is refused in place', async () => {
    expect(await phoneOf('international', '+1 (415) 555-0132')).toEqual({ pre: null, phone: '+14155550132', step: undefined });
    expect(await phoneOf('international', '12')).toEqual({ pre: null, phone: undefined, step: 'phone' });
  });
});

describe('a conversation keeps the mode its pre-chat showed in first', () => {
  it('the card painted before the late pack stays the card when the pack comes', async () => {
    const h = start({ preloaded: false, late: 'hold' });
    await toChat(h);
    expect(h.calls.some((c) => c.surface === 'prechatFormHtml')).toBe(true);
    const form = h.q('[data-prechat="name"]');
    expect(form).not.toBeNull();
    h.releaseLate();
    await flush(30);
    expect(box(h)).toBeNull();
    expect(h.q('[data-prechat="name"]')).not.toBeNull();
    h.runtime.setTab('home');
    await flush();
    h.runtime.setTab('chat');
    await flush(20);
    expect(box(h)).toBeNull();
  });

  it('a new conversation asks in the template\'s mode again', async () => {
    const h = start({ preloaded: false, late: 'hold' });
    await toChat(h);
    h.releaseLate();
    await flush(30);
    expect(box(h)).toBeNull();
    h.runtime.__test.startNew();
    await flush(20);
    h.runtime.setTab('chat');
    await flush(20);
    expect(box(h)!.getAttribute('data-prechat-step')).toBe('name');
  });

  it('back in a conversation whose pre-chat showed as a card, the card again (another one asks in steps)', async () => {
    const said = (cid: string) => [{ id: 'm-' + cid, role: 'agent', sender_type: 'agent', sender_name: 'سارا', text: 'سلام', time: new Date().toISOString(), conversation_id: cid }];
    const h = start({
      preloaded: false,
      late: 'hold',
      conversations: [{ id: 'c1' }, { id: 'c2' }],
      history: { c1: said('c1'), c2: said('c2') },
      identity: ASK({ timing: 'after_handoff' }),
    });
    await flush(40);
    h.runtime.__test.openConversation('c1');
    await flush(40);
    expect(h.q('[data-prechat="name"]')).not.toBeNull();
    h.releaseLate();
    await flush(30);
    expect(box(h)).toBeNull();
    h.runtime.__test.openConversation('c2');
    await flush(40);
    expect(box(h)!.getAttribute('data-prechat-step')).toBe('name');
    h.runtime.__test.openConversation('c1');
    await flush(40);
    expect(box(h)).toBeNull();
    expect(h.q('[data-prechat="name"]')).not.toBeNull();
    expect(bar(h).style.display).not.toBe('none');
  });

  it('`card` (the default option) keeps today\'s form', async () => {
    const h = start({ mode: 'card' });
    await toChat(h);
    expect(box(h)).toBeNull();
    expect(h.q('[data-prechat="name"]')).not.toBeNull();
  });

  it('a handoff opens with its reason, then the steps', async () => {
    const h = start({
      hint: { tab: 'chat', conversationId: 'c1' },
      conversations: [{ id: 'c1' }],
      history: { c1: [{ id: 'm1', role: 'agent', sender_type: 'agent', sender_name: 'سارا', text: 'سلام', time: new Date().toISOString(), conversation_id: 'c1' }] },
      identity: ASK({ timing: 'after_handoff' }),
    });
    await flush(40);
    h.runtime.__test.openConversation('c1');
    await flush(40);
    expect(box(h)!.getAttribute('data-prechat-step')).toBe('name');
    const rows = thread(h);
    expect(rows[0]).toBe('q:سلام');
    expect(rows[rows.length - 1]).toBe('q:سلام! برای شروع، اسم‌تون چیه؟');
    expect(h.q('[data-chat-messages] [data-typing-id="hc-subtitle"]')).not.toBeNull();
    // Answered, the composer comes back unlocked (the card's lock is not left behind).
    await answer(h, 'Ali');
    await answer(h, 'ali@example.com');
    click(h.q('[data-prechat-step-skip]'));
    await flush(20);
    expect(box(h)).toBeNull();
    expect(bar(h).style.display).toBe('flex');
    expect(bar(h).classList.contains('is-locked')).toBe(false);
    expect(h.q<HTMLTextAreaElement>('[data-msg-input]')!.disabled).toBe(false);
  });
});

describe('`default` draws no step', () => {
  it('with prechatMode steps in its config it shows its own form', async () => {
    const h = boot({ renderer: 'default', identity: ASK(), config: { templateOptions: { prechatMode: 'steps' } } });
    await toChat(h);
    expect(h.calls.some((c) => c.surface === 'prechatFormHtml')).toBe(true);
    expect(h.q('[data-prechat-step]')).toBeNull();
  });
});
