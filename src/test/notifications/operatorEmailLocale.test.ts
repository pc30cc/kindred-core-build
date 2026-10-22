/**
 * Server-written operator mail and push in the RECIPIENT's language.
 *
 *  - The transcript printed every row's stored body, so its system lines
 *    ("Your message is in the support queue.", "Sara closed the
 *    conversation") reached a Persian operator in English. Each recipient now
 *    gets the transcript and the mail in their own language, the system lines
 *    written from their kind, and a line nobody can write left out.
 *  - Subjects the server wrote when nobody typed one ('Offline message',
 *    'New conversation') print as '—', as no subject always did.
 *  - An operator who never chose a language got English mail and push even
 *    on a Persian platform; they now get the platform's language.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ServerConfig } from '../../../server/config';

type Row = Record<string, unknown>;
type Result = { data: Row[] | null; error: { code?: string; message: string } | null };
const db: Record<string, Row[]> = {};
const sent: Array<{ to: string; slug?: string; locale?: string }> = [];

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from(table: string) {
      const rows: Row[] = db[table] || (db[table] = []);
      const filters: Array<(r: Row) => boolean> = [];
      let pending: 'update' | 'insert' | null = null;
      let payload: Row | Row[] = {};
      const matched = () => rows.filter((r) => filters.every((f) => f(r)));
      const run = (): Result => {
        if (pending === 'update') {
          const hits = matched();
          for (const r of hits) Object.assign(r, payload);
          return { data: hits, error: null };
        }
        if (pending === 'insert') {
          const out: Row[] = [];
          for (const value of Array.isArray(payload) ? payload : [payload]) {
            if (table === 'notification_email_jobs' && rows.some((r) => r.dedupe_key === value.dedupe_key)) {
              return { data: null, error: { code: '23505', message: 'duplicate key' } };
            }
            const inserted = { id: `row-${rows.length + 1}`, status: 'pending', attempts: 0, ...value };
            rows.push(inserted);
            out.push(inserted);
          }
          return { data: out, error: null };
        }
        return { data: matched(), error: null };
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return builder; },
        neq: (c: string, v: unknown) => { filters.push((r) => r[c] !== v); return builder; },
        is: (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return builder; },
        in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return builder; },
        lt: (c: string, v: string) => { filters.push((r) => String(r[c]) < v); return builder; },
        lte: (c: string, v: string) => { filters.push((r) => String(r[c]) <= v); return builder; },
        gte: (c: string, v: string) => { filters.push((r) => String(r[c]) >= v); return builder; },
        or: () => builder,
        order: () => builder,
        limit: () => builder,
        update: (patch: Row) => { pending = 'update'; payload = patch; return builder; },
        insert: (values: Row | Row[]) => { pending = 'insert'; payload = values; return builder; },
        maybeSingle: async () => {
          const result = run();
          return { data: result.data?.[0] ?? null, error: result.error };
        },
        then: (resolve: (value: Result) => unknown) => resolve(run()),
      };
      return builder;
    },
  }),
}));

vi.mock('../../../server/services/email/index.js', () => ({
  sendEmail: async (_config: unknown, req: { to: string; templateSlug?: string; locale?: string }) => {
    sent.push({ to: req.to, slug: req.templateSlug, locale: req.locale });
    return { success: true, provider: 'stub', id: 'msg-1' };
  },
}));
vi.mock('../../../server/services/auth-email.js', () => ({
  resolveWorkspaceAppUrl: async () => 'https://example.test/app/inbox',
}));
vi.mock('../../../server/services/widget/operatorPresenceSource.js', () => ({
  getConnectedOperators: async () => ({ mode: 'realtime', connected: new Set(), lastSeen: new Map(), degraded: false }),
}));

const { queueTranscript, sweepUnreadDigest } = await import('../../../server/services/notificationEmail/producers.js');
const { dispatchNotificationEmails } = await import('../../../server/services/notificationEmail/dispatcher.js');
const { invalidateNotificationEmailSettingsCache } = await import('../../../server/services/notificationEmail/settings.js');
const { resolveRecipients } = await import('../../../server/services/push/recipients.js');
const { __resetOperatorLocaleCache } = await import('../../../server/services/operatorLocale.js');
const { __resetPlatformRegionCache } = await import('../../../server/services/platformRegion.js');

const CONFIG = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' } as unknown as ServerConfig;
const WS = 'ws-1';
const FA_OP = 'op-fa';
const EN_OP = 'op-en';
const CONV = 'conv-1';

let seq = 0;
function message(sender_type: string, body: string, metadata: Row = {}) {
  db.conversation_messages.push({
    conversation_id: CONV, sender_type, body, metadata,
    created_at: new Date(Date.parse('2026-10-18T08:00:00Z') + seq++ * 1000).toISOString(),
  });
}

function platform(row: Row) {
  db.platform_settings = [{ id: 1, ...row }];
  __resetPlatformRegionCache();
  __resetOperatorLocaleCache();
}

beforeEach(() => {
  for (const key of Object.keys(db)) delete db[key];
  sent.length = 0;
  db.notification_email_settings = [{
    id: true, enabled: true, unread_messages_enabled: true, transcripts_enabled: true,
    paid_invoices_enabled: true, weekly_summary_enabled: true, product_updates_enabled: true,
    provider_override: null, unread_after_minutes: 15, digest_every_minutes: 60,
    weekly_summary_dow: 1, weekly_summary_hour: 8,
  }];
  invalidateNotificationEmailSettingsCache();
  platform({ region_mode: 'multi', active_locales: ['en', 'fa', 'tr'], default_locale: 'en' });
  db.profiles = [
    { id: FA_OP, email: 'fa@example.test', full_name: 'Sara', preferred_locale: 'fa' },
    { id: EN_OP, email: 'en@example.test', full_name: 'Ali', preferred_locale: 'en' },
  ];
  db.workspace_members = [
    { workspace_id: WS, user_id: FA_OP, role: 'owner', suspended_at: null },
    { workspace_id: WS, user_id: EN_OP, role: 'agent', suspended_at: null },
  ];
  db.workspaces = [{ id: WS, name: 'Acme' }];
  db.contacts = [{ id: 'contact-1', name: 'Mina', email: null }];
  db.conversations = [{ id: CONV, workspace_id: WS, subject: 'Offline message', assigned_to: FA_OP, contact_id: 'contact-1', updated_at: '2026-10-18T09:00:00Z', status: 'open' }];
  db.conversation_messages = [];
  db.notification_email_jobs = [];
  db.user_email_notification_prefs = [];
  db.user_notification_prefs = [];
});

describe('the transcript', () => {
  beforeEach(() => {
    message('contact', 'سلام، سفارشم کجاست؟');
    message('system', 'Your message is in the support queue.', { kind: 'routing_in_queue' });
    message('system', 'a colleague joined the conversation.', { kind: 'routing_agent_joined', agent_name: 'a colleague' });
    message('agent', 'در راه است.');
    message('system', 'Ali unassigned this conversation', { kind: 'conversation_unassigned', internal: true, actor_name: 'Ali' });
    message('system', 'Something only next year knows', { kind: 'something_new' });
    message('system', 'Sara closed the conversation', { kind: 'conversation_closed', agent_name: 'Sara' });
  });

  it('goes to each recipient in their own language, one rendering per language', async () => {
    expect(await queueTranscript(CONFIG, { conversationId: CONV, workspaceId: WS, actorId: EN_OP })).toBe(2);
    const jobs = db.notification_email_jobs;
    const fa = jobs.find((j) => j.user_id === FA_OP)!;
    const en = jobs.find((j) => j.user_id === EN_OP)!;
    expect(fa.locale).toBe('fa');
    expect(en.locale).toBe('en');

    const faText = String((fa.payload as Row).transcript);
    expect(faText).toBe([
      '<p>← سلام، سفارشم کجاست؟</p>',
      '<p>→ بازدیدکننده در صف پشتیبانی منتظر است</p>',
      '<p>→ یکی از همکاران به گفتگو پیوست</p>',
      '<p>→ در راه است.</p>',
      '<p>→ Ali این گفتگو را از حالت واگذارشده خارج کرد</p>',
      '<p>→ Sara گفتگو را بست</p>',
    ].join(''));
    // No English system sentence, and nothing a reader cannot be told.
    expect(faText).not.toMatch(/support queue|joined|unassigned|closed the conversation|a colleague|next year/);

    const enText = String((en.payload as Row).transcript);
    expect(enText).toContain('<p>→ The visitor is waiting in the support queue</p>');
    expect(enText).toContain('<p>→ Sara closed the conversation</p>');
    expect(enText).not.toContain('next year');
  });

  it("prints a placeholder subject as '—'", async () => {
    await queueTranscript(CONFIG, { conversationId: CONV, workspaceId: WS, actorId: null });
    expect((db.notification_email_jobs[0].payload as Row).subject).toBe('—');
  });

  it('names a contact still called by the legacy "Visitor" by their email, else \'—\'', async () => {
    db.contacts = [{ id: 'contact-1', name: 'Visitor', email: null }];
    await queueTranscript(CONFIG, { conversationId: CONV, workspaceId: WS, actorId: null });
    expect((db.notification_email_jobs[0].payload as Row).contact).toBe('—');
    db.notification_email_jobs = [];
    db.contacts = [{ id: 'contact-1', name: 'Visitor', email: 'mina@example.com' }];
    await queueTranscript(CONFIG, { conversationId: CONV, workspaceId: WS, actorId: null });
    expect((db.notification_email_jobs[0].payload as Row).contact).toBe('mina@example.com');
  });

  it('keeps a subject somebody typed', async () => {
    db.conversations[0].subject = 'Refund for order 1042';
    await queueTranscript(CONFIG, { conversationId: CONV, workspaceId: WS, actorId: null });
    expect((db.notification_email_jobs[0].payload as Row).subject).toBe('Refund for order 1042');
  });
});

describe('the unread digest', () => {
  it("lists placeholder subjects as '—'", async () => {
    db.conversations = [
      { id: 'c1', workspace_id: WS, subject: 'Offline message', status: 'open' },
      { id: 'c2', workspace_id: WS, subject: 'New conversation', status: 'open' },
      { id: 'c3', workspace_id: WS, subject: 'Where is my parcel', status: 'open' },
    ];
    db.conversation_messages = ['c1', 'c2', 'c3'].map((id) => ({
      conversation_id: id, sender_type: 'contact', seen_at: null, created_at: '2026-10-18T07:00:00Z',
    }));
    await sweepUnreadDigest(CONFIG, new Date('2026-10-18T09:00:00Z'));
    expect(db.notification_email_jobs.length).toBeGreaterThan(0);
    for (const job of db.notification_email_jobs) {
      expect((job.payload as Row).list).toBe('— · — · Where is my parcel');
    }
  });
});

describe('an operator who never chose a language', () => {
  beforeEach(() => {
    platform({ region_mode: 'iran', active_locales: null, default_locale: null });
    db.profiles[1].preferred_locale = null;
  });

  it('is mailed in the platform language, not English', async () => {
    db.notification_email_jobs.push({
      id: 'job-1', user_id: EN_OP, workspace_id: WS, type: 'unread_messages', payload: { count: 1 },
      locale: null, attempts: 0, status: 'pending', scheduled_for: '2026-10-18T00:00:00Z', dedupe_key: 'k',
    });
    await dispatchNotificationEmails(CONFIG);
    expect(sent).toEqual([expect.objectContaining({ to: 'en@example.test', locale: 'fa' })]);
  });

  it('gets push copy in the platform language, not English', async () => {
    const recipients = await resolveRecipients(CONFIG, { workspaceId: WS, assignedTo: null, eventType: 'new_message' });
    const byUser = Object.fromEntries(recipients.map((r) => [r.userId, r.locale]));
    expect(byUser[EN_OP]).toBe('fa');
    expect(byUser[FA_OP]).toBe('fa');
  });

  it('a chosen language still wins', async () => {
    platform({ region_mode: 'multi', active_locales: ['fa', 'tr'], default_locale: 'fa' });
    db.profiles[1].preferred_locale = 'tr';
    const recipients = await resolveRecipients(CONFIG, { workspaceId: WS, assignedTo: null, eventType: 'new_message' });
    expect(recipients.find((r) => r.userId === EN_OP)?.locale).toBe('tr');
  });
});

describe('an operator whose language the platform does not offer', () => {
  // Every account from before migration 158 carries 'en'; on a Persian-only
  // platform its dashboard is Persian (src/hooks/usePlatformRegion.ts), so
  // its mail and push are too.
  beforeEach(() => {
    platform({ region_mode: 'iran', active_locales: null, default_locale: 'fa' });
    db.profiles[1].preferred_locale = 'en';
  });

  it('is mailed in the platform language', async () => {
    db.notification_email_jobs.push({
      id: 'job-2', user_id: EN_OP, workspace_id: WS, type: 'unread_messages', payload: { count: 1 },
      locale: null, attempts: 0, status: 'pending', scheduled_for: '2026-10-18T00:00:00Z', dedupe_key: 'k2',
    });
    await dispatchNotificationEmails(CONFIG);
    expect(sent).toEqual([expect.objectContaining({ to: 'en@example.test', locale: 'fa' })]);
  });

  it('gets push copy in the platform language', async () => {
    const recipients = await resolveRecipients(CONFIG, { workspaceId: WS, assignedTo: null, eventType: 'new_message' });
    expect(recipients.find((r) => r.userId === EN_OP)?.locale).toBe('fa');
  });
});
