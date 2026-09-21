/**
 * The operator notification emails, end to end through their own pipeline.
 *
 * These are the six switches that used to save and send nothing. Each one
 * that exists now has a producer, a template and a queue row behind it, and
 * the things worth pinning are the ones that would cost somebody real
 * trouble: a digest that goes twice, a switch the dispatcher forgets to
 * re-read, an invoice mailed to an operator who answers chats, and a
 * platform that starts mailing everybody the moment it is upgraded.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

type Row = Record<string, any>;
const db: Record<string, Row[]> = {};

const sent: Array<{ to: string; slug?: string; providerKey?: string; locale?: string; data?: Record<string, string> }> = [];
const email = vi.hoisted(() => ({ succeeds: true }));

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from(table: string) {
      const rows: Row[] = db[table] || (db[table] = []);
      const filters: Array<(r: Row) => boolean> = [];
      let pending: 'update' | 'insert' | 'upsert' | null = null;
      let payload: Row = {};

      const matched = () => rows.filter((r) => filters.every((f) => f(r)));

      const apply = (): Row[] => {
        if (pending === 'update') {
          const hits = matched();
          for (const r of hits) Object.assign(r, payload);
          return hits;
        }
        if (pending === 'insert' || pending === 'upsert') {
          const values = Array.isArray(payload) ? payload : [payload];
          const out: Row[] = [];
          for (const value of values) {
            if (table === 'notification_email_jobs') {
              const clash = rows.find((r) => r.dedupe_key === value.dedupe_key);
              if (clash) {
                const err: any = new Error('duplicate key');
                err.code = '23505';
                throw err;
              }
            }
            if (pending === 'upsert') {
              const existing = rows.find((r) => r.user_id === value.user_id);
              if (existing) {
                Object.assign(existing, value);
                out.push(existing);
                continue;
              }
            }
            const inserted = { id: value.id ?? `row-${rows.length + 1}`, status: 'pending', attempts: 0, ...value };
            rows.push(inserted);
            out.push(inserted);
          }
          return out;
        }
        return matched();
      };

      const run = () => {
        try {
          return { data: apply(), error: null };
        } catch (err: any) {
          return { data: null, error: { code: err.code, message: err.message } };
        }
      };

      const builder: any = {
        select: () => builder,
        eq(col: string, val: any) { filters.push((r: Row) => r[col] === val); return builder; },
        neq(col: string, val: any) { filters.push((r: Row) => r[col] !== val); return builder; },
        is(col: string, val: null) { filters.push((r: Row) => (r[col] ?? null) === val); return builder; },
        in(col: string, vals: any[]) { filters.push((r: Row) => vals.includes(r[col])); return builder; },
        or() { return builder; },
        lt(col: string, val: any) { filters.push((r: Row) => r[col] < val); return builder; },
        lte(col: string, val: any) { filters.push((r: Row) => r[col] <= val); return builder; },
        gte(col: string, val: any) { filters.push((r: Row) => r[col] >= val); return builder; },
        order() { return builder; },
        limit() { return builder; },
        update(patch: Row) { pending = 'update'; payload = patch; return builder; },
        insert(values: Row) { pending = 'insert'; payload = values; return builder; },
        upsert(values: Row) { pending = 'upsert'; payload = values; return builder; },
        maybeSingle: async () => {
          const result = run();
          return { data: result.data?.[0] ?? null, error: result.error };
        },
        then(resolve: any) { return resolve(run()); },
      };
      return builder;
    },
  }),
}));

vi.mock('../../../server/services/email/index.js', () => ({
  sendEmail: async (_config: unknown, req: any) => {
    if (!email.succeeds) return { success: false, provider: 'stub', error: 'nope' };
    sent.push({
      to: req.to,
      slug: req.templateSlug,
      providerKey: req.providerConfigKey,
      locale: req.locale,
      data: req.templateData,
    });
    return { success: true, provider: 'resend', id: 'msg-1' };
  },
}));

vi.mock('../../../server/services/auth-email.js', () => ({
  resolveWorkspaceAppUrl: async () => 'https://example.test/app/inbox',
}));

const { enqueueNotificationEmail } = await import('../../../server/services/notificationEmail/queue.js');
const { dispatchNotificationEmails } = await import('../../../server/services/notificationEmail/dispatcher.js');
const { sweepUnreadDigest } = await import('../../../server/services/notificationEmail/producers.js');
const { invalidateNotificationEmailSettingsCache } = await import(
  '../../../server/services/notificationEmail/settings.js'
);

const CONFIG = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' } as any;
const OWNER = 'user-owner';
const AGENT = 'user-agent';
const WORKSPACE = 'ws-1';

function settings(overrides: Row = {}) {
  db.notification_email_settings = [
    {
      id: true,
      enabled: true,
      unread_messages_enabled: true,
      transcripts_enabled: true,
      paid_invoices_enabled: true,
      weekly_summary_enabled: true,
      product_updates_enabled: true,
      provider_override: null,
      unread_after_minutes: 15,
      digest_every_minutes: 60,
      weekly_summary_dow: 1,
      weekly_summary_hour: 8,
      ...overrides,
    },
  ];
  invalidateNotificationEmailSettingsCache();
}

beforeEach(() => {
  for (const key of Object.keys(db)) delete db[key];
  sent.length = 0;
  email.succeeds = true;
  settings();

  db.profiles = [
    { id: OWNER, email: 'owner@example.test', full_name: 'Owner', preferred_locale: 'fa' },
    { id: AGENT, email: 'agent@example.test', full_name: 'Agent', preferred_locale: 'en' },
  ];
  db.workspace_members = [
    { workspace_id: WORKSPACE, user_id: OWNER, role: 'owner', suspended_at: null },
    { workspace_id: WORKSPACE, user_id: AGENT, role: 'agent', suspended_at: null },
  ];
  db.workspaces = [{ id: WORKSPACE, name: 'Acme' }];
  db.user_email_notification_prefs = [];
  db.user_notification_prefs = [];
  db.notification_email_jobs = [];
  db.conversation_messages = [];
  db.conversations = [];
});

describe('the platform switch', () => {
  it('sends nothing at all while the feature is off', async () => {
    settings({ enabled: false });
    const result = await enqueueNotificationEmail(CONFIG, {
      userId: AGENT,
      workspaceId: WORKSPACE,
      type: 'unread_messages',
      payload: {},
      dedupeKey: 'k1',
    });
    expect(result).toEqual({ queued: false, reason: 'platform_disabled' });
    expect(db.notification_email_jobs).toHaveLength(0);
  });

  it('nor when the feature is on but this type is not', async () => {
    settings({ unread_messages_enabled: false });
    const result = await enqueueNotificationEmail(CONFIG, {
      userId: AGENT,
      workspaceId: WORKSPACE,
      type: 'unread_messages',
      payload: {},
      dedupeKey: 'k1',
    });
    expect(result.reason).toBe('platform_disabled');
  });

  it('is asked again at send time, not only at queue time', async () => {
    // A digest queued at 2am for 8am must not go if the platform switched
    // the type off at 7.
    await enqueueNotificationEmail(CONFIG, {
      userId: AGENT,
      workspaceId: WORKSPACE,
      type: 'unread_messages',
      payload: { count: 3 },
      dedupeKey: 'k1',
    });
    settings({ unread_messages_enabled: false });

    await dispatchNotificationEmails(CONFIG);
    expect(sent).toHaveLength(0);
    expect(db.notification_email_jobs[0].status).toBe('skipped');
  });
});

describe('the operator\'s own switch', () => {
  it('is honoured before a job is even written', async () => {
    db.user_email_notification_prefs = [{ user_id: AGENT, unread_messages: false }];
    const result = await enqueueNotificationEmail(CONFIG, {
      userId: AGENT,
      workspaceId: WORKSPACE,
      type: 'unread_messages',
      payload: {},
      dedupeKey: 'k1',
    });
    expect(result).toEqual({ queued: false, reason: 'operator_opted_out' });
  });

  it('and again before it is sent', async () => {
    await enqueueNotificationEmail(CONFIG, {
      userId: AGENT,
      workspaceId: WORKSPACE,
      type: 'unread_messages',
      payload: { count: 1 },
      dedupeKey: 'k1',
    });
    db.user_email_notification_prefs = [{ user_id: AGENT, unread_messages: false }];

    await dispatchNotificationEmails(CONFIG);
    expect(sent).toHaveLength(0);
    expect(db.notification_email_jobs[0].status).toBe('skipped');
  });

  it('an operator who has never opened the page gets what the platform offers', async () => {
    const result = await enqueueNotificationEmail(CONFIG, {
      userId: AGENT,
      workspaceId: WORKSPACE,
      type: 'unread_messages',
      payload: { count: 1 },
      dedupeKey: 'k1',
    });
    expect(result.queued).toBe(true);
  });
});

describe('sending', () => {
  it('renders the right template, in the recipient\'s own language', async () => {
    await enqueueNotificationEmail(CONFIG, {
      userId: OWNER,
      workspaceId: WORKSPACE,
      type: 'unread_messages',
      payload: { count: 4, workspace: 'Acme' },
      dedupeKey: 'k1',
    });

    await dispatchNotificationEmails(CONFIG);

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('owner@example.test');
    expect(sent[0].slug).toBe('operator_unread_digest');
    expect(sent[0].locale).toBe('fa');
    // The producer's payload, plus the name the dispatcher resolved.
    expect(sent[0].data).toMatchObject({ count: '4', workspace: 'Acme', name: 'Owner' });
    expect(db.notification_email_jobs[0].status).toBe('sent');
  });

  it('uses the platform default transport unless an override is chosen', async () => {
    await enqueueNotificationEmail(CONFIG, {
      userId: OWNER, workspaceId: WORKSPACE, type: 'unread_messages', payload: {}, dedupeKey: 'k1',
    });
    await dispatchNotificationEmails(CONFIG);
    expect(sent[0].providerKey).toBeUndefined();

    sent.length = 0;
    settings({ provider_override: 'sendgrid' });
    await enqueueNotificationEmail(CONFIG, {
      userId: OWNER, workspaceId: WORKSPACE, type: 'unread_messages', payload: {}, dedupeKey: 'k2',
    });
    await dispatchNotificationEmails(CONFIG);
    expect(sent[0].providerKey).toBe('notification_email_provider');
  });

  it('retries a refused send rather than losing it', async () => {
    email.succeeds = false;
    await enqueueNotificationEmail(CONFIG, {
      userId: OWNER, workspaceId: WORKSPACE, type: 'unread_messages', payload: {}, dedupeKey: 'k1',
    });
    await dispatchNotificationEmails(CONFIG);

    const job = db.notification_email_jobs[0];
    expect(job.status).toBe('pending');
    expect(job.attempts).toBe(1);
    expect(job.last_error).toBeTruthy();
  });

  it('gives up after three tries rather than forever', async () => {
    email.succeeds = false;
    await enqueueNotificationEmail(CONFIG, {
      userId: OWNER, workspaceId: WORKSPACE, type: 'unread_messages', payload: {}, dedupeKey: 'k1',
    });
    for (let i = 0; i < 3; i += 1) {
      db.notification_email_jobs[0].scheduled_for = new Date(0).toISOString();
      db.notification_email_jobs[0].status = 'pending';
      await dispatchNotificationEmails(CONFIG);
    }
    expect(db.notification_email_jobs[0].status).toBe('failed');
  });

  it('skips an account with no address rather than failing forever', async () => {
    db.profiles = [{ id: AGENT, email: null, full_name: 'Agent', preferred_locale: 'en' }];
    await enqueueNotificationEmail(CONFIG, {
      userId: AGENT, workspaceId: WORKSPACE, type: 'unread_messages', payload: {}, dedupeKey: 'k1',
    });
    await dispatchNotificationEmails(CONFIG);
    expect(db.notification_email_jobs[0].status).toBe('skipped');
  });
});

describe('quiet hours', () => {
  it('move a job rather than dropping it', async () => {
    // 22:00–08:00 UTC, and it is the middle of the night.
    db.user_notification_prefs = [
      {
        user_id: OWNER,
        platform: 'web',
        workspace_id: null,
        quiet_hours_enabled: true,
        quiet_hours_start: '22:00',
        quiet_hours_end: '08:00',
        quiet_hours_timezone: 'UTC',
      },
    ];
    vi.setSystemTime(new Date('2026-09-21T23:30:00Z'));

    await enqueueNotificationEmail(CONFIG, {
      userId: OWNER, workspaceId: WORKSPACE, type: 'unread_messages', payload: {}, dedupeKey: 'k1',
    });
    await dispatchNotificationEmails(CONFIG);

    expect(sent).toHaveLength(0);
    const job = db.notification_email_jobs[0];
    expect(job.status).toBe('pending');
    expect(new Date(job.scheduled_for).getTime()).toBeGreaterThan(Date.now());
    vi.useRealTimers();
  });
});

describe('the digest', () => {
  it('is one mail per operator, not one per conversation', async () => {
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    db.conversations = [
      { id: 'c-1', workspace_id: WORKSPACE, subject: 'Where is my order', status: 'open', is_spam: false },
      { id: 'c-2', workspace_id: WORKSPACE, subject: 'Refund please', status: 'open', is_spam: false },
      { id: 'c-3', workspace_id: WORKSPACE, subject: 'Hello', status: 'open', is_spam: false },
    ];
    db.conversation_messages = [
      { id: 'm-1', conversation_id: 'c-1', sender_type: 'contact', seen_at: null, created_at: old },
      { id: 'm-2', conversation_id: 'c-2', sender_type: 'contact', seen_at: null, created_at: old },
      { id: 'm-3', conversation_id: 'c-3', sender_type: 'contact', seen_at: null, created_at: old },
    ];

    const result = await sweepUnreadDigest(CONFIG);

    expect(result.workspaces).toBe(1);
    // Two operators, one mail each — not three conversations times two.
    expect(result.queued).toBe(2);
    expect(db.notification_email_jobs).toHaveLength(2);
    expect(db.notification_email_jobs[0].payload.count).toBe(3);
  });

  it('does not go twice when two instances sweep the same window', async () => {
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    db.conversations = [{ id: 'c-1', workspace_id: WORKSPACE, subject: 'Hi', status: 'open', is_spam: false }];
    db.conversation_messages = [
      { id: 'm-1', conversation_id: 'c-1', sender_type: 'contact', seen_at: null, created_at: old },
    ];

    await sweepUnreadDigest(CONFIG);
    const second = await sweepUnreadDigest(CONFIG);

    expect(second.queued).toBe(0);
    expect(db.notification_email_jobs).toHaveLength(2); // one per operator, once
  });
});
