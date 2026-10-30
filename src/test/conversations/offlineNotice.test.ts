// @vitest-environment node
/**
 * The owners' mail when a visitor leaves a message while the team is away
 * (server/services/widget/offlineNotice.ts):
 *
 *  - nobody is mailed while the team is online;
 *  - a suspended member, one whose seat the plan has paused and one whose
 *    account is disabled are never mailed, nor the reply-to address when it
 *    is one of theirs;
 *  - every mail goes through the outbox with a per-message, per-recipient
 *    dedupe key, as a 'notification';
 *  - nothing the visitor typed is offered to a subject or a text part;
 *  - a workspace's first capture is mailed at once, the later ones of its
 *    15-minute window merged into one summary at the window's end (each one
 *    replacing the last, with the new count), and after the window the next
 *    capture is mailed at once again;
 *  - past the day's windows nothing is mailed, the window's summary included;
 *  - without the outbox, the notice is sent inline once and a summary not at all;
 *  - an owner or admin who turned the mail off is not mailed (nor, for them,
 *    the reply-to address); every mail to a member carries its one-click
 *    unsubscribe link (type offline_messages) and the line under its text,
 *    the reply-to address neither;
 *  - each summary is ranked by its count, so the outbox sends the highest.
 *
 * The data layer is fakeServiceDb.ts (its rpc answers nothing, so the quota
 * counts in memory, as without migration 289d); the outbox and sendEmail
 * record what they are given.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeServiceDb, fakeServiceClient, type FakeServiceDb } from './fakeServiceDb';

type Mail = Record<string, unknown> & {
  to: string;
  subject: string;
  text: string;
  templateSlug: string;
  templateData: Record<string, string>;
  htmlData: Record<string, string>;
  category: string;
  locale: string;
};
type Queued = {
  request: Mail & { listUnsubscribe?: { url: string }; footer?: { html: string; text: string } };
  opts: { dedupeKey?: string; supersedeKey?: string; supersedeRank?: number; notBefore?: Date };
};

const state = vi.hoisted(() => ({
  db: null as unknown as FakeServiceDb,
  queued: [] as Array<{ request: Record<string, unknown>; opts: Record<string, unknown> }>,
  inline: [] as Array<Record<string, unknown>>,
  outboxDown: false,
  online: false,
  locked: new Set<string>(),
}));

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeServiceClient(state.db) }));
vi.mock('../../../server/services/email/outbox.js', () => ({
  enqueueEmail: async (_c: unknown, request: Record<string, unknown>, opts: Record<string, unknown> = {}) => {
    if (state.outboxDown) return { queued: false, error: 'outbox_unavailable' };
    state.queued.push({ request, opts });
    return { queued: true, id: `q${state.queued.length}` };
  },
}));
vi.mock('../../../server/services/email/index.js', () => ({
  sendEmail: async (_c: unknown, request: Record<string, unknown>) => { state.inline.push(request); return { success: true, provider: 'smtp' }; },
}));
vi.mock('../../../server/services/widget/availability.js', () => ({
  resolveAvailability: async () => ({ state: state.online ? 'online' : 'offline', reason: 'outside_hours', next_open_at: null }),
}));
vi.mock('../../../server/services/billing/locks/state.js', () => ({ resolveLockState: async () => ({ enabled: true }) }));
vi.mock('../../../server/services/billing/locks/predicates.js', () => ({
  isMemberLocked: (_s: unknown, userId: string) => state.locked.has(userId),
}));
vi.mock('../../../server/services/auth-email.js', () => ({
  resolveWorkspaceAppUrl: async (_c: unknown, _ws: string, path: string) => `https://app.test/acme${path}`,
}));
vi.mock('../../../server/services/operatorLocale.js', () => ({
  operatorLocales: async (_c: unknown, ids: string[]) => new Map(ids.map((id) => [id, id === 'u-fa' || id.endsWith('fa00') ? 'fa' : 'en'])),
  operatorFallbackLocale: async () => 'fa',
}));
vi.mock('../../../server/services/calls/rtcResolver.js', () => ({ resolveApiBaseUrl: async () => 'https://api.test' }));
process.env.PLATFORM_SIGNING_SECRET = 'signing-secret-for-this-test-only-0123456789';

const notice = await import('../../../server/services/widget/offlineNotice.js');
const { verifyUnsubscribeToken } = await import('../../../server/services/notificationEmail/unsubscribe.js');
const { __resetEmailQuotaMemoryForTests } = await import('../../../server/services/email/sendQuota.js');
const { notifyOfflineCapture, OFFLINE_NOTICE_WINDOW_SECONDS, OFFLINE_NOTICE_WINDOWS_PER_DAY } = notice;

const CONFIG = { supabaseUrl: 'https://x.test', supabaseServiceRoleKey: 'k' } as never;
const WS = '11111111-1111-4111-8111-111111111111';
const NOW = Date.parse('2026-10-29T09:00:00Z');
const MIN = 60_000;

let seq = 0;
const capture = (over: Record<string, unknown> = {}) => {
  seq += 1;
  return {
    conversationId: `c-${seq}`,
    messageId: `m-${seq}`,
    message: 'Hi <b>there</b>, call me & soon',
    name: 'Ali "the visitor"',
    email: 'ali@example.com',
    phone: '+989121234567',
    ...over,
  };
};
const queued = () => state.queued as unknown as Queued[];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(NOW) });
  state.db = createFakeServiceDb();
  state.db.tables.workspace_members = [
    { workspace_id: WS, user_id: 'u-fa', role: 'owner', suspended_at: null },
    { workspace_id: WS, user_id: 'u-en', role: 'admin', suspended_at: null },
    { workspace_id: WS, user_id: 'u-agent', role: 'agent', suspended_at: null },
  ];
  state.db.tables.profiles = [
    { id: 'u-fa', email: 'sara@example.com' },
    { id: 'u-en', email: 'john@example.com' },
    { id: 'u-agent', email: 'agent@example.com' },
  ];
  state.db.tables.user_credentials = [];
  state.db.tables.user_email_notification_prefs = [];
  state.queued.length = 0;
  state.inline.length = 0;
  state.outboxDown = false;
  state.online = false;
  state.locked.clear();
  __resetEmailQuotaMemoryForTests();
});
afterEach(() => { vi.useRealTimers(); });

describe('who is mailed', () => {
  it('the owners and admins, each in their own language, through the outbox, once per message and recipient', async () => {
    const c = capture();
    expect(await notifyOfflineCapture(CONFIG, WS, c)).toBe('immediate');
    expect(queued().map((q) => [q.request.to, q.request.locale])).toEqual([['sara@example.com', 'fa'], ['john@example.com', 'en']]);
    expect(queued().map((q) => q.opts.dedupeKey)).toEqual([`offline_message:${c.messageId}:u-fa`, `offline_message:${c.messageId}:u-en`]);
    for (const q of queued()) {
      expect(q.request).toMatchObject({ workspaceId: WS, templateSlug: 'offline_message_received', category: 'notification' });
      expect(q.request.templateData.action_url).toBe(`https://app.test/acme/inbox?c=${c.conversationId}`);
    }
    expect(state.inline).toEqual([]);
  });

  it('never a suspended member, one whose seat is paused, or one whose account is disabled', async () => {
    state.db.tables.workspace_members.push(
      { workspace_id: WS, user_id: 'u-banned', role: 'admin', suspended_at: '2026-10-01T00:00:00Z' },
      { workspace_id: WS, user_id: 'u-paused', role: 'admin', suspended_at: null },
      { workspace_id: WS, user_id: 'u-off', role: 'admin', suspended_at: null },
    );
    state.db.tables.profiles.push(
      { id: 'u-banned', email: 'banned@example.com' },
      { id: 'u-paused', email: 'paused@example.com' },
      { id: 'u-off', email: 'off@example.com' },
    );
    state.locked.add('u-paused');
    state.db.tables.user_credentials = [{ user_id: 'u-off', status: 'disabled' }, { user_id: 'u-fa', status: 'active' }];
    await notifyOfflineCapture(CONFIG, WS, capture());
    expect(queued().map((q) => q.request.to)).toEqual(['sara@example.com', 'john@example.com']);
  });

  it('nobody left with an address: the workspace\'s reply-to address, unless it is an excluded member\'s', async () => {
    state.db.tables.workspace_members = [{ workspace_id: WS, user_id: 'u-banned', role: 'owner', suspended_at: '2026-10-01T00:00:00Z' }];
    state.db.tables.profiles = [{ id: 'u-banned', email: 'Banned@Example.com' }];
    state.db.tables.email_settings = [{ workspace_id: WS, reply_to_email: 'banned@example.com' }];
    expect(await notifyOfflineCapture(CONFIG, WS, capture())).toBe('no_recipient');
    expect(queued()).toEqual([]);

    state.db.tables.email_settings = [{ workspace_id: WS, reply_to_email: 'team@example.com' }];
    const c = capture();
    expect(await notifyOfflineCapture(CONFIG, WS, c)).toBe('immediate');
    expect(queued().map((q) => [q.request.to, q.request.locale, q.opts.dedupeKey])).toEqual([
      ['team@example.com', 'fa', `offline_message:${c.messageId}:reply_to`],
    ]);
  });

  it('nobody while the team is online (the caller\'s answer, or resolved here)', async () => {
    expect(await notifyOfflineCapture(CONFIG, WS, capture(), { teamOnline: true })).toBe('team_online');
    state.online = true;
    expect(await notifyOfflineCapture(CONFIG, WS, capture())).toBe('team_online');
    expect(queued()).toEqual([]);
    // Nor did those use up the window: the next capture while away is mailed at once.
    state.online = false;
    expect(await notifyOfflineCapture(CONFIG, WS, capture())).toBe('immediate');
  });
});

describe('what the visitor typed', () => {
  it('never reaches a subject or the template\'s text part: the HTML part alone has it, escaped', async () => {
    await notifyOfflineCapture(CONFIG, WS, capture());
    const mail = queued()[0].request;
    expect(mail.templateData).toEqual({
      conversation_id: expect.any(String), action_url: expect.any(String),
      contact_name: '', contact_email: '', contact_phone: '', message_body: '',
    });
    expect(mail.subject).toBe('New offline message');
    expect(mail.htmlData).toMatchObject({
      contact_name: 'Ali &quot;the visitor&quot;',
      contact_email: 'ali@example.com',
      message_body: 'Hi &lt;b&gt;there&lt;/b&gt;, call me &amp; soon',
    });
  });
});

describe('one window, one notice and one summary', () => {
  it('the first capture at once; the later ones merged into a summary at the window\'s end, the newest replacing the last', async () => {
    const first = capture();
    expect(await notifyOfflineCapture(CONFIG, WS, first)).toBe('immediate');
    vi.setSystemTime(NOW + 2 * MIN);
    const second = capture();
    expect(await notifyOfflineCapture(CONFIG, WS, second)).toBe('summary');
    vi.setSystemTime(NOW + 5 * MIN);
    const third = capture({ name: 'Mallory <script>', message: 'buy now http://spam.example' });
    expect(await notifyOfflineCapture(CONFIG, WS, third)).toBe('summary');

    const summaries = queued().filter((q) => q.request.templateSlug === 'offline_messages_summary');
    expect(summaries).toHaveLength(4);
    const windowEnd = new Date(NOW + OFFLINE_NOTICE_WINDOW_SECONDS * 1000);
    for (const s of summaries) {
      expect(s.opts.notBefore).toEqual(windowEnd);
      expect(s.opts.supersedeKey).toBe(`offline_summary:${WS}:${NOW}:${s.request.to === 'sara@example.com' ? 'u-fa' : 'u-en'}`);
      expect(s.request.category).toBe('notification');
      // No visitor text anywhere in a summary.
      expect(JSON.stringify(s.request)).not.toMatch(/Mallory|spam\.example|Ali|ali@example/);
    }
    expect(summaries.map((s) => s.opts.dedupeKey)).toEqual([
      `offline_summary:${second.messageId}:u-fa`, `offline_summary:${second.messageId}:u-en`,
      `offline_summary:${third.messageId}:u-fa`, `offline_summary:${third.messageId}:u-en`,
    ]);
    // The count is the window's later captures, in the recipient's digits.
    expect(summaries.map((s) => [s.request.locale, s.request.templateData.count])).toEqual([
      ['fa', '۱'], ['en', '1'], ['fa', '۲'], ['en', '2'],
    ]);
    // Ranked by that count: the outbox sends the highest of a window's
    // summaries, whichever reached it last.
    expect(summaries.map((s) => s.opts.supersedeRank)).toEqual([1, 1, 2, 2]);
    expect(summaries[3].request.subject).toBe('More offline messages: 2');
    expect(summaries[3].request.templateData.action_url).toBe('https://app.test/acme/inbox');

    // After the window, the next capture is mailed at once again.
    vi.setSystemTime(NOW + OFFLINE_NOTICE_WINDOW_SECONDS * 1000 + MIN);
    expect(await notifyOfflineCapture(CONFIG, WS, capture())).toBe('immediate');
  });

  it('another workspace has its own window', async () => {
    const other = '22222222-2222-4222-8222-222222222222';
    state.db.tables.workspace_members.push({ workspace_id: other, user_id: 'u-en', role: 'owner', suspended_at: null });
    expect(await notifyOfflineCapture(CONFIG, WS, capture())).toBe('immediate');
    expect(await notifyOfflineCapture(CONFIG, other, capture())).toBe('immediate');
  });
});

describe('the day\'s cap', () => {
  it('past the day\'s windows nothing is mailed, the window\'s summary included; the next day it starts again', async () => {
    for (let i = 0; i < OFFLINE_NOTICE_WINDOWS_PER_DAY; i += 1) {
      vi.setSystemTime(NOW + i * (OFFLINE_NOTICE_WINDOW_SECONDS * 1000 + MIN));
      expect(await notifyOfflineCapture(CONFIG, WS, capture())).toBe('immediate');
    }
    const before = queued().length;
    vi.setSystemTime(NOW + OFFLINE_NOTICE_WINDOWS_PER_DAY * (OFFLINE_NOTICE_WINDOW_SECONDS * 1000 + MIN));
    expect(await notifyOfflineCapture(CONFIG, WS, capture())).toBe('capped');
    expect(await notifyOfflineCapture(CONFIG, WS, capture())).toBe('capped');
    expect(queued()).toHaveLength(before);

    vi.setSystemTime(NOW + 25 * 60 * MIN);
    expect(await notifyOfflineCapture(CONFIG, WS, capture())).toBe('immediate');
  });
});

describe('without the outbox (migration 289b not applied)', () => {
  it('the notice is sent inline once; a summary, which must wait, is not sent', async () => {
    state.outboxDown = true;
    expect(await notifyOfflineCapture(CONFIG, WS, capture())).toBe('immediate');
    expect((state.inline as Mail[]).map((m) => m.to)).toEqual(['sara@example.com', 'john@example.com']);
    expect(await notifyOfflineCapture(CONFIG, WS, capture())).toBe('summary');
    expect(state.inline).toHaveLength(2);
  });
});

describe('a way out for each owner and admin', () => {
  it('every mail to a member carries its one-click link for this mail alone, and the line under its text', async () => {
    // Account ids are UUIDs, which is what an unsubscribe token names.
    const SARA = '00000000-0000-4000-8000-00000000fa00';
    const JOHN = '00000000-0000-4000-8000-00000000e400';
    state.db.tables.workspace_members = [
      { workspace_id: WS, user_id: SARA, role: 'owner', suspended_at: null },
      { workspace_id: WS, user_id: JOHN, role: 'admin', suspended_at: null },
    ];
    state.db.tables.profiles = [{ id: SARA, email: 'sara@example.com' }, { id: JOHN, email: 'john@example.com' }];
    await notifyOfflineCapture(CONFIG, WS, capture());
    vi.setSystemTime(NOW + 2 * MIN);
    await notifyOfflineCapture(CONFIG, WS, capture());
    expect(queued()).toHaveLength(4);
    for (const q of queued()) {
      const url = q.request.listUnsubscribe?.url ?? '';
      expect(url.startsWith('https://api.test/api/notifications/email/unsubscribe/')).toBe(true);
      const check = verifyUnsubscribeToken(url.split('/').pop());
      expect(check).toMatchObject({ ok: true, type: 'offline_messages', userId: q.request.to === 'sara@example.com' ? SARA : JOHN });
      expect(q.request.footer?.text).toContain(url);
    }
    const sara = queued().find((q) => q.request.to === 'sara@example.com')!;
    expect(sara.request.footer?.html).toContain('«پیام‌های آفلاین بازدیدکنندگان»');
    expect(sara.request.footer?.html).toContain('dir="rtl"');
    const john = queued().find((q) => q.request.to === 'john@example.com')!;
    expect(john.request.footer?.text).toContain('“Offline messages from visitors”');
  });

  it('one who turned it off is not mailed; when all have, nobody is, the reply-to address included', async () => {
    state.db.tables.user_email_notification_prefs = [{ user_id: 'u-en', offline_messages: false }, { user_id: 'u-fa', transcripts: false }];
    await notifyOfflineCapture(CONFIG, WS, capture());
    expect(queued().map((q) => q.request.to)).toEqual(['sara@example.com']);

    state.db.tables.user_email_notification_prefs = [{ user_id: 'u-en', offline_messages: false }, { user_id: 'u-fa', offline_messages: false }];
    state.db.tables.email_settings = [{ workspace_id: WS, reply_to_email: 'team@example.com' }];
    vi.setSystemTime(NOW + OFFLINE_NOTICE_WINDOW_SECONDS * 1000 + MIN);
    expect(await notifyOfflineCapture(CONFIG, WS, capture())).toBe('no_recipient');
    expect(queued()).toHaveLength(1);
  });

  it('the reply-to address, which is the workspace\'s setting and not a subscription, gets neither', async () => {
    state.db.tables.workspace_members = [];
    state.db.tables.email_settings = [{ workspace_id: WS, reply_to_email: 'team@example.com' }];
    expect(await notifyOfflineCapture(CONFIG, WS, capture())).toBe('immediate');
    const [mail] = queued();
    expect(mail.request.to).toBe('team@example.com');
    expect(mail.request.listUnsubscribe).toBeUndefined();
    expect(mail.request.footer).toBeUndefined();
  });
});

describe('the panel\'s test of this mail', () => {
  it('is the same notice, with sample details, sent now to the address given', async () => {
    const result = await notice.sendOfflineNoticeTest(CONFIG, { workspaceId: WS, to: 'me@example.com', locale: 'tr' });
    expect(result.success).toBe(true);
    expect(state.inline).toHaveLength(1);
    expect(state.inline[0]).toMatchObject({
      to: 'me@example.com', locale: 'tr', templateSlug: 'offline_message_received', workspaceId: WS,
      htmlData: expect.objectContaining({ contact_name: 'Test Visitor' }),
      templateData: expect.objectContaining({ contact_name: '' }),
    });
    expect(queued()).toEqual([]);
  });
});
