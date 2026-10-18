/**
 * Help articles while the first message is written (t2 02·06; issue #340,
 * g3 instant answers), with the SHIPPED runtime.js, runtime-ext.js,
 * runtime-late.js, runtime-kb.js and the real t2 renderer and extras
 * (coreFeaturesHarness.ts):
 *
 *  - GET /api/widget/kb-suggest (workspace, locale, the draft, two at most)
 *    once the typing stopped for 400 ms, never inside an IME composition
 *    (compositionend asks), the request before it aborted, a draft of fewer
 *    than three searchable characters never asked about, an answer kept per
 *    draft (the same draft again asks nothing, an answer for an older draft
 *    is not painted);
 *  - the tray over the composer (two rows at most, the words marked), gone
 *    when the message is sent, the draft emptied, Escape (before the panel's
 *    own Escape; that draft stays dismissed), a 429 (quietly, then nothing
 *    is asked for 30 s);
 *  - only until the team (an operator or the AI, not its greeting) answers;
 *    never with the help center off;
 *  - a row opens its article in the help view; back returns to the chat,
 *    the draft and the tray as they were;
 *  - before the late pack (or without it): nothing.
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

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RESULTS = [
  { slug: 'returns', title: 'شرایط مرجوعی کالا', snippet: '', matches: ['مرجوعی'], readingMinutes: 2 },
  { slug: 'refund', title: 'بازگشت وجه بعد از مرجوعی چقدر طول می‌کشد؟', snippet: '', matches: ['مرجوعی'], readingMinutes: 1 },
  { slug: 'third', title: 'سوم', snippet: '', matches: [], readingMinutes: 1 },
];
type Suggest = (q: string, signal: AbortSignal | null) => ApiAnswer | Promise<ApiAnswer>;
interface Start extends BootOptions { suggest?: Suggest; preloaded?: boolean }
const signals: Array<AbortSignal | null> = [];

function start(opts: Start = {}) {
  if (opts.preloaded !== false) {
    new Function(read('public/widget/presentation-t2-x.js')).call(window);
    new Function(read('public/widget/runtime-late.js')).call(window);
  }
  signals.length = 0;
  const suggest = opts.suggest || (() => ({ body: { results: RESULTS } }));
  return boot({
    renderer: 't2',
    ...opts,
    kb: { article: { slug: 'returns', title: 'شرایط مرجوعی کالا', content: '<p>متن</p>', updated_at: new Date().toISOString() }, ...(opts.kb || {}) },
    api: (url, init) => {
      if (url.includes('/api/widget/kb-suggest')) {
        signals.push((init && (init.signal as AbortSignal)) || null);
        return suggest(new URL(url).searchParams.get('q') || '', (init && (init.signal as AbortSignal)) || null);
      }
      return opts.api ? opts.api(url, init) : undefined;
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
const asks = (h: ReturnType<typeof boot>) => h.fetches.filter((u) => u.includes('/api/widget/kb-suggest'));
const tray = (h: ReturnType<typeof boot>) => h.q('[data-composer-zone] > [data-kb-suggest]');
async function write(h: ReturnType<typeof boot>, text: string, settle = 470) {
  typeInto(composer(h), text);
  await wait(settle);
  await flush(10);
}

describe('asking', () => {
  it('asks once the typing stopped for 400 ms, with the draft, the locale and two at most', async () => {
    const h = start();
    await toChat(h);
    typeInto(composer(h), 'مرج');
    await wait(100);
    typeInto(composer(h), 'مرجوعی کفش');
    await wait(120);
    expect(asks(h)).toEqual([]);
    // 320 ms after the last keystroke: still nothing (a pause between words).
    await wait(200);
    expect(asks(h)).toEqual([]);
    await wait(150);
    await flush(10);
    expect(asks(h)).toHaveLength(1);
    const u = new URL(asks(h)[0]);
    expect(u.pathname).toBe('/api/widget/kb-suggest');
    expect(Object.fromEntries(u.searchParams)).toEqual({ workspace_id: 'ws-test', locale: 'fa', q: 'مرجوعی کفش', limit: '2' });
    const t = tray(h)!;
    expect(t.parentElement!.firstElementChild).toBe(t);
    expect(Array.from(t.querySelectorAll('[data-kb-action="open"]')).map((b) => b.getAttribute('data-kb-slug'))).toEqual(['returns', 'refund']);
    expect(t.querySelector('mark')!.textContent).toBe('مرجوعی');
  });

  it('never inside an IME composition: its end asks', async () => {
    const h = start();
    await toChat(h);
    const el = composer(h);
    el.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    for (const v of ['م', 'مر', 'مرجوعی']) {
      el.value = v;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    }
    await wait(470);
    expect(asks(h)).toEqual([]);
    el.dispatchEvent(new Event('compositionend', { bubbles: true }));
    await wait(470);
    await flush(10);
    expect(asks(h)).toHaveLength(1);
    expect(new URL(asks(h)[0]).searchParams.get('q')).toBe('مرجوعی');
  });

  it('aborts the request before it; the same draft again asks nothing; an older draft\'s answer is not painted', async () => {
    const held: Array<() => void> = [];
    const h = start({
      suggest: (q) => (q === 'مرجوعی' ? new Promise((res) => held.push(() => res({ body: { results: [RESULTS[2]] } }))) : { body: { results: RESULTS } }),
    });
    await toChat(h);
    await write(h, 'مرجوعی');
    expect(asks(h)).toHaveLength(1);
    await write(h, 'مرجوعی کفش');
    expect(asks(h)).toHaveLength(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
    expect(tray(h)!.querySelectorAll('[data-kb-slug]')).toHaveLength(2);
    // The older answer lands late: the tray stays the newer draft's.
    held.forEach((f) => f());
    await flush(10);
    expect(Array.from(tray(h)!.querySelectorAll('[data-kb-slug]')).map((b) => b.getAttribute('data-kb-slug'))).toEqual(['returns', 'refund']);
    // Back to a draft answered before: at once, no request.
    await write(h, 'مرجوعی کفش  ', 40);
    expect(asks(h)).toHaveLength(2);
    expect(tray(h)).not.toBeNull();
  });

  it('asks nothing again for the draft whose answer is on its way', async () => {
    const held: Array<() => void> = [];
    const h = start({ suggest: () => new Promise((res) => held.push(() => res({ body: { results: RESULTS } }))) });
    await toChat(h);
    await write(h, 'مرجوعی کفش');
    expect(asks(h)).toHaveLength(1);
    // The same draft again (an edit undone) while it is asked about.
    await write(h, 'مرجوعی کفش ');
    expect(asks(h)).toHaveLength(1);
    held.forEach((f) => f());
    await flush(10);
    expect(tray(h)).not.toBeNull();
    expect(signals[0]!.aborted).toBe(false);
  });

  it('never for a draft of fewer than three searchable characters', async () => {
    const h = start();
    await toChat(h);
    for (const v of ['سل', '؟؟؟ !!', 'a b', '  ']) await write(h, v);
    expect(asks(h)).toEqual([]);
    expect(tray(h)).toBeNull();
  });
});

describe('the tray', () => {
  it('goes when the message is sent and when the draft empties', async () => {
    const h = start();
    await toChat(h);
    await write(h, 'مرجوعی کفش');
    expect(tray(h)).not.toBeNull();
    await write(h, '', 20);
    expect(tray(h)).toBeNull();
    await write(h, 'مرجوعی کفش', 20);
    expect(tray(h)).not.toBeNull();
    key(composer(h), 'Enter');
    await flush(20);
    expect(h.posts.filter((p) => p.url === 'chat:sendMessage')).toHaveLength(1);
    expect(tray(h)).toBeNull();
  });

  it('Escape closes it before the panel\'s own Escape, for that draft only', async () => {
    const h = start();
    await toChat(h);
    await write(h, 'مرجوعی کفش');
    let panelSaw = 0;
    h.panel.addEventListener('keydown', () => { panelSaw++; });
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    composer(h).dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(panelSaw).toBe(0);
    expect(tray(h)).toBeNull();
    expect(h.q('.wy-view-chat')).not.toBeNull();
    // The same draft (one more space) stays dismissed; another one asks again.
    await write(h, 'مرجوعی کفش ', 40);
    expect(tray(h)).toBeNull();
    await write(h, 'مرجوعی کفش ورزشی');
    expect(tray(h)).not.toBeNull();
    // With no tray, Escape is the panel's again.
    await write(h, '', 20);
    composer(h).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(panelSaw).toBe(1);
  });

  it('a 429 hides it quietly and nothing is asked for 30 s', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const h = start({ suggest: (q) => (q === 'مرجوعی' ? { status: 429, body: { code: 'RATE_LIMITED', retry_after: 30 } } : { body: { results: RESULTS } }) });
    await toChat(h);
    await write(h, 'مرجوعی');
    expect(asks(h)).toHaveLength(1);
    expect(tray(h)).toBeNull();
    await write(h, 'مرجوعی کفش');
    expect(asks(h)).toHaveLength(1);
    now += 31_000;
    await write(h, 'مرجوعی کفش ورزشی');
    expect(asks(h)).toHaveLength(2);
    expect(tray(h)).not.toBeNull();
  });
});

describe('when it is offered', () => {
  it('not once the team answered (the AI greeting is not an answer)', async () => {
    const intro = { id: 'i1', role: 'ai', sender_type: 'ai', text: 'سلام! چطور کمکتان کنم؟', time: new Date(Date.now() - 60_000).toISOString(), metadata: { source: 'ai_agent_intro' } };
    const op = { id: 'o1', role: 'agent', sender_type: 'agent', sender_name: 'سارا', text: 'سلام', time: new Date().toISOString() };
    const greeted = start({ hint: { tab: 'chat', conversationId: 'c1' }, conversations: [{ id: 'c1' }], history: { c1: [intro] } });
    await toChat(greeted);
    expect(greeted.runtime.__test.chatState().messages).toHaveLength(1);
    await write(greeted, 'مرجوعی کفش');
    expect(asks(greeted)).toHaveLength(1);
    resetWindow();
    const answered = start({ hint: { tab: 'chat', conversationId: 'c1' }, conversations: [{ id: 'c1' }], history: { c1: [intro, op] } });
    await toChat(answered);
    expect(answered.runtime.__test.chatState().messages).toHaveLength(2);
    await write(answered, 'مرجوعی کفش');
    expect(asks(answered)).toEqual([]);
    expect(tray(answered)).toBeNull();
  });

  it('a team answer arriving takes it away', async () => {
    const h = start({ realtime: true, hint: { tab: 'chat', conversationId: 'c1' }, conversations: [{ id: 'c1' }], history: { c1: [] } });
    await toChat(h);
    await write(h, 'مرجوعی کفش');
    expect(tray(h)).not.toBeNull();
    h.emitMessages([{ id: 'o1', conversation_id: 'c1', role: 'agent', sender_type: 'agent', sender_name: 'سارا', text: 'سلام', time: new Date().toISOString() }]);
    await flush(20);
    expect(h.runtime.__test.chatState().messages).toHaveLength(1);
    expect(tray(h)).toBeNull();
  });

  it('never with the help center off, nor before the late pack', async () => {
    const off = start({ config: { features: { chat: true, knowledgeBase: false } } });
    await toChat(off);
    await write(off, 'مرجوعی کفش');
    expect(asks(off)).toEqual([]);
    resetWindow();
    const before = start({ preloaded: false, late: 'hold' });
    await toChat(before);
    await write(before, 'مرجوعی کفش');
    expect(asks(before)).toEqual([]);
    expect(tray(before)).toBeNull();
  });
});

describe('opening an article', () => {
  it('opens it in the help view; back returns to the chat with the draft and the tray', async () => {
    const h = start();
    await toChat(h);
    await write(h, 'مرجوعی کفش');
    click(tray(h)!.querySelector('[data-kb-slug="returns"]'));
    await flush(30);
    expect(tray(h)).toBeNull();
    const article = h.fetches.filter((u) => u.includes('/api/widget/kb/article?'));
    expect(article).toHaveLength(1);
    expect(new URL(article[0]).searchParams.get('slug')).toBe('returns');
    expect(h.q('.kb-article-root')).not.toBeNull();
    click(h.q('.kb-article-root [data-view-back]'));
    await flush(30);
    expect(h.q('.wy-view-chat')).not.toBeNull();
    expect(composer(h).value).toBe('مرجوعی کفش');
    expect(tray(h)).not.toBeNull();
    expect(asks(h)).toHaveLength(1);
  });

  it('an article opened from the help list still goes back to the list', async () => {
    const h = start({ kb: { articles: [{ slug: 'returns', title: 'شرایط مرجوعی کالا', excerpt: 'x' }] } });
    await toChat(h);
    await write(h, 'مرجوعی کفش');
    click(tray(h)!.querySelector('[data-kb-slug="returns"]'));
    await flush(30);
    click(h.q('.kb-article-root [data-view-back]'));
    await flush(30);
    h.runtime.setTab('help');
    await flush(30);
    click(h.q('.wy-view-kb [data-kb-slug="returns"]'));
    await flush(30);
    click(h.q('.kb-article-root [data-view-back]'));
    await flush(30);
    expect(h.q('.wy-view-kb:not(.kb-article-root)')).not.toBeNull();
    expect(h.q('.wy-view-chat')).toBeNull();
  });
});
