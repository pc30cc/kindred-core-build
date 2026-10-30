/**
 * The unsubscribe link of the operator notification emails
 * (server/services/notificationEmail/unsubscribe.ts and
 * server/routes/notificationEmailUnsubscribe.ts):
 *
 *   - a token names one person and one type, is signed with a key derived
 *     from PLATFORM_SIGNING_SECRET (nothing new), and ends after 180 days; a
 *     changed byte, another secret or a date past its end is refused;
 *   - the one-click POST (RFC 8058) turns that type off for that person and
 *     nothing else, without a session; the GET only asks, so a link scanner
 *     unsubscribes nobody; a bad link gets a page, in the platform's
 *     language, that points at the settings;
 *   - the words are the dashboard's, key for key, in fa, en and tr.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';
import { db, resetDb } from './fakeNotificationDb';

vi.mock('../../../server/supabase.js', async () => {
  const { fakeClient } = await import('./fakeNotificationDb');
  return { getServiceClient: () => fakeClient() };
});
vi.mock('../../../server/services/auth-email.js', () => ({
  resolveWorkspaceAppUrl: async (_c: unknown, _w: unknown, path: string) => `https://app.example.test/app${path}`,
}));

const SECRET = 'signing-secret-for-this-test-only-0123456789';
process.env.PLATFORM_SIGNING_SECRET = SECRET;

const {
  signUnsubscribeToken, verifyUnsubscribeToken, UNSUBSCRIBE_STRINGS, UNSUBSCRIBE_TOKEN_TTL_MS, notificationFooter,
} = await import('../../../server/services/notificationEmail/unsubscribe.js');
const { notificationEmailUnsubscribeRouter } = await import('../../../server/routes/notificationEmailUnsubscribe.js');
const { __resetOperatorLocaleCache } = await import('../../../server/services/operatorLocale.js');
const { __resetPlatformRegionCache } = await import('../../../server/services/platformRegion.js');

const USER = '00000000-0000-4000-8000-0000000000aa';
const OTHER = '00000000-0000-4000-8000-0000000000bb';

function app() {
  const a = express();
  a.use((req, _res, next) => {
    (req as unknown as { serverConfig: unknown }).serverConfig = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k', corsOrigins: [] };
    next();
  });
  a.use('/api/notifications/email/unsubscribe', notificationEmailUnsubscribeRouter);
  return a;
}

beforeEach(() => {
  resetDb();
  db.profiles = [
    { id: USER, email: 'op@example.test', preferred_locale: 'fa' },
    { id: OTHER, email: 'other@example.test', preferred_locale: 'en' },
  ];
  db.user_email_notification_prefs = [{ user_id: OTHER, unread_messages: true, transcripts: true }];
  db.platform_settings = [{ id: 1, region_mode: 'multi', active_locales: ['en', 'fa', 'tr'], default_locale: 'en' }];
  __resetPlatformRegionCache();
  __resetOperatorLocaleCache();
});

describe('the token', () => {
  it('names one person and one type, and holds only as signed and within its time', () => {
    const token = signUnsubscribeToken(USER, 'weekly_summary')!;
    expect(verifyUnsubscribeToken(token)).toEqual({ ok: true, userId: USER, type: 'weekly_summary' });

    const [body, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ v: 1, u: OTHER, t: 'weekly_summary', x: 9_999_999_999 })).toString('base64url');
    expect(verifyUnsubscribeToken(`${forged}.${sig}`)).toEqual({ ok: false, reason: 'signature' });
    expect(verifyUnsubscribeToken(`${body}.${sig.slice(0, -2)}xx`)).toEqual({ ok: false, reason: 'signature' });
    expect(verifyUnsubscribeToken('nonsense')).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyUnsubscribeToken(token, new Date(Date.now() + UNSUBSCRIBE_TOKEN_TTL_MS + 60_000))).toEqual({ ok: false, reason: 'expired' });
    // Another server secret: refused.
    expect(verifyUnsubscribeToken(token, new Date(), { ...process.env, PLATFORM_SIGNING_SECRET: `${SECRET}-other` })).toEqual({ ok: false, reason: 'signature' });
  });

  it('is never made without a signing secret', () => {
    const env = { ...process.env, PLATFORM_SIGNING_SECRET: '', SUPABASE_SERVICE_ROLE_KEY: 'legacy-key', DATABASE_MODE: 'postgres-only', DATABASE_URL: 'postgresql://db.invalid/x' };
    expect(signUnsubscribeToken(USER, 'transcripts', new Date(), env)).toBeNull();
    expect(verifyUnsubscribeToken('a.b', new Date(), env)).toEqual({ ok: false, reason: 'unavailable' });
  });
});

describe('the link', () => {
  it('one click turns that type off for that person, without a session', async () => {
    const token = signUnsubscribeToken(USER, 'transcripts')!;
    const res = await request(app())
      .post(`/api/notifications/email/unsubscribe/${token}`)
      .type('form')
      .send('List-Unsubscribe=One-Click');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).toContain('dir="rtl"');
    expect(res.text).toContain('«متن گفتگوهایی که خودم رسیدگی کردم»');
    expect(db.user_email_notification_prefs.find((r) => r.user_id === USER)).toMatchObject({ transcripts: false });
    // Nobody else, and no other type.
    expect(db.user_email_notification_prefs.find((r) => r.user_id === OTHER)).toMatchObject({ unread_messages: true, transcripts: true });
    expect(db.user_email_notification_prefs.find((r) => r.user_id === USER)).not.toHaveProperty('unread_messages');
  });

  it('the page only asks: opening it changes nothing', async () => {
    const token = signUnsubscribeToken(OTHER, 'unread_messages')!;
    const res = await request(app()).get(`/api/notifications/email/unsubscribe/${token}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('<form method="post">');
    expect(res.text).toContain('Stop “Conversations still waiting” emails?');
    expect(db.user_email_notification_prefs.find((r) => r.user_id === OTHER)).toMatchObject({ unread_messages: true });
  });

  it('a link that is not ours, or too old, changes nothing and points at the settings', async () => {
    const res = await request(app()).post('/api/notifications/email/unsubscribe/abc.def');
    expect(res.status).toBe(400);
    expect(res.text).toContain('https://app.example.test/app/settings/notifications');
    expect(res.text).not.toContain('<form');
    expect(db.user_email_notification_prefs).toHaveLength(1);
  });
});

describe('the words', () => {
  const LOCALES = { fa, en, tr } as unknown as Record<'fa' | 'en' | 'tr', { notifications: Record<string, string> }>;

  it('equal the dashboard\'s, key for key, in fa, en and tr', () => {
    for (const locale of ['fa', 'en', 'tr'] as const) {
      expect(Object.keys(UNSUBSCRIBE_STRINGS[locale]).sort()).toEqual(Object.keys(UNSUBSCRIBE_STRINGS.en).sort());
      for (const [key, value] of Object.entries(UNSUBSCRIBE_STRINGS[locale])) {
        expect(value, `${locale} ${key}`).toBe(LOCALES[locale].notifications[key.replace(/^notifications\./, '')]);
      }
    }
  });

  it('the line under a mail says why it came and links the way out, escaped', () => {
    const footer = notificationFooter('en', 'weekly_summary', { unsubscribe: 'https://api.example.test/u/a"b', settings: null });
    expect(footer.html).toContain('“A weekly summary”');
    expect(footer.html).toContain('href="https://api.example.test/u/a&quot;b"');
    expect(footer.text).toBe('You get this email because “A weekly summary” is on in your email notifications.\nUnsubscribe: https://api.example.test/u/a"b');
  });
});
