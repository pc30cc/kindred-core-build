// @vitest-environment node
/**
 * The email outbox's decisions (server/services/email/outbox.ts), the same
 * for every provider, with the database and sendEmail stood in for (the real
 * SQL, claims and leases are in integration/emailOutbox289b.pg.test.ts):
 *
 *   - the schedule: 1, 5, 15 and 60 minutes, then every 3 hours;
 *   - sendEmailWithRetry queues a retry only for a failure that can pass,
 *     within 24 hours and never past the mail's own deadline, and says so
 *     (queuedRetry); a permanent failure, or a queue that cannot take it,
 *     queues nothing;
 *   - after a hand-over, the closed after-sent action runs (earlier links
 *     revoked, issued before the new one only) and older mails of the same
 *     kind still waiting are cancelled;
 *   - the stored request is sealed with PLUGIN_SECRETS_MASTER_KEY and reads
 *     back; without the key it is stored as it is;
 *   - a duplicate dedupe key is the mail already queued, not an error;
 *   - an after-sent action outside the closed list is refused;
 *   - the worker starts once, stops, drains within its bound and registers
 *     its drain for SIGTERM.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptPluginSecret } from '../../../server/lib/pluginCrypto';

type Row = Record<string, unknown>;
interface Write {
  table: string;
  op: 'insert' | 'update' | 'delete';
  values: Row | null;
  filters: Array<[string, string, unknown]>;
}

const db = vi.hoisted(() => ({
  writes: [] as Write[],
  insertError: null as { code?: string; message: string } | null,
  existing: null as Row | null,
}));

const sendEmail = vi.hoisted(() => vi.fn());
const shutdownHooks = vi.hoisted(() => new Map<string, () => Promise<unknown>>());

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from(table: string) {
      const write: Write = { table, op: 'update', values: null, filters: [] };
      const filter = (op: string) => (column: string, value: unknown) => {
        write.filters.push([op, column, value]);
        return builder;
      };
      const builder: Record<string, unknown> = {
        insert: (values: Row) => {
          Object.assign(write, { op: 'insert', values });
          db.writes.push(write);
          return builder;
        },
        update: (values: Row) => {
          Object.assign(write, { op: 'update', values });
          db.writes.push(write);
          return builder;
        },
        delete: () => {
          Object.assign(write, { op: 'delete' });
          db.writes.push(write);
          return builder;
        },
        select: () => builder,
        eq: filter('eq'),
        neq: filter('neq'),
        lt: filter('lt'),
        is: filter('is'),
        in: filter('in'),
        single: async () =>
          db.insertError
            ? { data: null, error: db.insertError }
            : { data: { id: 'row-1', created_at: '2026-10-29T10:00:00.000000+00:00' }, error: null },
        maybeSingle: async () => ({ data: db.existing, error: null }),
        then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null }),
      };
      return builder;
    },
    rpc: async () => ({ data: [], error: null }),
  }),
}));
vi.mock('../../../server/services/email/index.js', () => ({ sendEmail }));
vi.mock('../../../server/services/jobs/processShutdown.js', () => ({
  onProcessShutdown: (name: string, drain: () => Promise<unknown>) => shutdownHooks.set(name, drain),
}));

const outbox = await import('../../../server/services/email/outbox');

const KEY = 'a'.repeat(64);
const CONFIG = { pluginSecretsMasterKey: KEY } as never;
const WS = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const REQUEST = { workspaceId: WS, to: 'person@example.org', subject: 'Receipt', html: '<p>R-1</p>' };

const inserted = () => db.writes.filter((w) => w.op === 'insert').map((w) => w.values as Row);
const updatesOf = (table: string) => db.writes.filter((w) => w.op === 'update' && w.table === table);

beforeEach(() => {
  db.writes.length = 0;
  db.insertError = null;
  db.existing = null;
  sendEmail.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the schedule', () => {
  it('waits 1, 5, 15 and 60 minutes, then every 3 hours', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 11].map((n) => outbox.emailRetryDelayMs(n) / 60_000)).toEqual([1, 1, 5, 15, 60, 180, 180, 180]);
  });
});

describe('sendEmailWithRetry', () => {
  it('a failure that can pass is queued for a minute later, within the mail\'s deadline', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-29T10:00:00Z'), toFake: ['Date'] });
    sendEmail.mockResolvedValue({ success: false, provider: 'smtp', errorCode: 'timeout', permanent: false, error: 'timeout: the relay did not answer' });
    const expiresAt = new Date('2026-10-29T20:00:00Z');
    const result = await outbox.sendEmailWithRetry(CONFIG, REQUEST, { expiresAt, supersedeKey: 'password_reset:u' });
    expect(result).toMatchObject({ success: false, errorCode: 'timeout', queuedRetry: true });
    const [row] = inserted();
    expect(row).toMatchObject({
      workspace_id: WS,
      attempts: 1,
      next_attempt_at: '2026-10-29T10:01:00.000Z',
      give_up_at: expiresAt.toISOString(),
      provider: 'smtp',
      last_error_code: 'timeout',
      last_error: 'timeout: the relay did not answer',
      supersede_key: 'password_reset:u',
      category: 'transactional',
    });
    expect(Number(row.max_attempts)).toBeGreaterThanOrEqual(2);
  });

  it('never queues past 24 hours from the first attempt', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-29T10:00:00Z'), toFake: ['Date'] });
    sendEmail.mockResolvedValue({ success: false, provider: 'resend', errorCode: 'provider_error', permanent: false, error: 'provider_error: HTTP 503' });
    await outbox.sendEmailWithRetry(CONFIG, REQUEST);
    expect(inserted()[0].give_up_at).toBe('2026-10-30T10:00:00.000Z');
  });

  it('a permanent failure queues nothing and comes back as it is', async () => {
    const refused = { success: false, provider: 'smtp', errorCode: 'rejected', permanent: true, error: 'rejected: 550' };
    sendEmail.mockResolvedValue(refused);
    expect(await outbox.sendEmailWithRetry(CONFIG, REQUEST)).toEqual(refused);
    expect(db.writes).toEqual([]);
  });

  it('a queue that cannot take the mail leaves the failure as it was, without queuedRetry', async () => {
    sendEmail.mockResolvedValue({ success: false, provider: 'smtp', errorCode: 'connection', permanent: false, error: 'connection: refused' });
    db.insertError = { code: '42P01', message: 'relation "public.email_outbox" does not exist' };
    const result = await outbox.sendEmailWithRetry(CONFIG, REQUEST);
    expect(result.queuedRetry).toBeUndefined();
    expect(result.errorCode).toBe('connection');
  });

  it('after a hand-over: earlier links issued before the new one are revoked, older waiting mails cancelled', async () => {
    sendEmail.mockResolvedValue({ success: true, provider: 'smtp', id: 'q1' });
    const issuedAt = '2026-10-29T10:00:00.123456+00:00';
    const result = await outbox.sendEmailWithRetry(CONFIG, REQUEST, {
      supersedeKey: `password_reset:${USER}`,
      afterSent: { action: 'revoke_earlier_tokens', table: 'auth_reset_tokens', userId: USER, issuedAt },
    });
    expect(result).toEqual({ success: true, provider: 'smtp', id: 'q1' });
    expect(inserted()).toEqual([]);
    const [revoke] = updatesOf('auth_reset_tokens');
    expect(revoke.values).toEqual({ revoked_at: expect.any(String) });
    expect(revoke.filters).toEqual([
      ['eq', 'user_id', USER],
      ['is', 'used_at', null],
      ['is', 'revoked_at', null],
      ['lt', 'created_at', issuedAt],
    ]);
    const [cancel] = updatesOf('email_outbox');
    expect(cancel.values).toMatchObject({ status: 'cancelled', payload: null, last_error_code: 'superseded' });
    expect(cancel.filters).toEqual(expect.arrayContaining([
      ['eq', 'supersede_key', `password_reset:${USER}`],
      ['eq', 'status', 'pending'],
    ]));
  });

  it('runs no after-sent action outside the closed list', async () => {
    sendEmail.mockResolvedValue({ success: true, provider: 'smtp' });
    await outbox.sendEmailWithRetry(CONFIG, REQUEST, {
      afterSent: { action: 'revoke_earlier_tokens', table: 'profiles' as never, userId: USER, issuedAt: '2026-10-29T10:00:00Z' },
    });
    expect(db.writes).toEqual([]);
    expect(await outbox.enqueueEmail(CONFIG, REQUEST, {
      afterSent: { action: 'drop_table' as never, table: 'auth_reset_tokens', userId: USER, issuedAt: '2026-10-29T10:00:00Z' },
    })).toEqual({ queued: false, error: 'invalid_request' });
  });
});

describe('enqueueEmail', () => {
  it('stores the request sealed with the master key, and it reads back', async () => {
    expect(await outbox.enqueueEmail(CONFIG, { ...REQUEST, templateData: { action_url: 'https://app.example/reset?token=secret' } }))
      .toEqual({ queued: true, id: 'row-1' });
    const [row] = inserted();
    expect(row).toMatchObject({ attempts: 0, template_slug: null, dedupe_key: null });
    const payload = row.payload as { v: number; sealed: Record<string, string>; plain?: unknown };
    expect(payload.v).toBe(1);
    expect(payload.plain).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('secret');
    expect(payload.sealed).not.toHaveProperty('fingerprint');
    expect(JSON.parse(decryptPluginSecret(payload.sealed as never, KEY)))
      .toEqual({ ...REQUEST, templateData: { action_url: 'https://app.example/reset?token=secret' } });
  });

  it('without the master key, stores it as it is (dropped once final), and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await outbox.enqueueEmail({} as never, REQUEST);
    expect((inserted()[0].payload as { plain: unknown }).plain).toEqual(REQUEST);
    expect(String(warn.mock.calls[0]?.[0])).toContain('PLUGIN_SECRETS_MASTER_KEY');
    warn.mockRestore();
  });

  it('a dedupe key already queued is that mail, not an error', async () => {
    db.insertError = { code: '23505', message: 'duplicate key value violates unique constraint "email_outbox_dedupe_key_idx"' };
    db.existing = { id: 'first-row' };
    expect(await outbox.enqueueEmail(CONFIG, REQUEST, { dedupeKey: 'billing_payment_receipt:ws:l1' }))
      .toEqual({ queued: true, duplicate: true, id: 'first-row' });
  });

  it('refuses what cannot be mailed, and a link already expired', async () => {
    expect(await outbox.enqueueEmail(CONFIG, { ...REQUEST, to: 'a@x.org; b@y.org' })).toEqual({ queued: false, error: 'invalid_recipient' });
    expect(await outbox.enqueueEmail(CONFIG, { ...REQUEST, workspaceId: 'not-a-workspace' })).toEqual({ queued: false, error: 'invalid_request' });
    expect(await outbox.enqueueEmail(CONFIG, REQUEST, { expiresAt: new Date(Date.now() - 1) })).toEqual({ queued: false, error: 'expired' });
    expect(inserted()).toEqual([]);
  });

  it('platform mail (no workspace) is queued like any other', async () => {
    expect(await outbox.enqueueEmail(CONFIG, { ...REQUEST, workspaceId: null })).toEqual({ queued: true, id: 'row-1' });
    expect(inserted()[0].workspace_id).toBeNull();
  });
});

describe('the worker', () => {
  afterEach(async () => {
    await outbox.shutdownEmailOutboxWorker(500);
  });

  it('starts once, registers its drain for SIGTERM, and stops', async () => {
    outbox.startEmailOutboxWorker(CONFIG);
    outbox.startEmailOutboxWorker(CONFIG);
    expect(outbox.getEmailOutboxWorkerStatus().phase).toBe('running');
    expect(shutdownHooks.has('email-outbox')).toBe(true);
    await shutdownHooks.get('email-outbox')!();
    expect(outbox.getEmailOutboxWorkerStatus().phase).toBe('stopped');
  });

  it('a drain after shutdown claims nothing', async () => {
    outbox.startEmailOutboxWorker(CONFIG);
    outbox.stopEmailOutboxWorker();
    expect(await outbox.drainEmailOutbox(CONFIG, { runMaintenance: false })).toBe(0);
  });
});
