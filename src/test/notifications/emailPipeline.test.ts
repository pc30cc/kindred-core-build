/**
 * The operator notification emails, end to end through their own pipeline.
 *
 * These are the switches that used to save and send nothing. Each one that
 * exists now has a producer, a template and a queue row behind it, and the
 * things worth pinning are the ones that would cost somebody real trouble:
 * a digest that goes twice (or every hour for the same conversations), a
 * switch the dispatcher forgets to re-read, an invoice mailed to an operator
 * who answers chats, a visitor's markup in a platform mail, a mail lost to a
 * deploy, and a platform that starts mailing everybody the moment it is
 * upgraded.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db, resetDb, type Row } from './fakeNotificationDb';

vi.mock('../../../server/supabase.js', async () => {
  const { fakeClient } = await import('./fakeNotificationDb');
  return { getServiceClient: () => fakeClient() };
});

type Sent = {
  to: string;
  workspaceId: string | null;
  slug?: string;
  providerKey?: string;
  locale?: string;
  category?: string;
  data: Record<string, string>;
  html: Record<string, string>;
  listUnsubscribe?: { url: string };
  footer?: { html: string; text: string };
};
const email = vi.hoisted(() => ({
  sent: [] as Sent[],
  outcomes: [] as Array<'ok' | 'timeout' | 'suppressed' | 'throw'>,
}));

vi.mock('../../../server/services/email/index.js', () => ({
  sendEmail: async (_config: unknown, req: Record<string, unknown>) => {
    const outcome = email.outcomes.shift() ?? 'ok';
    if (outcome === 'throw') throw new Error('database went away');
    if (outcome === 'timeout') return { success: false, provider: 'smtp', errorCode: 'timeout', permanent: false, error: 'timeout: the relay did not answer' };
    if (outcome === 'suppressed') return { success: false, provider: 'none', errorCode: 'suppressed', permanent: true, error: 'suppressed: the address is on the suppression list' };
    email.sent.push({
      to: String(req.to),
      workspaceId: req.workspaceId as string | null,
      slug: req.templateSlug as string,
      providerKey: req.providerConfigKey as string | undefined,
      locale: req.locale as string,
      category: req.category as string,
      data: req.templateData as Record<string, string>,
      html: req.htmlData as Record<string, string>,
      listUnsubscribe: req.listUnsubscribe as { url: string } | undefined,
      footer: req.footer as { html: string; text: string } | undefined,
    });
    return { success: true, provider: 'smtp', id: `msg-${email.sent.length}` };
  },
}));

const store = vi.hoisted(() => ({ notification: null as null | { provider_name: string; config: Record<string, unknown> } }));
vi.mock('../../../server/services/email/providerConfigStore.js', () => ({
  readEmailProviderConfig: async () => store.notification,
}));

vi.mock('../../../server/services/auth-email.js', () => ({
  resolveWorkspaceAppUrl: async (_c: unknown, _w: unknown, path: string) => `https://app.example.test/app${path}`,
}));

process.env.PLATFORM_SIGNING_SECRET = 'signing-secret-for-this-test-only-0123456789';

const { enqueueNotificationEmail } = await import('../../../server/services/notificationEmail/queue.js');
const {
  dispatchNotificationEmails, reclaimStuckJobs, purgeFinishedJobs, MAX_ATTEMPTS, STUCK_SENDING_MS,
} = await import('../../../server/services/notificationEmail/dispatcher.js');
const {
  sweepUnreadDigest, sweepWeeklySummary, queueTranscript, queueInvoicePaid, fanOutAnnouncements, ANNOUNCEMENTS_PER_HOUR,
} = await import('../../../server/services/notificationEmail/producers.js');
const { invalidateNotificationEmailSettingsCache } = await import('../../../server/services/notificationEmail/settings.js');
const { verifyUnsubscribeToken } = await import('../../../server/services/notificationEmail/unsubscribe.js');

const CONFIG = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' } as never;
const OWNER = '00000000-0000-4000-8000-000000000001';
const AGENT = '00000000-0000-4000-8000-000000000002';
const STAFF = '00000000-0000-4000-8000-000000000003';
const WORKSPACE = '10000000-0000-4000-8000-000000000001';
const jobs = () => db.notification_email_jobs as Row[];

function settings(overrides: Row = {}) {
  db.notification_email_settings = [{
    id: true, enabled: true, unread_messages_enabled: true, transcripts_enabled: true, paid_invoices_enabled: true,
    weekly_summary_enabled: true, product_updates_enabled: true, provider_override: null, unread_after_minutes: 15,
    digest_every_minutes: 60, weekly_summary_dow: 1, weekly_summary_hour: 8, ...overrides,
  }];
  invalidateNotificationEmailSettingsCache();
}

const queue = (overrides: Row = {}) => enqueueNotificationEmail(CONFIG, {
  userId: OWNER, workspaceId: WORKSPACE, type: 'unread_messages', payload: { count: 1 }, dedupeKey: `k-${Math.random()}`, ...overrides,
} as never);

/** Makes every queued job due now. */
function due() {
  for (const job of jobs()) if (job.status === 'pending') job.scheduled_for = new Date(Date.now() - 1000).toISOString();
}

beforeEach(() => {
  resetDb();
  email.sent.length = 0;
  email.outcomes.length = 0;
  store.notification = null;
  settings();
  db.platform_domains = [{ api_base_url: 'https://api.example.test' }];
  db.profiles = [
    { id: OWNER, email: 'owner@example.test', full_name: 'Owner', preferred_locale: 'fa' },
    { id: AGENT, email: 'agent@example.test', full_name: 'Agent', preferred_locale: 'en' },
    { id: STAFF, email: 'staff@example.test', full_name: 'Staff', preferred_locale: 'en' },
  ];
  db.workspace_members = [
    { workspace_id: WORKSPACE, user_id: OWNER, role: 'owner', suspended_at: null },
    { workspace_id: WORKSPACE, user_id: AGENT, role: 'agent', suspended_at: null },
    { workspace_id: WORKSPACE, user_id: STAFF, role: 'staff', suspended_at: null },
  ];
  db.workspaces = [{ id: WORKSPACE, name: 'Acme', owner_id: OWNER }];
  db.notification_email_jobs = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the platform switch', () => {
  it('sends nothing at all while the feature is off', async () => {
    settings({ enabled: false });
    expect(await queue()).toEqual({ queued: false, reason: 'platform_disabled' });
    expect(jobs()).toHaveLength(0);
  });

  it('nor when the feature is on but this type is not', async () => {
    settings({ unread_messages_enabled: false });
    expect((await queue()).reason).toBe('platform_disabled');
  });

  it('is asked again at send time, not only at queue time', async () => {
    await queue();
    settings({ unread_messages_enabled: false });
    await dispatchNotificationEmails(CONFIG);
    expect(email.sent).toHaveLength(0);
    expect(jobs()[0].status).toBe('skipped');
  });
});

describe('the operator\'s own switch', () => {
  it('is honoured before a job is even written, and again before it is sent', async () => {
    db.user_email_notification_prefs = [{ user_id: AGENT, unread_messages: false }];
    expect(await queue({ userId: AGENT })).toEqual({ queued: false, reason: 'operator_opted_out' });

    db.user_email_notification_prefs = [];
    await queue({ userId: AGENT });
    db.user_email_notification_prefs = [{ user_id: AGENT, unread_messages: false }];
    await dispatchNotificationEmails(CONFIG);
    expect(email.sent).toHaveLength(0);
    expect(jobs()[0].status).toBe('skipped');
  });
});

describe('sending', () => {
  it('renders the right template, in the recipient\'s own language, through the default provider', async () => {
    await queue({ payload: { count: 4, workspace: 'Acme' } });
    await dispatchNotificationEmails(CONFIG);

    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]).toMatchObject({
      to: 'owner@example.test', slug: 'operator_unread_digest', locale: 'fa', workspaceId: WORKSPACE, category: 'notification',
    });
    expect(email.sent[0].providerKey).toBeUndefined();
    // The count in the reader's digits: this owner reads Persian.
    expect(email.sent[0].data).toMatchObject({ count: '۴', workspace: 'Acme', name: 'Owner' });
    expect(jobs()[0]).toMatchObject({ status: 'sent', attempts: 1 });
    // What the mail said is gone from the queue once it is sent.
    expect(jobs()[0].payload).toEqual({});
  });

  it('escapes every value for the HTML part and keeps it as typed for the subject and the text', async () => {
    const markup = '<a href=//evil.example>Verify your account</a>';
    db.profiles[0].full_name = '<img src=x onerror=alert(1)>';
    await queue({ payload: { list: markup, workspace: 'Tom & "Jerry"', contact: markup } });
    await dispatchNotificationEmails(CONFIG);

    const { data, html } = email.sent[0];
    expect(data.list).toBe(markup);
    expect(html.list).toBe('&lt;a href=//evil.example&gt;Verify your account&lt;/a&gt;');
    expect(html.contact).not.toContain('<');
    expect(html.workspace).toBe('Tom &amp; &quot;Jerry&quot;');
    expect(html.name).toBe('&lt;img src=x onerror=alert(1)&gt;');
    expect(data.name).toBe('<img src=x onerror=alert(1)>');
  });

  it('carries a one-click unsubscribe for this person and this type, and a visible line in their language', async () => {
    await queue();
    await dispatchNotificationEmails(CONFIG);
    const { listUnsubscribe, footer } = email.sent[0];
    expect(listUnsubscribe?.url).toMatch(/^https:\/\/api\.example\.test\/api\/notifications\/email\/unsubscribe\/[\w-]+\.[\w-]+$/);
    const token = listUnsubscribe!.url.split('/').pop();
    expect(verifyUnsubscribeToken(token)).toEqual({ ok: true, userId: OWNER, type: 'unread_messages' });
    expect(footer?.html).toContain('dir="rtl"');
    expect(footer?.html).toContain('لغو اشتراک');
    expect(footer?.html).toContain(listUnsubscribe!.url);
    expect(footer?.text).toContain(listUnsubscribe!.url);
  });

  it('without an https API base, points the visible line at the settings page and sends no header', async () => {
    db.platform_domains = [{ api_base_url: 'http://localhost:3001' }];
    await queue();
    await dispatchNotificationEmails(CONFIG);
    expect(email.sent[0].listUnsubscribe).toBeUndefined();
    expect(email.sent[0].footer?.html).toContain('https://app.example.test/app/settings/notifications');
  });

  it('uses the notification provider only when it is the one chosen and it can send', async () => {
    settings({ provider_override: 'sendgrid' });
    await queue();
    await dispatchNotificationEmails(CONFIG);
    expect(email.sent[0].providerKey).toBeUndefined(); // nothing stored: the default

    store.notification = { provider_name: 'resend', config: { api_key: 'k', from_email: 'n@example.test' } };
    await queue();
    await dispatchNotificationEmails(CONFIG);
    expect(email.sent[1].providerKey).toBeUndefined(); // another provider: the default

    store.notification = { provider_name: 'sendgrid', config: { from_email: 'n@example.test' } };
    await queue();
    await dispatchNotificationEmails(CONFIG);
    expect(email.sent[2].providerKey).toBeUndefined(); // cannot send (no key): the default

    store.notification = { provider_name: 'sendgrid', config: { api_key: 'k', from_email: 'n@example.test' } };
    await queue();
    await dispatchNotificationEmails(CONFIG);
    expect(email.sent[3].providerKey).toBe('notification_email_provider');
  });

  it('retries a failure that can pass on the outbox schedule, and counts each attempt', async () => {
    email.outcomes.push('timeout', 'timeout');
    await queue();
    const t0 = Date.now();
    await dispatchNotificationEmails(CONFIG);
    let job = jobs()[0];
    expect(job).toMatchObject({ status: 'pending', attempts: 1, last_error: 'timeout: the relay did not answer' });
    expect(Date.parse(job.scheduled_for as string) - t0).toBeGreaterThanOrEqual(60_000 - 1000);
    expect(Date.parse(job.scheduled_for as string) - t0).toBeLessThan(2 * 60_000);

    due();
    await dispatchNotificationEmails(CONFIG);
    job = jobs()[0];
    expect(job.attempts).toBe(2);
    expect(Date.parse(job.scheduled_for as string) - Date.now()).toBeGreaterThan(4 * 60_000);

    due();
    await dispatchNotificationEmails(CONFIG);
    expect(jobs()[0]).toMatchObject({ status: 'sent', attempts: 3 });
  });

  it('gives up after the outbox\'s attempts, not after three', async () => {
    await queue();
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      email.outcomes.push('timeout');
      due();
      await dispatchNotificationEmails(CONFIG);
      expect(jobs()[0].status).toBe(i + 1 < MAX_ATTEMPTS ? 'pending' : 'failed');
    }
    expect(jobs()[0].attempts).toBe(MAX_ATTEMPTS);
    expect(jobs()[0].payload).toEqual({});
  });

  it('never retries a failure that cannot pass', async () => {
    email.outcomes.push('suppressed');
    await queue();
    await dispatchNotificationEmails(CONFIG);
    expect(jobs()[0]).toMatchObject({ status: 'failed', attempts: 1 });
  });

  it('tries again after an error of its own instead of failing the job', async () => {
    email.outcomes.push('throw');
    await queue();
    await dispatchNotificationEmails(CONFIG);
    expect(jobs()[0]).toMatchObject({ status: 'pending', attempts: 1 });
    expect(String(jobs()[0].last_error)).toMatch(/^dispatch_error: database went away/);
  });

  it('skips an account with no address rather than failing forever', async () => {
    db.profiles[1].email = null;
    await queue({ userId: AGENT });
    await dispatchNotificationEmails(CONFIG);
    expect(jobs()[0].status).toBe('skipped');
  });

  it('drops a job nobody could deliver in 48 hours', async () => {
    await queue();
    jobs()[0].created_at = new Date(Date.now() - 49 * 60 * 60_000).toISOString();
    await dispatchNotificationEmails(CONFIG);
    expect(email.sent).toHaveLength(0);
    expect(jobs()[0].status).toBe('skipped');
  });
});

describe('who may receive it', () => {
  it('never a member suspended in the workspace, nor one removed from it', async () => {
    db.workspace_members[1].suspended_at = new Date().toISOString();
    await queue({ userId: AGENT });
    db.workspace_members = db.workspace_members.filter((m) => m.user_id !== OWNER);
    await queue({ userId: OWNER });
    await dispatchNotificationEmails(CONFIG);
    expect(email.sent).toHaveLength(0);
    expect(jobs().map((j) => [j.status, j.last_error])).toEqual([
      ['skipped', 'suspended in the workspace'],
      ['skipped', 'no longer a member of the workspace'],
    ]);
  });

  it('not a payment notice to an admin demoted since it was queued', async () => {
    await queue({ userId: AGENT, type: 'paid_invoices', payload: {} });
    await dispatchNotificationEmails(CONFIG);
    expect(jobs()[0]).toMatchObject({ status: 'skipped', last_error: 'no longer an owner or admin' });
  });

  it('platform mail goes as platform mail, never in some workspace\'s log, and not to someone suspended everywhere', async () => {
    await queue({ userId: AGENT, workspaceId: null, type: 'product_updates', payload: { title: 'Hello', body: 'News' } });
    await dispatchNotificationEmails(CONFIG);
    expect(email.sent[0]).toMatchObject({ workspaceId: null, category: 'marketing', slug: 'operator_product_update' });

    db.workspace_members[1].suspended_at = new Date().toISOString();
    await queue({ userId: AGENT, workspaceId: null, type: 'product_updates', payload: { title: 'Again', body: 'News' } });
    await dispatchNotificationEmails(CONFIG);
    expect(email.sent).toHaveLength(1);
    expect(jobs()[1]).toMatchObject({ status: 'skipped', last_error: 'suspended in every workspace' });

    // Someone in no workspace at all still gets what the platform says.
    db.workspace_members = db.workspace_members.filter((m) => m.user_id !== AGENT);
    await queue({ userId: AGENT, workspaceId: null, type: 'product_updates', payload: { title: 'Third', body: 'News' } });
    await dispatchNotificationEmails(CONFIG);
    expect(email.sent).toHaveLength(2);
  });

  it('a transcript goes to the assignee and the operator who resolved it, only while active members', async () => {
    db.conversations = [{ id: 'c-1', workspace_id: WORKSPACE, subject: 'Help', assigned_to: AGENT, contact_id: null, updated_at: '2026-10-29T10:00:00Z' }];
    db.conversation_messages = [];
    db.workspace_members[1].suspended_at = new Date().toISOString();
    expect(await queueTranscript(CONFIG, { conversationId: 'c-1', workspaceId: WORKSPACE, actorId: OWNER })).toBe(1);
    expect(jobs().map((j) => j.user_id)).toEqual([OWNER]);
    expect(jobs()[0].conversation_ids).toEqual(['c-1']);
  });
});

describe('quiet hours', () => {
  it('move a job rather than dropping it, and moving it is not an attempt', async () => {
    db.user_notification_prefs = [{
      user_id: OWNER, platform: 'web', workspace_id: null, quiet_hours_enabled: true,
      quiet_hours_start: '22:00', quiet_hours_end: '08:00', quiet_hours_timezone: 'UTC',
    }];
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-21T23:30:00Z'));

    await queue();
    for (let i = 0; i < 5; i += 1) {
      due();
      await dispatchNotificationEmails(CONFIG);
    }
    expect(email.sent).toHaveLength(0);
    const job = jobs()[0];
    expect(job).toMatchObject({ status: 'pending', attempts: 0 });
    expect(new Date(job.scheduled_for as string).getTime()).toBeGreaterThan(Date.now());
  });
});

describe('a job cut off mid-send', () => {
  it('is taken back with its attempt counted, and one too old to matter is dropped', async () => {
    await queue();
    await queue({ userId: AGENT });
    const old = new Date(Date.now() - STUCK_SENDING_MS - 60_000).toISOString();
    Object.assign(jobs()[0], { status: 'sending', claimed_at: old, attempts: 0 });
    Object.assign(jobs()[1], { status: 'sending', claimed_at: old, created_at: new Date(Date.now() - 49 * 60 * 60_000).toISOString() });

    expect(await reclaimStuckJobs(CONFIG)).toBe(2);
    expect(jobs()[0]).toMatchObject({ status: 'pending', attempts: 1, claimed_at: null });
    expect(jobs()[1]).toMatchObject({ status: 'skipped' });

    await dispatchNotificationEmails(CONFIG);
    expect(email.sent.map((s) => s.to)).toEqual(['owner@example.test']);
  });

  it('one still within its send is left alone', async () => {
    await queue();
    Object.assign(jobs()[0], { status: 'sending', claimed_at: new Date().toISOString() });
    expect(await reclaimStuckJobs(CONFIG)).toBe(0);
    expect(jobs()[0].status).toBe('sending');
  });
});

describe('retention', () => {
  it('finished jobs go after 30 days; waiting ones stay', async () => {
    db.notification_email_jobs = [
      { id: 'a', status: 'sent', created_at: new Date(Date.now() - 31 * 86_400_000).toISOString() },
      { id: 'b', status: 'failed', created_at: new Date(Date.now() - 31 * 86_400_000).toISOString() },
      { id: 'c', status: 'sent', created_at: new Date(Date.now() - 2 * 86_400_000).toISOString() },
      { id: 'd', status: 'pending', created_at: new Date(Date.now() - 31 * 86_400_000).toISOString() },
    ];
    await purgeFinishedJobs(CONFIG);
    expect(jobs().map((j) => j.id)).toEqual(['c', 'd']);
  });
});

describe('the digest', () => {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

  function waiting(conversations: Array<{ id: string; subject?: string; assigned_to?: string | null; status?: string }>) {
    db.conversations = conversations.map((c) => ({
      workspace_id: WORKSPACE, status: 'open', is_spam: false, assigned_to: null, subject: 'Hello', ...c,
    }));
    db.conversation_messages = conversations.map((c, i) => ({
      id: `m-${c.id}-${i}`, conversation_id: c.id, sender_type: 'contact', seen_at: null, created_at: minutesAgo(60),
    }));
  }

  it('is one mail per operator with an Inbox, not one per conversation, and never to staff', async () => {
    waiting([{ id: 'c-1', subject: 'Where is my order' }, { id: 'c-2', subject: 'Refund please' }, { id: 'c-3' }]);
    const result = await sweepUnreadDigest(CONFIG);
    expect(result).toEqual({ workspaces: 1, queued: 2 });
    expect(jobs().map((j) => j.user_id).sort()).toEqual([OWNER, AGENT].sort());
    expect(jobs()[0].payload).toMatchObject({ count: 3 });
    expect([...(jobs()[0].conversation_ids as string[])].sort()).toEqual(['c-1', 'c-2', 'c-3']);
  });

  it('tells an operator about the conversations nobody holds and their own, not a colleague\'s', async () => {
    waiting([{ id: 'c-1' }, { id: 'c-2', assigned_to: AGENT }]);
    await sweepUnreadDigest(CONFIG);
    const of = (user: string) => jobs().find((j) => j.user_id === user)!;
    expect(of(OWNER).conversation_ids).toEqual(['c-1']);
    expect([...(of(AGENT).conversation_ids as string[])].sort()).toEqual(['c-1', 'c-2']);
  });

  it('keeps one open digest per operator: a later sweep gives it the new list', async () => {
    waiting([{ id: 'c-1' }]);
    await sweepUnreadDigest(CONFIG, new Date());
    waiting([{ id: 'c-1' }, { id: 'c-2' }]);
    // Another window, and still nothing sent: the same job, a longer list.
    const second = await sweepUnreadDigest(CONFIG, new Date(Date.now() + 2 * 60 * 60_000));
    expect(second.queued).toBe(0);
    expect(jobs()).toHaveLength(2);
    for (const job of jobs()) expect(job.payload).toMatchObject({ count: 2 });
  });

  it('is not sent again for the same conversations, only for something new, and not more often than the setting', async () => {
    waiting([{ id: 'c-1' }]);
    await sweepUnreadDigest(CONFIG);
    await dispatchNotificationEmails(CONFIG);
    expect(email.sent).toHaveLength(2);

    // The same conversation still waits, hours later: nothing new to say.
    const later = new Date(Date.now() + 3 * 60 * 60_000);
    expect((await sweepUnreadDigest(CONFIG, later)).queued).toBe(0);

    // A newer message in it: something new, but within the hour of the last one, not yet.
    db.conversation_messages.push({ id: 'm-new', conversation_id: 'c-1', sender_type: 'contact', seen_at: null, created_at: minutesAgo(20) });
    expect((await sweepUnreadDigest(CONFIG, new Date(Date.now() + 10 * 60_000))).queued).toBe(0);
    // An hour on, it goes.
    expect((await sweepUnreadDigest(CONFIG, later)).queued).toBe(2);
  });

  it('drops a waiting digest once nothing waits any more', async () => {
    waiting([{ id: 'c-1' }]);
    await sweepUnreadDigest(CONFIG);
    db.conversation_messages[0].seen_at = new Date().toISOString();
    await sweepUnreadDigest(CONFIG);
    expect(jobs().map((j) => [j.status, j.last_error])).toEqual([
      ['skipped', 'nothing is waiting any more'],
      ['skipped', 'nothing is waiting any more'],
    ]);
  });

  it('starts from the open conversations: thousands of unseen messages in closed ones hide nothing', async () => {
    waiting([{ id: 'c-open' }]);
    for (let i = 0; i < 3000; i += 1) {
      db.conversations.push({ id: `c-closed-${i}`, workspace_id: WORKSPACE, status: 'closed', is_spam: false, assigned_to: null, subject: 'x' });
      db.conversation_messages.push({ conversation_id: `c-closed-${i}`, sender_type: 'contact', seen_at: null, created_at: minutesAgo(10_000 + i) });
    }
    const result = await sweepUnreadDigest(CONFIG);
    expect(result.queued).toBe(2);
    expect(jobs()[0].conversation_ids).toEqual(['c-open']);
  });
});

describe('the announcement', () => {
  it('fans out from the ticker, a page at a time, at most the hour\'s allowance, once per operator, as plain text', async () => {
    const users = Array.from({ length: ANNOUNCEMENTS_PER_HOUR + 50 }, (_, i) => `20000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    db.profiles.push(...users.map((id) => ({ id, email: `${id.slice(-4)}@example.test`, full_name: null, preferred_locale: 'en' })));
    db.workspace_members.push(...users.map((user_id) => ({ workspace_id: WORKSPACE, user_id, role: 'agent', suspended_at: null })));
    // In two workspaces, still one mail.
    db.workspace_members.push({ workspace_id: '10000000-0000-4000-8000-000000000002', user_id: users[0], role: 'agent', suspended_at: null });
    db.notification_email_announcements = [{
      id: 'ann-1', title: 'New inbox', body: 'Line one\n<b>not bold</b>', dedupe_key: 'k', status: 'sending',
      fanout_cursor: null, recipients_queued: 0, created_at: new Date().toISOString(),
    }];

    expect((await fanOutAnnouncements(CONFIG)).queued).toBe(ANNOUNCEMENTS_PER_HOUR);
    expect(await fanOutAnnouncements(CONFIG)).toEqual({ queued: 0 }); // the hour's allowance is spent
    const announcement = db.notification_email_announcements[0];
    expect(announcement).toMatchObject({ status: 'sending', recipients_queued: ANNOUNCEMENTS_PER_HOUR });

    // An hour later the rest goes, and the announcement is done.
    for (const job of jobs()) job.created_at = new Date(Date.now() - 61 * 60_000).toISOString();
    expect((await fanOutAnnouncements(CONFIG)).queued).toBe(users.length + 3 - ANNOUNCEMENTS_PER_HOUR);
    expect(announcement).toMatchObject({ status: 'done', recipients_queued: users.length + 3 });
    const keys = jobs().map((j) => j.dedupe_key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(jobs().every((j) => j.workspace_id === null && j.type === 'product_updates')).toBe(true);

    const job = jobs().find((j) => j.user_id === OWNER)!;
    job.scheduled_for = new Date(0).toISOString();
    for (const other of jobs()) if (other !== job) other.status = 'skipped';
    await dispatchNotificationEmails(CONFIG);
    expect(email.sent[0].data.body).toBe('Line one\n<b>not bold</b>');
    expect(email.sent[0].html.body).toBe('Line one<br>&lt;b&gt;not bold&lt;/b&gt;');
  });

  it('waits while the platform has announcements off', async () => {
    settings({ product_updates_enabled: false });
    db.notification_email_announcements = [{ id: 'a', title: 't', body: 'b', status: 'sending', fanout_cursor: null, recipients_queued: 0, created_at: new Date().toISOString() }];
    expect(await fanOutAnnouncements(CONFIG)).toEqual({ queued: 0 });
    expect(db.notification_email_announcements[0].status).toBe('sending');
  });
});

describe('the weekly summary', () => {
  function activeWeek() {
    db.conversations = [{ id: 'c-1', workspace_id: WORKSPACE, status: 'resolved', created_at: '2026-10-25T10:00:00Z', updated_at: '2026-10-25T11:00:00Z' }];
    db.conversation_messages = [{ conversation_id: 'c-1', created_at: '2026-10-25T10:00:00Z' }];
  }

  it('goes on the chosen day and hour in each operator\'s own time zone, to the members with an Inbox', async () => {
    activeWeek();
    // Monday 08:00 in Tehran is 04:30 UTC; the owner is in Tehran, the agent in UTC.
    db.user_notification_prefs = [
      { user_id: OWNER, platform: 'web', workspace_id: null, quiet_hours_timezone: 'Asia/Tehran' },
      { user_id: AGENT, platform: 'web', workspace_id: null, quiet_hours_timezone: 'UTC' },
    ];
    const tehranMorning = new Date('2026-10-26T04:45:00Z');
    expect((await sweepWeeklySummary(CONFIG, tehranMorning)).queued).toBe(1);
    expect(jobs().map((j) => [j.user_id, j.dedupe_key])).toEqual([[OWNER, `weekly:${OWNER}:${WORKSPACE}:2026-10-26`]]);

    // The same instant again: nothing more. At 08:00 UTC the agent's turn.
    expect((await sweepWeeklySummary(CONFIG, tehranMorning)).queued).toBe(0);
    expect((await sweepWeeklySummary(CONFIG, new Date('2026-10-26T08:10:00Z'))).queued).toBe(1);
    expect(jobs().map((j) => j.user_id)).toEqual([OWNER, AGENT]);
    // Staff have no Inbox to open: never.
    expect(jobs().some((j) => j.user_id === STAFF)).toBe(false);
  });

  it('says nothing for a week nothing happened in', async () => {
    db.conversations = [];
    db.conversation_messages = [];
    expect((await sweepWeeklySummary(CONFIG, new Date('2026-10-26T08:10:00Z'))).queued).toBe(0);
  });
});

describe('the payment notice', () => {
  it('goes to the owners and admins, in each one\'s language, but not to the billing recipient the receipt went to', async () => {
    const ADMIN = '00000000-0000-4000-8000-000000000009';
    db.profiles.push({ id: ADMIN, email: 'admin@example.test', full_name: 'Admin', preferred_locale: 'en' });
    db.workspace_members.push({ workspace_id: WORKSPACE, user_id: ADMIN, role: 'admin', suspended_at: null });
    db.billing_accounts = [];
    db.platform_settings = [{ region_mode: 'multi', active_locales: ['en', 'fa'], default_locale: 'en' }];

    const queued = await queueInvoicePaid(CONFIG, {
      workspaceId: WORKSPACE, amountMinor: 1999, currency: 'USD', paymentKey: 'ledger-1', receiptNumber: 'R-7',
    });
    // The owner is the billing recipient: their receipt says it.
    expect(queued).toBe(1);
    expect(jobs()[0]).toMatchObject({ user_id: ADMIN, type: 'paid_invoices', dedupe_key: `invoice:${ADMIN}:ledger-1:${WORKSPACE}` });
    expect(jobs()[0].payload).toMatchObject({ amount: '$19.99', invoice_label: ' (R-7)' });

    // The same payment again: one mail.
    await queueInvoicePaid(CONFIG, { workspaceId: WORKSPACE, amountMinor: 1999, currency: 'USD', paymentKey: 'ledger-1' });
    expect(jobs()).toHaveLength(1);
  });
});
