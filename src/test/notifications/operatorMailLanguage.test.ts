/**
 * An operator's MAIL is written in the template's language, not the
 * dashboard's (server/services/operatorLocale.ts operatorMailLocale).
 *
 * Since the Super Admin sets the dashboard's languages (shared/
 * panelLanguages.ts), a WebYar panel (region `iran`) may also be English,
 * while its mail templates stay Persian (email/index.ts resolveEmailScope:
 * the visitors' languages, Iran Persian only). An English operator there
 * used to get the Persian template filled with English words: the
 * transcript's "Customer"/"Team" and system lines, Latin digits, an amount
 * in "Toman", and an English, left-to-right unsubscribe line. Now every
 * value in the mail is Persian, while the operator's push stays English.
 * RESPOK's row (multi, en and tr) is unchanged: each operator's own.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ServerConfig } from '../../../server/config';
import { db } from './fakeNotificationDb';

type Row = Record<string, unknown>;
interface Sent {
  to: string;
  slug?: string;
  locale?: string;
  type?: string;
  html?: Record<string, string>;
  data?: Record<string, string>;
  footer?: { html: string; text: string };
  unsubscribe?: string | null;
}
const sent: Sent[] = [];

vi.mock('../../../server/supabase.js', async () => {
  const { fakeClient } = await import('./fakeNotificationDb');
  return { getServiceClient: () => fakeClient() };
});

vi.mock('../../../server/services/email/index.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/email/index.js')>()),
  sendEmail: async (_config: unknown, req: {
    to: string; templateSlug?: string; locale?: string; htmlData?: Record<string, string>;
    templateData?: Record<string, string>; footer?: { html: string; text: string }; listUnsubscribe?: { url: string };
  }) => {
    sent.push({
      to: req.to, slug: req.templateSlug, locale: req.locale, html: req.htmlData, data: req.templateData,
      footer: req.footer, unsubscribe: req.listUnsubscribe?.url ?? null,
    });
    return { success: true, provider: 'stub', id: 'msg-1' };
  },
}));
vi.mock('../../../server/services/auth-email.js', () => ({
  resolveWorkspaceAppUrl: async () => 'https://example.test/app/settings',
}));
vi.mock('../../../server/services/widget/operatorPresenceSource.js', () => ({
  getConnectedOperators: async () => ({ mode: 'realtime', connected: new Set(), lastSeen: new Map(), degraded: false }),
}));

const { queueInvoicePaid, queueTranscript } = await import('../../../server/services/notificationEmail/producers.js');
const { dispatchNotificationEmails } = await import('../../../server/services/notificationEmail/dispatcher.js');
const { notificationFooter } = await import('../../../server/services/notificationEmail/unsubscribe.js');
const { invalidateNotificationEmailSettingsCache } = await import('../../../server/services/notificationEmail/settings.js');
const { resolveRecipients } = await import('../../../server/services/push/recipients.js');
const { __resetOperatorLocaleCache, operatorLocale, operatorMailLocale } = await import('../../../server/services/operatorLocale.js');
const { __resetPlatformRegionCache } = await import('../../../server/services/platformRegion.js');
const { resolveEmailScope } = await import('../../../server/services/email/index.js');

const CONFIG = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' } as unknown as ServerConfig;
const WS = 'ws-1';
const FA_OP = 'op-fa';
const EN_OP = 'op-en';
const CONV = 'conv-1';

/** WebYar with English added to its dashboard: Persian mail, an English panel for whoever picks it. */
const WEBYAR_EN_PANEL = { region_mode: 'iran', active_locales: ['fa', 'en'], default_locale: 'fa', site_mode: 'multi_language' };
/** RESPOK's row on 2026-10-31. */
const RESPOK = { region_mode: 'multi', active_locales: ['en', 'tr'], default_locale: 'en', site_mode: 'multi_language' };

let seq = 0;
function message(sender_type: string, body: string, metadata: Row = {}) {
  db.conversation_messages.push({
    conversation_id: CONV, sender_type, body, metadata,
    created_at: new Date(Date.parse('2026-10-31T08:00:00Z') + seq++ * 1000).toISOString(),
  });
}

function platform(row: Row) {
  db.platform_settings = [{ id: 1, ...row }];
  __resetPlatformRegionCache();
  __resetOperatorLocaleCache();
}

function digestJob(userId: string, locale: string | null, id = `job-${userId}`) {
  db.notification_email_jobs.push({
    id, user_id: userId, workspace_id: WS, type: 'unread_messages', payload: { count: 3, minutes: 15, workspace: 'Acme' },
    locale, attempts: 0, status: 'pending', scheduled_for: '2026-10-31T00:00:00Z', dedupe_key: id,
  });
}

/** The footer the dispatcher must have written, in `locale`, for what the mail carried. */
function expectedFooter(mail: Sent, locale: 'fa' | 'en' | 'tr', type: 'transcripts' | 'unread_messages') {
  return notificationFooter(locale, type, {
    unsubscribe: mail.unsubscribe ?? null,
    settings: mail.unsubscribe ? null : 'https://example.test/app/settings',
  });
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
  db.conversations = [{ id: CONV, workspace_id: WS, subject: 'Refund', assigned_to: FA_OP, contact_id: 'contact-1', updated_at: '2026-10-31T09:00:00Z', status: 'open' }];
  db.conversation_messages = [];
  db.notification_email_jobs = [];
  db.user_email_notification_prefs = [];
  db.user_notification_prefs = [];
  platform(WEBYAR_EN_PANEL);
});

describe('WebYar with English on its dashboard: an English operator', () => {
  it('keeps English for the dashboard, push and the operator APIs', async () => {
    expect(await operatorLocale(CONFIG, EN_OP)).toBe('en');
    const recipients = await resolveRecipients(CONFIG, { workspaceId: WS, assignedTo: null, eventType: 'new_message' });
    expect(recipients.find((r) => r.userId === EN_OP)?.locale).toBe('en');
    expect(recipients.find((r) => r.userId === FA_OP)?.locale).toBe('fa');
  });

  it('gets the transcript in Persian: its lines, its words, its footer', async () => {
    message('contact', 'سلام، سفارشم کجاست؟');
    message('system', 'Your message is in the support queue.', { kind: 'routing_in_queue' });
    message('agent', 'در راه است.');
    message('system', 'Sara closed the conversation', { kind: 'conversation_closed', agent_name: 'Sara' });
    expect(await queueTranscript(CONFIG, { conversationId: CONV, workspaceId: WS, actorId: EN_OP })).toBe(2);

    const job = db.notification_email_jobs.find((j) => j.user_id === EN_OP)!;
    expect(job.locale).toBe('fa');
    const lines = (job.payload as Row).transcript_lines as string[];
    expect(lines).toContain('· بازدیدکننده در صف پشتیبانی منتظر است');
    expect(lines.join('\n')).not.toMatch(/support queue|closed the conversation/);

    await dispatchNotificationEmails(CONFIG);
    const mail = sent.find((m) => m.to === 'en@example.test')!;
    expect(mail.locale).toBe('fa');
    expect(mail.html?.transcript).toContain('<div class="meta">تیم</div>');
    expect(mail.html?.transcript).not.toMatch(/>Team<|>Customer</);
    expect(mail.footer).toEqual(expectedFooter(mail, 'fa', 'transcripts'));
    expect(mail.footer?.html).toMatch(/^<p dir="rtl"/);
    expect(mail.footer?.text).not.toMatch(/You get this email|Unsubscribe|Change your email/);
  });

  it('gets a payment\'s amount in Persian, as the template is', async () => {
    db.workspace_members[1].role = 'admin';
    expect(await queueInvoicePaid(CONFIG, { workspaceId: WS, amountMinor: 1_000_000, currency: 'IRR', paymentKey: 'pay-1' })).toBe(2);
    const job = db.notification_email_jobs.find((j) => j.user_id === EN_OP)!;
    expect(job.locale).toBe('fa');
    expect((job.payload as Row).amount).toBe('۱۰۰٬۰۰۰ تومان');
  });

  it('gets the digest with Persian digits and footer, whatever language the job was queued in', async () => {
    digestJob(EN_OP, 'en');
    digestJob(FA_OP, null);
    await dispatchNotificationEmails(CONFIG);
    expect(sent).toHaveLength(2);
    for (const mail of sent) {
      expect(mail.locale).toBe('fa');
      expect(mail.data).toMatchObject({ count: '۳', minutes: '۱۵' });
      expect(mail.html).toMatchObject({ count: '۳', minutes: '۱۵' });
      expect(mail.footer).toEqual(expectedFooter(mail, 'fa', 'unread_messages'));
    }
  });
});

describe('RESPOK (multi, en and tr): unchanged, each operator\'s own', () => {
  beforeEach(() => {
    platform(RESPOK);
    db.profiles[0].preferred_locale = 'tr';
  });

  it('an English and a Turkish operator get their own digits and footer', async () => {
    digestJob(EN_OP, null);
    digestJob(FA_OP, null);
    await dispatchNotificationEmails(CONFIG);
    const en = sent.find((m) => m.to === 'en@example.test')!;
    const tr = sent.find((m) => m.to === 'fa@example.test')!;
    expect(en.locale).toBe('en');
    expect(en.footer).toEqual(expectedFooter(en, 'en', 'unread_messages'));
    expect(tr.locale).toBe('tr');
    expect(tr.footer).toEqual(expectedFooter(tr, 'tr', 'unread_messages'));
    expect(en.data).toMatchObject({ count: '3' });
  });

  it('a transcript keeps each recipient\'s language, push too', async () => {
    message('contact', 'Merhaba');
    message('agent', 'Hello');
    await queueTranscript(CONFIG, { conversationId: CONV, workspaceId: WS, actorId: EN_OP });
    const byUser = Object.fromEntries(db.notification_email_jobs.map((j) => [j.user_id, j.locale]));
    expect(byUser).toEqual({ [FA_OP]: 'tr', [EN_OP]: 'en' });
    await dispatchNotificationEmails(CONFIG);
    expect(sent.find((m) => m.to === 'en@example.test')?.html?.transcript).toContain('<div class="meta">Team</div>');
    expect(sent.find((m) => m.to === 'fa@example.test')?.html?.transcript).toContain('<div class="meta">Ekip</div>');
    const recipients = await resolveRecipients(CONFIG, { workspaceId: WS, assignedTo: null, eventType: 'new_message' });
    expect(Object.fromEntries(recipients.map((r) => [r.userId, r.locale]))).toEqual({ [FA_OP]: 'tr', [EN_OP]: 'en' });
  });
});

describe('operatorMailLocale is the language resolveEmailScope sends the template in', () => {
  const rows: Array<[string, Row]> = [
    ['WebYar (iran, fa only, single language)', { region_mode: 'iran', active_locales: ['fa'], default_locale: 'fa', site_mode: 'single_language' }],
    ['WebYar with English and Turkish on its panel', { region_mode: 'iran', active_locales: ['fa', 'en', 'tr'], default_locale: 'en', site_mode: 'multi_language' }],
    ['RESPOK (multi, en and tr)', RESPOK],
    ['multi, nothing picked', { region_mode: 'multi', active_locales: null, default_locale: 'en' }],
    ['turkey', { region_mode: 'turkey', active_locales: null, default_locale: 'tr' }],
    ['global', { region_mode: 'global', active_locales: null, default_locale: 'en' }],
  ];
  for (const [label, row] of rows) {
    it(label, async () => {
      platform(row);
      for (const locale of ['fa', 'en', 'tr'] as const) {
        const scope = await resolveEmailScope(CONFIG, locale);
        expect(scope).not.toBeNull();
        expect(await operatorMailLocale(CONFIG, locale)).toBe(scope!.locales[0]);
      }
    });
  }

  it('WebYar: Persian whatever the operator reads; RESPOK: the operator\'s own', async () => {
    expect(await operatorMailLocale(CONFIG, 'en')).toBe('fa');
    expect(await operatorMailLocale(CONFIG, 'tr')).toBe('fa');
    platform(RESPOK);
    expect(await operatorMailLocale(CONFIG, 'en')).toBe('en');
    expect(await operatorMailLocale(CONFIG, 'tr')).toBe('tr');
    expect(await operatorMailLocale(CONFIG, 'fa')).toBe('en');
  });
});
