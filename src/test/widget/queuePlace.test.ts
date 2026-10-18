/**
 * The visitor's place in the queue (t1 08·c; issue #340, g4 f2), with the
 * SHIPPED runtime.js, runtime-ext.js, runtime-late.js and the real t1
 * renderer and extras (coreFeaturesHarness.ts):
 *
 *  - while the thread's last word on routing is "in the queue" and the
 *    thread is on screen (panel open, chat tab, page visible), GET
 *    /api/widget/queue asks at once and every 30 s; the row shows the place
 *    (and the wait, when the server knows one), repainted only on a change;
 *  - it stops for good when the server says the visitor is not waiting any
 *    more, or an operator joins; it pauses while the panel is closed or the
 *    page hidden; a failed request keeps what was shown;
 *  - `default` never asks.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { boot, resetWindow, type ApiAnswer, type BootOptions } from './coreFeaturesHarness';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

beforeEach(() => {
  resetWindow();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
});

const T = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const visitorMsg = { id: 'v1', role: 'visitor', sender_type: 'contact', text: 'سلام، سفارش ۴۸۲۱۳ هنوز کد رهگیری نداره.', time: T(3), conversation_id: 'c1' };
const queued = (id = 'q1', min = 2) => ({
  id, role: 'system', sender_type: 'system', text: 'Your message is in the support queue.', time: T(min), conversation_id: 'c1',
  metadata: { kind: 'routing_in_queue' },
});
const joined = { id: 'j1', role: 'system', sender_type: 'system', text: 'Sara joined', time: T(0), conversation_id: 'c1', metadata: { kind: 'routing_agent_joined', agent_name: 'سارا' } };

function start(answers: Array<ApiAnswer | 'fail'>, opts: BootOptions = {}) {
  new Function(read('public/widget/presentation-t1-x.js')).call(window);
  new Function(read('public/widget/runtime-late.js')).call(window);
  let i = 0;
  return boot({
    renderer: 't1',
    realtime: true,
    conversations: [{ id: 'c1' }],
    history: { c1: [visitorMsg, queued()] },
    api: (url) => {
      if (!url.includes('/api/widget/queue?')) return undefined;
      const a = answers[Math.min(i++, answers.length - 1)];
      return a === 'fail' ? Promise.reject(new Error('offline')) as unknown as ApiAnswer : a;
    },
    ...opts,
  });
}
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
async function open(h: ReturnType<typeof boot>) {
  await tick(50);
  h.runtime.__test.openConversation('c1');
  await tick(50);
}
const asks = (h: ReturnType<typeof boot>) => h.fetches.filter((u) => u.includes('/api/widget/queue?'));
const pill = (h: ReturnType<typeof boot>) => Array.from(h.shadow.querySelectorAll('[data-chat-messages] .msg-system-pill')).map((p) => p.textContent);
const paints = (h: ReturnType<typeof boot>) => h.calls.filter((c) => c.surface === 'messagesHtml').length;

describe('the place in the queue', () => {
  it('asked at once for a queued thread, then every 30 s; the row says it; repainted only when it changes', async () => {
    const h = start([{ body: { position: 2, wait_minutes: 3 } }, { body: { position: 2, wait_minutes: 3 } }, { body: { position: 1, wait_minutes: null } }]);
    await open(h);
    expect(asks(h)).toEqual(['https://api.test/api/widget/queue?workspace_id=ws-test&conversation_id=c1']);
    expect(pill(h)).toEqual(['نفر ۲ در صف · حدود ۳ دقیقه']);
    expect(h.q('.msg-system-pill .live:not(.off)')).not.toBeNull();
    const before = paints(h);
    await tick(30_000);
    expect(asks(h)).toHaveLength(2);
    expect(paints(h)).toBe(before);
    await tick(30_000);
    expect(asks(h)).toHaveLength(3);
    expect(pill(h)).toEqual(['نفر ۱ در صف']);
  });

  it('stops when the server says the visitor is not waiting any more: Core\'s own words again', async () => {
    const h = start([{ body: { position: 2, wait_minutes: null } }, { body: { position: null, wait_minutes: null } }]);
    await open(h);
    await tick(30_000);
    expect(asks(h)).toHaveLength(2);
    expect(pill(h)).toEqual([(h.env().t as (k: string) => string)('routingInQueue')]);
    await tick(120_000);
    expect(asks(h)).toHaveLength(2);
  });

  it('stops when an operator joins', async () => {
    const h = start([{ body: { position: 3, wait_minutes: 5 } }]);
    await open(h);
    h.emitMessages([joined]);
    await tick(50);
    await tick(60_000);
    expect(asks(h)).toHaveLength(1);
    expect(pill(h).some((t) => t && t.includes('در صف ·'))).toBe(false);
  });

  it('pauses while the panel is closed or the page hidden, and asks again when it is back', async () => {
    const h = start([{ body: { position: 2, wait_minutes: 3 } }]);
    await open(h);
    (h.runtime as unknown as { close: () => void }).close();
    await tick(90_000);
    expect(asks(h)).toHaveLength(1);
    h.runtime.open();
    await tick(50);
    expect(asks(h)).toHaveLength(2);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    await tick(90_000);
    expect(asks(h)).toHaveLength(2);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    await tick(50);
    expect(asks(h)).toHaveLength(3);
  });

  it('a failed request keeps what was shown, and tries again later', async () => {
    const h = start([{ body: { position: 4, wait_minutes: 9 } }, 'fail', { status: 500, body: {} }, { body: { position: 3, wait_minutes: 7 } }]);
    await open(h);
    await tick(30_000);
    await tick(30_000);
    expect(pill(h)).toEqual(['نفر ۴ در صف · حدود ۹ دقیقه']);
    await tick(30_000);
    expect(pill(h)).toEqual(['نفر ۳ در صف · حدود ۷ دقیقه']);
  });

  it('a refusal (400, 403) is not asked again; a busy server (429) is', async () => {
    const h = start([{ body: { position: 2, wait_minutes: null } }, { status: 403, body: { code: 'CONVERSATION_ACCESS_DENIED' } }]);
    await open(h);
    await tick(30_000);
    await tick(120_000);
    expect(asks(h)).toHaveLength(2);
    resetWindow();
    vi.restoreAllMocks();
    const h2 = start([{ status: 429, body: {} }, { body: { position: 2, wait_minutes: null } }]);
    await open(h2);
    await tick(30_000);
    expect(asks(h2)).toHaveLength(2);
    expect(pill(h2)).toEqual(['نفر ۲ در صف']);
  });

  it('nothing is asked for a thread that is not queued', async () => {
    const h = start([{ body: { position: 1 } }], { history: { c1: [visitorMsg, queued(), joined] } });
    await open(h);
    await tick(60_000);
    expect(asks(h)).toEqual([]);
  });
});

describe('`default`', () => {
  it('never asks for the place, and keeps its row\'s words', async () => {
    const h = boot({ renderer: 'default', realtime: true, conversations: [{ id: 'c1' }], history: { c1: [visitorMsg, queued()] } });
    await open(h);
    await tick(60_000);
    expect(h.fetches.some((u) => u.includes('/api/widget/queue'))).toBe(false);
  });
});
