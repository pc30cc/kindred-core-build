/**
 * The visitor's panel, driven through the SHIPPED runtime.js in jsdom (the
 * default, t1 and t2 renderers through the real registry):
 *
 *   V-07  a page view counts the replies that came while the visitor was
 *         elsewhere (the thread list's unread counts): the launcher badge,
 *         one preview beside it per reply, and the loader's `gs_active`
 *         hint while a thread is open or pending; replies the visitor saw
 *         where they landed move the read marker, so they never come back
 *         as unread;
 *   V-12  a closed conversation reads as over in the lists (never "open",
 *         no live dot), and a message that opens a new conversation under
 *         an ended one is set apart by a "New conversation" divider;
 *   V-13  the department picker speaks the visitor's language, marks a
 *         department nobody answers now, never stands in front of an open
 *         thread, and a new conversation asks again;
 *   V-22  the panel carries a readable accent (4.5:1 for its ink);
 *   V-24  on a phone (the panel is the whole screen) it is modal: aria-modal
 *         and Tab kept inside; on a computer it is not;
 *   V-26  the panel declares the widget's language;
 *   V-28  the first message answering a "Message inside the chat" names the
 *         rule, and the line the server stored takes the local one's place.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boot, click, flush, resetWindow, typeInto, win, type BootOptions, type Dict } from './coreFeaturesHarness';

const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
const RULE = '0c6b1c2e-1d2a-4e3b-9c4d-5e6f7a8b9c0d';

beforeEach(() => {
  vi.useRealTimers();
  resetWindow();
  document.cookie = 'gs_active=; path=/; max-age=0';
  delete (window as unknown as Dict).matchMedia;
});
afterEach(() => { vi.restoreAllMocks(); });

type Harness = ReturnType<typeof boot>;
interface ChatSend {
  text: string;
  clientMessageId: string;
  smartRule?: { id: string; locale: string | null } | null;
  onAccepted: (info: Dict) => void;
  onConversation: (cid: string) => void;
}
const sends = (h: Harness) => h.posts.filter((p) => p.url === 'chat:sendMessage').map((p) => p.body as unknown as ChatSend);
function write(h: Harness, text: string) {
  typeInto(h.q<HTMLTextAreaElement>('[data-msg-input]')!, text);
  click(h.q('[data-send-btn]'));
}
async function inThread(opts: BootOptions = {}) {
  const h = boot({
    hint: { tab: 'chat', conversationId: 'c1' },
    conversations: [{ id: 'c1', status: 'closed' }],
    history: { c1: [{ id: 'op-1', role: 'agent', sender_type: 'agent', sender_name: 'سارا', text: 'روز خوش', time: iso(60_000) }] },
    ...opts,
  });
  await flush(40);
  // A closed thread is not reopened by itself at boot: the visitor opens it from the list.
  h.runtime.__test.openConversation('c1');
  await flush(20);
  h.runtime.__test.setConnectionState('online');
  await flush(5);
  return h;
}

describe('V-07: replies that came while the visitor was on another page', () => {
  it('reach the launcher (badge) and, once, the preview beside it; the hint says a thread is going on', async () => {
    const h = boot({ open: false, conversations: [{ id: 'c1', status: 'open', unreadCount: 2, operatorName: 'سارا' }] });
    await flush(40);
    expect(h.unread[h.unread.length - 1]).toBe(2);
    const toast = h.q('.gs-toast')!;
    expect(toast).not.toBeNull();
    expect(toast.style.display).toBe('block');
    expect(toast.textContent).toContain('سارا');
    expect(toast.textContent).toContain('preview c1');
    expect(document.cookie).toContain('gs_active=1');
  });

  it('the same reply is not previewed again on the next page (the badge still is)', async () => {
    // The thread list as the server answers it on both pages: the same last reply.
    const at = iso(30_000);
    const api = (url: string) => (url.includes('/api/widget/conversations') && !url.includes('/read')
      ? { body: { conversations: [{ id: 'c1', status: 'open', preview: 'موجود است', unreadCount: 1, outbound: false, updatedAt: at, lastMessageAt: at }] } }
      : undefined);
    const first = boot({ open: false, api });
    await flush(40);
    expect(first.q('.gs-toast')!.style.display).toBe('block');
    // The next page in the same tab: a fresh runtime, the same session storage.
    document.body.innerHTML = '';
    for (const key of Object.keys(win)) if (key.startsWith('__gs')) delete win[key];
    win.__GS_WIDGET_TEST_HOOKS__ = true;
    vi.restoreAllMocks();
    const next = boot({ open: false, api });
    await flush(40);
    expect(next.unread[next.unread.length - 1]).toBe(1);
    const toast = next.q('.gs-toast');
    expect(!toast || toast.style.display !== 'block').toBe(true);
  });

  it('the thread the visitor has open in view counts none', async () => {
    const h = await inThread({ conversations: [{ id: 'c1', status: 'open', unreadCount: 3 }] });
    expect(h.unread.every((n) => n === 0)).toBe(true);
  });

  it('with no open or pending thread the hint goes', async () => {
    document.cookie = 'gs_active=1; path=/';
    const h = boot({ open: false, conversations: [{ id: 'c1', status: 'resolved' }] });
    await flush(40);
    expect(h.unread.every((n) => n === 0)).toBe(true);
    expect(document.cookie).not.toContain('gs_active=1');
  });

  it('a runtime booted with the panel closed never takes the page\'s focus', async () => {
    const field = document.createElement('input');
    document.body.appendChild(field);
    field.focus();
    boot({ open: false, conversations: [{ id: 'c1', status: 'open', unreadCount: 1 }] });
    await flush(40);
    await new Promise((r) => setTimeout(r, 260));
    expect(document.activeElement).toBe(field);
  });
});

describe('V-07: what the visitor read where it landed is read for the server too', () => {
  // The server counts a thread's replies after the visitor's read marker as
  // unread on the next page view (badge, title, preview), so the marker
  // follows what is seen, not only a thread opened from the list.
  const reads = (h: Harness, cid = 'c1') => h.fetches.filter((u) => u.includes(`/api/widget/conversations/${cid}/read`)).length;
  const reply = (id: string, cid = 'c1') => ({ id, conversation_id: cid, role: 'agent', sender_type: 'agent', sender_name: 'سارا', text: 'پاسخ ' + id, time: iso() });
  afterEach(() => { vi.useRealTimers(); });

  it('a reply that lands in the thread open in view moves the marker, once for a burst', async () => {
    const h = boot({ realtime: true, hint: { tab: 'chat', conversationId: 'c1' }, conversations: [{ id: 'c1', status: 'open' }], history: { c1: [] } });
    await flush(40);
    h.runtime.__test.setConnectionState('online');
    await flush(5);
    const before = reads(h);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    h.emitMessages([reply('op-1')]);
    h.emitMessages([reply('op-2')]);
    await vi.advanceTimersByTimeAsync(500);
    // Not one request per reply.
    expect(reads(h)).toBe(before);
    await vi.advanceTimersByTimeAsync(5000);
    expect(reads(h)).toBe(before + 1);
    // Nothing new: nothing more.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reads(h)).toBe(before + 1);
    expect(h.unread.every((n) => n === 0)).toBe(true);
  });

  it('replies that came while the panel was closed are read when it opens again', async () => {
    // The visitor has written in it (a thread without a visitor line opens by itself on a reply).
    const history = { c1: [{ id: 'v-1', role: 'visitor', sender_type: 'visitor', text: 'سلام', time: iso(60_000) }] };
    const h = boot({ realtime: true, hint: { tab: 'chat', conversationId: 'c1' }, conversations: [{ id: 'c1', status: 'open' }], history });
    await flush(40);
    h.runtime.__test.setConnectionState('online');
    await flush(5);
    h.runtime.close();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const before = reads(h);
    h.emitMessages([reply('op-3')]);
    await vi.advanceTimersByTimeAsync(6000);
    // Closed: unread, and not read for the server.
    expect(h.unread[h.unread.length - 1]).toBe(1);
    expect(reads(h)).toBe(before);
    h.runtime.open();
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.unread[h.unread.length - 1]).toBe(0);
    expect(reads(h)).toBe(before + 1);
  });

  it('a reply in the background is not read for the server until the visitor is back', async () => {
    const h = boot({ realtime: true, hint: { tab: 'chat', conversationId: 'c1' }, conversations: [{ id: 'c1', status: 'open' }], history: { c1: [] } });
    await flush(40);
    h.runtime.__test.setConnectionState('online');
    await flush(5);
    const before = reads(h);
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    h.emitMessages([reply('op-4')]);
    await vi.advanceTimersByTimeAsync(6000);
    expect(reads(h)).toBe(before);
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(reads(h)).toBe(before + 1);
  });

  it('the conversation a first message opens is read with the lines already on screen', async () => {
    const h = boot({ conversations: [] });
    await flush(40);
    h.runtime.__test.setConnectionState('online');
    h.runtime.setTab('chat');
    await flush(10);
    write(h, 'سلام');
    await flush(5);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const send = sends(h)[0];
    send.onConversation('c-new');
    send.onAccepted({ conversationId: 'c-new', messageId: 'srv-1' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(reads(h, 'c-new')).toBe(1);
  });
});

describe('V-12: the end of a conversation reads as such', () => {
  for (const renderer of ['default', 't1'] as const) {
    it(`${renderer}: a closed conversation is listed as resolved, never open (no live dot)`, async () => {
      const h = boot({ renderer, conversations: [{ id: 'c1', status: 'closed' }, { id: 'c2', status: 'open' }] });
      await flush(40);
      h.runtime.setTab('list');
      await flush(10);
      const rows = Array.from(h.shadow.querySelectorAll('[data-conversation-open]'));
      const closed = rows.find((r) => r.getAttribute('data-conversation-open') === 'c1')!;
      const open = rows.find((r) => r.getAttribute('data-conversation-open') === 'c2')!;
      expect(closed.textContent).toContain('حل‌شده');
      expect(closed.textContent).not.toContain('باز');
      expect(closed.querySelector('.live')).toBeNull();
      expect(open.textContent).toContain('باز');
    });

    it(`${renderer}: a message that opens a new conversation under an ended one comes after a divider`, async () => {
      const h = await inThread({ renderer });
      write(h, 'یک سؤال دیگر');
      await flush(5);
      const [s] = sends(h);
      // The thread on screen had ended: the server put the message in a new conversation.
      s.onConversation('c2');
      s.onAccepted({ conversationId: 'c2', messageId: 'm-new' });
      await flush(10);
      const list = h.q('[data-chat-messages]')!;
      const html = list.innerHTML;
      const divider = html.indexOf('گفتگوی جدید');
      expect(divider).toBeGreaterThan(html.indexOf('روز خوش'));
      expect(divider).toBeLessThan(html.indexOf('یک سؤال دیگر'));
    });
  }

  it('a send that stays in the same conversation draws no divider', async () => {
    const h = await inThread({ conversations: [{ id: 'c1', status: 'open' }] });
    write(h, 'ادامه');
    await flush(5);
    const [s] = sends(h);
    s.onConversation('c1');
    s.onAccepted({ conversationId: 'c1', messageId: 'm-next' });
    await flush(10);
    expect(h.q('[data-chat-messages]')!.textContent).not.toContain('گفتگوی جدید');
  });
});

describe('V-13: the department picker', () => {
  const DEPTS = {
    mode: 'multi', channel: 'chat', default_department_id: null,
    visible_departments: [
      { id: 'd-sales', name: 'فروش', capabilities: { chat: true, audio: false, video: false }, online: true },
      { id: 'd-support', name: 'پشتیبانی فنی', capabilities: { chat: true, audio: true, video: false }, online: false },
    ],
  };
  const api = (url: string) => (url.includes('/api/widget/departments/visible') ? { body: DEPTS } : undefined);

  for (const renderer of ['default', 't2'] as const) {
    it(`${renderer}: in the visitor's language, the department nobody answers now marked`, async () => {
      const h = boot({ renderer, api });
      await flush(40);
      h.runtime.setTab('chat');
      await flush(20);
      const picker = h.q('.dept-picker')!;
      expect(picker).not.toBeNull();
      expect(picker.getAttribute('aria-label')).toBe('دپارتمان‌ها');
      expect(picker.textContent).toContain('چطور می‌توانیم کمکتان کنیم؟');
      expect(picker.textContent).toContain('دپارتمانی را که می‌خواهید با آن گفتگو کنید انتخاب کنید');
      expect(picker.textContent).not.toMatch(/How can we help|Choose a team|Chat|Voice/);
      const away = h.q('[data-dept-id="d-support"]')!;
      expect(away.classList.contains('is-offline')).toBe(true);
      expect(away.textContent).toContain('اکنون آفلاین');
      expect(h.q('[data-dept-id="d-sales"]')!.textContent).not.toContain('آفلاین');
    });
  }

  it('never in front of an open thread (a new tab of an open conversation)', async () => {
    const h = await inThread({ api, conversations: [{ id: 'c1', status: 'open' }] });
    h.runtime.setTab('chat');
    await flush(20);
    expect(h.q('.dept-picker')).toBeNull();
    expect(h.q('[data-msg-input]')).not.toBeNull();
  });

  it('a new conversation is a new choice of department', async () => {
    const h = boot({ api });
    await flush(40);
    h.runtime.setTab('chat');
    await flush(20);
    click(h.q('[data-dept-id="d-sales"]'));
    await flush(10);
    expect(h.q('.dept-picker')).toBeNull();
    h.runtime.__test.startNew();
    await flush(20);
    expect(h.q('.dept-picker')).not.toBeNull();
  });
});

describe('V-22 / V-24 / V-26: the panel itself', () => {
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a: string, b: string) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };

  it('declares the widget\'s language, whatever the page\'s', async () => {
    document.documentElement.lang = 'en';
    const fa = boot();
    expect(fa.panel.getAttribute('lang')).toBe('fa');
    resetWindow();
    vi.restoreAllMocks();
    const tr = boot({ config: { locale: 'tr-TR' } });
    expect(tr.panel.getAttribute('lang')).toBe('tr');
  });

  // On the shell, where the template's stylesheet resolves --wy-accent
  // (e2e/widgetAccentContrast.spec.ts checks the colours a browser draws).
  const shellOf = (h: Harness) => h.shadow.querySelector<HTMLElement>('.shell')!;
  for (const color of ['#3B82F6', '#F59E0B', '#1F93FF', '#FFEB3B', '#6D5DFB']) {
    it(`a readable accent for ${color}: its ink reaches 4.5:1`, () => {
      const h = boot({ config: { primaryColor: color } });
      const bg = shellOf(h).style.getPropertyValue('--gs-primary-aa');
      const ink = shellOf(h).style.getPropertyValue('--gs-on-primary');
      expect(bg).toMatch(/^#[0-9a-f]{6}$/);
      expect(ratio(bg, ink)).toBeGreaterThanOrEqual(4.5);
      expect(h.panel.style.getPropertyValue('--gs-primary-aa')).toBe('');
    });
  }

  it('the readable accent is made from the colour the shell wears (a kit\'s, in place of the uncustomised one)', () => {
    // The loader put the Iran kit's turquoise on the shell for the seeded #3B82F6.
    const h = boot({ config: { primaryColor: '#3B82F6' }, shellAccent: '#0B7D6C' });
    const bg = shellOf(h).style.getPropertyValue('--gs-primary-aa');
    expect(bg).toBe('#0b7d6c');
    expect(ratio(bg, shellOf(h).style.getPropertyValue('--gs-on-primary'))).toBeGreaterThanOrEqual(4.5);
    // A light workspace colour keeps its own hue with dark ink.
    resetWindow();
    vi.restoreAllMocks();
    const light = boot({ config: { primaryColor: '#F5C518' }, shellAccent: '#F5C518' });
    expect(shellOf(light).style.getPropertyValue('--gs-primary-aa')).toBe('#f5c518');
    expect(shellOf(light).style.getPropertyValue('--gs-on-primary')).toBe('#1c2024');
  });

  it('on a phone the open panel is modal and keeps Tab inside; closed or on a computer it is not', async () => {
    (window as unknown as Dict).matchMedia = (q: string) => ({ matches: /max-width:640px/.test(q), media: q });
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
    const h = boot({ open: false });
    await flush(30);
    expect(h.panel.hasAttribute('aria-modal')).toBe(false);
    h.runtime.open();
    expect(h.panel.getAttribute('aria-modal')).toBe('true');
    const all = Array.from(h.panel.querySelectorAll<HTMLElement>('button:not([disabled]), textarea:not([disabled]), input:not([disabled])'));
    expect(all.length).toBeGreaterThan(1);
    const last = all[all.length - 1];
    last.focus();
    last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(h.shadow.activeElement).toBe(all[0]);
    all[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    expect(h.shadow.activeElement).toBe(last);
    h.runtime.close();
    expect(h.panel.hasAttribute('aria-modal')).toBe(false);
  });

  it('on a computer the panel is a popover, not modal', async () => {
    (window as unknown as Dict).matchMedia = (q: string) => ({ matches: false, media: q });
    const h = boot();
    await flush(10);
    expect(h.panel.hasAttribute('aria-modal')).toBe(false);
  });
});

describe('V-28: a "Message inside the chat" opens the conversation it starts', () => {
  const surface = () => ({ id: RULE, mode: 'chat_message', body: '۱۰٪ تخفیف اولین خرید؟ همین‌جا جواب بدهید!', dismissible: true, onDismiss() {}, onCta() {} });
  const showSmart = (h: Harness) => (h.runtime as unknown as { showSmart: (s: unknown) => boolean }).showSmart(surface());

  it('the first message names the rule; the stored line takes the local one\'s place, above the answer', async () => {
    const h = boot();
    await flush(40);
    h.runtime.__test.setConnectionState('online');
    expect(showSmart(h)).toBe(true);
    await flush(10);
    expect(h.q('.smart-msg-row')).not.toBeNull();
    write(h, 'بله');
    await flush(5);
    const [s] = sends(h);
    expect(s.smartRule).toEqual({ id: RULE, locale: 'fa' });
    s.onConversation('c9');
    s.onAccepted({
      conversationId: 'c9', messageId: 'm-visitor',
      openingMessage: { id: 'm-rule', conversation_id: 'c9', sender_type: 'bot', role: 'agent', body: '۱۰٪ تخفیف اولین خرید؟ همین‌جا جواب بدهید!', created_at: iso(), time: iso(), metadata: { source: 'smart_rule', smart_rule_id: RULE } },
    });
    await flush(10);
    expect(h.q('.smart-msg-row')).toBeNull();
    const text = h.q('[data-chat-messages]')!.textContent!;
    expect(text.indexOf('۱۰٪ تخفیف')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('۱۰٪ تخفیف')).toBeLessThan(text.indexOf('بله'));
    // A later message names nothing.
    write(h, 'کد تخفیف؟');
    await flush(5);
    expect(sends(h)[1].smartRule).toBeNull();
  });

  it('without a rule on screen a first message names none', async () => {
    const h = boot();
    await flush(40);
    h.runtime.__test.setConnectionState('online');
    h.runtime.setTab('chat');
    await flush(10);
    write(h, 'سلام');
    await flush(5);
    expect(sends(h)[0].smartRule).toBeNull();
  });
});
