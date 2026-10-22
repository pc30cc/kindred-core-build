/**
 * A system row outside the thread reads in the visitor's language (owner,
 * 2026-10-18: «پیام شما در صف پشتیبانی قرار گرفت» read right in the thread
 * but in English on t2's home card).
 *
 * The server stores system rows with an English body and says what they are
 * in `metadata.kind`; the thread renderers write the sentence from the kind.
 * Everything else Core shows now does the same (runtime.js systemRowText),
 * with the SHIPPED runtime.js and the real renderers (coreFeaturesHarness.ts):
 *
 *  - the thread list's rows (GET /api/widget/conversations `systemKind` /
 *    `systemMeta`, server/routes/widget.ts): the preview Core hands the
 *    home and list views of `default`, t1 and t2;
 *  - a live system frame while the visitor cannot see it: the toast, the
 *    screen-reader announcement and the page's public `message` event; a
 *    kind Core cannot write shows and announces nothing (the count stays);
 *  - a quoted system row (`reply_to.kind` / `reply_to.meta`,
 *    widgetAttachments.ts).
 *
 * A row without `systemKind` (an older server, any other message) is
 * handed over exactly as before.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boot, flush, resetWindow, type BootOptions, type Harness } from './coreFeaturesHarness';

beforeEach(() => { vi.useRealTimers(); resetWindow(); });
afterEach(() => { vi.restoreAllMocks(); });

type Locale = 'fa' | 'en' | 'tr';
type Kind = 'queue' | 'busy' | 'join' | 'transfer' | 'noAgent' | 'invite' | 'ended';

const NOW = new Date().toISOString();

/** One row per visitor kind, as the server sends it (stored English body as `preview`). */
const ROWS: Record<Kind, Record<string, unknown>> = {
  queue: { preview: 'Your message is in the support queue.', systemKind: 'routing_in_queue', systemMeta: {} },
  // Everyone at capacity (chatRouting.ts): the same kind, another wait.
  busy: { preview: 'Everyone on our team is busy right now.', systemKind: 'routing_in_queue', systemMeta: { reason: 'all_busy' } },
  join: { preview: 'Sara joined the conversation.', systemKind: 'routing_agent_joined', systemMeta: { agent_name: 'Sara' } },
  // A name with a replacement pattern in it stays as typed.
  transfer: { preview: 'Ali transferred this conversation to Mina $&', systemKind: 'conversation_transferred', systemMeta: { to_name: 'Mina $&' } },
  noAgent: { preview: 'Nobody from our team is online right now.', systemKind: 'routing_no_agent_available', systemMeta: { reason: 'nobody_online' } },
  invite: { preview: 'You have been invited to a video call.', systemKind: 'call_invitation', systemMeta: { channel: 'video', operator_name: 'Sara' } },
  ended: { preview: 'Call ended by operator · 01:15', systemKind: 'call_ended', systemMeta: { ended_by: 'operator', end_reason: 'hangup', duration_seconds: 75 } },
};

const EXPECTED: Record<Locale, Record<Kind, string>> = {
  fa: {
    queue: 'پیام شما در صف پشتیبانی قرار گرفت.',
    busy: 'در حال حاضر همهٔ همکاران ما مشغول‌اند. شما در صف هستید و به‌محض آزاد شدن یکی از همکاران، همین‌جا پاسخ می‌دهیم.',
    join: 'Sara به گفتگو پیوست',
    transfer: 'Mina $& به گفتگو پیوست',
    noAgent: 'در حال حاضر هیچ‌یک از همکاران ما آنلاین نیست. پیام شما ثبت شد و به‌محض بازگشت یکی از همکاران، همین‌جا پاسخ می‌دهیم.',
    invite: 'Sara شما را به تماس تصویری دعوت کرد',
    ended: 'تماس از طرف اپراتور پایان یافت · مدت تماس ۰۱:۱۵',
  },
  en: {
    queue: 'Your message is in the support queue.',
    busy: "Everyone on our team is busy right now. You're in the queue and we'll reply here as soon as someone is free.",
    join: 'Sara joined the conversation',
    transfer: 'Mina $& joined the conversation',
    noAgent: "Nobody from our team is online right now. Your message is saved and we'll reply here as soon as someone is back.",
    invite: 'Sara invited you to a video call',
    ended: 'Call ended by operator · Duration 01:15',
  },
  tr: {
    queue: 'Mesajınız destek kuyruğuna alındı.',
    busy: 'Ekibimizin tamamı şu anda meşgul. Sıradasınız; biri müsait olur olmaz burada yanıtlayacağız.',
    join: 'Sara görüşmeye katıldı',
    transfer: 'Mina $& görüşmeye katıldı',
    noAgent: 'Şu anda ekibimizden kimse çevrimiçi değil. Mesajınız kaydedildi; biri döner dönmez burada yanıtlayacağız.',
    invite: 'Sara sizi görüntülü aramaya davet etti',
    ended: 'Görüşme operatör tarafından sonlandırıldı · Süre 01:15',
  },
};

const KINDS = Object.keys(ROWS) as Kind[];

const listRow = (id: string, extra: Record<string, unknown>) => ({
  id, status: 'open', unreadCount: 1, outbound: false, updatedAt: NOW, lastMessageAt: NOW, attachmentKind: null, ...extra,
});

/** Answers the thread list with these rows (the harness's own fake answers everything else). */
const listApi = (rows: Array<Record<string, unknown>>): BootOptions['api'] =>
  (url) => (url.includes('/api/widget/conversations?') ? { body: { conversations: rows } } : undefined);

type Vm = { id: string; preview: string };
function previews(h: Harness, surface: 'homeHtml' | 'conversationListHtml'): Record<string, string> {
  const args = h.lastCall(surface);
  const vms = ((args && (args[0] as { conversations?: Vm[] }).conversations) || []) as Vm[];
  return Object.fromEntries(vms.map((c) => [c.id, c.preview]));
}

describe('the thread list: a system row previews in the visitor\'s language', () => {
  for (const locale of ['fa', 'en', 'tr'] as const) {
    for (const renderer of ['default', 't1', 't2'] as const) {
      it(`${locale} · ${renderer}: every visitor kind reads as its sentence on the home view`, async () => {
        const h = boot({
          renderer,
          config: { locale },
          api: listApi(KINDS.map((k) => listRow('c-' + k, ROWS[k]))),
        });
        const want = Object.fromEntries(KINDS.map((k) => ['c-' + k, EXPECTED[locale][k]]));
        await vi.waitFor(() => expect(previews(h, 'homeHtml')).toEqual(want));
      });
    }
  }

  it('the owner\'s case, drawn: t2\'s home in Persian shows the queue notice in Persian, not the stored English', async () => {
    const h = boot({ renderer: 't2', config: { locale: 'fa' }, api: listApi([listRow('c-live', ROWS.queue)]) });
    await vi.waitFor(() => expect(previews(h, 'homeHtml')['c-live']).toBeTruthy());
    h.runtime.setTab('home');
    await vi.waitFor(() => expect(h.body.textContent).toContain('پیام شما در صف پشتیبانی قرار گرفت.'));
    expect(h.body.textContent).not.toContain('support queue');
  });

  it('the list view gets the same previews (default, fa)', async () => {
    const h = boot({ renderer: 'default', api: listApi(KINDS.map((k) => listRow('c-' + k, ROWS[k]))) });
    await flush(20);
    h.runtime.setTab('list');
    const want = Object.fromEntries(KINDS.map((k) => ['c-' + k, EXPECTED.fa[k]]));
    await vi.waitFor(() => expect(previews(h, 'conversationListHtml')).toEqual(want));
  });

  it('the generic sentences: a join with no name, a call with no inviter, a call that never connected', async () => {
    const h = boot({
      renderer: 'default',
      api: listApi([
        listRow('c-join', { preview: 'A colleague joined the conversation.', systemKind: 'routing_agent_joined', systemMeta: {} }),
        listRow('c-invite', { preview: 'You have been invited to an audio call.', systemKind: 'call_invitation', systemMeta: { channel: 'audio' } }),
        listRow('c-failed', { preview: 'Call ended', systemKind: 'call_ended', systemMeta: { ended_by: 'visitor', end_reason: 'failed', duration_seconds: 40 } }),
        listRow('c-zero', { preview: 'Call ended', systemKind: 'call_ended', systemMeta: { ended_by: 'visitor', duration_seconds: 0 } }),
        listRow('c-long', { preview: 'Call ended', systemKind: 'call_ended', systemMeta: { ended_by: 'visitor', duration_seconds: 3725 } }),
        listRow('c-sys', { preview: 'Call ended', systemKind: 'call_ended', systemMeta: { duration_seconds: 5 } }),
      ]),
    });
    await vi.waitFor(() => expect(previews(h, 'homeHtml')).toEqual({
      'c-join': 'یکی از همکاران به گفتگو پیوست',
      'c-invite': 'به یک تماس صوتی دعوت شده‌اید',
      'c-failed': 'تماس برقرار نشد',
      'c-zero': 'تماس برقرار نشد',
      'c-long': 'شما تماس را پایان دادید · مدت تماس ۰۱:۰۲:۰۵',
      'c-sys': 'تماس پایان یافت · مدت تماس ۰۰:۰۵',
    }));
  });

  it('rows without systemKind (any other message, an older server) are handed over as before', async () => {
    const h = boot({
      renderer: 'default',
      api: listApi([
        listRow('c-text', { preview: 'سفارشتان ارسال شد.' }),
        listRow('c-photo', { preview: '', attachmentKind: 'image', outbound: true }),
        listRow('c-old', { preview: 'Your message is in the support queue.' }),
        // A kind this Core cannot write keeps the server's preview.
        listRow('c-new', { preview: 'Something new', systemKind: 'something_new', systemMeta: {} }),
      ]),
    });
    await vi.waitFor(() => expect(Object.keys(previews(h, 'homeHtml'))).toHaveLength(4));
    const p = previews(h, 'homeHtml');
    expect(p['c-text']).toBe('سفارشتان ارسال شد.');
    expect(p['c-photo']).toBe('شما یک تصویر ارسال کردید');
    expect(p['c-old']).toBe('Your message is in the support queue.');
    expect(p['c-new']).toBe('Something new');
  });
});

/** A system row as the realtime envelope carries it (publish.ts buildMessageEnvelope). */
const systemFrame = (id: string, metadata: Record<string, unknown>, body: string) => ({
  id, conversation_id: 'c1', role: 'system', sender_type: 'system', text: body, body, time: NOW, created_at: NOW,
  metadata, sender_name: null,
});

function announced(h: Harness): string {
  return Array.from(h.panel.querySelectorAll('.sr-only[aria-live]')).map((el) => el.textContent || '').join('|');
}
const toastBody = (h: Harness) => h.q('.gs-toast .gs-toast-body')?.textContent ?? null;
const messageEvents = (h: Harness) => h.events.filter((e) => e.name === 'message').map((e) => e.payload);

async function closedPanel(locale: Locale) {
  const h = boot({
    renderer: 'default', realtime: true, publicEvents: true, open: false,
    config: { locale, brandName: 'Shop' }, conversations: [{ id: 'c1' }], history: { c1: [] },
  });
  await flush(30);
  return h;
}

describe('a live system frame the visitor cannot see: toast, announcement and public event in their language', () => {
  for (const locale of ['fa', 'en', 'tr'] as const) {
    it(`${locale}: the queue notice`, async () => {
      const h = await closedPanel(locale);
      const seen = h.unread.length;
      h.emitMessages([systemFrame('s1', { kind: 'routing_in_queue' }, 'Your message is in the support queue.')]);
      await vi.waitFor(() => expect(toastBody(h)).toBe(EXPECTED[locale].queue));
      expect(announced(h)).toContain(EXPECTED[locale].queue);
      expect(messageEvents(h)).toEqual([{ text: EXPECTED[locale].queue, senderType: 'system' }]);
      // The badge counted it, as any new message.
      expect(h.unread.slice(seen)).toContain(1);
      if (locale !== 'en') expect(announced(h)).not.toContain('support queue');
    });
  }

  it('fa: a join names the operator in the Persian sentence', async () => {
    const h = await closedPanel('fa');
    h.emitMessages([systemFrame('s2', { kind: 'routing_agent_joined', agent_name: 'سارا' }, 'سارا joined the conversation.')]);
    await vi.waitFor(() => expect(toastBody(h)).toBe('سارا به گفتگو پیوست'));
    expect(messageEvents(h)).toEqual([{ text: 'سارا به گفتگو پیوست', senderType: 'system' }]);
  });

  it('a kind Core cannot write: no toast text, no announcement, no English; the count still moves', async () => {
    const h = await closedPanel('fa');
    const seen = h.unread.length;
    h.emitMessages([systemFrame('s3', { kind: 'something_new' }, 'Something happened in English')]);
    await vi.waitFor(() => expect(h.unread.slice(seen)).toContain(1));
    expect(messageEvents(h)).toHaveLength(1);
    expect(toastBody(h) || '').toBe('');
    expect(announced(h)).not.toContain('English');
    expect(JSON.stringify(messageEvents(h))).not.toContain('English');
  });

  it('an operator\'s attachment-only message still shows its toast, with their name', async () => {
    // Only a system frame Core cannot write is silent: a photo with no
    // caption has no text either, and toasted before the change.
    const h = await closedPanel('fa');
    const seen = h.unread.length;
    h.emitMessages([{
      id: 'a2', conversation_id: 'c1', role: 'agent', sender_type: 'agent', sender_name: 'سارا', text: '', body: '', time: NOW,
      attachment: { id: 'att1', kind: 'image', mime_type: 'image/png', name: 'p.png' },
    }]);
    await vi.waitFor(() => expect(h.unread.slice(seen)).toContain(1));
    await vi.waitFor(() => expect(h.q('.gs-toast .gs-toast-title')?.textContent).toBe('سارا'));
  });

  it('an operator\'s reply still reads as its own text', async () => {
    const h = await closedPanel('fa');
    h.emitMessages([{ id: 'a1', conversation_id: 'c1', role: 'agent', sender_type: 'agent', sender_name: 'سارا', text: 'سلام، در خدمتم.', time: NOW }]);
    await vi.waitFor(() => expect(toastBody(h)).toBe('سلام، در خدمتم.'));
    expect(messageEvents(h)).toEqual([{ text: 'سلام، در خدمتم.', senderType: 'agent' }]);
  });
});

describe('a quoted system row reads in the visitor\'s language', () => {
  it('reply_to with a kind is written from it; any other quote keeps its text', async () => {
    const h = boot({
      renderer: 'default',
      conversations: [{ id: 'c1' }],
      history: {
        c1: [
          {
            id: 'v1', role: 'visitor', sender_type: 'contact', text: 'چقدر طول می‌کشد؟', time: NOW, conversation_id: 'c1',
            reply_to: { id: 'sys-1', text: 'Your message is in the support queue.', sender_type: 'system', kind: 'routing_in_queue', meta: {} },
          },
          {
            id: 'v2', role: 'visitor', sender_type: 'contact', text: 'ممنون', time: NOW, conversation_id: 'c1',
            reply_to: { id: 'a-1', text: 'سفارشتان ارسال شد.', sender_type: 'agent' },
          },
        ],
      },
    });
    await flush(20);
    h.runtime.__test.openConversation('c1');
    await vi.waitFor(() => expect((h.runtime.__test.chatState().messages as unknown[]).length).toBe(2));
    const quotes = (h.runtime.__test.chatState().messages as Array<{ replyTo: { id: string; text: string } | null }>)
      .map((m) => m.replyTo);
    expect(quotes).toEqual([
      { id: 'sys-1', text: 'پیام شما در صف پشتیبانی قرار گرفت.', senderType: 'system' },
      { id: 'a-1', text: 'سفارشتان ارسال شد.', senderType: 'agent' },
    ]);
  });
  it('a quoted kind this Core cannot write draws no quote at all (never the English body)', async () => {
    // The server quotes only kinds the widget writes (visitorReplyPreview);
    // a newer server's kind meeting a cached Core is dropped like an
    // internal parent, in every renderer (an empty quote text draws none).
    for (const renderer of ['default', 't1', 't2'] as const) {
      resetWindow();
      const h = boot({
        renderer,
        conversations: [{ id: 'c1' }],
        history: {
          c1: [{
            id: 'v1', role: 'visitor', sender_type: 'contact', text: 'ممنون', time: NOW, conversation_id: 'c1',
            reply_to: { id: 'sys-9', text: 'Something new happened', sender_type: 'system', kind: 'something_new', meta: {} },
          }],
        },
      });
      await flush(20);
      h.runtime.__test.openConversation('c1');
      await vi.waitFor(() => expect(h.panel.textContent).toContain('ممنون'));
      expect(h.panel.querySelector('.msg-quote'), renderer).toBeNull();
      expect(h.panel.textContent, renderer).not.toContain('Something new happened');
    }
  });
});

describe('the thread says which wait it is (chatRouting.ts reason)', () => {
  // Nobody of the team online, everyone busy (auto routing at capacity), or
  // the manual queue: three rows, three sentences, in every renderer.
  for (const renderer of ['default', 't1', 't2'] as const) {
    it(`${renderer}: nobody online, everyone busy and the manual queue each read as themselves`, async () => {
      resetWindow();
      const h = boot({
        renderer,
        config: { locale: 'fa' },
        conversations: [{ id: 'c1' }],
        history: {
          c1: [
            { id: 'v1', role: 'visitor', sender_type: 'contact', text: 'سلام', time: NOW, conversation_id: 'c1' },
            { ...systemFrame('s1', { kind: 'routing_no_agent_available', reason: 'nobody_online' }, 'Nobody from our team is online right now.'), role: 'system' },
            { ...systemFrame('s2', { kind: 'routing_in_queue', reason: 'all_busy' }, 'Everyone on our team is busy right now.'), role: 'system' },
            { ...systemFrame('s3', { kind: 'routing_in_queue' }, 'Your message is in the support queue.'), role: 'system' },
          ],
        },
      });
      await flush(20);
      h.runtime.__test.openConversation('c1');
      await vi.waitFor(() => expect(h.panel.textContent).toContain('سلام'));
      const text = h.panel.textContent || '';
      expect(text, renderer).toContain(EXPECTED.fa.noAgent);
      expect(text, renderer).toContain(EXPECTED.fa.busy);
      expect(text, renderer).toContain(EXPECTED.fa.queue);
      expect(text, renderer).not.toMatch(/Nobody from|Everyone on|support queue/);
    });
  }
});
