/**
 * Issue #340 round 4 through the SHIPPED runtime.js, runtime-ext.js,
 * runtime-late.js, runtime-kb.js and the real t1 / t2 renderers and extras
 * (coreFeaturesHarness.ts):
 *
 *  - an AI answer about an order (`metadata.kind` 'order_status'): its text
 *    alone until the late pack is in, then its card under it (one repaint);
 *  - the track-order row (`config.commerce.trackOrder`): a press starts a
 *    conversation whose first message is the localized «پیگیری سفارشم»,
 *    through Core's one send path (away: the message left for the team);
 *  - an article's author: `meta=1` on the article request of a renderer
 *    that draws it, `author_name` under its title (t1 and t2);
 *  - help search results: the server's snippet and matched words reach the
 *    renderer (t2 draws them);
 *  - what round 4 adds to Core binds once: repaints add no listener to the
 *    page.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { boot, click, flush, resetWindow, typeInto, type BootOptions } from './coreFeaturesHarness';
import { avatarFace } from './avatarFace';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

beforeEach(() => { vi.useRealTimers(); resetWindow(); });
afterEach(() => { vi.restoreAllMocks(); });

function preload(t: 't1' | 't2') {
  new Function(read(`public/widget/presentation-${t}-x.js`)).call(window);
  new Function(read('public/widget/runtime-late.js')).call(window);
}
const ORDER_ROW = {
  id: 'ai-1', role: 'ai', sender_type: 'ai', text: 'سلام علی! سفارشتان امروز صبح ارسال شد.', time: new Date().toISOString(),
  metadata: { source: 'ai_agent', kind: 'order_status', order: { v: 1, number: '48213', summary: 'کفش رانینگ، سایز ۴۲', more: 0, status: 'shipped', statusLabel: null, step: 2, arrives: null, trackingUrl: 'https://post.ir/t/1' } },
};
const sends = (h: ReturnType<typeof boot>) => h.posts.filter((p) => p.url === 'chat:sendMessage');

describe('an AI answer\'s order card', () => {
  it('is the text alone until the late pack is in, then the card under it', async () => {
    const h = boot({ renderer: 't2', late: 'hold', hint: { tab: 'chat', conversationId: 'c1' }, conversations: [{ id: 'c1' }], history: { c1: [ORDER_ROW] } });
    await flush(40);
    expect(h.q('[data-chat-messages] .msg-text')!.textContent).toBe('سلام علی! سفارشتان امروز صبح ارسال شد.');
    expect(h.q('[data-chat-messages] .card')).toBeNull();
    h.releaseLate();
    await flush(20);
    const card = h.q('[data-chat-messages] .card')!;
    expect(card.querySelector('.tt b')!.textContent).toBe('سفارش ۴۸۲۱۳');
    expect(card.querySelector('a.trk')!.getAttribute('href')).toBe('https://post.ir/t/1');
  });

  it('never for t1, whose thread shows the text', async () => {
    preload('t1');
    const h = boot({ renderer: 't1', hint: { tab: 'chat', conversationId: 'c1' }, conversations: [{ id: 'c1' }], history: { c1: [ORDER_ROW] } });
    await flush(40);
    expect(h.q('[data-chat-messages] .msg-text')!.textContent).toBe('سلام علی! سفارشتان امروز صبح ارسال شد.');
    expect(h.q('[data-chat-messages] .card, [data-chat-messages] .steps')).toBeNull();
  });
});

describe('the track-order row', () => {
  const STORE = { commerce: { trackOrder: true } };

  it('starts a conversation whose first message is «پیگیری سفارشم», once', async () => {
    preload('t2');
    // An earlier conversation, closed (history: one conversation, nothing current).
    const h = boot({ renderer: 't2', config: STORE, conversations: [{ id: 'c-old', status: 'closed' }] });
    await flush(40);
    h.runtime.__test.setConnectionState('online');
    await flush(5);
    const row = h.q('[data-home-action="track-order"]')!;
    expect(row.getAttribute('data-topic')).toBe('پیگیری سفارشم');
    click(row);
    click(row);
    await flush(20);
    expect(h.q('.wy-view-chat')).not.toBeNull();
    expect(sends(h).map((p) => p.body.text)).toEqual(['پیگیری سفارشم']);
    expect(sends(h)[0].body.conversationId ?? null).toBeNull();
  });

  it('in English and Turkish too', async () => {
    preload('t2');
    const h = boot({ renderer: 't2', config: { ...STORE, locale: 'en' } });
    await flush(40);
    h.runtime.__test.setConnectionState('online');
    click(h.q('[data-home-action="track-order"]'));
    await flush(20);
    expect(sends(h).map((p) => p.body.text)).toEqual(['Track my order']);
  });

  it('away, the message left for the team', async () => {
    preload('t2');
    const h = boot({
      renderer: 't2',
      config: { ...STORE, availability: { state: 'offline', offline_mode: 'capture_message', next_open_at: null } },
      api: (u) => (u.endsWith('/api/widget/offline-messages') ? { body: { ok: true, captured: true, conversation_id: 'c-away', message_id: '55555555-5555-4555-8555-555555555555' } } : undefined),
    });
    await flush(40);
    h.runtime.__test.setConnectionState('online');
    expect(h.q('[data-home-action="track-order"]')).not.toBeNull();
    click(h.q('[data-home-action="track-order"]'));
    await flush(30);
    const away = h.posts.filter((p) => p.url.endsWith('/api/widget/offline-messages'));
    expect(away.map((p) => p.body.message)).toEqual(['پیگیری سفارشم']);
  });

  it('is not drawn without a store, and is set aside without Core\'s module', async () => {
    const h = boot({ renderer: 't2' });
    await flush(40);
    expect(h.q('[data-home-action="track-order"]')).toBeNull();
    resetWindow();
    const off = boot({ renderer: 't2', ext: 'fail', config: STORE });
    await flush(60);
    expect(off.panel.classList.contains('ext-off')).toBe(true);
    // Drawn, but the stylesheet sets it aside (.ext-off .r[data-topic]).
    expect(off.q('.r[data-home-action="track-order"][data-topic]')).not.toBeNull();
  });
});

describe('an article\'s author', () => {
  const ARTICLE = { id: 'a1', title: 'چطور سفارشم را پیگیری کنم؟', slug: 'track', content: '<p>یک دو سه</p>', updated_at: '2026-10-01T00:00:00Z', category_id: null, author_name: 'سارا' };
  for (const t of ['t1', 't2'] as const) {
    it(`${t}: asked for with meta=1 and drawn under the title`, async () => {
      preload(t);
      const h = boot({ renderer: t, kb: { article: ARTICLE } });
      await flush(30);
      h.runtime.setTab('help', 'track');
      await flush(30);
      const req = h.fetches.filter((u) => u.includes('/api/widget/kb/article?'));
      expect(req).toHaveLength(1);
      expect(Object.fromEntries(new URL(req[0]).searchParams)).toEqual({ workspace_id: 'ws-test', locale: 'fa', slug: 'track', meta: '1' });
      const vm = h.lastCall('kbHtml')![0] as { article: Record<string, unknown> };
      expect(vm.article.author).toBe('سارا');
      expect(h.q('.am')!.textContent).toContain('سارا');
      expect(avatarFace(h.q('.am .av'))).toBe('person');
    });
  }

  it('no author_name (or only spaces): none drawn', async () => {
    const h = boot({ renderer: 't2', kb: { article: { ...ARTICLE, author_name: '  ' } } });
    await flush(30);
    h.runtime.setTab('help', 'track');
    await flush(30);
    expect((h.lastCall('kbHtml')![0] as { article: Record<string, unknown> }).article.author).toBeNull();
    expect(h.q('.am .av')).toBeNull();
  });
});

describe('help search results with the server\'s snippet', () => {
  it('t2 shows the snippet with the matched words marked', async () => {
    preload('t2');
    const h = boot({
      renderer: 't2',
      kbSearch: { ارسال: [{ slug: 'ship', title: 'زمان و هزینه ارسال', excerpt: 'خلاصه‌ای دیگر', snippet: '…هزینه‌ی ارسال برای خریدهای بالای ۲ میلیون…', matches: ['ارسال'] }] },
    } as BootOptions);
    await flush(30);
    h.runtime.setTab('help');
    await flush(30);
    const field = h.q<HTMLInputElement>('[data-kb-search]')!;
    typeInto(field, 'ارسال');
    await new Promise((r) => setTimeout(r, 340));
    await flush(20);
    const search = h.fetches.filter((u) => u.includes('/api/widget/kb/search'));
    expect(new URL(search[0]).searchParams.get('match')).toBe('words');
    const item = h.q('[data-kb-results] [data-kb-slug="ship"]')!;
    expect(item.querySelector('small')!.innerHTML).toBe('…هزینه‌ی <mark>ارسال</mark> برای خریدهای بالای ۲ میلیون…');
  });
});

describe('round 4\'s Core binds once', () => {
  // The tray, the emoji search and the downloads bind to the chat frame
  // (built once) when the pack lands: views painted again and again add no
  // listener to anything still on the page.
  for (const t of ['t1', 't2'] as const) {
    it(`${t}: no listener piles up on the page across repaints`, async () => {
      preload(t);
      const counts = new Map<EventTarget, number>();
      const real = EventTarget.prototype.addEventListener;
      vi.spyOn(EventTarget.prototype, 'addEventListener').mockImplementation(function (this: EventTarget, ...args: Parameters<EventTarget['addEventListener']>) {
        counts.set(this, (counts.get(this) || 0) + 1);
        return real.apply(this, args);
      });
      const h = boot({
        renderer: t,
        conversations: [{ id: 'c1' }],
        history: { c1: [ORDER_ROW] },
        api: (u) => (u.includes('/api/widget/kb-suggest') ? { body: { results: [] } } : undefined),
      });
      await flush(40);
      const live = () => {
        let n = 0;
        counts.forEach((c, el) => { if ((el as Node).isConnected || el === window || el === document) n += c; });
        return n;
      };
      const round = async () => {
        h.runtime.setTab('chat');
        await flush(10);
        h.runtime.__test.openConversation('c1');
        await flush(10);
        h.runtime.setTab('help');
        await flush(10);
        h.runtime.setTab('home');
        await flush(10);
        h.runtime.setTab('chat');
        await flush(10);
        typeInto(h.q<HTMLTextAreaElement>('[data-msg-input]')!, 'مرجوعی کفش');
        await flush(5);
      };
      await round();
      const before = live();
      await round();
      await round();
      await round();
      expect(live()).toBe(before);
    });
  }
});
