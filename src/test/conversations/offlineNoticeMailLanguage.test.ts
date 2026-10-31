// @vitest-environment node
/**
 * The owners' offline-message mails are written in the template's language
 * (server/services/operatorLocale.ts operatorMailLocale), not the
 * dashboard's: on WebYar (region `iran`) with English added to the panel, an
 * English owner gets the Persian template with a Persian summary (its
 * numbers in Persian digits) and a Persian, right-to-left unsubscribe line,
 * never English words in a Persian mail. RESPOK (multi, en and tr) is
 * unchanged: each owner's own language.
 *
 * Real operatorLocale and platformRegion over fakeServiceDb.ts; the outbox
 * records what it is asked to queue.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeServiceDb, fakeServiceClient, type FakeServiceDb } from './fakeServiceDb';

type Queued = {
  request: Record<string, unknown> & {
    to: string;
    locale: string;
    subject: string;
    templateData: Record<string, string>;
    footer?: { html: string; text: string };
  };
};

const state = vi.hoisted(() => ({
  db: null as unknown as FakeServiceDb,
  queued: [] as Array<{ request: Record<string, unknown> }>,
}));

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeServiceClient(state.db) }));
vi.mock('../../../server/services/email/outbox.js', () => ({
  enqueueEmail: async (_c: unknown, request: Record<string, unknown>) => {
    state.queued.push({ request });
    return { queued: true, id: `q${state.queued.length}` };
  },
}));
vi.mock('../../../server/services/email/index.js', () => ({
  sendEmail: async () => ({ success: true, provider: 'smtp' }),
}));
vi.mock('../../../server/services/widget/availability.js', () => ({
  resolveAvailability: async () => ({ state: 'offline', reason: 'outside_hours', next_open_at: null }),
}));
vi.mock('../../../server/services/billing/locks/state.js', () => ({ resolveLockState: async () => ({ enabled: false }) }));
vi.mock('../../../server/services/billing/locks/predicates.js', () => ({ isMemberLocked: () => false }));
vi.mock('../../../server/services/auth-email.js', () => ({
  resolveWorkspaceAppUrl: async (_c: unknown, _ws: string, path: string) => `https://app.test/acme${path}`,
}));
vi.mock('../../../server/services/calls/rtcResolver.js', () => ({ resolveApiBaseUrl: async () => 'https://api.test' }));
process.env.PLATFORM_SIGNING_SECRET = 'signing-secret-for-this-test-only-0123456789';

const { notifyOfflineCapture } = await import('../../../server/services/widget/offlineNotice.js');
const { notificationFooter } = await import('../../../server/services/notificationEmail/unsubscribe.js');
const { __resetEmailQuotaMemoryForTests } = await import('../../../server/services/email/sendQuota.js');
const { __resetOperatorLocaleCache, operatorLocale } = await import('../../../server/services/operatorLocale.js');
const { __resetPlatformRegionCache } = await import('../../../server/services/platformRegion.js');

const CONFIG = { supabaseUrl: 'https://x.test', supabaseServiceRoleKey: 'k' } as never;
const WS = '11111111-1111-4111-8111-111111111111';
const NOW = Date.parse('2026-10-31T09:00:00Z');

const WEBYAR_EN_PANEL = { id: 1, region_mode: 'iran', active_locales: ['fa', 'en'], default_locale: 'en', site_mode: 'multi_language' };
const RESPOK = { id: 1, region_mode: 'multi', active_locales: ['en', 'tr'], default_locale: 'en', site_mode: 'multi_language' };

let seq = 0;
const capture = () => {
  seq += 1;
  return { conversationId: `c-${seq}`, messageId: `m-${seq}`, message: 'سلام', name: 'Ali', email: 'ali@example.com', phone: null };
};
const queued = () => state.queued as unknown as Queued[];
const byRecipient = () => Object.fromEntries(queued().map((q) => [q.request.to, q.request.locale]));

function platform(row: Record<string, unknown>) {
  state.db.tables.platform_settings = [row];
  __resetPlatformRegionCache();
  __resetOperatorLocaleCache();
}

/** The footer the notice must carry, in `locale`, for its own unsubscribe link. */
function expectedFooter(q: Queued, locale: 'fa' | 'en' | 'tr') {
  const unsubscribe = (q.request.listUnsubscribe as { url: string } | undefined)?.url ?? null;
  return notificationFooter(locale, 'offline_messages', {
    unsubscribe,
    settings: unsubscribe ? null : 'https://app.test/acme/settings/notifications',
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(NOW) });
  state.db = createFakeServiceDb();
  state.db.tables.workspace_members = [
    { workspace_id: WS, user_id: 'u-fa', role: 'owner', suspended_at: null },
    { workspace_id: WS, user_id: 'u-en', role: 'admin', suspended_at: null },
  ];
  state.db.tables.profiles = [
    { id: 'u-fa', email: 'sara@example.com', preferred_locale: 'fa' },
    { id: 'u-en', email: 'john@example.com', preferred_locale: 'en' },
  ];
  state.db.tables.user_credentials = [];
  state.db.tables.user_email_notification_prefs = [];
  state.queued.length = 0;
  __resetEmailQuotaMemoryForTests();
  platform(WEBYAR_EN_PANEL);
});
afterEach(() => { vi.useRealTimers(); });

describe('WebYar with English on its dashboard', () => {
  it('the English owner keeps English for the dashboard, and gets the notice in Persian, footer and all', async () => {
    expect(await operatorLocale(CONFIG, 'u-en')).toBe('en');
    expect(await notifyOfflineCapture(CONFIG, WS, capture())).toBe('immediate');
    expect(byRecipient()).toEqual({ 'sara@example.com': 'fa', 'john@example.com': 'fa' });
    for (const q of queued()) {
      expect(q.request.footer).toEqual(expectedFooter(q, 'fa'));
      expect(q.request.footer?.html).toMatch(/^<p dir="rtl"/);
    }
  });

  it('the window\'s summary: Persian digits and words, for both', async () => {
    await notifyOfflineCapture(CONFIG, WS, capture());
    state.queued.length = 0;
    expect(await notifyOfflineCapture(CONFIG, WS, capture())).toBe('summary');
    expect(byRecipient()).toEqual({ 'sara@example.com': 'fa', 'john@example.com': 'fa' });
    for (const q of queued()) {
      expect(q.request.templateData).toMatchObject({ count: '۱', minutes: '۱۵' });
      expect(q.request.subject).toBe('پیام‌های آفلاین بیشتر: ۱');
      expect(q.request.footer).toEqual(expectedFooter(q, 'fa'));
    }
  });

  it('the reply-to address, with no owner to mail, in Persian too', async () => {
    state.db.tables.profiles = [];
    state.db.tables.email_settings = [{ workspace_id: WS, reply_to_email: 'team@example.com' }];
    expect(await notifyOfflineCapture(CONFIG, WS, capture())).toBe('immediate');
    expect(byRecipient()).toEqual({ 'team@example.com': 'fa' });
  });
});

describe('RESPOK (multi, en and tr): unchanged', () => {
  it('each owner\'s own language, its digits and footer', async () => {
    platform(RESPOK);
    state.db.tables.profiles = [
      { id: 'u-fa', email: 'sara@example.com', preferred_locale: 'tr' },
      { id: 'u-en', email: 'john@example.com', preferred_locale: 'en' },
    ];
    await notifyOfflineCapture(CONFIG, WS, capture());
    expect(byRecipient()).toEqual({ 'sara@example.com': 'tr', 'john@example.com': 'en' });
    const tr = queued().find((q) => q.request.to === 'sara@example.com')!;
    expect(tr.request.footer).toEqual(expectedFooter(tr, 'tr'));
    state.queued.length = 0;
    await notifyOfflineCapture(CONFIG, WS, capture());
    const en = queued().find((q) => q.request.to === 'john@example.com')!;
    expect(en.request.subject).toBe('More offline messages: 1');
    expect(en.request.footer).toEqual(expectedFooter(en, 'en'));
  });
});
