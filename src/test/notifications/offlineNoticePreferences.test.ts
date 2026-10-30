/**
 * The owners' and admins' own switch for the mail they get when a visitor
 * leaves a message while the team is away (offline_messages, migration 289g):
 *
 *   - Settings → Notifications offers it to an owner or admin of some
 *     workspace, whatever Super Admin → Notifications offers (it has no
 *     platform switch), and saves it; an agent is not offered it;
 *   - before 289g (no column) the page still loads, without it, and nobody
 *     counts as having declined it;
 *   - the mail's one-click link turns it off for that person alone;
 *   - a lookup that fails is not consent to send.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { db, resetDb } from './fakeNotificationDb';

const state = vi.hoisted(() => ({
  user: '00000000-0000-4000-8000-0000000000aa',
  /** Columns this "database" does not have, as before migration 289g. */
  missingColumns: [] as string[],
  failPrefs: false,
}));

vi.mock('../../../server/supabase.js', async () => {
  const { fakeClient } = await import('./fakeNotificationDb');
  return {
    getServiceClient: () => {
      const client = fakeClient();
      return {
        ...client,
        from(table: string) {
          const builder = client.from(table) as Record<string, (...args: unknown[]) => unknown>;
          if (table !== 'user_email_notification_prefs') return builder;
          const select = builder.select;
          builder.select = (cols?: unknown, ...rest: unknown[]) => {
            const wanted = String(cols ?? '');
            const missing = state.missingColumns.some((c) => wanted.includes(c));
            if (state.failPrefs || missing) {
              const error = state.failPrefs
                ? { code: '57014', message: 'canceling statement due to statement timeout' }
                : { code: '42703', message: 'column does not exist' };
              const failed: Record<string, unknown> = {};
              for (const name of ['eq', 'in', 'limit']) failed[name] = () => failed;
              failed.maybeSingle = async () => ({ data: null, error });
              failed.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error }).then(resolve);
              return failed;
            }
            return select(cols, ...rest);
          };
          return builder;
        },
      };
    },
  };
});
vi.mock('../../../server/lib/workspaceAuth.js', () => ({
  requireUser: async () => state.user,
  serverConfigOf: (req: { serverConfig: unknown }) => req.serverConfig,
}));
vi.mock('../../../server/services/auth-email.js', () => ({
  resolveWorkspaceAppUrl: async (_c: unknown, _w: unknown, path: string) => `https://app.example.test/app${path}`,
}));

process.env.PLATFORM_SIGNING_SECRET = 'signing-secret-for-this-test-only-0123456789';

const { notificationEmailRouter } = await import('../../../server/routes/notificationEmail.js');
const { notificationEmailUnsubscribeRouter } = await import('../../../server/routes/notificationEmailUnsubscribe.js');
const { signUnsubscribeToken } = await import('../../../server/services/notificationEmail/unsubscribe.js');
const { operatorsDeclining, operatorWants } = await import('../../../server/services/notificationEmail/queue.js');
const { invalidateNotificationEmailSettingsCache } = await import('../../../server/services/notificationEmail/settings.js');
const { __resetOperatorLocaleCache } = await import('../../../server/services/operatorLocale.js');
const { __resetPlatformRegionCache } = await import('../../../server/services/platformRegion.js');

const OWNER = '00000000-0000-4000-8000-0000000000aa';
const AGENT = '00000000-0000-4000-8000-0000000000bb';
const WS = '11111111-1111-4111-8111-111111111111';
const CONFIG = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k', corsOrigins: [] } as never;

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    (req as unknown as { serverConfig: unknown }).serverConfig = CONFIG;
    next();
  });
  a.use('/api/notifications/email/unsubscribe', notificationEmailUnsubscribeRouter);
  a.use('/api/notifications/email', notificationEmailRouter);
  return a;
}

beforeEach(() => {
  resetDb();
  state.user = OWNER;
  state.missingColumns = [];
  state.failPrefs = false;
  db.profiles = [
    { id: OWNER, email: 'owner@example.test', preferred_locale: 'en' },
    { id: AGENT, email: 'agent@example.test', preferred_locale: 'en' },
  ];
  db.workspace_members = [
    { workspace_id: WS, user_id: OWNER, role: 'owner' },
    { workspace_id: WS, user_id: AGENT, role: 'agent' },
  ];
  // The platform offers transcripts only.
  db.notification_email_settings = [{ id: true, enabled: true, transcripts_enabled: true }];
  db.platform_settings = [{ id: 1, region_mode: 'multi', active_locales: ['en', 'fa', 'tr'], default_locale: 'en' }];
  invalidateNotificationEmailSettingsCache();
  __resetPlatformRegionCache();
  __resetOperatorLocaleCache();
});

describe('Settings → Notifications', () => {
  it('offers the switch to an owner or admin, beside what the platform offers, and saves it', async () => {
    const res = await request(app()).get('/api/notifications/email');
    expect(res.status).toBe(200);
    expect(res.body.available).toEqual(['transcripts', 'offline_messages']);
    expect(res.body.prefs.offline_messages).toBe(true);

    const saved = await request(app()).patch('/api/notifications/email').send({ offline_messages: false });
    expect(saved.status).toBe(200);
    expect(saved.body.prefs.offline_messages).toBe(false);
    expect(db.user_email_notification_prefs.find((r) => r.user_id === OWNER)).toMatchObject({ offline_messages: false });
    expect(await operatorWants(CONFIG, OWNER, 'offline_messages')).toBe(false);
  });

  it('an agent, who never gets the mail, is not offered its switch', async () => {
    state.user = AGENT;
    const res = await request(app()).get('/api/notifications/email');
    expect(res.body.available).toEqual(['transcripts']);
  });

  it('before 289g the page still loads, without the switch it could not save', async () => {
    state.missingColumns = ['offline_messages'];
    const res = await request(app()).get('/api/notifications/email');
    expect(res.status).toBe(200);
    expect(res.body.available).toEqual(['transcripts']);
  });
});

describe('who declined', () => {
  it('is read for every recipient at once; before 289g nobody has', async () => {
    db.user_email_notification_prefs = [{ user_id: OWNER, offline_messages: false }, { user_id: AGENT, transcripts: false }];
    expect([...(await operatorsDeclining(CONFIG, [OWNER, AGENT], 'offline_messages'))!]).toEqual([OWNER]);
    state.missingColumns = ['offline_messages'];
    expect((await operatorsDeclining(CONFIG, [OWNER, AGENT], 'offline_messages'))!.size).toBe(0);
    expect(await operatorWants(CONFIG, OWNER, 'offline_messages')).toBe(true);
  });

  it('a lookup that fails is not consent to send', async () => {
    state.failPrefs = true;
    expect(await operatorsDeclining(CONFIG, [OWNER], 'offline_messages')).toBeNull();
    expect(await operatorWants(CONFIG, OWNER, 'offline_messages')).toBe(false);
  });
});

describe('the mail\'s one-click link', () => {
  it('turns the offline-message mail off for that person alone, and says so in their words', async () => {
    db.user_email_notification_prefs = [{ user_id: AGENT, offline_messages: true }];
    const token = signUnsubscribeToken(OWNER, 'offline_messages')!;
    const page = await request(app()).get(`/api/notifications/email/unsubscribe/${token}`);
    expect(page.text).toContain('Stop “Offline messages from visitors” emails?');
    const res = await request(app()).post(`/api/notifications/email/unsubscribe/${token}`).type('form').send('List-Unsubscribe=One-Click');
    expect(res.status).toBe(200);
    expect(db.user_email_notification_prefs.find((r) => r.user_id === OWNER)).toMatchObject({ offline_messages: false });
    expect(db.user_email_notification_prefs.find((r) => r.user_id === AGENT)).toMatchObject({ offline_messages: true });
  });
});
